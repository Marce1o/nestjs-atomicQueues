import {
  Injectable,
  Logger,
  Inject,
  Optional,
  forwardRef,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import * as path from 'path';
import { IAtomicQueuesModuleConfig, ISerializedMessage } from '../domain';
import { MessageRouter } from '../services/message-router';
import { EntityWorkerManager } from '../workers';
import { MasterCoordinator, LeaderElectionService, ClusterDiscoveryService } from '../cluster';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';

interface GrpcUnaryCall {
  request: Record<string, unknown>;
}

interface GrpcServerStreamingCall extends GrpcUnaryCall {
  write(message: Record<string, unknown>): void;
  end(): void;
  on(event: 'cancelled', listener: () => void): void;
  cancelled: boolean;
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
  private activePetitions = 0;
  private readonly maxConcurrentPetitions: number;
  private nodeAddressCache: { map: Map<string, string>; expiresAt: number } | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    @Inject(forwardRef(() => MessageRouter)) private readonly router: MessageRouter,
    private readonly workerManager: EntityWorkerManager,
    @Inject(forwardRef(() => MasterCoordinator))
    private readonly masterCoordinator: MasterCoordinator,
    private readonly leaderElection: LeaderElectionService,
    @Optional() private readonly clusterDiscovery?: ClusterDiscoveryService,
  ) {
    this.maxConcurrentPetitions = config.grpc?.maxConcurrentPetitions ?? 50;
  }

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
      reportWorkers: this.handleReportWorkers.bind(this),
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

    this.masterCoordinator.setWorkerListProvider(() =>
      Promise.resolve(this.workerManager.listWorkers()),
    );
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

  private async handleEnqueueToWorker(call: GrpcUnaryCall, callback: GrpcCallback): Promise<void> {
    try {
      const requestEpoch = call.request.masterEpoch as number;
      const currentEpoch = this.leaderElection.epoch;
      if (currentEpoch > 0 && requestEpoch < currentEpoch) {
        callback(null, {
          accepted: false,
          rejectReason: `Stale epoch ${requestEpoch} < ${currentEpoch}`,
        });
        return;
      }
      if (requestEpoch > 0) {
        this.leaderElection.updateSeenEpoch(requestEpoch);
      }

      const entityKey = call.request.entityKey as string;
      const envelope = call.request.message as Record<string, unknown>;
      const message = this.deserializeEnvelope(envelope);

      await this.workerManager.enqueue(entityKey, message);
      callback(null, { accepted: true, rejectReason: '' });
    } catch (err) {
      const errorMsg = (err as Error).message;
      const rejectReason =
        errorMsg === 'WORKER_LIMIT_EXCEEDED' || errorMsg === 'QUEUE_DEPTH_EXCEEDED'
          ? 'RESOURCE_EXHAUSTED'
          : errorMsg;
      callback(null, { accepted: false, rejectReason });
    }
  }

  private async handleEnqueueToWorkerAndWait(call: GrpcServerStreamingCall): Promise<void> {
    const abortController = new AbortController();
    call.on('cancelled', () => abortController.abort());

    try {
      const requestEpoch = call.request.masterEpoch as number;
      const currentEpoch = this.leaderElection.epoch;
      if (currentEpoch > 0 && requestEpoch < currentEpoch) {
        if (!call.cancelled) {
          call.write({ correlationId: '', error: `Stale epoch ${requestEpoch} < ${currentEpoch}` });
          call.end();
        }
        return;
      }
      if (requestEpoch > 0) {
        this.leaderElection.updateSeenEpoch(requestEpoch);
      }

      const entityKey = call.request.entityKey as string;
      const envelope = call.request.message as Record<string, unknown>;
      const message = this.deserializeEnvelope(envelope);

      const result = await this.workerManager.enqueueAndWait(
        entityKey, message, this.resolveAndWaitTimeout(message.entityType), abortController.signal,
      );

      if (!call.cancelled) {
        call.write({
          correlationId: message.correlationId ?? '',
          result: Buffer.from(JSON.stringify(result), 'utf-8'),
        });
        call.end();
      }
    } catch (err) {
      if (!call.cancelled) {
        const errorMsg = (err as Error).message;
        const error =
          errorMsg === 'WORKER_LIMIT_EXCEEDED' || errorMsg === 'QUEUE_DEPTH_EXCEEDED'
            ? 'RESOURCE_EXHAUSTED'
            : errorMsg;
        call.write({ correlationId: '', error });
        call.end();
      }
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
    if (!this.masterCoordinator.isMaster()) {
      callback(null, { accepted: false, rejectReason: 'NOT_MASTER' });
      return;
    }
    const requestEpoch = call.request.masterEpoch as number;
    const currentEpoch = this.leaderElection.epoch;
    if (requestEpoch > 0 && requestEpoch > currentEpoch) {
      callback(null, { accepted: false, rejectReason: 'STALE_MASTER' });
      return;
    }
    if (this.masterCoordinator.isRebuildingTable()) {
      callback(null, { accepted: false, rejectReason: 'MASTER_REBUILDING' });
      return;
    }
    if (this.maxConcurrentPetitions > 0 && this.activePetitions >= this.maxConcurrentPetitions) {
      callback(null, { accepted: false, rejectReason: 'RESOURCE_EXHAUSTED' });
      return;
    }

    this.activePetitions++;
    try {
      const entityKey = call.request.entityKey as string;
      const envelope = call.request.message as Record<string, unknown>;
      const message = this.deserializeEnvelope(envelope);

      await this.router.dispatchAsMaster(entityKey, message);

      const resolution = this.masterCoordinator.resolve(entityKey);
      const assignedReplicaAddr = await this.getReplicaAddress(resolution.replicaId);
      callback(null, {
        accepted: true,
        rejectReason: '',
        assignedReplicaId: resolution.replicaId,
        assignedReplicaAddr,
      });
    } catch (err) {
      callback(null, { accepted: false, rejectReason: (err as Error).message });
    } finally {
      this.activePetitions--;
    }
  }

  private async handlePetitionAndWait(call: GrpcServerStreamingCall): Promise<void> {
    if (!this.masterCoordinator.isMaster()) {
      call.write({ correlationId: '', error: 'NOT_MASTER' });
      call.end();
      return;
    }
    const requestEpoch = call.request.masterEpoch as number;
    const currentEpoch = this.leaderElection.epoch;
    if (requestEpoch > 0 && requestEpoch > currentEpoch) {
      call.write({ correlationId: '', error: 'STALE_MASTER' });
      call.end();
      return;
    }
    if (this.masterCoordinator.isRebuildingTable()) {
      call.write({ correlationId: '', error: 'MASTER_REBUILDING' });
      call.end();
      return;
    }
    if (this.maxConcurrentPetitions > 0 && this.activePetitions >= this.maxConcurrentPetitions) {
      call.write({ correlationId: '', error: 'RESOURCE_EXHAUSTED' });
      call.end();
      return;
    }

    this.activePetitions++;
    let cancelled = false;
    const cancelPromise = new Promise<never>((_, reject) => {
      call.on('cancelled', () => {
        cancelled = true;
        reject(new Error('Stream cancelled by client'));
      });
    });

    try {
      const entityKey = call.request.entityKey as string;
      const envelope = call.request.message as Record<string, unknown>;
      const message = this.deserializeEnvelope(envelope);

      const result = await Promise.race([
        this.router.dispatchAsMasterAndWait(entityKey, message, this.resolveAndWaitTimeout(message.entityType)),
        cancelPromise,
      ]);

      if (!cancelled) {
        call.write({
          correlationId: message.correlationId ?? '',
          result: Buffer.from(JSON.stringify(result), 'utf-8'),
        });
        call.end();
      }
    } catch (err) {
      if (!cancelled) {
        call.write({ correlationId: '', error: (err as Error).message });
        call.end();
      }
    } finally {
      this.activePetitions--;
    }
  }

  private handleReportIdle(call: GrpcUnaryCall, callback: GrpcCallback): void {
    const entityKey = call.request.entityKey as string;
    this.masterCoordinator.release(entityKey);
    callback(null, { shouldTeardown: true });
  }

  private handleReportWorkers(call: GrpcUnaryCall, callback: GrpcCallback): void {
    const replicaId = call.request.replicaId as string;
    const entityKeys = call.request.entityKeys as string[];
    const epoch = call.request.epoch as number;

    const accepted = this.masterCoordinator.acceptWorkerReport(replicaId, entityKeys, epoch);
    callback(null, { accepted, rejectReason: accepted ? '' : 'EPOCH_MISMATCH_OR_NOT_MASTER' });
  }

  // =========================================================================
  // Master → Master: cross-service
  // =========================================================================

  private async handleForward(call: GrpcUnaryCall, callback: GrpcCallback): Promise<void> {
    try {
      const envelope = call.request;
      const senderEpoch = envelope.senderEpoch as number;
      if (senderEpoch > 0) {
        this.logger.debug(`Forward from origin=${envelope.originServer} epoch=${senderEpoch}`);
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
      callback(null, { accepted: false, rejectReason: (err as Error).message });
    }
  }

  private async handleForwardAndWait(call: GrpcServerStreamingCall): Promise<void> {
    let cancelled = false;
    const cancelPromise = new Promise<never>((_, reject) => {
      call.on('cancelled', () => {
        cancelled = true;
        reject(new Error('Stream cancelled by client'));
      });
    });

    try {
      const envelope = call.request;
      const senderEpoch = envelope.senderEpoch as number;
      if (senderEpoch > 0) {
        this.logger.debug(`ForwardAndWait from origin=${envelope.originServer} epoch=${senderEpoch}`);
      }
      const data = JSON.parse(Buffer.from(envelope.payload as Buffer).toString('utf-8'));

      const result = await Promise.race([
        this.router.enqueueAndWait(
          envelope.entityType as string,
          envelope.name as string,
          envelope.entityId as string,
          data,
          this.resolveAndWaitTimeout(envelope.entityType as string),
          { maxAttempts: envelope.maxAttempts as number },
        ),
        cancelPromise,
      ]);

      if (!cancelled) {
        call.write({
          correlationId: envelope.correlationId as string,
          result: Buffer.from(JSON.stringify(result), 'utf-8'),
        });
        call.end();
      }
    } catch (err) {
      if (!cancelled) {
        call.write({
          correlationId: call.request.correlationId as string,
          error: (err as Error).message,
        });
        call.end();
      }
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

  private resolveAndWaitTimeout(entityType?: string): number {
    if (entityType) {
      const entityConfig = this.config.entities?.[entityType];
      if (entityConfig?.replyTimeout) return entityConfig.replyTimeout;
    }
    return this.config.grpc?.deadlines?.andWaitMs ?? 60000;
  }

  private async getReplicaAddress(replicaId: string): Promise<string> {
    const localId = this.config.grpc?.serverId ?? 'local';
    if (replicaId === localId) {
      return this.config.grpc?.advertisedAddress ?? this.config.grpc?.listenAddress ?? '';
    }
    if (!this.clusterDiscovery) return '';
    if (this.nodeAddressCache && Date.now() < this.nodeAddressCache.expiresAt) {
      return this.nodeAddressCache.map.get(replicaId) ?? '';
    }
    const nodes = await this.clusterDiscovery.getNodes();
    const map = new Map<string, string>();
    for (const node of nodes) {
      map.set(node.serverId, node.grpcAddress);
    }
    this.nodeAddressCache = { map, expiresAt: Date.now() + 2000 };
    return map.get(replicaId) ?? '';
  }

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
