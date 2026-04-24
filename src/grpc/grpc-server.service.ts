import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import * as path from 'path';
import { IAtomicQueuesModuleConfig, ISerializedMessage } from '../domain';
import { MessageRouter } from '../services/message-router';
import { WorkerPoolService } from '../workers';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';

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
  private server: any = null;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly router: MessageRouter,
    private readonly workerPool: WorkerPoolService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.grpc?.enabled) return;

    let grpc: any;
    let protoLoader: any;

    try {
      /* eslint-disable @typescript-eslint/no-var-requires */
      grpc = require('@grpc/grpc-js');
      protoLoader = require('@grpc/proto-loader');
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

    const proto = grpc.loadPackageDefinition(packageDef) as any;
    const service = proto.atomicqueues.v1.AtomicQueuesNode.service;

    this.server = new grpc.Server();
    this.server.addService(service, {
      forward: this.handleForward.bind(this),
      forwardAndWait: this.handleForwardAndWait.bind(this),
      ping: this.handlePing.bind(this),
    });

    const listenAddress = this.config.grpc.listenAddress ?? '0.0.0.0:50051';

    await new Promise<void>((resolve, reject) => {
      this.server.bindAsync(
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
    if (!this.server) return;

    return new Promise<void>((resolve) => {
      this.server.tryShutdown(() => {
        this.logger.log('gRPC server shut down');
        resolve();
      });
    });
  }

  // =========================================================================
  // RPC HANDLERS
  // =========================================================================

  private async handleForward(call: any, callback: any): Promise<void> {
    try {
      const envelope = call.request;
      const maxHops = this.config.grpc?.maxForwardHops ?? 3;

      if (envelope.hops >= maxHops) {
        callback(null, {
          accepted: false,
          rejectReason: `max forward hops exceeded (${envelope.hops}/${maxHops})`,
        });
        return;
      }

      const data = JSON.parse(Buffer.from(envelope.payload).toString('utf-8'));

      const ref = await this.router.enqueue(
        envelope.entityType,
        envelope.name,
        envelope.entityId,
        data,
        {
          correlationId: envelope.correlationId || undefined,
          isQuery: envelope.isQuery,
          maxAttempts: envelope.maxAttempts,
        },
      );

      callback(null, { accepted: true, rejectReason: '' });
    } catch (err) {
      this.logger.error(`Forward RPC error: ${(err as Error).message}`);
      callback(null, { accepted: false, rejectReason: (err as Error).message });
    }
  }

  private async handleForwardAndWait(call: any): Promise<void> {
    try {
      const envelope = call.request;
      const maxHops = this.config.grpc?.maxForwardHops ?? 3;

      if (envelope.hops >= maxHops) {
        call.write({
          correlationId: envelope.correlationId,
          error: `max forward hops exceeded (${envelope.hops}/${maxHops})`,
        });
        call.end();
        return;
      }

      const data = JSON.parse(Buffer.from(envelope.payload).toString('utf-8'));
      const timeout = 60000; // TODO: pass timeout in envelope metadata

      const result = await this.router.enqueueAndWait(
        envelope.entityType,
        envelope.name,
        envelope.entityId,
        data,
        timeout,
        { maxAttempts: envelope.maxAttempts },
      );

      call.write({
        correlationId: envelope.correlationId,
        result: Buffer.from(JSON.stringify(result), 'utf-8'),
      });
      call.end();
    } catch (err) {
      call.write({
        correlationId: call.request.correlationId,
        error: (err as Error).message,
      });
      call.end();
    }
  }

  private handlePing(call: any, callback: any): void {
    callback(null, {
      serverId: this.config.grpc?.serverId ?? 'unknown',
      activeWorkers: this.workerPool.getWorkerCount(),
      queueDepth: this.workerPool.getTotalQueueDepth(),
      entityTypes: [], // TODO: populated from EntityTypeRegistry
    });
  }
}
