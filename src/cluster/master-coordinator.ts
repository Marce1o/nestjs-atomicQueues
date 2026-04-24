import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { IAtomicQueuesModuleConfig } from '../domain';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';
import { LeaderElectionService } from './leader-election.service';
import { ClusterDiscoveryService, ClusterNode } from './cluster-discovery.service';

export interface WorkerAssignment {
  replicaId: string;
  assignedAt: number;
  lastActiveAt: number;
}

/**
 * MasterCoordinator — the brain of the replica set.
 *
 * Only active on the elected master replica. Manages the worker assignment
 * table: which entity:entityId worker lives on which replica. All petitions
 * route through the master, which either forwards to the owning replica
 * or spawns a new worker on the least-loaded one.
 *
 * Atomicity: all decisions happen on the master's event loop, which is
 * single-threaded. No locks needed for assignment table mutations.
 *
 * In single-server mode (no gRPC), the coordinator acts locally —
 * it IS the only replica, so all workers are local.
 */
@Injectable()
export class MasterCoordinator implements OnModuleInit {
  private readonly logger = new Logger(MasterCoordinator.name);

  /** entityKey → which replica owns the worker */
  private readonly assignments = new Map<string, WorkerAssignment>();

  /** replicaId → worker count (for load balancing) */
  private readonly replicaLoad = new Map<string, number>();

  private readonly localReplicaId: string;
  private readonly isClusterMode: boolean;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly leaderElection: LeaderElectionService,
    private readonly clusterDiscovery: ClusterDiscoveryService,
  ) {
    this.localReplicaId = config.grpc?.serverId ?? 'local';
    this.isClusterMode = config.grpc?.enabled ?? false;
  }

  async onModuleInit(): Promise<void> {
    if (!this.isClusterMode) {
      // Single-server: this replica is always the master
      this.replicaLoad.set(this.localReplicaId, 0);
      this.logger.log('MasterCoordinator running in single-server mode');
      return;
    }

    // Listen for leadership changes
    this.leaderElection.onLeaderChange((isLeader) => {
      if (isLeader) {
        this.logger.log('This replica is now the master — rebuilding assignment table');
        this.rebuildAssignmentTable();
      } else {
        this.logger.log('This replica lost master role — clearing assignment table');
        this.assignments.clear();
        this.replicaLoad.clear();
      }
    });

    // Listen for cluster changes (replica joins/leaves)
    this.clusterDiscovery.onRingChange((nodes) => {
      if (this.isMaster()) {
        this.reconcileReplicas(nodes);
      }
    });
  }

  // =========================================================================
  // PUBLIC API — called by MessageRouter
  // =========================================================================

  /**
   * Resolve where a message should be processed.
   * Returns the replicaId that owns (or should own) the worker.
   *
   * In single-server mode, always returns the local replica.
   * In cluster mode, checks assignment table and spawns if needed.
   */
  resolve(entityKey: string): { replicaId: string; isLocal: boolean; needsSpawn: boolean } {
    if (!this.isClusterMode || !this.isMaster()) {
      // Single-server or not master: always local
      const existing = this.assignments.has(entityKey);
      if (!existing) {
        this.assignWorker(entityKey, this.localReplicaId);
      }
      return { replicaId: this.localReplicaId, isLocal: true, needsSpawn: !existing };
    }

    // Cluster mode, this is the master
    const assignment = this.assignments.get(entityKey);
    if (assignment) {
      assignment.lastActiveAt = Date.now();
      return {
        replicaId: assignment.replicaId,
        isLocal: assignment.replicaId === this.localReplicaId,
        needsSpawn: false,
      };
    }

    // No worker exists — spawn on least loaded replica
    const targetReplica = this.pickLeastLoaded();
    this.assignWorker(entityKey, targetReplica);

    return {
      replicaId: targetReplica,
      isLocal: targetReplica === this.localReplicaId,
      needsSpawn: true,
    };
  }

  /**
   * Remove a worker assignment (called on idle teardown).
   */
  release(entityKey: string): void {
    const assignment = this.assignments.get(entityKey);
    if (assignment) {
      this.decrementLoad(assignment.replicaId);
      this.assignments.delete(entityKey);
    }
  }

  /**
   * Check if this replica is the master.
   */
  isMaster(): boolean {
    if (!this.isClusterMode) return true;
    return this.leaderElection.getIsLeader();
  }

  /**
   * Get the assignment table (for debugging / gRPC ListWorkers).
   */
  getAssignments(): Map<string, WorkerAssignment> {
    return new Map(this.assignments);
  }

  /**
   * Get the total number of assigned workers across the cluster.
   */
  totalAssignedWorkers(): number {
    return this.assignments.size;
  }

  /**
   * Get load per replica.
   */
  getReplicaLoad(): Map<string, number> {
    return new Map(this.replicaLoad);
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
    // TODO: in cluster mode, query all replicas via gRPC ListWorkers
    // and rebuild the assignment table from their responses.
    // For now, start with empty table — workers will be re-spawned on demand.
    this.assignments.clear();
    this.replicaLoad.clear();

    if (this.isClusterMode) {
      const nodes = await this.clusterDiscovery.getNodes();
      for (const node of nodes) {
        this.replicaLoad.set(node.serverId, 0);
      }
    } else {
      this.replicaLoad.set(this.localReplicaId, 0);
    }

    this.logger.log(`Assignment table rebuilt: ${this.replicaLoad.size} replicas, 0 workers`);
  }

  private reconcileReplicas(nodes: ClusterNode[]): void {
    const liveIds = new Set(nodes.map((n) => n.serverId));

    // Remove dead replicas and their workers
    for (const [replicaId] of this.replicaLoad) {
      if (!liveIds.has(replicaId) && replicaId !== this.localReplicaId) {
        this.logger.warn(`Replica ${replicaId} is gone — removing its workers`);

        // Remove all assignments for the dead replica
        for (const [entityKey, assignment] of this.assignments) {
          if (assignment.replicaId === replicaId) {
            this.assignments.delete(entityKey);
          }
        }
        this.replicaLoad.delete(replicaId);
      }
    }

    // Add new replicas
    for (const node of nodes) {
      if (!this.replicaLoad.has(node.serverId)) {
        this.replicaLoad.set(node.serverId, 0);
        this.logger.log(`New replica discovered: ${node.serverId}`);
      }
    }
  }
}
