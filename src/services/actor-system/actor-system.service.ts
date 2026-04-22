import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig, ISerializedMessage, IMessageRef } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { LogService } from '../log';
import { ExecutorPoolService } from '../executor-pool';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

@Injectable()
export class ActorSystem {
  private readonly logger = new Logger(ActorSystem.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly logService: LogService,
    private readonly executorPool: ExecutorPoolService,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
  }

  async send<T extends object>(
    entityType: string,
    entityId: string,
    message: T,
  ): Promise<IMessageRef> {
    const entityKey = `${entityType}:${entityId}`;
    const serialized = this.serializeMessage(entityType, entityId, message);
    await this.logService.append(entityKey, serialized);
    await this.executorPool.tickle();
    return { id: serialized.id, entityKey };
  }

  async sendAndWait<T extends object, R = any>(
    entityType: string,
    entityId: string,
    message: T,
    timeout = 30000,
  ): Promise<R> {
    const correlationId = uuidv4();
    const entityKey = `${entityType}:${entityId}`;
    const serialized = this.serializeMessage(entityType, entityId, message, correlationId);

    const resultChannel = `${this.keyPrefix}:results:${correlationId}`;
    const subscriber = this.redis.duplicate();

    try {
      const resultPromise = new Promise<R>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`sendAndWait timeout after ${timeout}ms for ${message.constructor.name} on ${entityKey}`));
        }, timeout);

        subscriber.subscribe(resultChannel).then(() => {
          subscriber.on('message', (_ch: string, data: string) => {
            clearTimeout(timer);
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(parsed.error));
            } else {
              resolve(parsed.result);
            }
          });
        });
      });

      await this.logService.append(entityKey, serialized);
      await this.executorPool.tickle();

      return await resultPromise;
    } finally {
      await subscriber.unsubscribe(resultChannel);
      await subscriber.quit();
    }
  }

  private serializeMessage<T extends object>(
    entityType: string,
    entityId: string,
    message: T,
    correlationId?: string,
  ): ISerializedMessage {
    const data: Record<string, any> = {};
    for (const key of Object.keys(message)) {
      data[key] = (message as any)[key];
    }

    const retryConfig = this.config.entities?.[entityType]?.retry ?? this.config.retry;

    return {
      id: uuidv4(),
      name: message.constructor.name,
      data,
      entityType,
      entityId,
      correlationId,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: retryConfig?.maxAttempts ?? 3,
    };
  }
}
