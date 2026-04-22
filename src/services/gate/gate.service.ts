import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

@Injectable()
export class GateService {
  private readonly logger = new Logger(GateService.name);
  private readonly keyPrefix: string;
  private readonly defaultTTL: number;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
    this.defaultTTL = config.executor?.gateTTL ?? 30;
  }

  getGateKey(entityKey: string): string {
    return `${this.keyPrefix}:gate:${entityKey}`;
  }

  async acquire(entityKey: string, ownerToken: string, ttlSeconds?: number): Promise<boolean> {
    const gateKey = this.getGateKey(entityKey);
    const ttl = ttlSeconds ?? this.defaultTTL;
    const result = await this.redis.set(gateKey, ownerToken, 'EX', ttl, 'NX');
    return result === 'OK';
  }

  async release(entityKey: string): Promise<void> {
    const gateKey = this.getGateKey(entityKey);
    await this.redis.del(gateKey);
  }

  async extend(entityKey: string, ttlSeconds?: number): Promise<boolean> {
    const gateKey = this.getGateKey(entityKey);
    const ttl = ttlSeconds ?? this.defaultTTL;
    const result = await this.redis.expire(gateKey, ttl);
    return result === 1;
  }

  async isHeld(entityKey: string): Promise<boolean> {
    const gateKey = this.getGateKey(entityKey);
    return (await this.redis.exists(gateKey)) === 1;
  }

  getTTLForEntity(entityType: string): number {
    return this.config.entities?.[entityType]?.gateTTL ?? this.defaultTTL;
  }
}
