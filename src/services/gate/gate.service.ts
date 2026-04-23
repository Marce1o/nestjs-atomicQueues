import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const EXTEND_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

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

  async release(entityKey: string, ownerToken: string): Promise<boolean> {
    const gateKey = this.getGateKey(entityKey);
    const result = (await this.redis.eval(
      RELEASE_IF_OWNER_SCRIPT,
      1,
      gateKey,
      ownerToken,
    )) as number;
    return result === 1;
  }

  async extend(entityKey: string, ownerToken: string, ttlSeconds?: number): Promise<boolean> {
    const gateKey = this.getGateKey(entityKey);
    const ttl = ttlSeconds ?? this.defaultTTL;
    const result = (await this.redis.eval(
      EXTEND_IF_OWNER_SCRIPT,
      1,
      gateKey,
      ownerToken,
      ttl.toString(),
    )) as number;
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
