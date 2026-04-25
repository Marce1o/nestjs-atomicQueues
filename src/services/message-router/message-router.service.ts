import { Injectable, Logger, Inject, Optional, forwardRef } from '@nestjs/common';
import { IAtomicQueuesModuleConfig, ISerializedMessage, IMessageRef } from '../../domain';
import { fastId, retry } from '../../utils';
import { EntityWorkerManager } from '../../workers';
import {
  MasterCoordinator,
  ClusterDiscoveryService,
  ClusterNode,
  LeaderElectionService,
} from '../../cluster';
import { GrpcClientPool } from '../../grpc';
import { ATOMIC_QUEUES_CONFIG } from '../constants';

@Injectable()
export class MessageRouter {
  private readonly logger = new Logger(MessageRouter.name);
  private readonly isClusterMode: boolean;

  private nodeCache: { nodes: ClusterNode[]; expiresAt: number } | null = null;
  private masterCache: { address: string | null; expiresAt: number } | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly workerManager: EntityWorkerManager,
    @Inject(forwardRef(() => MasterCoordinator))
    private readonly masterCoordinator: MasterCoordinator,
    @Optional() private readonly grpcClientPool?: GrpcClientPool,
    @Optional() private readonly clusterDiscovery?: ClusterDiscoveryService,
    @Optional() private readonly leaderElection?: LeaderElectionService,
  ) {
    this.isClusterMode = config.grpc?.enabled ?? false;
  }

  invalidateTopologyCache(): void {
    this.nodeCache = null;
    this.masterCache = null;
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
    if (!this.masterCoordinator.isMaster()) {
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
    if (!this.masterCoordinator.isMaster()) {
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
        const deadline = new Date(Date.now() + 1500);
        await new Promise<void>((resolve, reject) => {
          (client as unknown as Record<string, Function>).petition(
            { entityKey, message: this.serializeEnvelope(message) },
            { deadline },
            (err: Error | null, response: Record<string, unknown>) => {
              if (err) return reject(err);
              if (!response.accepted) return reject(new Error(response.rejectReason as string));
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
    const replicaAddress = await this.getReplicaAddress(replicaId);
    if (!replicaAddress) {
      this.masterCoordinator.release(entityKey);
      this.nodeCache = null;
      await this.dispatchAsMaster(entityKey, message);
      return;
    }

    try {
      const client = await this.grpcClientPool!.getClient(replicaId, replicaAddress);
      const deadline = new Date(Date.now() + 1500);
      await new Promise<void>((resolve, reject) => {
        (client as unknown as Record<string, Function>).enqueueToWorker(
          { entityKey, message: this.serializeEnvelope(message) },
          { deadline },
          (err: Error | null, response: Record<string, unknown>) => {
            if (err) return reject(err);
            if (!response.accepted) return reject(new Error(response.rejectReason as string));
            resolve();
          },
        );
      });
    } catch (err) {
      this.logger.warn(
        `Forward to ${replicaId} failed: ${(err as Error).message} — reassigning`,
      );
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
    const replicaAddress = await this.getReplicaAddress(replicaId);
    if (!replicaAddress) {
      this.masterCoordinator.release(entityKey);
      this.nodeCache = null;
      return this.dispatchAsMasterAndWait<R>(entityKey, message, timeout);
    }

    try {
      const client = await this.grpcClientPool!.getClient(replicaId, replicaAddress);
      return await new Promise<R>((resolve, reject) => {
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
    } catch (err) {
      this.logger.warn(
        `ForwardAndWait to ${replicaId} failed: ${(err as Error).message} — reassigning`,
      );
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
      this.logger.warn(
        `No service group found for foreign entity type '${message.entityType}' — dropping`,
      );
      return;
    }

    const foreignAddress = await this.leaderElection?.getForeignMasterAddress(serviceGroup);
    if (!foreignAddress) {
      this.logger.warn(
        `Foreign master for group '${serviceGroup}' not found — dropping`,
      );
      return;
    }

    const serverId = this.config.grpc?.serverId ?? 'local';
    await this.grpcClientPool!.forward(
      `${serviceGroup}-master`,
      foreignAddress,
      message,
      serverId,
      0,
    );
  }

  private async forwardToForeignServiceAndWait<R>(
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    const serviceGroup = await this.clusterDiscovery?.resolveServiceGroup(message.entityType);
    if (!serviceGroup) {
      throw new Error(
        `No service group found for foreign entity type '${message.entityType}'`,
      );
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
    );
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
    };
  }

  private resolveTimeout(entityType: string, explicit?: number): number {
    if (explicit !== undefined) return explicit;
    const entityConfig = this.config.entities?.[entityType];
    if (entityConfig?.replyTimeout) return entityConfig.replyTimeout;
    return 60000;
  }
}
