import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import * as path from 'path';
import { IAtomicQueuesModuleConfig, ISerializedMessage } from '../domain';
import { MessageRouter } from '../services/message-router';
import { EntityWorkerManager } from '../workers';
import { MasterCoordinator } from '../cluster';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';

interface GrpcUnaryCall {
  request: Record<string, unknown>;
}

interface GrpcServerStreamingCall extends GrpcUnaryCall {
  write(message: Record<string, unknown>): void;
  end(): void;
}

type GrpcCallback = (err: Error | null, response?: Record<string, unknown>) => void;

interface GrpcServer {
  addService(service: unknown, handlers: Record<string, unknown>): void;
  bindAsync(address: string, credentials: unknown, callback: (err: Error | null) => void): void;
  tryShutdown(callback: () => void): void;
}

interface GrpcModule {
  Server: new () => GrpcServer;
  ServerCredentials: { createInsecure(): unknown };
  loadPackageDefinition(
    packageDef: unknown,
  ): Record<string, Record<string, Record<string, Record<string, unknown>>>>;
}

interface ProtoLoaderModule {
  loadSync(filename: string, options: Record<string, unknown>): unknown;
}

/**
 * gRPC Server — handles all cross-replica and cross-service communication.
 *
 * RPCs:
 * - SpawnWorker / TeardownWorker / ListWorkers: Master → Replica
 * - EnqueueToWorker / EnqueueToWorkerAndWait: Master → Replica (dispatch)
 * - Petition / PetitionAndWait: Replica → Master (routing)
 * - ReportIdle: Replica → Master (idle teardown)
 * - Forward / ForwardAndWait: Master → Master (cross-service)
 */
