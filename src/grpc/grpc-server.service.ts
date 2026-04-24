import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import * as path from 'path';
import { IAtomicQueuesModuleConfig } from '../domain';
import { MessageRouter } from '../services/message-router';
import { EntityWorkerManager } from '../workers';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';

/** Minimal shape of a gRPC unary call (from @grpc/grpc-js). */
interface GrpcUnaryCall {
  request: Record<string, unknown>;
}

/** Minimal shape of a gRPC server-streaming call (from @grpc/grpc-js). */
interface GrpcServerStreamingCall extends GrpcUnaryCall {
  write(message: Record<string, unknown>): void;
  end(): void;
}

/** Minimal shape of a gRPC callback (from @grpc/grpc-js). */
type GrpcCallback = (err: Error | null, response?: Record<string, unknown>) => void;

/** Minimal shape of a gRPC server instance (from @grpc/grpc-js). */
interface GrpcServer {
  addService(service: unknown, handlers: Record<string, unknown>): void;
  bindAsync(address: string, credentials: unknown, callback: (err: Error | null) => void): void;
  tryShutdown(callback: () => void): void;
}

/** Minimal shape of the @grpc/grpc-js module used at runtime. */
interface GrpcModule {
  Server: new () => GrpcServer;
  ServerCredentials: { createInsecure(): unknown };
  loadPackageDefinition(
    packageDef: unknown,
  ): Record<string, Record<string, Record<string, Record<string, unknown>>>>;
}

/** Minimal shape of the @grpc/proto-loader module used at runtime. */
interface ProtoLoaderModule {
  loadSync(filename: string, options: Record<string, unknown>): unknown;
}

/**
 * gRPC Server — receives messages forwarded from peer servers.
 *
 * Only starts when `config.grpc.enabled` is true.
 * Dynamically imports `@grpc/grpc-js` and `@grpc/proto-loader` to keep
 * them as optional peer dependencies.
 */
@Injectable()
export class GrpcServerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(GrpcServerService.name);
  private server: GrpcServer | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly router: MessageRouter,
    private readonly workerManager: EntityWorkerManager,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.grpc?.enabled) return;

    let grpc: GrpcModule;
    let protoLoader: ProtoLoaderModule;

    try {
      /* eslint-disable @typescript-eslint/no-var-requires */
      grpc = require('@grpc/grpc-js') as GrpcModule;
      protoLoader = require('@grpc/proto-loader') as ProtoLoaderModule;
      /* eslint-enable @typescript-eslint/no-var-requires */
    } catch {
      throw new Error(
        'gRPC is enabled but @grpc/grpc-js and/or @grpc/proto-loader are not installed. ' +
          'Run: npm install @grpc/grpc-js @grpc/proto-loader',
      );
    }

    const protoPath = path.join(__dirname, 'atomicqueues.proto');
    const packageDef = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpc.loadPackageDefinition(packageDef);
    const service = (proto.atomicqueues as Record<string, Record<string, unknown>>).v1
      .AtomicQueuesNode;

    this.server = new grpc.Server();
    this.server.addService(service, {
      forward: this.handleForward.bind(this),
      forwardAndWait: this.handleForwardAndWait.bind(this),
      ping: this.handlePing.bind(this),
    });

    const listenAddress = this.config.grpc.listenAddress ?? '0.0.0.0:50051';
    const server = this.server;

    await new Promise<void>((resolve, reject) => {
      server.bindAsync(
        listenAddress,
        grpc.ServerCredentials.createInsecure(),
        (err: Error | null) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });

    this.logger.log(`gRPC server listening on ${listenAddress}`);
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (!server) return;

    return new Promise<void>((resolve) => {
      server.tryShutdown(() => {
        this.logger.log('gRPC server shut down');
        resolve();
      });
    });
  }

  // =========================================================================
  // RPC HANDLERS
  // =========================================================================

  private async handleForward(call: GrpcUnaryCall, callback: GrpcCallback): Promise<void> {
    try {
      const envelope = call.request;
      const maxHops = this.config.grpc?.maxForwardHops ?? 3;

      if ((envelope.hops as number) >= maxHops) {
        callback(null, {
          accepted: false,
          rejectReason: `max forward hops exceeded (${envelope.hops}/${maxHops})`,
        });
        return;
      }

      const data = JSON.parse(Buffer.from(envelope.payload as Buffer).toString('utf-8'));

      await this.router.enqueue(
        envelope.entityType as string,
        envelope.name as string,
        envelope.entityId as string,
        data,
        {
          correlationId: (envelope.correlationId as string) || undefined,
          isQuery: envelope.isQuery as boolean,
          maxAttempts: envelope.maxAttempts as number,
        },
      );

      callback(null, { accepted: true, rejectReason: '' });
    } catch (err) {
      this.logger.error(`Forward RPC error: ${(err as Error).message}`);
      callback(null, { accepted: false, rejectReason: (err as Error).message });
    }
  }

  private async handleForwardAndWait(call: GrpcServerStreamingCall): Promise<void> {
    try {
      const envelope = call.request;
      const maxHops = this.config.grpc?.maxForwardHops ?? 3;

      if ((envelope.hops as number) >= maxHops) {
        call.write({
          correlationId: envelope.correlationId as string,
          error: `max forward hops exceeded (${envelope.hops}/${maxHops})`,
        });
        call.end();
        return;
      }

      const data = JSON.parse(Buffer.from(envelope.payload as Buffer).toString('utf-8'));
      const timeout = 60000; // TODO: pass timeout in envelope metadata

      const result = await this.router.enqueueAndWait(
        envelope.entityType as string,
        envelope.name as string,
        envelope.entityId as string,
        data,
        timeout,
        { maxAttempts: envelope.maxAttempts as number },
      );

      call.write({
        correlationId: envelope.correlationId as string,
        result: Buffer.from(JSON.stringify(result), 'utf-8'),
      });
      call.end();
    } catch (err) {
      call.write({
        correlationId: call.request.correlationId as string,
        error: (err as Error).message,
      });
      call.end();
    }
  }

  private handlePing(_call: GrpcUnaryCall, callback: GrpcCallback): void {
    callback(null, {
      serverId: this.config.grpc?.serverId ?? 'unknown',
      activeWorkers: this.workerManager.workerCount(),
      queueDepth: this.workerManager.totalQueueDepth(),
      entityTypes: [], // TODO: populated from EntityTypeRegistry
    });
  }
}
