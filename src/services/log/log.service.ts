import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig, ISerializedMessage } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

@Injectable()
export class LogService {
  private readonly logger = new Logger(LogService.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
  }

  getLogKey(entityKey: string): string {
    return `${this.keyPrefix}:log:${entityKey}`;
  }

  getReadySetKey(): string {
    return `${this.keyPrefix}:ready`;
  }

  getDeadLetterKey(entityType: string): string {
    return `${this.keyPrefix}:dead:${entityType}`;
  }

  async append(entityKey: string, message: ISerializedMessage): Promise<number> {
    const logKey = this.getLogKey(entityKey);
    const readyKey = this.getReadySetKey();

    const pipeline = this.redis.pipeline();
    pipeline.lpush(logKey, JSON.stringify(message));
    pipeline.sadd(readyKey, entityKey);
    const results = await pipeline.exec();

    const length = (results?.[0]?.[1] as number) ?? 0;
    this.logger.debug(`Appended message ${message.name} to ${entityKey} (depth: ${length})`);
    return length;
  }

  async popNext(entityKey: string): Promise<ISerializedMessage | null> {
    const logKey = this.getLogKey(entityKey);
    const raw = await this.redis.rpop(logKey);
    if (!raw) return null;
    return JSON.parse(raw) as ISerializedMessage;
  }

  async length(entityKey: string): Promise<number> {
    const logKey = this.getLogKey(entityKey);
    return this.redis.llen(logKey);
  }

  async markReady(entityKey: string): Promise<void> {
    await this.redis.sadd(this.getReadySetKey(), entityKey);
  }

  async unmarkReady(entityKey: string): Promise<void> {
    await this.redis.srem(this.getReadySetKey(), entityKey);
  }

  async deadLetter(entityType: string, message: ISerializedMessage): Promise<void> {
    const deadKey = this.getDeadLetterKey(entityType);
    await this.redis.lpush(
      deadKey,
      JSON.stringify({
        ...message,
        deadLetteredAt: Date.now(),
      }),
    );
    this.logger.warn(
      `Dead-lettered message ${message.name} for ${entityType}:${message.entityId} after ${message.attempts} attempts`,
    );
  }

  async getDeadLetters(entityType: string, limit = 100): Promise<ISerializedMessage[]> {
    const deadKey = this.getDeadLetterKey(entityType);
    const raw = await this.redis.lrange(deadKey, 0, limit - 1);
    return raw.map((r) => JSON.parse(r));
  }

  async readyCount(): Promise<number> {
    return this.redis.scard(this.getReadySetKey());
  }
}
