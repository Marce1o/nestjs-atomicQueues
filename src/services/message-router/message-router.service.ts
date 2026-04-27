import { Injectable, Logger, Inject, Optional, forwardRef, OnModuleInit } from '@nestjs/common';
import { IAtomicQueuesModuleConfig, ISerializedMessage, IMessageRef } from '../../domain';
import { fastId, retry } from '../../utils';
import { EntityWorkerManager } from '../../workers';
import {
  MasterCoordinator,
  ClusterDiscoveryService,
  ClusterNode,
  LeaderElectionService,
} from '../../cluster';
import { GrpcPeerMonitor } from '../../cluster/grpc-peer-monitor.service';
import { RedisHealthMonitor } from '../../cluster/redis-health-monitor.service';
import { GrpcClientPool } from '../../grpc';
import { ATOMIC_QUEUES_CONFIG } from '../constants';

@Injectable()
export class MessageRouter implements OnModuleInit {
  private readonly logger = new Logger(MessageRouter.name);
  private readonly isClusterMode: boolean;

  private nodeCache: { nodes: ClusterNode[]; expiresAt: number } | null = null;
  private masterCache: { address: string | null; expiresAt: number } | null = null;
  private readonly assignmentCache = new Map<
    string,
    { replicaId: string; replicaAddress: string; epoch: number; cachedAt: number }
  >();
  private unsubscribePeerMonitor: (() => void) | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly workerManager: EntityWorkerManager,
    @Inject(forwardRef(() => MasterCoordinator))
    private readonly masterCoordinator: MasterCoordinator,
    @Optional() private readonly grpcClientPool?: GrpcClientPool,
    @Optional() private readonly clusterDiscovery?: ClusterDiscoveryService,
    @Optional() private readonly leaderElection?: LeaderElectionService,
    @Optional() private readonly peerMonitor?: GrpcPeerMonitor,
    @Optional() private readonly redisHealthMonitor?: RedisHealthMonitor,
  ) {
    this.isClusterMode = config.grpc?.enabled ?? false;
  }

  async onModuleInit(): Promise<void> {
    if (this.peerMonitor) {
      this.unsubscribePeerMonitor = this.peerMonitor.onPeerStateChange((serverId, state) => {
        if (state === 'suspected-dead') {
          this.invalidateTopologyCache();
          this.grpcClientPool?.openCircuit(serverId);
        } else if (state === 'alive') {
          this.grpcClientPool?.closeCircuit(serverId);
        }
      });
    }
  }

  invalidateTopologyCache(): void {
    this.nodeCache = null;
    this.masterCache = null;
    this.assignmentCache.clear();
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
      id: fastId(),
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

    if (this.isClusterMode) {
      await this.clusterDispatch(entityKey, message);
    } else {
      await this.workerManager.enqueue(entityKey, message);
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
      id: fastId(),
      name: messageName,
      data,
      entityType,
      entityId,
      isQuery: true,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? retryConfig?.maxAttempts ?? 1,
    };

    if (this.isClusterMode) {
      return this.clusterDispatchAndWait<R>(entityKey, message, resolvedTimeout);
    }

    return this.workerManager.enqueueAndWait<R>(entityKey, message, resolvedTimeout);
  }

  // =========================================================================
  // CLUSTER DISPATCH
  // =========================================================================

  private async clusterDispatch(entityKey: string, message: ISerializedMessage): Promise<void> {
    if (this.redisHealthMonitor?.isDegraded) {
      throw new Error('Cluster degraded: Redis unreachable');
    }

    if (!this.masterCoordinator.isMaster()) {
      const cached = this.getAssignmentFromCache(entityKey);
      if (cached) {
        try {
          await this.dispatchViaCachedAssignment(entityKey, message, cached);
          return;
        } catch {
          this.assignmentCache.delete(entityKey);
        }
      }
      await this.petitionMaster(entityKey, message);
      return;
    }

    await this.dispatchAsMaster(entityKey, message);
  }

  private async clusterDispatchAndWait<R>(
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    if (this.redisHealthMonitor?.isDegraded) {
      throw new Error('Cluster degraded: Redis unreachable');
    }

    if (!this.masterCoordinator.isMaster()) {
      const cached = this.getAssignmentFromCache(entityKey);
      if (cached) {
        try {
          return await this.dispatchViaCachedAssignmentAndWait<R>(
            entityKey,
            message,
            timeout,
            cached,
          );
        } catch {
          this.assignmentCache.delete(entityKey);
        }
      }
      return this.petitionMasterAndWait<R>(entityKey, message, timeout);
    }

    return this.dispatchAsMasterAndWait<R>(entityKey, message, timeout);
  }

  // =========================================================================
  // MASTER DISPATCH
  // =========================================================================

  async dispatchAsMaster(entityKey: string, message: ISerializedMessage): Promise<void> {
    if (!this.isLocalEntityType(message.entityType)) {
      await this.forwardToForeignService(message);
      return;
    }

    const resolution = this.masterCoordinator.resolve(entityKey);
    if (resolution.isLocal) {
      await this.workerManager.enqueue(entityKey, message);
    } else {
      await this.forwardToReplica(resolution.replicaId, entityKey, message);
    }
  }

  async dispatchAsMasterAndWait<R>(
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    if (!this.isLocalEntityType(message.entityType)) {
      return this.forwardToForeignServiceAndWait<R>(message, timeout);
    }

    const resolution = this.masterCoordinator.resolve(entityKey);
    if (resolution.isLocal) {
      return this.workerManager.enqueueAndWait<R>(entityKey, message, timeout);
    }
    return this.forwardToReplicaAndWait<R>(resolution.replicaId, entityKey, message, timeout);
  }

  private isLocalEntityType(entityType: string): boolean {
    return entityType in (this.config.entities ?? {});
  }

  // =========================================================================
  // gRPC — Replica → Master (Petition) — NO FALLBACK-TO-LOCAL
  // =========================================================================

  private async petitionMaster(entityKey: string, message: ISerializedMessage): Promise<void> {
    await retry(
      async () => {
        if (this.masterCoordinator.isMaster()) {
          await this.dispatchAsMaster(entityKey, message);
          return;
        }

        const masterAddress = await this.getMasterAddress();
        if (!masterAddress) {
          throw new Error('No master available');
        }

        this.masterCache = null;
        const client = await this.grpcClientPool!.getClient('master', masterAddress);
        const deadline = new Date(Date.now() + (this.config.grpc?.deadlines?.forwardMs ?? 1500));
        await new Promise<void>((resolve, reject) => {
          (client as unknown as Record<string, Function>).petition(
            {
              entityKey,
              message: this.serializeEnvelope(message),
              masterEpoch: this.leaderElection?.epoch ?? 0,
            },
            { deadline },
            (err: Error | null, response: Record<string, unknown>) => {
              if (err) return reject(err);
              if (!response.accepted) return reject(new Error(response.rejectReason as string));
              const assignedReplicaId = response.assignedReplicaId as string;
              if (assignedReplicaId) {
                this.assignmentCache.set(entityKey, {
                  replicaId: assignedReplicaId,
                  replicaAddress: (response.assignedReplicaAddr as string) ?? '',
                  epoch: this.leaderElection?.epoch ?? 0,
                  cachedAt: Date.now(),
                });
              }
              resolve();
            },
          );
        });
      },
      {
        maxAttempts: 3,
        baseDelay: 50,
        exponential: true,
        onRetry: (attempt) => {
          this.masterCache = null;
          this.logger.warn(`Petition retry ${attempt} for ${entityKey}`);
        },
      },
    );
  }

  private async petitionMasterAndWait<R>(
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    return retry(
      async () => {
        if (this.masterCoordinator.isMaster()) {
          return this.dispatchAsMasterAndWait<R>(entityKey, message, timeout);
        }

        const masterAddress = await this.getMasterAddress();
        if (!masterAddress) {
          throw new Error('No master available');
        }

        this.masterCache = null;
        const client = await this.grpcClientPool!.getClient('master', masterAddress);
        return new Promise<R>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Petition timeout after ${timeout}ms`)),
            timeout,
          );

          const stream = (client as unknown as Record<string, Function>).petitionAndWait({
            entityKey,
            message: this.serializeEnvelope(message),
            masterEpoch: this.leaderElection?.epoch ?? 0,
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
      },
      {
        maxAttempts: 3,
        baseDelay: 50,
        exponential: true,
        onRetry: (attempt) => {
          this.masterCache = null;
          this.logger.warn(`PetitionAndWait retry ${attempt} for ${entityKey}`);
        },
      },
    );
  }

  // =========================================================================
  // gRPC — Master → Replica (EnqueueToWorker) — REASSIGN ON FAILURE
  // =========================================================================

  private async forwardToReplica(
    replicaId: string,
    entityKey: string,
    message: ISerializedMessage,
  ): Promise<void> {
    // Skip gRPC call if peer is already suspected dead
    if (this.peerMonitor?.getPeerState(replicaId) === 'suspected-dead') {
      this.masterCoordinator.release(entityKey);
      this.nodeCache = null;
      await this.dispatchAsMaster(entityKey, message);
      return;
    }

    const replicaAddress = await this.getReplicaAddress(replicaId);
    if (!replicaAddress) {
      this.masterCoordinator.release(entityKey);
      this.nodeCache = null;
      await this.dispatchAsMaster(entityKey, message);
      return;
    }

    try {
      const client = await this.grpcClientPool!.getClient(replicaId, replicaAddress);
      const deadline = new Date(Date.now() + (this.config.grpc?.deadlines?.forwardMs ?? 1500));
      await new Promise<void>((resolve, reject) => {
        (client as unknown as Record<string, Function>).enqueueToWorker(
          {
            entityKey,
            message: this.serializeEnvelope(message),
            masterEpoch: this.leaderElection?.epoch ?? 0,
          },
          { deadline },
          (err: Error | null, response: Record<string, unknown>) => {
            if (err) return reject(err);
            if (!response.accepted) return reject(new Error(response.rejectReason as string));
            resolve();
          },
        );
      });
      this.grpcClientPool!.recordSuccess(replicaId);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== 'PEER_CIRCUIT_OPEN') {
        this.logger.warn(`Forward to ${replicaId} failed: ${msg} — reassigning`);
        this.grpcClientPool!.recordFailure(replicaId);
      }
      this.masterCoordinator.release(entityKey);
      this.grpcClientPool!.removeClient(replicaId);
      this.nodeCache = null;
      await this.dispatchAsMaster(entityKey, message);
    }
  }

  private async forwardToReplicaAndWait<R>(
    replicaId: string,
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    if (this.peerMonitor?.getPeerState(replicaId) === 'suspected-dead') {
      this.masterCoordinator.release(entityKey);
      this.nodeCache = null;
      return this.dispatchAsMasterAndWait<R>(entityKey, message, timeout);
    }

    const replicaAddress = await this.getReplicaAddress(replicaId);
    if (!replicaAddress) {
      this.masterCoordinator.release(entityKey);
      this.nodeCache = null;
      return this.dispatchAsMasterAndWait<R>(entityKey, message, timeout);
    }

    try {
      const client = await this.grpcClientPool!.getClient(replicaId, replicaAddress);
      const result = await new Promise<R>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Forward timeout after ${timeout}ms`)),
          timeout,
        );

        const stream = (client as unknown as Record<string, Function>).enqueueToWorkerAndWait({
          entityKey,
          message: this.serializeEnvelope(message),
          masterEpoch: this.leaderElection?.epoch ?? 0,
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
      this.grpcClientPool!.recordSuccess(replicaId);
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== 'PEER_CIRCUIT_OPEN') {
        this.logger.warn(`ForwardAndWait to ${replicaId} failed: ${msg} — reassigning`);
        this.grpcClientPool!.recordFailure(replicaId);
      }
      this.masterCoordinator.release(entityKey);
      this.grpcClientPool!.removeClient(replicaId);
      this.nodeCache = null;
      return this.dispatchAsMasterAndWait<R>(entityKey, message, timeout);
    }
  }

  // =========================================================================
  // gRPC — Master → Foreign Master (Cross-Service)
  // =========================================================================

  private async forwardToForeignService(message: ISerializedMessage): Promise<void> {
    const serviceGroup = await this.clusterDiscovery?.resolveServiceGroup(message.entityType);
    if (!serviceGroup) {
      throw new Error(`No service group found for foreign entity type '${message.entityType}'`);
    }

    const foreignAddress = await this.leaderElection?.getForeignMasterAddress(serviceGroup);
    if (!foreignAddress) {
      throw new Error(
        `Foreign master for group '${serviceGroup}' not found for entity type '${message.entityType}'`,
      );
    }

    const serverId = this.config.grpc?.serverId ?? 'local';
    await this.grpcClientPool!.forward(
      `${serviceGroup}-master`,
      foreignAddress,
      message,
      serverId,
      0,
      this.leaderElection?.epoch ?? 0,
    );
  }

  private async forwardToForeignServiceAndWait<R>(
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    const serviceGroup = await this.clusterDiscovery?.resolveServiceGroup(message.entityType);
    if (!serviceGroup) {
      throw new Error(`No service group found for foreign entity type '${message.entityType}'`);
    }

    const foreignAddress = await this.leaderElection?.getForeignMasterAddress(serviceGroup);
    if (!foreignAddress) {
      throw new Error(`Foreign master for group '${serviceGroup}' not found`);
    }

    const serverId = this.config.grpc?.serverId ?? 'local';
    return this.grpcClientPool!.forwardAndWait<R>(
      `${serviceGroup}-master`,
      foreignAddress,
      message,
      serverId,
      0,
      timeout,
      this.leaderElection?.epoch ?? 0,
    );
  }

  // =========================================================================
  // HELPERS — cached assignment routing (bypass master on repeat dispatch)
  // =========================================================================

  private getAssignmentFromCache(
    entityKey: string,
  ): { replicaId: string; replicaAddress: string; epoch: number } | null {
    const entry = this.assignmentCache.get(entityKey);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > 5000) {
      this.assignmentCache.delete(entityKey);
      return null;
    }
    return entry;
  }

  private async dispatchViaCachedAssignment(
    entityKey: string,
    message: ISerializedMessage,
    cached: { replicaId: string; replicaAddress: string; epoch: number },
  ): Promise<void> {
    const localServerId = this.config.grpc?.serverId ?? 'local';
    if (cached.replicaId === localServerId) {
      await this.workerManager.enqueue(entityKey, message);
      return;
    }
    const client = await this.grpcClientPool!.getClient(cached.replicaId, cached.replicaAddress);
    const deadline = new Date(Date.now() + (this.config.grpc?.deadlines?.forwardMs ?? 1500));
    await new Promise<void>((resolve, reject) => {
      (client as unknown as Record<string, Function>).enqueueToWorker(
        {
          entityKey,
          message: this.serializeEnvelope(message),
          masterEpoch: cached.epoch,
        },
        { deadline },
        (err: Error | null, response: Record<string, unknown>) => {
          if (err) return reject(err);
          if (!response.accepted) return reject(new Error(response.rejectReason as string));
          resolve();
        },
      );
    });
  }

  private async dispatchViaCachedAssignmentAndWait<R>(
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
    cached: { replicaId: string; replicaAddress: string; epoch: number },
  ): Promise<R> {
    const localServerId = this.config.grpc?.serverId ?? 'local';
    if (cached.replicaId === localServerId) {
      return this.workerManager.enqueueAndWait<R>(entityKey, message, timeout);
    }
    const client = await this.grpcClientPool!.getClient(cached.replicaId, cached.replicaAddress);
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Cached forward timeout after ${timeout}ms`)),
        timeout,
      );
      const stream = (client as unknown as Record<string, Function>).enqueueToWorkerAndWait({
        entityKey,
        message: this.serializeEnvelope(message),
        masterEpoch: cached.epoch,
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
  // HELPERS — cached topology lookups
  // =========================================================================

  private async getMasterAddress(): Promise<string | null> {
    if (!this.leaderElection) return null;
    if (this.masterCache && Date.now() < this.masterCache.expiresAt) {
      return this.masterCache.address;
    }
    const address = await this.leaderElection.getMasterAddress();
    this.masterCache = { address, expiresAt: Date.now() + 1000 };
    return address;
  }

  private async getReplicaAddress(replicaId: string): Promise<string | null> {
    if (!this.clusterDiscovery) return null;
    let nodes: ClusterNode[];
    if (this.nodeCache && Date.now() < this.nodeCache.expiresAt) {
      nodes = this.nodeCache.nodes;
    } else {
      nodes = await this.clusterDiscovery.getNodes();
      this.nodeCache = { nodes, expiresAt: Date.now() + 1000 };
    }
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
      senderEpoch: this.leaderElection?.epoch ?? 0,
    };
  }

  private resolveTimeout(entityType: string, explicit?: number): number {
    if (explicit !== undefined) return explicit;
    const entityConfig = this.config.entities?.[entityType];
    if (entityConfig?.replyTimeout) return entityConfig.replyTimeout;
    return 60000;
  }
}
