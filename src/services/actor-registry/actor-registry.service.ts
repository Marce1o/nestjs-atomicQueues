import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown, Optional, Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { getActorMetadata, getActorHandlers, getEntityType } from '../../decorators';
import { ActorOptions, ActorHandlerMetadata } from '../../decorators/interfaces';
import { HandlerExecutor } from '../handler-executor';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

interface ActorDefinition {
  options: ActorOptions;
  targetClass: Type<unknown>;
  handlers: ActorHandlerMetadata[];
  handlerMap: Map<string, string>;
}

interface ActorInstance {
  instance: Record<string, unknown>;
  entityId: string;
  entityType: string;
  lastAccessedAt: number;
}

@Injectable()
export class ActorRegistry implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ActorRegistry.name);
  private readonly keyPrefix: string;

  private readonly definitions = new Map<string, ActorDefinition>();
  private readonly instances = new Map<string, ActorInstance>();
  private evictionInterval: NodeJS.Timeout | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    @Optional() private readonly discoveryService: DiscoveryService,
    private readonly handlerExecutor: HandlerExecutor,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
  }

  async onModuleInit(): Promise<void> {
    this.discoverActors();
    this.registerWithExecutor();
    this.startEvictionCycle();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.evictionInterval) {
      clearInterval(this.evictionInterval);
    }
    for (const [entityKey, entry] of this.instances) {
      await this.persistState(entityKey, entry);
    }
    this.instances.clear();
  }

  private discoverActors(): void {
    if (!this.discoveryService) return;

    const providers = this.discoveryService.getProviders();
    for (const wrapper of providers) {
      const { metatype, instance } = wrapper;
      if (!metatype || !instance) continue;

      const handlers = getActorHandlers(metatype);
      if (handlers.length === 0) continue;

      const actorMeta = getActorMetadata(metatype);
      let entityType: string | undefined;

      if (actorMeta) {
        entityType = actorMeta.entityType;
      } else {
        for (const h of handlers) {
          const et = getEntityType(h.messageClass);
          if (et) {
            entityType = et;
            break;
          }
        }
      }

      if (!entityType) continue;

      const handlerMap = new Map<string, string>();
      for (const h of handlers) {
        handlerMap.set(h.messageClass.name, h.methodName);
      }

      const definition: ActorDefinition = {
        options: actorMeta ?? { entityType },
        targetClass: metatype as Type<unknown>,
        handlers,
        handlerMap,
      };

      this.definitions.set(entityType, definition);
      this.logger.log(
        `Registered actor: ${metatype.name} for entity type '${entityType}' with ${handlers.length} handlers`,
      );
    }
  }

  private registerWithExecutor(): void {
    for (const [entityType, def] of this.definitions) {
      this.handlerExecutor.registerActor(
        entityType,
        { _placeholder: true } as unknown as Record<string, Function>,
        def.handlerMap,
      );
    }
  }

  async getOrCreateInstance(entityType: string, entityId: string): Promise<Record<string, unknown> | null> {
    const definition = this.definitions.get(entityType);
    if (!definition) return null;

    const entityKey = `${entityType}:${entityId}`;
    let entry = this.instances.get(entityKey);

    if (!entry) {
      const instance = Reflect.construct(definition.targetClass, []) as Record<string, unknown>;

      const persisted = this.config.entities?.[entityType]?.statePersistence !== false;
      if (persisted) {
        await this.restoreState(entityKey, instance);
      }

      entry = {
        instance,
        entityId,
        entityType,
        lastAccessedAt: Date.now(),
      };
      this.instances.set(entityKey, entry);
    }

    entry.lastAccessedAt = Date.now();
    return entry.instance;
  }

  hasActor(entityType: string): boolean {
    return this.definitions.has(entityType);
  }

  getHandlerMethod(entityType: string, messageName: string): string | undefined {
    return this.definitions.get(entityType)?.handlerMap.get(messageName);
  }

  getRegisteredEntityTypes(): string[] {
    return Array.from(this.definitions.keys());
  }

  private async persistState(entityKey: string, entry: ActorInstance): Promise<void> {
    const entityConfig = this.config.entities?.[entry.entityType];
    if (entityConfig?.statePersistence === false) return;

    try {
      const stateKey = `${this.keyPrefix}:actor-state:${entityKey}`;
      const stateTTL = entityConfig?.stateTTL ?? 86400;
      const state = this.extractState(entry.instance);
      if (Object.keys(state).length > 0) {
        await this.redis.set(stateKey, JSON.stringify(state), 'EX', stateTTL);
      }
    } catch (err) {
      this.logger.error(`Failed to persist state for ${entityKey}: ${(err as Error).message}`);
    }
  }

  private async restoreState(entityKey: string, instance: Record<string, unknown>): Promise<void> {
    try {
      const stateKey = `${this.keyPrefix}:actor-state:${entityKey}`;
      const raw = await this.redis.get(stateKey);
      if (raw) {
        const state = JSON.parse(raw);
        Object.assign(instance, state);
        this.logger.debug(`Restored state for ${entityKey}`);
      }
    } catch (err) {
      this.logger.error(`Failed to restore state for ${entityKey}: ${(err as Error).message}`);
    }
  }

  private extractState(instance: Record<string, unknown>): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    for (const key of Object.keys(instance)) {
      const val = instance[key];
      if (typeof val === 'function') continue;
      if (val instanceof Map || val instanceof Set || val instanceof Date) continue;
      if (val !== null && typeof val === 'object' && Object.getPrototypeOf(val) !== Object.prototype && !Array.isArray(val)) continue;
      state[key] = val;
    }
    return state;
  }

  private startEvictionCycle(): void {
    const interval = 10000;
    this.evictionInterval = setInterval(async () => {
      const now = Date.now();
      for (const [entityKey, entry] of this.instances) {
        const entityConfig = this.config.entities?.[entry.entityType];
        const idleTimeout = entityConfig?.actorIdleTimeout ?? 60000;

        if (now - entry.lastAccessedAt > idleTimeout) {
          await this.persistState(entityKey, entry);
          this.instances.delete(entityKey);
          this.logger.debug(`Evicted idle actor: ${entityKey}`);
        }
      }
    }, interval);
  }
}
