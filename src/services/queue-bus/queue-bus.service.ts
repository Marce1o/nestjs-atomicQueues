import { Injectable, Logger, Inject, Type, Optional, forwardRef } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { v4 as uuidv4 } from 'uuid';
import {
  IAtomicQueuesModuleConfig,
  ISerializedMessage,
  IMessageRef,
  Reply,
  InferReply,
} from '../../domain';
import { getEntityType } from '../../decorators';
import { resolveKeyPrefix, discoverCqrsClasses } from '../../utils';
import { LogService } from '../log';
import { ExecutorPoolService } from '../executor-pool';
import { HandlerExecutor } from '../handler-executor';
import { ResultCollector } from '../result-collector';
import { RegistryService } from '../registry';
import { ATOMIC_QUEUES_CONFIG } from '../constants';
import { getJobName, extractData, extractEntityIdExplicit } from './queue-bus.utils';
import { ClusterContracts } from './cluster-contracts';

export interface EntityTarget {
  enqueue<T extends object>(commandOrQuery: T, options?: { entityId?: string }): Promise<IMessageRef>;
  enqueue(messageName: string, entityId: string, data: Record<string, unknown>): Promise<IMessageRef>;

  enqueueAndWait<T extends Reply<unknown>>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<InferReply<T>>;
  enqueueAndWait<T extends object, R = unknown>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<R>;
  enqueueAndWait<R = unknown>(messageName: string, entityId: string, data: Record<string, unknown>, timeout?: number): Promise<R>;

  enqueueClass<T extends object>(commandOrQuery: T, options?: { entityId?: string }): Promise<IMessageRef>;
  enqueueRaw(messageName: string, entityId: string, data: Record<string, unknown>): Promise<IMessageRef>;

  enqueueClassAndWait<T extends Reply<unknown>>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<InferReply<T>>;
  enqueueClassAndWait<T extends object, R = unknown>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<R>;
  enqueueRawAndWait<R = unknown>(messageName: string, entityId: string, data: Record<string, unknown>, timeout?: number): Promise<R>;

  enqueueBulk<T extends object>(commands: T[], options?: { entityId?: string }): Promise<IMessageRef[]>;
}

@Injectable()
export class QueueBus {
  private readonly logger = new Logger(QueueBus.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly logService: LogService,
    private readonly executorPool: ExecutorPoolService,
    private readonly handlerExecutor: HandlerExecutor,
    private readonly resultCollector: ResultCollector,
    @Optional() @Inject(forwardRef(() => RegistryService)) private readonly registryService?: RegistryService,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
  }

  // =========================================================================
  // EXPLICIT PUBLIC API — class-based
  // =========================================================================

  async enqueueClass<T extends object>(
    commandOrQuery: T,
    options?: { entityId?: string },
  ): Promise<IMessageRef> {
    const entityType = this.resolveEntityType(commandOrQuery);
    return this.dispatchClass(entityType, commandOrQuery, options?.entityId);
  }

  async enqueueClassAndWait<T extends Reply<unknown>>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<InferReply<T>>;
  async enqueueClassAndWait<T extends object, R = unknown>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<R>;
  async enqueueClassAndWait<T extends object>(
    commandOrQuery: T,
    options?: { entityId?: string; timeout?: number },
  ): Promise<unknown> {
    const entityType = this.resolveEntityType(commandOrQuery);
    return this.dispatchClassAndWait(entityType, commandOrQuery, options?.entityId, options?.timeout);
  }

  // =========================================================================
  // EXPLICIT PUBLIC API — raw (cross-service, no class needed)
  // =========================================================================

  async enqueueRaw(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
  ): Promise<IMessageRef> {
    return this.dispatchRaw(entityType, messageName, entityId, data);
  }

  async enqueueRawAndWait<R = unknown>(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
    timeout?: number,
  ): Promise<R> {
    return this.dispatchRawAndWait<R>(entityType, messageName, entityId, data, timeout);
  }

  // =========================================================================
  // BACKWARD-COMPATIBLE OVERLOADED FACADES
  // =========================================================================

