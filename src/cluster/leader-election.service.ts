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
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
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
  private readonly lockTTLMs: number;
  private readonly renewalIntervalMs: number;
  private readonly acquisitionIntervalMs: number;
  private readonly grpcAddress: string;

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
    this.grpcAddress = config.grpc?.advertisedAddress ?? '0.0.0.0:50051';
    this.lockTTLMs = config.grpc?.leaderTTLMs ?? 2000;
    this.renewalIntervalMs = config.grpc?.leaderRenewalMs ?? 400;
    this.acquisitionIntervalMs = config.grpc?.leaderAcquisitionMs ?? 400;
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
   * Get the current master's gRPC address (reads from Redis).
   * Returns null if no master or not in cluster mode.
   */
  /**
   * Get the current master's gRPC address (reads from Redis).
   * Returns null if no master or not in cluster mode.
   */
  async getMasterAddress(): Promise<string | null> {
    if (!this.enabled) return null;
    const addressKey = `${this.getLeaderKey()}:address`;
    return this.redis.get(addressKey);
  }

  /**
   * Get a foreign service group's master gRPC address (reads from Redis).
   */
  async getForeignMasterAddress(serviceGroup: string): Promise<string | null> {
    if (!this.enabled) return null;
    const addressKey = `${this.keyPrefix}:cluster:leader:${serviceGroup}:address`;
    return this.redis.get(addressKey);
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
    const result = await this.redis.set(key, this.serverId, 'PX', this.lockTTLMs, 'NX');

    if (result === 'OK') {
      const addressKey = `${key}:address`;
      await this.redis.set(addressKey, this.grpcAddress, 'PX', this.lockTTLMs);
      this.becomeLeader();
    }
  }

  private becomeLeader(): void {
    if (this.isLeader) return;

    this.isLeader = true;
    this.logger.log(
      `This server (${this.serverId}) is now the leader for group '${this.serviceGroup}'`,
    );

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
      this.lockTTLMs.toString(),
    )) as number;

    if (result === 1) {
      const addressKey = `${key}:address`;
      await this.redis.set(addressKey, this.grpcAddress, 'PX', this.lockTTLMs);
    } else {
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
