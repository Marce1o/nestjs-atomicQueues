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
  private leaderEpoch = 0;
  private lastRenewalSuccess = 0;
  private renewalTimer: NodeJS.Timeout | null = null;
  private acquisitionTimer: NodeJS.Timeout | null = null;

  private readonly leaderChangeListeners: Array<(isLeader: boolean) => void> = [];

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) config: IAtomicQueuesModuleConfig,
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
      this.isLeader = true;
      return;
    }

    await this.tryAcquire();

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

  getIsLeader(): boolean {
    return this.isLeader;
  }

  get epoch(): number {
    return this.leaderEpoch;
  }

  async getMasterAddress(): Promise<string | null> {
    if (!this.enabled) return null;
    const addressKey = `${this.getLeaderKey()}:address`;
    return this.redis.get(addressKey);
  }

  async getForeignMasterAddress(serviceGroup: string): Promise<string | null> {
    if (!this.enabled) return null;
    const addressKey = `${this.keyPrefix}:cluster:leader:${serviceGroup}:address`;
    return this.redis.get(addressKey);
  }

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
      const epochKey = `${key}:epoch`;
      this.leaderEpoch = await this.redis.incr(epochKey);

      const addressKey = `${key}:address`;
      const pipeline = this.redis.pipeline();
      pipeline.set(addressKey, this.grpcAddress, 'PX', this.lockTTLMs);
      pipeline.pexpire(epochKey, this.lockTTLMs * 10);
      await pipeline.exec();

      this.lastRenewalSuccess = Date.now();
      this.becomeLeader();
    }
  }

  private becomeLeader(): void {
    if (this.isLeader) return;

    this.isLeader = true;
    this.logger.log(
      `This server (${this.serverId}) is now the leader for group '${this.serviceGroup}' (epoch ${this.leaderEpoch})`,
    );

    this.renewalTimer = setInterval(() => {
      this.renew().catch((err) => {
        this.logger.error(`Leader lock renewal failed: ${(err as Error).message}`);
        this.loseLeadership();
      });
    }, this.renewalIntervalMs);

    this.notifyListeners(true);
  }

  private async renew(): Promise<void> {
    if (Date.now() - this.lastRenewalSuccess > this.lockTTLMs * 0.6) {
      this.loseLeadership();
      return;
    }

    const key = this.getLeaderKey();
    const result = (await this.redis.eval(
      EXTEND_IF_OWNER,
      1,
      key,
      this.serverId,
      this.lockTTLMs.toString(),
    )) as number;

    if (result === 1) {
      this.lastRenewalSuccess = Date.now();
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
