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
  /** Enqueue a decorated command/query class instance. */
  enqueue<T extends object>(commandOrQuery: T, options?: { entityId?: string }): Promise<IMessageRef>;
  /** Enqueue a raw message by name and payload (no class needed — cross-service). */
  enqueue(messageName: string, entityId: string, data: Record<string, any>): Promise<IMessageRef>;

  /** Enqueue a Reply-branded command/query and wait — return type inferred from the brand. */
  enqueueAndWait<T extends Reply<any>>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<InferReply<T>>;
  /** Enqueue a decorated command/query and wait for its result. */
  enqueueAndWait<T extends object, R = any>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<R>;
  /** Enqueue a raw message and wait for its result (no class needed — cross-service). */
  enqueueAndWait<R = any>(messageName: string, entityId: string, data: Record<string, any>, timeout?: number): Promise<R>;

  /** Enqueue multiple decorated command/query instances. */
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
  // ENQUEUE — unified API for local classes and foreign raw payloads
  // =========================================================================

  /** Enqueue a decorated command/query class instance. */
  async enqueue<T extends object>(commandOrQuery: T, options?: { entityId?: string }): Promise<IMessageRef>;
  /** Enqueue a raw message by entity type, name, and payload (no class needed). */
  async enqueue(entityType: string, messageName: string, entityId: string, data: Record<string, any>): Promise<IMessageRef>;
  async enqueue(
    commandOrEntityType: object | string,
    messageNameOrOptions?: string | { entityId?: string },
    entityId?: string,
    data?: Record<string, any>,
  ): Promise<IMessageRef> {
    if (typeof commandOrEntityType === 'string') {
      return this._raw(
        commandOrEntityType,
        messageNameOrOptions as string,
        entityId!,
        data!,
      );
    }

    const commandOrQuery = commandOrEntityType;
    const options = messageNameOrOptions as { entityId?: string } | undefined;
    const entityType = getEntityType(commandOrQuery.constructor);
    if (!entityType) {
      throw new Error(
        `Cannot enqueue ${commandOrQuery.constructor.name}. Add @EntityType('type') decorator.`,
      );
    }
    return this._enqueue(entityType, commandOrQuery, options?.entityId);
  }

  // =========================================================================
  // ENQUEUE AND WAIT — unified API with reply
  // =========================================================================

  /** Enqueue a Reply-branded command/query and wait — return type inferred from the brand. */
  async enqueueAndWait<T extends Reply<any>>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<InferReply<T>>;
  /** Enqueue a decorated command/query and wait for its result. */
  async enqueueAndWait<T extends object, R = any>(commandOrQuery: T, options?: { entityId?: string; timeout?: number }): Promise<R>;
  /** Enqueue a raw message and wait for its result (no class needed). */
  async enqueueAndWait<R = any>(entityType: string, messageName: string, entityId: string, data: Record<string, any>, timeout?: number): Promise<R>;
  async enqueueAndWait(
    commandOrEntityType: object | string,
    messageNameOrOptions?: string | { entityId?: string; timeout?: number },
    entityIdOrNothing?: string,
    data?: Record<string, any>,
    timeout?: number,
  ): Promise<any> {
    if (typeof commandOrEntityType === 'string') {
      return this._rawAndWait(
        commandOrEntityType,
        messageNameOrOptions as string,
        entityIdOrNothing!,
        data!,
        timeout,
      );
    }

    const commandOrQuery = commandOrEntityType;
    const options = messageNameOrOptions as { entityId?: string; timeout?: number } | undefined;
    const entityType = getEntityType(commandOrQuery.constructor);
    if (!entityType) {
      throw new Error(
        `Cannot enqueue ${commandOrQuery.constructor.name}. Add @EntityType('type') decorator.`,
      );
    }
    return this._enqueueAndWait(entityType, commandOrQuery, options?.entityId, options?.timeout);
  }

  // =========================================================================
  // FOR ENTITY — scoped API with the same overloads
  // =========================================================================

  forEntity(entityType: string): EntityTarget {
    const self = this;

    const target: EntityTarget = {
      async enqueue(
        commandOrMsgName: any,
        entityIdOrOptions?: any,
        data?: any,
      ): Promise<IMessageRef> {
        if (typeof commandOrMsgName === 'string') {
          return self._raw(entityType, commandOrMsgName, entityIdOrOptions, data);
        }
        return self._enqueue(entityType, commandOrMsgName, entityIdOrOptions?.entityId);
      },

      async enqueueAndWait(
        commandOrMsgName: any,
        entityIdOrOptions?: any,
        dataOrNothing?: any,
        timeout?: number,
      ): Promise<any> {
        if (typeof commandOrMsgName === 'string') {
          return self._rawAndWait(entityType, commandOrMsgName, entityIdOrOptions, dataOrNothing, timeout);
        }
        return self._enqueueAndWait(entityType, commandOrMsgName, entityIdOrOptions?.entityId, entityIdOrOptions?.timeout);
      },

      async enqueueBulk(
        commands: object[],
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

    return target;
  }

  // =========================================================================
  // INTROSPECT — read live contracts from the cluster registry
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

  static discoverFromCqrs(discoveryService: DiscoveryService): { commands: number; queries: number } {
    const providers = (discoveryService as any).getProviders?.() ?? [];
    const { commands, queries } = discoverCqrsClasses(providers);

    for (const [name, cls] of commands) {
      if (!QueueBus.globalRegistry.has(name)) {
        QueueBus.register(cls as Type<any>, false);
      }
    }
    for (const [name, cls] of queries) {
      if (!QueueBus.globalRegistry.has(name)) {
        QueueBus.register(cls as Type<any>, true);
      }
    }

    return { commands: commands.size, queries: queries.size };
  }

  // =========================================================================
  // PRIVATE — class-based enqueue (extracts name/data from decorators)
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

    return this._raw(entityType, jobName, entityId, data);
  }

  private async _enqueueAndWait<T extends object, R = any>(
    entityType: string,
    commandOrQuery: T,
    entityIdOverride?: string,
    timeout?: number,
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

    return this._rawAndWait(entityType, jobName, entityId, data, timeout);
  }

  // =========================================================================
  // PRIVATE — raw enqueue (message name + plain data, no class needed)
  // =========================================================================

  private async _raw(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, any>,
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

  private async _rawAndWait<R = any>(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, any>,
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
