import { Injectable, Logger, Inject, Optional, OnModuleInit } from '@nestjs/common';
import { IAtomicQueuesModuleConfig } from '../domain';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';
import { GrpcClientPool } from '../grpc';
import { LeaderElectionService } from './leader-election.service';
import { ClusterDiscoveryService, ClusterNode } from './cluster-discovery.service';
import { ServerRingService } from './server-ring.service';

export interface WorkerAssignment {
  replicaId: string;
  assignedAt: number;
  lastActiveAt: number;
}

@Injectable()
export class MasterCoordinator implements OnModuleInit {
  private readonly logger = new Logger(MasterCoordinator.name);

  private readonly assignments = new Map<string, WorkerAssignment>();
  private readonly replicaLoad = new Map<string, number>();

  private readonly localReplicaId: string;
  private readonly isClusterMode: boolean;
  private readonly serviceGroup: string;
  private rebuilding = false;
  private workerListProvider: (() => Promise<string[]>) | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly leaderElection: LeaderElectionService,
    private readonly clusterDiscovery: ClusterDiscoveryService,
    private readonly serverRing: ServerRingService,
    @Optional() private readonly grpcClientPool?: GrpcClientPool,
  ) {
    this.localReplicaId = config.grpc?.serverId ?? 'local';
    this.isClusterMode = config.grpc?.enabled ?? false;
    this.serviceGroup = config.grpc?.serviceGroup ?? 'default';
  }

  async onModuleInit(): Promise<void> {
    if (!this.isClusterMode) {
      this.replicaLoad.set(this.localReplicaId, 0);
      this.logger.log('MasterCoordinator running in single-server mode');
      return;
    }

    this.leaderElection.onLeaderChange((isLeader) => {
      if (isLeader) {
        this.logger.log('This replica is now the master — rebuilding assignment table');
        this.rebuildAssignmentTable();
      } else {
        this.logger.log('This replica lost master role — clearing assignment table');
        this.assignments.clear();
        this.replicaLoad.clear();
        this.pushWorkersToMaster();
      }
    });

    this.clusterDiscovery.onRingChange((nodes) => {
      if (this.isMaster()) {
        this.reconcileReplicas(nodes);
      }
    });
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  resolve(entityKey: string): {
    replicaId: string;
    isLocal: boolean;
    needsSpawn: boolean;
    epoch: number;
  } {
    const epoch = this.isClusterMode ? this.leaderElection.epoch : 0;

    if (this.rebuilding) {
      return { replicaId: this.localReplicaId, isLocal: true, needsSpawn: true, epoch };
    }

    if (!this.isClusterMode || !this.isMaster()) {
      const existing = this.assignments.has(entityKey);
      if (!existing) {
        this.assignWorker(entityKey, this.localReplicaId);
      }
      return { replicaId: this.localReplicaId, isLocal: true, needsSpawn: !existing, epoch };
    }

    // Tier 1: assignment table (authoritative if present)
    const assignment = this.assignments.get(entityKey);
    if (assignment) {
      assignment.lastActiveAt = Date.now();
      return {
        replicaId: assignment.replicaId,
        isLocal: assignment.replicaId === this.localReplicaId,
        needsSpawn: false,
        epoch,
      };
    }

    // Tier 2: consistent hash ring (deterministic fallback)
    let targetReplica: string;
    if (this.serverRing.size > 0) {
      const separatorIdx = entityKey.indexOf(':');
      const entityType = entityKey.substring(0, separatorIdx);
      const entityId = entityKey.substring(separatorIdx + 1);
      const owner = this.serverRing.getOwner(entityType, entityId);
      targetReplica = owner?.serverId ?? this.pickLeastLoaded();
    } else {
      targetReplica = this.pickLeastLoaded();
    }

    this.assignWorker(entityKey, targetReplica);

    return {
      replicaId: targetReplica,
      isLocal: targetReplica === this.localReplicaId,
      needsSpawn: true,
      epoch,
    };
  }

  release(entityKey: string): void {
    const assignment = this.assignments.get(entityKey);
    if (assignment) {
      this.decrementLoad(assignment.replicaId);
      this.assignments.delete(entityKey);
    }
  }

  isMaster(): boolean {
    if (!this.isClusterMode) return true;
    return this.leaderElection.getIsLeader();
  }

  isRebuildingTable(): boolean {
    return this.rebuilding;
  }

  getAssignments(): Map<string, WorkerAssignment> {
    return new Map(this.assignments);
  }

  totalAssignedWorkers(): number {
    return this.assignments.size;
  }

  getReplicaLoad(): Map<string, number> {
    return new Map(this.replicaLoad);
  }

  setWorkerListProvider(provider: () => Promise<string[]>): void {
    this.workerListProvider = provider;
  }

  acceptWorkerReport(replicaId: string, entityKeys: string[], epoch: number): boolean {
    if (!this.isMaster()) return false;
    if (epoch > 0 && epoch !== this.leaderElection.epoch) return false;

    if (!this.replicaLoad.has(replicaId)) {
      this.replicaLoad.set(replicaId, 0);
    }

    let added = 0;
    for (const entityKey of entityKeys) {
      if (!this.assignments.has(entityKey)) {
        this.assignments.set(entityKey, {
          replicaId,
          assignedAt: Date.now(),
          lastActiveAt: Date.now(),
        });
        this.incrementLoad(replicaId);
        added++;
      }
    }

    this.logger.log(
      `Accepted worker report from ${replicaId}: ${entityKeys.length} reported, ${added} new assignments`,
    );
    return true;
  }

  // =========================================================================
  // INTERNAL — assignment management
  // =========================================================================

  private assignWorker(entityKey: string, replicaId: string): void {
    this.assignments.set(entityKey, {
      replicaId,
      assignedAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    this.incrementLoad(replicaId);
    this.logger.debug(`Assigned worker ${entityKey} → ${replicaId}`);
  }

  private pickLeastLoaded(): string {
    if (this.replicaLoad.size === 0) {
      return this.localReplicaId;
    }

    let minLoad = Infinity;
    let target = this.localReplicaId;

    for (const [replicaId, load] of this.replicaLoad) {
      if (load < minLoad) {
        minLoad = load;
        target = replicaId;
      }
    }

    return target;
  }

  private incrementLoad(replicaId: string): void {
    this.replicaLoad.set(replicaId, (this.replicaLoad.get(replicaId) ?? 0) + 1);
  }

  private decrementLoad(replicaId: string): void {
    const current = this.replicaLoad.get(replicaId) ?? 0;
    this.replicaLoad.set(replicaId, Math.max(0, current - 1));
  }

  // =========================================================================
  // INTERNAL — cluster operations
  // =========================================================================

  private async rebuildAssignmentTable(): Promise<void> {
    this.rebuilding = true;
    this.replicaLoad.clear();

    const allNodes = this.isClusterMode ? await this.clusterDiscovery.getNodes() : [];
    const nodes = allNodes.filter((n) => n.serviceGroup === this.serviceGroup);

    for (const node of nodes) {
      this.replicaLoad.set(node.serverId, 0);
    }
    this.replicaLoad.set(this.localReplicaId, 0);

    if (this.isClusterMode && this.grpcClientPool) {
      let totalRecovered = 0;

      for (const node of nodes) {
        if (node.serverId === this.localReplicaId) continue;

        try {
          const client = await this.grpcClientPool.getClient(node.serverId, node.grpcAddress);
          const deadline = new Date(Date.now() + (this.config.grpc?.deadlines?.syncMs ?? 1000));
          const workers = await new Promise<Array<{ entityKey: string }>>((resolve, reject) => {
            (client as unknown as Record<string, Function>).listWorkers(
              {},
              { deadline },
              (err: Error | null, response: Record<string, unknown>) => {
                if (err) return reject(err);
                resolve((response.workers as Array<{ entityKey: string }>) ?? []);
              },
            );
          });

          for (const w of workers) {
            this.assignments.set(w.entityKey, {
              replicaId: node.serverId,
              assignedAt: Date.now(),
              lastActiveAt: Date.now(),
            });
            this.incrementLoad(node.serverId);
            totalRecovered++;
          }
        } catch (err) {
          this.logger.warn(
            `Failed to query replica ${node.serverId} for workers: ${(err as Error).message} — removing from load map`,
          );
          this.replicaLoad.delete(node.serverId);
          this.grpcClientPool.removeClient(node.serverId);
        }
      }

      this.logger.log(
        `Assignment table rebuilt: ${this.replicaLoad.size} replicas, ${totalRecovered} workers recovered`,
      );
    } else {
      this.logger.log(`Assignment table rebuilt: ${this.replicaLoad.size} replicas, 0 workers`);
    }

    this.rebuilding = false;
  }

  private reconcileReplicas(nodes: ClusterNode[]): void {
    const sameGroupNodes = nodes.filter((n) => n.serviceGroup === this.serviceGroup);
    const liveIds = new Set(sameGroupNodes.map((n) => n.serverId));

    for (const [replicaId] of this.replicaLoad) {
      if (!liveIds.has(replicaId) && replicaId !== this.localReplicaId) {
        this.logger.warn(`Replica ${replicaId} is gone — removing its workers`);

        for (const [entityKey, assignment] of this.assignments) {
          if (assignment.replicaId === replicaId) {
            this.assignments.delete(entityKey);
          }
        }
        this.replicaLoad.delete(replicaId);
      }
    }

    for (const node of sameGroupNodes) {
      if (!this.replicaLoad.has(node.serverId)) {
        this.replicaLoad.set(node.serverId, 0);
        this.logger.log(`New replica discovered: ${node.serverId}`);
      }
    }
  }

  private async pushWorkersToMaster(): Promise<void> {
    if (!this.grpcClientPool || !this.workerListProvider) return;

    const workers = await this.workerListProvider();
    if (workers.length === 0) return;

    const masterAddress = await this.leaderElection.getMasterAddress();
    if (!masterAddress) {
      this.logger.warn('Cannot push workers: no master address found');
      return;
    }

    try {
      const client = await this.grpcClientPool.getClient('master', masterAddress);
      const deadline = new Date(Date.now() + (this.config.grpc?.deadlines?.syncMs ?? 1000));
      await new Promise<void>((resolve, reject) => {
        (client as unknown as Record<string, Function>).reportWorkers(
          {
            replicaId: this.localReplicaId,
            entityKeys: workers,
            epoch: 0,
          },
          { deadline },
          (err: Error | null, response: Record<string, unknown>) => {
            if (err) return reject(err);
            if (!response.accepted) return reject(new Error(response.rejectReason as string));
            resolve();
          },
        );
      });
      this.logger.log(`Pushed ${workers.length} workers to new master at ${masterAddress}`);
    } catch (err) {
      this.logger.warn(`Failed to push workers to master: ${(err as Error).message}`);
    }
  }
}
