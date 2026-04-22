import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown, Optional, Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { getActorMetadata, getActorHandlers } from '../../decorators';
import { ActorOptions, ActorHandlerMetadata } from '../../decorators/interfaces';
import { HandlerExecutor } from '../handler-executor';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

interface ActorDefinition {
  options: ActorOptions;
  targetClass: Type<any>;
  handlers: ActorHandlerMetadata[];
  handlerMap: Map<string, string>;
}

interface ActorInstance {
  instance: any;
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

      const actorMeta = getActorMetadata(metatype);
      if (!actorMeta) continue;

      const handlers = getActorHandlers(metatype);
      const handlerMap = new Map<string, string>();
      for (const h of handlers) {
        handlerMap.set(h.messageClass.name, h.methodName);
      }

      const definition: ActorDefinition = {
        options: actorMeta,
        targetClass: metatype as Type<any>,
        handlers,
        handlerMap,
      };

      this.definitions.set(actorMeta.entityType, definition);
      this.logger.log(
        `Registered @Actor: ${metatype.name} for entity type '${actorMeta.entityType}' with ${handlers.length} handlers`,
      );
    }
  }

  private registerWithExecutor(): void {
    for (const [entityType, def] of this.definitions) {
      const proxy: Record<string, Function> = {};

      for (const [msgName, methodName] of def.handlerMap) {
        proxy[methodName] = async (msgData: any) => {
          return msgData;
        };
      }

      this.handlerExecutor.registerActor(entityType, proxy, def.handlerMap);
    }
  }

  async getOrCreateInstance(entityType: string, entityId: string): Promise<any | null> {
    const definition = this.definitions.get(entityType);
    if (!definition) return null;

    const entityKey = `${entityType}:${entityId}`;
    let entry = this.instances.get(entityKey);

    if (!entry) {
      const instance = Object.create(definition.targetClass.prototype);

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
      const state = this.extractState(entry.instance);
      if (Object.keys(state).length > 0) {
        await this.redis.set(stateKey, JSON.stringify(state), 'EX', 86400);
      }
    } catch (err) {
      this.logger.error(`Failed to persist state for ${entityKey}: ${(err as Error).message}`);
    }
  }

  private async restoreState(entityKey: string, instance: any): Promise<void> {
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

  private extractState(instance: any): Record<string, any> {
    const state: Record<string, any> = {};
    for (const key of Object.keys(instance)) {
      const val = instance[key];
      if (typeof val !== 'function') {
        state[key] = val;
      }
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
