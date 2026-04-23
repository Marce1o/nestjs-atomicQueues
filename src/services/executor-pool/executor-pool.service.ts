import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig, ISerializedMessage } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { SchedulerService } from '../scheduler';
import { GateService } from '../gate';
import { LogService } from '../log';
import { HandlerExecutor } from '../handler-executor';
import { EntityTypeRegistry } from '../entity-type-registry';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

@Injectable()
export class ExecutorPoolService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ExecutorPoolService.name);
  private readonly keyPrefix: string;
  private readonly poolSize: number;
  private activeExecutors = 0;
  private running = false;
  private subscriberClient: Redis | null = null;
  private ownedEntityTypes: string[] | undefined;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly scheduler: SchedulerService,
    private readonly gateService: GateService,
    private readonly logService: LogService,
    private readonly handlerExecutor: HandlerExecutor,
    private readonly entityTypeRegistry: EntityTypeRegistry,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
    this.poolSize = config.executor?.poolSize ?? 1;
  }

  async onModuleInit(): Promise<void> {
    this.running = true;

    // Collect entity types this node can handle (actors + config).
    // When the list is non-empty the Lua script only picks matching keys,
    // so foreign entity types are never stolen from other services.
    this.ownedEntityTypes = this.collectOwnedEntityTypes();

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
      await new Promise((resolve) => setTimeout(resolve, 100));
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
    // Multi-service node with no handlers — don't compete for messages
    if (this.ownedEntityTypes !== undefined && this.ownedEntityTypes.length === 0) return;

    while (this.running && this.activeExecutors < this.poolSize) {
      const result = await this.scheduler.pickNext(this.ownedEntityTypes);
      if (!result) break;

      this.activeExecutors++;
      this.executeMessage(result.entityKey, result.message, result.ownerToken).finally(() => {
        this.activeExecutors--;
        if (this.running) {
          this.tryDispatch();
        }
      });
    }
  }

  private async executeMessage(
    entityKey: string,
    message: ISerializedMessage,
    ownerToken: string,
  ): Promise<void> {
    const entityType = message.entityType;
    const entityId = message.entityId;
    const ttl = this.gateService.getTTLForEntity(entityType);
    const refreshInterval = this.config.executor?.gateRefreshInterval ?? ttl * 500;

    const refresher = setInterval(async () => {
      try {
        await this.gateService.extend(entityKey, ownerToken, ttl);
      } catch (err) {
        this.logger.error(`Gate refresh failed for ${entityKey}: ${(err as Error).message}`);
      }
    }, refreshInterval);

    try {
      const result = await this.handlerExecutor.execute(message, entityKey);
      await this.publishResult(message, result);
      await this.scheduler.complete(entityKey, ownerToken);
    } catch (err) {
      await this.scheduler.fail(entityKey, ownerToken, message, err as Error);
      await this.publishResult(message, undefined, err as Error);
    } finally {
      clearInterval(refresher);
    }
  }

  private async publishResult(
    message: ISerializedMessage,
    result?: unknown,
    error?: Error,
  ): Promise<void> {
    if (!message.correlationId) return;
    const channel = `${this.keyPrefix}:results:${message.correlationId}`;
    const payload = error ? JSON.stringify({ error: error.message }) : JSON.stringify({ result });
    await this.redis.publish(channel, payload);
  }

  /**
   * Build the list of entity types this node owns handlers for.
   * Returns undefined (accept-all) when no specific handlers are registered,
   * which keeps single-service deployments zero-config.
   */
  private collectOwnedEntityTypes(): string[] | undefined {
    const types = new Set<string>();

    for (const et of this.entityTypeRegistry.getRegisteredEntityTypes()) {
      types.add(et);
    }

    // Entity types declared in config
    if (this.config.entities) {
      for (const et of Object.keys(this.config.entities)) {
        types.add(et);
      }
    }

    if (types.size > 0) return Array.from(types);

    // In multi-service mode (registry enabled), no handlers means
    // this node is a pure client — return empty array to accept nothing.
    if (this.config.registry?.enabled) return [];

    // Single-service setup — return undefined to accept all.
    return undefined;
  }
}