  async enqueue<T extends object>(commandOrQuery: T, options?: { entityId?: string }): Promise<IMessageRef>;
  async enqueue(entityType: string, messageName: string, entityId: string, data: Record<string, unknown>): Promise<IMessageRef>;
  async enqueue(
    commandOrEntityType: object | string,
    messageNameOrOptions?: string | { entityId?: string },
    entityId?: string,
    data?: Record<string, unknown>,
  ): Promise<IMessageRef> {
    if (typeof commandOrEntityType === 'string') {
      return this.enqueueRaw(commandOrEntityType, messageNameOrOptions as string, entityId!, data!);
    }
    return this.enqueueClass(commandOrEntityType, messageNameOrOptions as { entityId?: string } | undefined);
  }

  async enqueueAndWait<T extends Reply<unknown>>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<InferReply<T>>;
  async enqueueAndWait<T extends object, R = unknown>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<R>;
  async enqueueAndWait<R = unknown>(entityType: string, messageName: string, entityId: string, data: Record<string, unknown>, timeout?: number): Promise<R>;
  async enqueueAndWait(
    commandOrEntityType: object | string,
    messageNameOrOptions?: string | { entityId?: string; timeout?: number },
    entityIdOrNothing?: string,
    data?: Record<string, unknown>,
    timeout?: number,
  ): Promise<unknown> {
    if (typeof commandOrEntityType === 'string') {
      return this.enqueueRawAndWait(commandOrEntityType, messageNameOrOptions as string, entityIdOrNothing!, data!, timeout);
    }
    return this.enqueueClassAndWait(commandOrEntityType, messageNameOrOptions as { entityId?: string; timeout?: number } | undefined);
  }

  // =========================================================================
  // FOR ENTITY — scoped API
  // =========================================================================

  forEntity(entityType: string): EntityTarget {
    const self = this;

    return {
      enqueue<T extends object>(
        commandOrMsgName: T | string,
        entityIdOrOptions?: string | { entityId?: string },
        data?: Record<string, unknown>,
      ): Promise<IMessageRef> {
        if (typeof commandOrMsgName === 'string') {
          return self.dispatchRaw(entityType, commandOrMsgName, entityIdOrOptions as string, data!);
        }
        return self.dispatchClass(entityType, commandOrMsgName, (entityIdOrOptions as { entityId?: string })?.entityId);
      },

      enqueueAndWait(
        commandOrMsgName: object | string,
        entityIdOrOptions?: string | { entityId?: string; timeout?: number },
        dataOrNothing?: Record<string, unknown>,
        timeout?: number,
      ): Promise<unknown> {
        if (typeof commandOrMsgName === 'string') {
          return self.dispatchRawAndWait(entityType, commandOrMsgName, entityIdOrOptions as string, dataOrNothing!, timeout);
        }
        const opts = entityIdOrOptions as { entityId?: string; timeout?: number } | undefined;
        return self.dispatchClassAndWait(entityType, commandOrMsgName, opts?.entityId, opts?.timeout);
      },

      enqueueClass<T extends object>(commandOrQuery: T, options?: { entityId?: string }): Promise<IMessageRef> {
        return self.dispatchClass(entityType, commandOrQuery, options?.entityId);
      },

      enqueueRaw(messageName: string, entityId: string, data: Record<string, unknown>): Promise<IMessageRef> {
        return self.dispatchRaw(entityType, messageName, entityId, data);
      },

      enqueueClassAndWait(commandOrQuery: object, options?: { entityId?: string; timeout?: number }): Promise<unknown> {
        return self.dispatchClassAndWait(entityType, commandOrQuery, options?.entityId, options?.timeout);
      },

      enqueueRawAndWait<R = unknown>(messageName: string, entityId: string, data: Record<string, unknown>, timeout?: number): Promise<R> {
        return self.dispatchRawAndWait<R>(entityType, messageName, entityId, data, timeout);
      },

      async enqueueBulk(
        commands: object[],
        options?: { entityId?: string },
      ): Promise<IMessageRef[]> {
        const refs: IMessageRef[] = [];
        for (const cmd of commands) {
          refs.push(await self.dispatchClass(entityType, cmd, options?.entityId));
        }
        await self.executorPool.tickle();
        return refs;
      },
    };
  }

  // =========================================================================
  // INTROSPECT
  // =========================================================================

  async introspect(): Promise<ClusterContracts> {
    if (!this.registryService) {
      throw new Error(
        'Cannot introspect: registry is not configured. ' +
        'Enable it with: registry: { enabled: true, serviceName: "..." }',
      );
    }

    const snapshot = await this.registryService.exportSnapshot();
    return new ClusterContracts(snapshot);
  }

