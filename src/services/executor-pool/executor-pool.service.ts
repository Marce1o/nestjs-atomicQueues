import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { SchedulerService } from '../scheduler';
import { GateService } from '../gate';
import { LogService } from '../log';
import { HandlerExecutor } from '../handler-executor';
import { ActorRegistry } from '../actor-registry';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

@Injectable()
export class ExecutorPoolService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ExecutorPoolService.name);
  private readonly keyPrefix: string;
  private readonly poolSize: number;
  private activeExecutors = 0;
  private running = false;
  private subscriberClient: Redis | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly scheduler: SchedulerService,
    private readonly gateService: GateService,
    private readonly logService: LogService,
    private readonly handlerExecutor: HandlerExecutor,
    private readonly actorRegistry: ActorRegistry,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
    this.poolSize = config.executor?.poolSize ?? 1;
  }

  async onModuleInit(): Promise<void> {
    this.running = true;
    this.subscriberClient = this.redis.duplicate();

    const tickleChannel = `${this.keyPrefix}:tickle`;
    await this.subscriberClient.subscribe(tickleChannel);
    this.subscriberClient.on('message', (_channel: string, _msg: string) => {
      this.tryDispatch();
    });

    this.logger.log(`Executor pool started with poolSize=${this.poolSize}`);

    this.tryDispatch();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.subscriberClient) {
      await this.subscriberClient.unsubscribe();
      await this.subscriberClient.quit();
    }

    const maxWait = 30000;
    const start = Date.now();
    while (this.activeExecutors > 0 && Date.now() - start < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (this.activeExecutors > 0) {
      this.logger.warn(`Shutdown with ${this.activeExecutors} active executors still running`);
    }
  }

  async tickle(): Promise<void> {
    const tickleChannel = `${this.keyPrefix}:tickle`;
    await this.redis.publish(tickleChannel, '1');
  }

  private async tryDispatch(): Promise<void> {
    while (this.running && this.activeExecutors < this.poolSize) {
      const result = await this.scheduler.pickNext();
      if (!result) break;

      this.activeExecutors++;
      this.executeMessage(result.entityKey, result.message, result.ownerToken)
        .finally(() => {
          this.activeExecutors--;
          if (this.running) {
            this.tryDispatch();
          }
        });
    }
  }

  private async executeMessage(
    entityKey: string,
    message: any,
    ownerToken: string,
  ): Promise<void> {
    const entityType = message.entityType;
    const entityId = message.entityId;
    const ttl = this.gateService.getTTLForEntity(entityType);
    const refreshInterval = this.config.executor?.gateRefreshInterval ?? (ttl * 500);

    const refresher = setInterval(async () => {
      try {
        await this.gateService.extend(entityKey, ttl);
      } catch (err) {
        this.logger.error(`Gate refresh failed for ${entityKey}: ${(err as Error).message}`);
      }
    }, refreshInterval);

    try {
      if (this.actorRegistry.hasActor(entityType)) {
        const actor = await this.actorRegistry.getOrCreateInstance(entityType, entityId);
        const methodName = this.actorRegistry.getHandlerMethod(entityType, message.name);
        if (actor && methodName) {
          const result = await actor[methodName]({ ...message.data });
          await this.publishResult(message, result);
          await this.scheduler.complete(entityKey);
          return;
        }
      }

      const result = await this.handlerExecutor.execute(message, entityKey);
      await this.publishResult(message, result);
      await this.scheduler.complete(entityKey);
    } catch (err) {
      await this.scheduler.fail(entityKey, message, err as Error);
      await this.publishResult(message, undefined, err as Error);
    } finally {
      clearInterval(refresher);
    }
  }

  private async publishResult(message: any, result?: unknown, error?: Error): Promise<void> {
    if (!message.correlationId) return;
    const channel = `${this.keyPrefix}:results:${message.correlationId}`;
    const payload = error
      ? JSON.stringify({ error: error.message })
      : JSON.stringify({ result });
    await this.redis.publish(channel, payload);
  }
}
