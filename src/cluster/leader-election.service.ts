import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../domain';
import { resolveKeyPrefix } from '../utils';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../services/constants';

const RELEASE_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const EXTEND_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Leader Election Service.
 *
 * Within each service group (set of replicas running the same code),
 * exactly ONE replica is the leader. Adapted from v1's ServiceQueueManager.
 *
 * Uses Redis SET NX with TTL for distributed lock:
 * - Lock key: `{prefix}:cluster:leader:{serviceGroup}`
 * - Lock value: serverId of the leader
 * - TTL: 10s, renewed every 3s
 *
 * Leader responsibilities:
 * - WAL recovery for the service group on startup
 * - Ring change coordination
 * - Arbitrating conflicting claims during rapid ring changes
 */
@Injectable()
export class LeaderElectionService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LeaderElectionService.name);
  private readonly keyPrefix: string;
  private readonly enabled: boolean;
  private readonly serverId: string;
  private readonly serviceGroup: string;
  private readonly lockTTL = 10;
  private readonly renewalIntervalMs = 3000;
  private readonly acquisitionIntervalMs = 3000;

  private isLeader = false;
  private renewalTimer: NodeJS.Timeout | null = null;
  private acquisitionTimer: NodeJS.Timeout | null = null;

  private readonly leaderChangeListeners: Array<(isLeader: boolean) => void> = [];

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
    this.enabled = config.grpc?.enabled ?? false;
    this.serverId = config.grpc?.serverId ?? 'unknown';
    this.serviceGroup = config.grpc?.serviceGroup ?? 'default';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      // Single-server mode: this node is always the leader
      this.isLeader = true;
      return;
    }

    // Try to acquire leadership
    await this.tryAcquire();

    // Start periodic acquisition attempts (in case current leader dies)
    this.acquisitionTimer = setInterval(() => {
      if (!this.isLeader) {
        this.tryAcquire().catch((err) => {
          this.logger.error(`Leader acquisition failed: ${(err as Error).message}`);
        });
      }
    }, this.acquisitionIntervalMs);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    if (this.acquisitionTimer) clearInterval(this.acquisitionTimer);

    if (this.isLeader && this.enabled) {
      await this.release();
    }
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  /**
   * Check if this server is the leader.
   */
  getIsLeader(): boolean {
    return this.isLeader;
  }

  /**
   * Register a listener for leadership changes.
   */
  onLeaderChange(listener: (isLeader: boolean) => void): () => void {
    this.leaderChangeListeners.push(listener);
    return () => {
      const idx = this.leaderChangeListeners.indexOf(listener);
      if (idx >= 0) this.leaderChangeListeners.splice(idx, 1);
    };
  }

  // =========================================================================
  // INTERNAL — Lock Management
  // =========================================================================

  private getLeaderKey(): string {
    return `${this.keyPrefix}:cluster:leader:${this.serviceGroup}`;
  }

  private async tryAcquire(): Promise<void> {
    const key = this.getLeaderKey();
    const result = await this.redis.set(key, this.serverId, 'EX', this.lockTTL, 'NX');

    if (result === 'OK') {
      this.becomeLeader();
    }
  }

  private becomeLeader(): void {
    if (this.isLeader) return;

    this.isLeader = true;
    this.logger.log(`This server (${this.serverId}) is now the leader for group '${this.serviceGroup}'`);

    // Start renewal
    this.renewalTimer = setInterval(() => {
      this.renew().catch((err) => {
        this.logger.error(`Leader lock renewal failed: ${(err as Error).message}`);
        this.loseLeadership();
      });
    }, this.renewalIntervalMs);

    this.notifyListeners(true);
  }

  private async renew(): Promise<void> {
    const key = this.getLeaderKey();
    const result = (await this.redis.eval(
      EXTEND_IF_OWNER,
      1,
      key,
      this.serverId,
      this.lockTTL.toString(),
    )) as number;

    if (result !== 1) {
      // Lock was lost (expired or stolen)
      this.loseLeadership();
    }
  }

  private loseLeadership(): void {
    if (!this.isLeader) return;

    this.isLeader = false;
    this.logger.warn(`This server lost leadership for group '${this.serviceGroup}'`);

    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }

    this.notifyListeners(false);
  }

  private async release(): Promise<void> {
    const key = this.getLeaderKey();
    await this.redis.eval(RELEASE_IF_OWNER, 1, key, this.serverId);
    this.isLeader = false;
    this.logger.log(`Released leadership for group '${this.serviceGroup}'`);
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
