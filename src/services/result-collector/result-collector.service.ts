import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

interface PendingResult {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

@Injectable()
export class ResultCollector implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ResultCollector.name);
  private readonly keyPrefix: string;
  private readonly pending = new Map<string, PendingResult>();
  private subscriber: Redis | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
  }

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    const pattern = `${this.keyPrefix}:results:*`;
    await this.subscriber.psubscribe(pattern);

    this.subscriber.on('pmessage', (_pattern: string, channel: string, payload: string) => {
      const parts = channel.split(':');
      const correlationId = parts[parts.length - 1];

      const entry = this.pending.get(correlationId);
      if (!entry) return;

      clearTimeout(entry.timer);
      this.pending.delete(correlationId);

      try {
        const parsed = JSON.parse(payload);
        if (parsed.error) {
          entry.reject(new Error(parsed.error));
        } else {
          entry.resolve(parsed.result);
        }
      } catch (err) {
        entry.reject(new Error(`Failed to parse result: ${(err as Error).message}`));
      }
    });

    this.logger.log('ResultCollector initialized with pattern subscription');
  }

  async onApplicationShutdown(): Promise<void> {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Application shutting down'));
    }
    this.pending.clear();

    if (this.subscriber) {
      await this.subscriber.punsubscribe();
      await this.subscriber.quit();
      this.subscriber = null;
    }
  }

  waitForResult<R = any>(correlationId: string, timeout: number): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`Result timeout after ${timeout}ms for correlation ${correlationId}`));
      }, timeout);

      this.pending.set(correlationId, { resolve, reject, timer });
    });
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
