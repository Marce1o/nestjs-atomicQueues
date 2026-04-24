import { Injectable, Logger, Inject, Type } from '@nestjs/common';
import {
  IAtomicQueuesModuleConfig,
  IMessageRef,
  Reply,
  InferReply,
} from '../../domain';
import { getEntityType } from '../../decorators';
import { resolveKeyPrefix } from '../../utils';
import { MessageRouter } from '../message-router';
import { ATOMIC_QUEUES_CONFIG } from '../constants';
import { getJobName, extractData, extractEntityIdExplicit } from './queue-bus.utils';

export interface EntityTarget {
  enqueue<T extends object>(
    commandOrQuery: T,
    options?: { entityId?: string },
  ): Promise<IMessageRef>;
  enqueue(
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
  ): Promise<IMessageRef>;

  enqueueAndWait<T extends Reply<unknown>>(
    commandOrQuery: T,
    options?: { entityId?: string; timeout?: number },
  ): Promise<InferReply<T>>;
  enqueueAndWait<T extends object, R = unknown>(
    commandOrQuery: T,
    options?: { entityId?: string; timeout?: number },
  ): Promise<R>;
  enqueueAndWait<R = unknown>(
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
    timeout?: number,
  ): Promise<R>;

  enqueueClass<T extends object>(
    commandOrQuery: T,
    options?: { entityId?: string },
  ): Promise<IMessageRef>;
  enqueueRaw(
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
  ): Promise<IMessageRef>;

  enqueueClassAndWait<T extends Reply<unknown>>(
    commandOrQuery: T,
    options?: { entityId?: string; timeout?: number },
  ): Promise<InferReply<T>>;
  enqueueClassAndWait<T extends object, R = unknown>(
    commandOrQuery: T,
    options?: { entityId?: string; timeout?: number },
  ): Promise<R>;
  enqueueRawAndWait<R = unknown>(
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
    timeout?: number,
  ): Promise<R>;

  enqueueBulk<T extends object>(
    commands: T[],
    options?: { entityId?: string },
  ): Promise<IMessageRef[]>;
}

@Injectable()
export class QueueBus {
  private readonly logger = new Logger(QueueBus.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly router: MessageRouter,
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

  async enqueueClassAndWait<T extends Reply<unknown>>(
    commandOrQuery: T,
    options?: { entityId?: string; timeout?: number },
  ): Promise<InferReply<T>>;
  async enqueueClassAndWait<T extends object, R = unknown>(
    commandOrQuery: T,
    options?: { entityId?: string; timeout?: number },
  ): Promise<R>;
  async enqueueClassAndWait<T extends object>(
    commandOrQuery: T,
    options?: { entityId?: string; timeout?: number },
  ): Promise<unknown> {
    const entityType = this.resolveEntityType(commandOrQuery);
    return this.dispatchClassAndWait(
      entityType,
      commandOrQuery,
      options?.entityId,
      options?.timeout,
    );
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
    return this.router.enqueue(entityType, messageName, entityId, data);
  }

  async enqueueRawAndWait<R = unknown>(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
    timeout?: number,
  ): Promise<R> {
    return this.router.enqueueAndWait<R>(entityType, messageName, entityId, data, timeout);
  }

  // =========================================================================
  // BACKWARD-COMPATIBLE OVERLOADED FACADES
  // =========================================================================

  async enqueue<T extends object>(
    commandOrQuery: T,
    options?: { entityId?: string },
  ): Promise<IMessageRef>;
  async enqueue(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
  ): Promise<IMessageRef>;
  async enqueue(
    commandOrEntityType: object | string,
    messageNameOrOptions?: string | { entityId?: string },
    entityId?: string,
    data?: Record<string, unknown>,
  ): Promise<IMessageRef> {
    if (typeof commandOrEntityType === 'string') {
      return this.enqueueRaw(commandOrEntityType, messageNameOrOptions as string, entityId!, data!);
    }
    return this.enqueueClass(
      commandOrEntityType,
      messageNameOrOptions as { entityId?: string } | undefined,
    );
  }

  async enqueueAndWait<T extends Reply<unknown>>(
    commandOrQuery: T,
    options?: { entityId?: string; timeout?: number },
  ): Promise<InferReply<T>>;
  async enqueueAndWait<T extends object, R = unknown>(
    commandOrQuery: T,
    options?: { entityId?: string; timeout?: number },
  ): Promise<R>;
  async enqueueAndWait<R = unknown>(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
    timeout?: number,
  ): Promise<R>;
  async enqueueAndWait(
    commandOrEntityType: object | string,
    messageNameOrOptions?: string | { entityId?: string; timeout?: number },
    entityIdOrNothing?: string,
    data?: Record<string, unknown>,
    timeout?: number,
  ): Promise<unknown> {
    if (typeof commandOrEntityType === 'string') {
      return this.enqueueRawAndWait(
        commandOrEntityType,
        messageNameOrOptions as string,
        entityIdOrNothing!,
        data!,
        timeout,
      );
    }
    return this.enqueueClassAndWait(
      commandOrEntityType,
      messageNameOrOptions as { entityId?: string; timeout?: number } | undefined,
    );
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
          return self.router.enqueue(
            entityType,
            commandOrMsgName,
            entityIdOrOptions as string,
            data!,
          );
        }
        return self.dispatchClass(
          entityType,
          commandOrMsgName,
          (entityIdOrOptions as { entityId?: string })?.entityId,
        );
      },