  // =========================================================================
  // STATIC REGISTRY
  // =========================================================================

  private static readonly globalRegistry = new Map<string, { className: string; targetClass: Type<unknown>; isQuery: boolean }>();

  static register(targetClass: Type<unknown>, isQuery = false): void {
    QueueBus.globalRegistry.set(targetClass.name, {
      className: targetClass.name,
      targetClass,
      isQuery,
    });
  }

  static registerCommands(...commands: Type<unknown>[]): void {
    commands.forEach(cmd => QueueBus.register(cmd, false));
  }

  static registerQueries(...queries: Type<unknown>[]): void {
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

  static discoverFromCqrs(discoveryService: DiscoveryService): { commands: number; queries: number } {
    const providers = (discoveryService as { getProviders?: () => { metatype?: Function | null }[] }).getProviders?.() ?? [];
    const { commands, queries } = discoverCqrsClasses(providers);

    for (const [name, cls] of commands) {
      if (!QueueBus.globalRegistry.has(name)) {
        QueueBus.register(cls as Type<unknown>, false);
      }
    }
    for (const [name, cls] of queries) {
      if (!QueueBus.globalRegistry.has(name)) {
        QueueBus.register(cls as Type<unknown>, true);
      }
    }

    return { commands: commands.size, queries: queries.size };
  }

  // =========================================================================
  // PRIVATE — class-based dispatch (extracts name/data from decorators)
  // =========================================================================

  private resolveEntityType(commandOrQuery: object): string {
    const entityType = getEntityType(commandOrQuery.constructor);
    if (!entityType) {
      throw new Error(
        `Cannot enqueue ${commandOrQuery.constructor.name}. Add @EntityType('type') decorator.`,
      );
    }
    return entityType;
  }

  private async dispatchClass<T extends object>(
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

    return this.dispatchRaw(entityType, jobName, entityId, data);
  }

  private async dispatchClassAndWait<T extends object>(
    entityType: string,
    commandOrQuery: T,
    entityIdOverride?: string,
    timeout?: number,
  ): Promise<unknown> {
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

    return this.dispatchRawAndWait(entityType, jobName, entityId, data, timeout);
  }

  // =========================================================================
  // PRIVATE — raw dispatch (message name + plain data, no class needed)
  // =========================================================================

  private async dispatchRaw(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
  ): Promise<IMessageRef> {
    const entityKey = `${entityType}:${entityId}`;
    const entityConfig = this.config.entities?.[entityType];
    const retryConfig = entityConfig?.retry ?? this.config.retry;

    if (this.registryService?.isEnabled()) {
      await this.registryService.validate(entityType, messageName, data);
    }

    const message: ISerializedMessage = {
      id: uuidv4(),
      name: messageName,
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

  private resolveTimeout(entityType: string, explicit?: number): number {
    if (explicit !== undefined) return explicit;

    const entityConfig = this.config.entities?.[entityType];
    if (entityConfig?.replyTimeout) return entityConfig.replyTimeout;
    if (this.config.executor?.defaultReplyTimeout) return this.config.executor.defaultReplyTimeout;

    const gateTTL = entityConfig?.gateTTL ?? this.config.executor?.gateTTL ?? 30;
    return gateTTL * 2 * 1000;
  }

  private async dispatchRawAndWait<R = unknown>(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
    timeout?: number,
  ): Promise<R> {
    const entityKey = `${entityType}:${entityId}`;
    const correlationId = uuidv4();
    const entityConfig = this.config.entities?.[entityType];
    const retryConfig = entityConfig?.retry ?? this.config.retry;

    if (this.registryService?.isEnabled()) {
      await this.registryService.validate(entityType, messageName, data);
    }

    const message: ISerializedMessage = {
      id: uuidv4(),
      name: messageName,
      data,
      entityType,
      entityId,
      isQuery: true,
      correlationId,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: retryConfig?.maxAttempts ?? 3,
    };

    const resolvedTimeout = this.resolveTimeout(entityType, timeout);
    const resultPromise = this.resultCollector.waitForResult<R>(correlationId, resolvedTimeout);

    await this.logService.append(entityKey, message);
    await this.executorPool.tickle();

    return resultPromise;
  }
}
