import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../domain';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../services/constants';

@Injectable()
export class RedisHealthMonitor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisHealthMonitor.name);
  private readonly enabled: boolean;
  private readonly checkIntervalMs: number;
  private readonly failureThreshold: number;

  private checkTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private _isDegraded = false;

  private readonly healthChangeListeners: Array<(healthy: boolean) => void> = [];

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.enabled = config.grpc?.enabled ?? false;
    this.checkIntervalMs = config.grpc?.redisHealthCheckMs ?? 500;
    this.failureThreshold = config.grpc?.redisHealthFailureThreshold ?? 3;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;

    this.checkTimer = setInterval(() => {
      this.check().catch((err) => {
        this.logger.error(`Health check error: ${(err as Error).message}`);
      });
    }, this.checkIntervalMs);

    this.logger.log(
      `Redis health monitor started: interval=${this.checkIntervalMs}ms, threshold=${this.failureThreshold}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  get isDegraded(): boolean {
    return this._isDegraded;
  }

  onHealthChange(listener: (healthy: boolean) => void): () => void {
    this.healthChangeListeners.push(listener);
    return () => {
      const idx = this.healthChangeListeners.indexOf(listener);
      if (idx >= 0) this.healthChangeListeners.splice(idx, 1);
    };
  }

  private async check(): Promise<void> {
    try {
      await this.redis.ping();
      this.consecutiveFailures = 0;

      if (this._isDegraded) {
        this._isDegraded = false;
        this.logger.log('Redis connectivity restored');
        this.notifyListeners(true);
      }
    } catch {
      this.consecutiveFailures++;

      if (!this._isDegraded && this.consecutiveFailures >= this.failureThreshold) {
        this._isDegraded = true;
        this.logger.error(
          `Redis unreachable after ${this.consecutiveFailures} consecutive failures — entering degraded mode`,
        );
        this.notifyListeners(false);
      }
    }
  }

  private notifyListeners(healthy: boolean): void {
    for (const listener of this.healthChangeListeners) {
      try {
        listener(healthy);
      } catch (err) {
        this.logger.error(`Health change listener error: ${(err as Error).message}`);
      }
    }
  }
}
