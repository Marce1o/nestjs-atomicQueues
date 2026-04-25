import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../domain';
import { resolveKeyPrefix } from '../utils';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../services/constants';
import { ClusterDiscoveryService, ClusterNode } from './cluster-discovery.service';

@Injectable()
export class LeaderElectionService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LeaderElectionService.name);
  private readonly keyPrefix: string;
  private readonly enabled: boolean;
  private readonly serverId: string;
  private readonly serviceGroup: string;

  private isLeader = false;
  private leaderEpoch = 0;
  private unsubscribeRingChange: (() => void) | null = null;

  private readonly leaderChangeListeners: Array<(isLeader: boolean) => void> = [];

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) config: IAtomicQueuesModuleConfig,
    private readonly clusterDiscovery: ClusterDiscoveryService,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
    this.enabled = config.grpc?.enabled ?? false;
    this.serverId = config.grpc?.serverId ?? 'unknown';
    this.serviceGroup = config.grpc?.serviceGroup ?? 'default';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.isLeader = true;
      return;
    }

    const nodes = await this.clusterDiscovery.getNodes();
    await this.recomputeLeader(nodes);

    this.unsubscribeRingChange = this.clusterDiscovery.onRingChange((updatedNodes) => {
      this.recomputeLeader(updatedNodes).catch((err) => {
        this.logger.error(`Leader recomputation failed: ${(err as Error).message}`);
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.unsubscribeRingChange) {
      this.unsubscribeRingChange();
    }
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