@Injectable()
export class GrpcServerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(GrpcServerService.name);
  private server: GrpcServer | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    @Inject(forwardRef(() => MessageRouter)) private readonly router: MessageRouter,
    private readonly workerManager: EntityWorkerManager,
    @Inject(forwardRef(() => MasterCoordinator))
    private readonly masterCoordinator: MasterCoordinator,
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
    const ServiceDef = (proto.atomicqueues as Record<string, Record<string, unknown>>).v1
      .AtomicQueuesNode as Record<string, unknown>;
    const service = ServiceDef.service ?? ServiceDef;

    this.server = new grpc.Server();
    this.server.addService(service, {
      // Master → Replica: worker management
      spawnWorker: this.handleSpawnWorker.bind(this),
      enqueueToWorker: this.handleEnqueueToWorker.bind(this),
      enqueueToWorkerAndWait: this.handleEnqueueToWorkerAndWait.bind(this),
      teardownWorker: this.handleTeardownWorker.bind(this),
      listWorkers: this.handleListWorkers.bind(this),
      // Replica → Master: petitions
      petition: this.handlePetition.bind(this),
      petitionAndWait: this.handlePetitionAndWait.bind(this),
      reportIdle: this.handleReportIdle.bind(this),
      // Master → Master: cross-service
      forward: this.handleForward.bind(this),
      forwardAndWait: this.handleForwardAndWait.bind(this),
      // Health
      ping: this.handlePing.bind(this),
    });

    const listenAddress = this.config.grpc.listenAddress ?? '0.0.0.0:50051';
    const server = this.server;

    await new Promise<void>((resolve, reject) => {
      server.bindAsync(
        listenAddress,
        grpc.ServerCredentials.createInsecure(),
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
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
  // Master → Replica: worker management
  // =========================================================================

  private handleSpawnWorker(call: GrpcUnaryCall, callback: GrpcCallback): void {
    try {
      const entityKey = call.request.entityKey as string;
      const spawned = this.workerManager.spawn(entityKey);
      callback(null, { spawned, error: '' });
    } catch (err) {
      callback(null, { spawned: false, error: (err as Error).message });
    }
  }

  private handleEnqueueToWorker(call: GrpcUnaryCall, callback: GrpcCallback): void {
    try {
      const entityKey = call.request.entityKey as string;
      const envelope = call.request.message as Record<string, unknown>;
      const message = this.deserializeEnvelope(envelope);

      this.workerManager.enqueue(entityKey, message);
      callback(null, { accepted: true, rejectReason: '' });
    } catch (err) {
      callback(null, { accepted: false, rejectReason: (err as Error).message });
    }
  }

  private async handleEnqueueToWorkerAndWait(call: GrpcServerStreamingCall): Promise<void> {
    try {
      const entityKey = call.request.entityKey as string;
      const envelope = call.request.message as Record<string, unknown>;
      const message = this.deserializeEnvelope(envelope);

      const result = await this.workerManager.enqueueAndWait(entityKey, message, 60000);

      call.write({
        correlationId: message.correlationId ?? '',
        result: Buffer.from(JSON.stringify(result), 'utf-8'),
      });
      call.end();
    } catch (err) {
      call.write({
        correlationId: '',
        error: (err as Error).message,
      });
      call.end();
    }
  }

  private async handleTeardownWorker(call: GrpcUnaryCall, callback: GrpcCallback): Promise<void> {
    try {
      const entityKey = call.request.entityKey as string;
      await this.workerManager.teardown(entityKey);
      callback(null, { tornDown: true });
    } catch (err) {
      callback(null, { tornDown: false });
    }
  }

  private handleListWorkers(_call: GrpcUnaryCall, callback: GrpcCallback): void {
    const workerKeys = this.workerManager.listWorkers();
    const workers = workerKeys.map((key) => ({
      entityKey: key,
      queueDepth: 0,
      isProcessing: false,
      lastActive: Date.now(),
    }));
    callback(null, { workers });
  }

  // =========================================================================
  // Replica → Master: petitions
  // =========================================================================

  private async handlePetition(call: GrpcUnaryCall, callback: GrpcCallback): Promise<void> {
    try {
      const entityKey = call.request.entityKey as string;
      const envelope = call.request.message as Record<string, unknown>;
      const message = this.deserializeEnvelope(envelope);

      // Delegate to MessageRouter's master dispatch (handles cross-replica + cross-service)
      await this.router.dispatchAsMaster(entityKey, message);

      callback(null, { accepted: true, rejectReason: '' });
    } catch (err) {
      callback(null, { accepted: false, rejectReason: (err as Error).message });
    }
  }

  private async handlePetitionAndWait(call: GrpcServerStreamingCall): Promise<void> {
    try {
      const entityKey = call.request.entityKey as string;
      const envelope = call.request.message as Record<string, unknown>;
      const message = this.deserializeEnvelope(envelope);

      const result = await this.router.dispatchAsMasterAndWait(entityKey, message, 60000);

      call.write({
        correlationId: message.correlationId ?? '',
        result: Buffer.from(JSON.stringify(result), 'utf-8'),
      });
      call.end();
    } catch (err) {
      call.write({ correlationId: '', error: (err as Error).message });
      call.end();
    }
  }

  private handleReportIdle(call: GrpcUnaryCall, callback: GrpcCallback): void {
    const entityKey = call.request.entityKey as string;
    this.masterCoordinator.release(entityKey);
    callback(null, { shouldTeardown: true });
  }

  // =========================================================================
  // Master → Master: cross-service
  // =========================================================================

  private async handleForward(call: GrpcUnaryCall, callback: GrpcCallback): Promise<void> {
    try {
      const envelope = call.request;
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
      callback(null, { accepted: false, rejectReason: (err as Error).message });
    }
  }

  private async handleForwardAndWait(call: GrpcServerStreamingCall): Promise<void> {
    try {
      const envelope = call.request;
      const data = JSON.parse(Buffer.from(envelope.payload as Buffer).toString('utf-8'));

      const result = await this.router.enqueueAndWait(
        envelope.entityType as string,
        envelope.name as string,
        envelope.entityId as string,
        data,
        60000,
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

  // =========================================================================
  // Health
  // =========================================================================

  private handlePing(_call: GrpcUnaryCall, callback: GrpcCallback): void {
    callback(null, {
      serverId: this.config.grpc?.serverId ?? 'unknown',
      isMaster: this.masterCoordinator.isMaster(),
      activeWorkers: this.workerManager.workerCount(),
      queueDepth: this.workerManager.totalQueueDepth(),
      entityTypes: [],
    });
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private deserializeEnvelope(envelope: Record<string, unknown>): ISerializedMessage {
    const payload = envelope.payload
      ? JSON.parse(Buffer.from(envelope.payload as Buffer).toString('utf-8'))
      : {};

    return {
      id: (envelope.id as string) ?? '',
      name: (envelope.name as string) ?? '',
      data: payload,
      entityType: (envelope.entityType as string) ?? '',
      entityId: (envelope.entityId as string) ?? '',
      correlationId: (envelope.correlationId as string) || undefined,
      isQuery: (envelope.isQuery as boolean) || undefined,
      enqueuedAt: (envelope.enqueuedAt as number) ?? Date.now(),
      attempts: (envelope.attempts as number) ?? 0,
      maxAttempts: (envelope.maxAttempts as number) ?? 1,
    };
  }
}
