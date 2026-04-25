import { Injectable, Logger, Inject, Optional, forwardRef } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig, ISerializedMessage, IMessageRef } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { WalService } from '../../wal';
import { EntityWorkerManager } from '../../workers';
import { MasterCoordinator, ClusterDiscoveryService, LeaderElectionService } from '../../cluster';
import { GrpcClientPool } from '../../grpc';
import { ATOMIC_QUEUES_CONFIG } from '../constants';

/**
 * MessageRouter — central dispatch layer.
 *
 * Single-server: dispatches directly to local EntityWorkerManager.
 * Cluster mode:
 *   - Non-master replicas → gRPC Petition to master
 *   - Master → resolve entity→replica, dispatch locally or gRPC EnqueueToWorker
 */
@Injectable()
export class MessageRouter {
  private readonly logger = new Logger(MessageRouter.name);
  private readonly keyPrefix: string;
  private readonly isClusterMode: boolean;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly walService: WalService,
    private readonly workerManager: EntityWorkerManager,
    @Inject(forwardRef(() => MasterCoordinator))
    private readonly masterCoordinator: MasterCoordinator,
    @Optional() private readonly grpcClientPool?: GrpcClientPool,
    @Optional() private readonly clusterDiscovery?: ClusterDiscoveryService,
    @Optional() private readonly leaderElection?: LeaderElectionService,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
    this.isClusterMode = config.grpc?.enabled ?? false;
  }

  async enqueue(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
    options?: { correlationId?: string; isQuery?: boolean; maxAttempts?: number },
  ): Promise<IMessageRef> {
    const entityKey = `${entityType}:${entityId}`;
    const retryConfig = this.config.entities?.[entityType]?.retry ?? this.config.retry;

    const message: ISerializedMessage = {
      id: uuidv4(),
      name: messageName,
      data,
      entityType,
      entityId,
      isQuery: options?.isQuery,
      correlationId: options?.correlationId,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? retryConfig?.maxAttempts ?? 1,
    };

    // WAL write for durability (all paths)
    await this.walService.write(entityKey, message);

    // Cluster mode: route through master topology
    if (this.isClusterMode) {
      await this.clusterDispatch(entityKey, message);
    } else {
      // Single-server: direct local dispatch
      this.workerManager.enqueue(entityKey, message);
    }

    return { id: message.id, entityKey };
  }

  async enqueueAndWait<R = unknown>(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
    timeout?: number,
    options?: { maxAttempts?: number },
  ): Promise<R> {
    const entityKey = `${entityType}:${entityId}`;
    const retryConfig = this.config.entities?.[entityType]?.retry ?? this.config.retry;
    const resolvedTimeout = this.resolveTimeout(entityType, timeout);

    const message: ISerializedMessage = {
      id: uuidv4(),
      name: messageName,
      data,
      entityType,
      entityId,
      isQuery: true,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? retryConfig?.maxAttempts ?? 1,
    };

    await this.walService.write(entityKey, message);

    if (this.isClusterMode) {
      return this.clusterDispatchAndWait<R>(entityKey, message, resolvedTimeout);
    }

    return this.workerManager.enqueueAndWait<R>(entityKey, message, resolvedTimeout);
  }

  // =========================================================================
  // CLUSTER DISPATCH
  // =========================================================================

  private async clusterDispatch(entityKey: string, message: ISerializedMessage): Promise<void> {
    if (!this.masterCoordinator.isMaster()) {
      // Not master → petition the master
      await this.petitionMaster(entityKey, message);
      return;
    }

    // We ARE the master → resolve and dispatch
    const resolution = this.masterCoordinator.resolve(entityKey);

    if (resolution.isLocal) {
      this.workerManager.enqueue(entityKey, message);
    } else {
      await this.forwardToReplica(resolution.replicaId, entityKey, message);
    }
  }

  private async clusterDispatchAndWait<R>(
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    if (!this.masterCoordinator.isMaster()) {
      return this.petitionMasterAndWait<R>(entityKey, message, timeout);
    }

    const resolution = this.masterCoordinator.resolve(entityKey);

    if (resolution.isLocal) {
      return this.workerManager.enqueueAndWait<R>(entityKey, message, timeout);
    }

    return this.forwardToReplicaAndWait<R>(resolution.replicaId, entityKey, message, timeout);
  }

  // =========================================================================
  // gRPC — Replica → Master (Petition)
  // =========================================================================

  private async petitionMaster(entityKey: string, message: ISerializedMessage): Promise<void> {
    const masterAddress = await this.getMasterAddress();
    if (!masterAddress) {
      this.logger.warn('No master found — processing locally as fallback');
      this.workerManager.enqueue(entityKey, message);
      return;
    }

    const client = await this.grpcClientPool!.getClient('master', masterAddress);
    await new Promise<void>((resolve, reject) => {
      (client as unknown as Record<string, Function>).petition(
        {
          entityKey,
          message: this.serializeEnvelope(message),
        },
        (err: Error | null, response: Record<string, unknown>) => {
          if (err) return reject(err);
          if (!response.accepted) return reject(new Error(response.rejectReason as string));
          resolve();
        },
      );
    });
  }

  private async petitionMasterAndWait<R>(
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    const masterAddress = await this.getMasterAddress();
    if (!masterAddress) {
      this.logger.warn('No master found — processing locally as fallback');
      return this.workerManager.enqueueAndWait<R>(entityKey, message, timeout);
    }

    const client = await this.grpcClientPool!.getClient('master', masterAddress);
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Petition timeout after ${timeout}ms`)),
        timeout,
      );

      const stream = (client as unknown as Record<string, Function>).petitionAndWait({
        entityKey,
        message: this.serializeEnvelope(message),
      });

      stream.on('data', (response: Record<string, unknown>) => {
        clearTimeout(timer);
        if (response.error) reject(new Error(response.error as string));
        else if (response.result) {
          resolve(JSON.parse(Buffer.from(response.result as Buffer).toString()) as R);
        }
      });

      stream.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // =========================================================================
  // gRPC — Master → Replica (EnqueueToWorker)
  // =========================================================================

  private async forwardToReplica(
    replicaId: string,
    entityKey: string,
    message: ISerializedMessage,
  ): Promise<void> {
    const replicaAddress = await this.getReplicaAddress(replicaId);
    if (!replicaAddress) {
      this.logger.warn(`Replica ${replicaId} not found — processing locally`);
      this.workerManager.enqueue(entityKey, message);
      return;
    }

    const client = await this.grpcClientPool!.getClient(replicaId, replicaAddress);
    await new Promise<void>((resolve, reject) => {
      (client as unknown as Record<string, Function>).enqueueToWorker(
        {
          entityKey,
          message: this.serializeEnvelope(message),
        },
        (err: Error | null, response: Record<string, unknown>) => {
          if (err) return reject(err);
          if (!response.accepted) return reject(new Error(response.rejectReason as string));
          resolve();
        },
      );
    });
  }

  private async forwardToReplicaAndWait<R>(
    replicaId: string,
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    const replicaAddress = await this.getReplicaAddress(replicaId);
    if (!replicaAddress) {
      return this.workerManager.enqueueAndWait<R>(entityKey, message, timeout);
    }

    const client = await this.grpcClientPool!.getClient(replicaId, replicaAddress);
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Forward timeout after ${timeout}ms`)),
        timeout,
      );

      const stream = (client as unknown as Record<string, Function>).enqueueToWorkerAndWait({
        entityKey,
        message: this.serializeEnvelope(message),
      });

      stream.on('data', (response: Record<string, unknown>) => {
        clearTimeout(timer);
        if (response.error) reject(new Error(response.error as string));
        else if (response.result) {
          resolve(JSON.parse(Buffer.from(response.result as Buffer).toString()) as R);
        }
      });

      stream.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // =========================================================================
  // HELPERS
  // =========================================================================

  private async getMasterAddress(): Promise<string | null> {
    if (!this.leaderElection) return null;
    return this.leaderElection.getMasterAddress();
  }

  private async getReplicaAddress(replicaId: string): Promise<string | null> {
    if (!this.clusterDiscovery) return null;
    const nodes = await this.clusterDiscovery.getNodes();
    const node = nodes.find((n) => n.serverId === replicaId);
    return node?.grpcAddress ?? null;
  }

  private serializeEnvelope(message: ISerializedMessage): Record<string, unknown> {
    return {
      id: message.id,
      name: message.name,
      payload: Buffer.from(JSON.stringify(message.data)),
      entityType: message.entityType,
      entityId: message.entityId,
      correlationId: message.correlationId ?? '',
      isQuery: message.isQuery ?? false,
      enqueuedAt: message.enqueuedAt,
      attempts: message.attempts,
      maxAttempts: message.maxAttempts,
      originServer: this.config.grpc?.serverId ?? 'local',
      hops: 0,
    };
  }

  private resolveTimeout(entityType: string, explicit?: number): number {
    if (explicit !== undefined) return explicit;
    const entityConfig = this.config.entities?.[entityType];
    if (entityConfig?.replyTimeout) return entityConfig.replyTimeout;
    return 60000;
  }
}