      enqueueAndWait(
        commandOrMsgName: object | string,
        entityIdOrOptions?: string | { entityId?: string; timeout?: number },
        dataOrNothing?: Record<string, unknown>,
        timeout?: number,
      ): Promise<unknown> {
        if (typeof commandOrMsgName === 'string') {
          return self.router.enqueueAndWait(
            entityType,
            commandOrMsgName,
            entityIdOrOptions as string,
            dataOrNothing!,
            timeout,
          );
        }
        const opts = entityIdOrOptions as { entityId?: string; timeout?: number } | undefined;
        return self.dispatchClassAndWait(
          entityType,
          commandOrMsgName,
          opts?.entityId,
          opts?.timeout,
        );
      },

      enqueueClass<T extends object>(
        commandOrQuery: T,
        options?: { entityId?: string },
      ): Promise<IMessageRef> {
        return self.dispatchClass(entityType, commandOrQuery, options?.entityId);
      },

      enqueueRaw(
        messageName: string,
        entityId: string,
        data: Record<string, unknown>,
      ): Promise<IMessageRef> {
        return self.router.enqueue(entityType, messageName, entityId, data);
      },

      enqueueClassAndWait(
        commandOrQuery: object,
        options?: { entityId?: string; timeout?: number },
      ): Promise<unknown> {
        return self.dispatchClassAndWait(
          entityType,
          commandOrQuery,
          options?.entityId,
          options?.timeout,
        );
      },

      enqueueRawAndWait<R = unknown>(
        messageName: string,
        entityId: string,
        data: Record<string, unknown>,
        timeout?: number,
      ): Promise<R> {
        return self.router.enqueueAndWait<R>(entityType, messageName, entityId, data, timeout);
      },

      async enqueueBulk(
        commands: object[],
        options?: { entityId?: string },
      ): Promise<IMessageRef[]> {
        const refs: IMessageRef[] = [];
        for (const cmd of commands) {
          refs.push(await self.dispatchClass(entityType, cmd, options?.entityId));
        }
        return refs;
      },
    };
  }

  // =========================================================================
  // STATIC REGISTRY (preserved for class registration)
  // =========================================================================

  private static readonly globalRegistry = new Map<
    string,
    { className: string; targetClass: Type<unknown>; isQuery: boolean }
  >();

  static register(targetClass: Type<unknown>, isQuery = false): void {
    QueueBus.globalRegistry.set(targetClass.name, {
      className: targetClass.name,
      targetClass,
      isQuery,
    });
  }

  static registerCommands(...commands: Type<unknown>[]): void {
    commands.forEach((cmd) => QueueBus.register(cmd, false));
  }

  static registerQueries(...queries: Type<unknown>[]): void {
    queries.forEach((q) => QueueBus.register(q, true));
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

  // =========================================================================
  // PRIVATE — class-based dispatch
  // =========================================================================

  private resolveEntityType(commandOrQuery: object): string {
    const entityType = getEntityType(commandOrQuery.constructor);
    if (!entityType) {
      throw new Error(
        `Cannot enqueue ${commandOrQuery.constructor.name}. Add @EntityType('type') or @QueueEntity('type') decorator.`,
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
    const entityId =
      entityIdOverride ??
      extractEntityIdExplicit(commandOrQuery, data, undefined, entityConfig, this.logger);

    return this.router.enqueue(entityType, jobName, entityId, data);
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
    const entityId =
      entityIdOverride ??
      extractEntityIdExplicit(commandOrQuery, data, undefined, entityConfig, this.logger);

    return this.router.enqueueAndWait(entityType, jobName, entityId, data, timeout);
  }
}
