import { Injectable, Logger, Inject, Optional, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../domain';
import { resolveKeyPrefix } from '../utils';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../services/constants';
import { ClusterDiscoveryService, ClusterNode } from './cluster-discovery.service';
import { RedisHealthMonitor } from './redis-health-monitor.service';

@Injectable()
export class LeaderElectionService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LeaderElectionService.name);
  private readonly keyPrefix: string;
  private readonly enabled: boolean;
  private readonly serverId: string;
  private readonly serviceGroup: string;
  private readonly debounceMs: number;

  private isLeader = false;
  private leaderEpoch = 0;
  private unsubscribeRingChange: (() => void) | null = null;
  private unsubscribeRedisHealth: (() => void) | null = null;
  private recomputeTimer: NodeJS.Timeout | null = null;
  private lastRecomputeAt = 0;
  private pendingNodes: ClusterNode[] | null = null;

  private readonly leaderChangeListeners: Array<(isLeader: boolean) => void> = [];

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) config: IAtomicQueuesModuleConfig,
    private readonly clusterDiscovery: ClusterDiscoveryService,
    @Optional() private readonly redisHealthMonitor?: RedisHealthMonitor,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
    this.enabled = config.grpc?.enabled ?? false;
    this.serverId = config.grpc?.serverId ?? 'unknown';
    this.serviceGroup = config.grpc?.serviceGroup ?? 'default';
    this.debounceMs = config.grpc?.leaderDebounceMs ?? 800;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.isLeader = true;
      return;
    }

    const nodes = await this.clusterDiscovery.getNodes();
    await this.recomputeLeader(nodes);

    this.unsubscribeRingChange = this.clusterDiscovery.onRingChange((updatedNodes) => {
      this.scheduleRecompute(updatedNodes);
    });

    if (this.redisHealthMonitor) {
      this.unsubscribeRedisHealth = this.redisHealthMonitor.onHealthChange((healthy) => {
        if (!healthy && this.isLeader) {
          this.isLeader = false;
          this.logger.warn(
            `Voluntarily resigning leadership for group '${this.serviceGroup}' — Redis unreachable`,
          );
          this.notifyListeners(false);
        }
      });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.unsubscribeRingChange) this.unsubscribeRingChange();
    if (this.unsubscribeRedisHealth) this.unsubscribeRedisHealth();
    if (this.recomputeTimer) clearTimeout(this.recomputeTimer);
    this.isLeader = false;
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  getIsLeader(): boolean {
    return this.isLeader;
  }

  get epoch(): number {
    return this.leaderEpoch;
  }

  updateSeenEpoch(epoch: number): void {
    if (epoch > this.leaderEpoch) {
      this.leaderEpoch = epoch;
    }
  }

  async getMasterAddress(): Promise<string | null> {
    if (!this.enabled) return null;
    const nodes = await this.clusterDiscovery.getNodes();
    const leader = nodes
      .filter((n) => n.serviceGroup === this.serviceGroup)
      .sort((a, b) => a.serverId.localeCompare(b.serverId))[0];
    return leader?.grpcAddress ?? null;
  }

  async getForeignMasterAddress(serviceGroup: string): Promise<string | null> {
    if (!this.enabled) return null;
    const nodes = await this.clusterDiscovery.getNodes();
    const leader = nodes
      .filter((n) => n.serviceGroup === serviceGroup)
      .sort((a, b) => a.serverId.localeCompare(b.serverId))[0];
    return leader?.grpcAddress ?? null;
  }

  onLeaderChange(listener: (isLeader: boolean) => void): () => void {
    this.leaderChangeListeners.push(listener);
    return () => {
      const idx = this.leaderChangeListeners.indexOf(listener);
      if (idx >= 0) this.leaderChangeListeners.splice(idx, 1);
    };
  }

  // =========================================================================
  // INTERNAL
  // =========================================================================

  private scheduleRecompute(nodes: ClusterNode[]): void {
    this.pendingNodes = nodes;

    if (this.lastRecomputeAt === 0) {
      this.executeRecompute();
      return;
    }

    if (this.recomputeTimer) return;

    const elapsed = Date.now() - this.lastRecomputeAt;
    const remaining = Math.max(0, this.debounceMs - elapsed);

    if (remaining === 0) {
      this.executeRecompute();
    } else {
      this.recomputeTimer = setTimeout(() => this.executeRecompute(), remaining);
    }
  }

  private executeRecompute(): void {
    this.recomputeTimer = null;
    this.lastRecomputeAt = Date.now();
    const nodes = this.pendingNodes;
    this.pendingNodes = null;
    if (nodes) {
      this.recomputeLeader(nodes).catch((err) => {
        this.logger.error(`Leader recomputation failed: ${(err as Error).message}`);
      });
    }
  }

  private async recomputeLeader(nodes: ClusterNode[]): Promise<void> {
    const sameGroup = nodes
      .filter((n) => n.serviceGroup === this.serviceGroup)
      .sort((a, b) => a.serverId.localeCompare(b.serverId));

    const leaderId = sameGroup[0]?.serverId ?? null;

    if (leaderId === this.serverId && !this.isLeader) {
      this.isLeader = true;
      const epochKey = `${this.keyPrefix}:cluster:leader:${this.serviceGroup}:epoch`;
      this.leaderEpoch = await this.redis.incr(epochKey);
      this.logger.log(
        `This server (${this.serverId}) is now the leader for group '${this.serviceGroup}' (epoch ${this.leaderEpoch})`,
      );
      this.notifyListeners(true);
    } else if (leaderId !== this.serverId && this.isLeader) {
      this.isLeader = false;
      this.logger.warn(`This server lost leadership for group '${this.serviceGroup}'`);
      this.notifyListeners(false);
    }
  }

  private notifyListeners(isLeader: boolean): void {
    for (const listener of this.leaderChangeListeners) {
      try {
        listener(isLeader);
      } catch (err) {
        this.logger.error(`Leader change listener error: ${(err as Error).message}`);
      }
    }
  }
}
