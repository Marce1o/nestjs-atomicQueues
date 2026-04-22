import { Injectable, Logger, Inject, Type } from '@nestjs/common';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import {
  IAtomicQueuesModuleConfig,
  ISerializedMessage,
  IMessageRef,
} from '../../domain';
import { getEntityType } from '../../decorators';
import { resolveKeyPrefix } from '../../utils';
import { LogService } from '../log';
import { ExecutorPoolService } from '../executor-pool';
import { HandlerExecutor } from '../handler-executor';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';
import { getJobName, extractData, extractEntityIdExplicit } from './queue-bus.utils';

@Injectable()
export class QueueBus {
  private readonly logger = new Logger(QueueBus.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly logService: LogService,
    private readonly executorPool: ExecutorPoolService,
    private readonly handlerExecutor: HandlerExecutor,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
  }

  async enqueue<T extends object>(
    commandOrQuery: T,
    options?: { entityId?: string },
  ): Promise<IMessageRef> {
    const entityType = getEntityType(commandOrQuery.constructor);
    if (!entityType) {
      throw new Error(
        `Cannot enqueue ${commandOrQuery.constructor.name}. Add @EntityType('type') decorator.`,
      );
    }

    return this._enqueue(entityType, commandOrQuery, options?.entityId);
  }

  forEntity(entityType: string) {
    const self = this;
    return {
      async enqueue<T extends object>(
        commandOrQuery: T,
        options?: { entityId?: string },
      ): Promise<IMessageRef> {
        return self._enqueue(entityType, commandOrQuery, options?.entityId);
      },

      async enqueueAndWait<T extends object, R = any>(
        commandOrQuery: T,
        options?: { entityId?: string; timeout?: number },
      ): Promise<R> {
        return self._enqueueAndWait(entityType, commandOrQuery, options?.entityId, options?.timeout);
      },

      async enqueueBulk<T extends object>(
        commands: T[],
        options?: { entityId?: string },
      ): Promise<IMessageRef[]> {
        const refs: IMessageRef[] = [];
        for (const cmd of commands) {
          refs.push(await self._enqueue(entityType, cmd, options?.entityId));
        }
        await self.executorPool.tickle();
        return refs;
      },
    };
  }

  async enqueueAndWait<T extends object, R = any>(
    commandOrQuery: T,
    options?: { entityId?: string; timeout?: number },
  ): Promise<R> {
    const entityType = getEntityType(commandOrQuery.constructor);
    if (!entityType) {
      throw new Error(
        `Cannot enqueue ${commandOrQuery.constructor.name}. Add @EntityType('type') decorator.`,
      );
    }
    return this._enqueueAndWait(entityType, commandOrQuery, options?.entityId, options?.timeout);
  }

  // =========================================================================
  // STATIC REGISTRY
  // =========================================================================

  private static readonly globalRegistry = new Map<string, { className: string; targetClass: Type<any>; isQuery: boolean }>();

  static register(targetClass: Type<any>, isQuery = false): void {
    QueueBus.globalRegistry.set(targetClass.name, {
      className: targetClass.name,
      targetClass,
      isQuery,
    });
  }

  static registerCommands(...commands: Type<any>[]): void {
    commands.forEach(cmd => QueueBus.register(cmd, false));
  }

  static registerQueries(...queries: Type<any>[]): void {
    queries.forEach(q => QueueBus.register(q, true));
  }

  static getRegistered(className: string) {
    return QueueBus.globalRegistry.get(className);
  }

  static isRegistered(className: string): boolean {
    return QueueBus.globalRegistry.has(className);
  }

  static getAllRegistered() {
    return new Map(QueueBus.globalRegistry);
  }

  static discoverFromCqrs(discoveryService: any): { commands: number; queries: number } {
    const COMMAND_HANDLER_METADATA = '__commandHandler__';
    const QUERY_HANDLER_METADATA = '__queryHandler__';
    let commandCount = 0;
    let queryCount = 0;

    const providers = discoveryService.getProviders?.() ?? [];
    for (const wrapper of providers) {
      const { metatype } = wrapper;
      if (!metatype) continue;

      const commandClass = Reflect.getMetadata(COMMAND_HANDLER_METADATA, metatype);
      if (commandClass && typeof commandClass === 'function') {
        if (!QueueBus.globalRegistry.has(commandClass.name)) {
          QueueBus.register(commandClass, false);
          commandCount++;
        }
      }

      const queryClass = Reflect.getMetadata(QUERY_HANDLER_METADATA, metatype);
      if (queryClass && typeof queryClass === 'function') {
        if (!QueueBus.globalRegistry.has(queryClass.name)) {
          QueueBus.register(queryClass, true);
          queryCount++;
        }
      }
    }

    return { commands: commandCount, queries: queryCount };
  }

  // =========================================================================
  // PRIVATE
  // =========================================================================

  private async _enqueue<T extends object>(
    entityType: string,
    commandOrQuery: T,
    entityIdOverride?: string,
  ): Promise<IMessageRef> {
    const jobName = getJobName(commandOrQuery);
    const data = extractData(commandOrQuery);
    const entityConfig = this.config.entities?.[entityType];
    const entityId = entityIdOverride ?? extractEntityIdExplicit(
      commandOrQuery,
      data,
      undefined,
      entityConfig,
      this.logger,
    );

    const entityKey = `${entityType}:${entityId}`;
    const retryConfig = entityConfig?.retry ?? this.config.retry;

    const message: ISerializedMessage = {
      id: uuidv4(),
      name: jobName,
      data,
      entityType,
      entityId,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: retryConfig?.maxAttempts ?? 3,
    };

    await this.logService.append(entityKey, message);
    await this.executorPool.tickle();

    return { id: message.id, entityKey };
  }

  private async _enqueueAndWait<T extends object, R = any>(
    entityType: string,
    commandOrQuery: T,
    entityIdOverride?: string,
    timeout = 30000,
  ): Promise<R> {
    const jobName = getJobName(commandOrQuery);
    const data = extractData(commandOrQuery);
    const entityConfig = this.config.entities?.[entityType];
    const entityId = entityIdOverride ?? extractEntityIdExplicit(
      commandOrQuery,
      data,
      undefined,
      entityConfig,
      this.logger,
    );

    const entityKey = `${entityType}:${entityId}`;
    const correlationId = uuidv4();
    const retryConfig = entityConfig?.retry ?? this.config.retry;

    const message: ISerializedMessage = {
      id: uuidv4(),
      name: jobName,
      data,
      entityType,
      entityId,
      isQuery: true,
      correlationId,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: retryConfig?.maxAttempts ?? 3,
    };

    const resultChannel = `${this.keyPrefix}:results:${correlationId}`;
    const subscriber = this.redis.duplicate();

    try {
      const resultPromise = new Promise<R>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`enqueueAndWait timeout after ${timeout}ms for ${jobName} on ${entityKey}`));
        }, timeout);

        subscriber.subscribe(resultChannel).then(() => {
          subscriber.on('message', (_ch: string, payload: string) => {
            clearTimeout(timer);
            const parsed = JSON.parse(payload);
            if (parsed.error) {
              reject(new Error(parsed.error));
            } else {
              resolve(parsed.result);
            }
          });
        });
      });

      await this.logService.append(entityKey, message);
      await this.executorPool.tickle();

      return await resultPromise;
    } finally {
      await subscriber.unsubscribe(resultChannel);
      await subscriber.quit();
    }
  }
}
