import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import {
  getEntityType,
  getEntityIdProperty,
  getActorMetadata,
  getActorHandlers,
  getJobCommandMetadata,
  getJobQueryMetadata,
  getSchemaMetadata,
  getReplySchemaMetadata,
} from '../../decorators';
import { QueueBus } from '../queue-bus';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';
import { EntityContract, MessageSpec, RegistryChange, RegistrySnapshot } from './registry.types';
import { convertZodToJsonSchema } from './schema-converter';

@Injectable()
export class RegistryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RegistryService.name);
  private readonly keyPrefix: string;
  private readonly enabled: boolean;
  private readonly serviceName: string;
  private readonly schemaValidation: boolean;
  private readonly registrationTTL: number;
  private readonly heartbeatInterval: number;

  private readonly cache = new Map<string, EntityContract>();
  private readonly changeListeners: Array<(change: RegistryChange) => void> = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private subscriber: Redis | null = null;
  private readonly ownedEntityTypes = new Set<string>();

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    @Optional() private readonly discoveryService: DiscoveryService,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
    this.enabled = config.registry?.enabled ?? false;
    this.serviceName = config.registry?.serviceName ?? 'unknown';
    this.schemaValidation = config.registry?.schemaValidation ?? false;
    this.registrationTTL = config.registry?.registrationTTL ?? 30;
    this.heartbeatInterval = config.registry?.heartbeatInterval ?? 10000;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;

    this.subscriber = this.redis.duplicate();
    const updateChannel = this.getUpdateChannel();
    await this.subscriber.subscribe(updateChannel);
    this.subscriber.on('message', (_ch: string, payload: string) => {
      this.handleRegistryUpdate(payload);
    });

    await this.publishLocalContracts();

    this.heartbeatTimer = setInterval(() => {
      this.refreshRegistrations().catch((err) => {
        this.logger.error(`Heartbeat failed: ${(err as Error).message}`);
      });
    }, this.heartbeatInterval);

    this.logger.log(
      `Registry enabled for service '${this.serviceName}' with ${this.ownedEntityTypes.size} entity types`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.enabled) return;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    if (this.subscriber) {
      await this.subscriber.unsubscribe();
      await this.subscriber.quit();
    }
  }

  async getContract(entityType: string): Promise<EntityContract | null> {
    if (!this.enabled) return null;

    const cached = this.cache.get(entityType);
    if (cached) return cached;

    const key = this.getRegistryKey(entityType);
    const raw = await this.redis.get(key);
    if (!raw) return null;

    const contract = JSON.parse(raw) as EntityContract;
    this.cache.set(entityType, contract);
    return contract;
  }

  async listEntityTypes(): Promise<string[]> {
    if (!this.enabled) return [];

    const pattern = `${this.keyPrefix}:registry:*`;
    const keys = await this.scanKeys(pattern);
    return keys.map((k) => k.replace(`${this.keyPrefix}:registry:`, ''));
  }

  async getMessage(entityType: string, messageName: string): Promise<MessageSpec | null> {
    const contract = await this.getContract(entityType);
    if (!contract) return null;
    return contract.messages[messageName] ?? null;
  }

  watchChanges(callback: (change: RegistryChange) => void): () => void {
    this.changeListeners.push(callback);
    return () => {
      const idx = this.changeListeners.indexOf(callback);
      if (idx >= 0) this.changeListeners.splice(idx, 1);
    };
  }

  async exportSnapshot(): Promise<RegistrySnapshot> {
    const entityTypes = await this.listEntityTypes();
    const entities: EntityContract[] = [];

    for (const et of entityTypes) {
      const contract = await this.getContract(et);
      if (contract) entities.push(contract);
    }

    return {
      generatedAt: Date.now(),
      keyPrefix: this.keyPrefix,
      entities,
    };
  }

  async validate(
    entityType: string,
    messageName: string,
    data?: Record<string, any>,
  ): Promise<void> {
    if (!this.enabled) return;

    const contract = await this.getContract(entityType);

    if (!contract) {
      throw new Error(
        `[Registry] Unknown entity type '${entityType}'. ` +
          `No service has registered handlers for this entity type. ` +
          `Registered types: [${(await this.listEntityTypes()).join(', ')}]`,
      );
    }

    const msgSpec = contract.messages[messageName];
    if (!msgSpec) {
      const accepted = Object.keys(contract.messages).join(', ');
      throw new Error(
        `[Registry] Entity '${entityType}' (service: ${contract.serviceName}) does not accept message '${messageName}'. ` +
          `Accepted messages: [${accepted}]`,
      );
    }

    if (this.schemaValidation && msgSpec.schema && data) {
      this.validateJsonSchema(data, msgSpec.schema, entityType, messageName);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private async publishLocalContracts(): Promise<void> {
    if (!this.discoveryService) return;

    const contracts = new Map<string, EntityContract>();

    const providers = this.discoveryService.getProviders();

    // 1. @Actor classes and auto-discovered @On handlers
    for (const wrapper of providers) {
      const { metatype } = wrapper;
      if (!metatype) continue;

      const handlers = getActorHandlers(metatype);
      if (handlers.length === 0) continue;

      // If @Actor is present, use its explicit entity type.
      // Otherwise, infer from the message classes' @EntityType.
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

      const contract = this.getOrCreateContract(contracts, entityType);
      for (const handler of handlers) {
        const msgClass = handler.messageClass;
        const msgName = msgClass.name;
        if (!contract.messages[msgName]) {
          contract.messages[msgName] = this.buildMessageSpec(msgClass);
        }
      }
    }

    // 2. @JobCommand / @JobQuery classes
    for (const wrapper of providers) {
      const { metatype } = wrapper;
      if (!metatype) continue;

      const cmdMeta = getJobCommandMetadata(metatype);
      if (cmdMeta && cmdMeta.entityType) {
        const contract = this.getOrCreateContract(contracts, cmdMeta.entityType);
        const msgName = cmdMeta.targetClass.name;
        if (!contract.messages[msgName]) {
          contract.messages[msgName] = this.buildMessageSpec(cmdMeta.targetClass, 'command');
        }
      }

      const queryMeta = getJobQueryMetadata(metatype);
      if (queryMeta && queryMeta.entityType) {
        const contract = this.getOrCreateContract(contracts, queryMeta.entityType);
        const msgName = queryMeta.targetClass.name;
        if (!contract.messages[msgName]) {
          contract.messages[msgName] = this.buildMessageSpec(queryMeta.targetClass, 'query');
        }
      }
    }

    // 3. @CommandHandler / @QueryHandler (CQRS)
    const COMMAND_HANDLER_METADATA = '__commandHandler__';
    const QUERY_HANDLER_METADATA = '__queryHandler__';

    for (const wrapper of providers) {
      const { metatype } = wrapper;
      if (!metatype) continue;

      const commandClass = Reflect.getMetadata(COMMAND_HANDLER_METADATA, metatype);
      if (commandClass && typeof commandClass === 'function') {
        const entityType = getEntityType(commandClass);
        if (entityType) {
          const contract = this.getOrCreateContract(contracts, entityType);
          if (!contract.messages[commandClass.name]) {
            contract.messages[commandClass.name] = this.buildMessageSpec(commandClass, 'command');
          }
        }
      }

      const queryClass = Reflect.getMetadata(QUERY_HANDLER_METADATA, metatype);
      if (queryClass && typeof queryClass === 'function') {
        const entityType = getEntityType(queryClass);
        if (entityType) {
          const contract = this.getOrCreateContract(contracts, entityType);
          if (!contract.messages[queryClass.name]) {
            contract.messages[queryClass.name] = this.buildMessageSpec(queryClass, 'query');
          }
        }
      }
    }

    // 4. QueueBus static registry
    const queueBusRegistry = QueueBus.getAllRegistered();
    for (const [className, entry] of queueBusRegistry) {
      const entityType = getEntityType(entry.targetClass);
      if (entityType) {
        const contract = this.getOrCreateContract(contracts, entityType);
        if (!contract.messages[className]) {
          contract.messages[className] = this.buildMessageSpec(
            entry.targetClass,
            entry.isQuery ? 'query' : 'command',
          );
        }
      }
    }

    for (const [entityType, contract] of contracts) {
      await this.publishContract(entityType, contract);
      this.ownedEntityTypes.add(entityType);
    }
  }

  private buildMessageSpec(msgClass: Function, kind?: 'command' | 'query'): MessageSpec {
    const zodSchema = getSchemaMetadata(msgClass);
    const zodReplySchema = getReplySchemaMetadata(msgClass);

    // If no explicit kind given, infer 'query' when a reply schema is present
    const inferredKind = kind ?? (zodReplySchema ? 'query' : 'command');

    const spec: MessageSpec = {
      kind: inferredKind,
    };

    if (zodSchema) {
      const jsonSchema = convertZodToJsonSchema(zodSchema);
      if (jsonSchema) spec.schema = jsonSchema;
    }

    if (zodReplySchema) {
      const jsonReplySchema = convertZodToJsonSchema(zodReplySchema);
      if (jsonReplySchema) spec.replySchema = jsonReplySchema;
    }

    const entityIdField = getEntityIdProperty(msgClass);
    if (entityIdField) spec.entityIdField = entityIdField;

    return spec;
  }

  private getOrCreateContract(
    map: Map<string, EntityContract>,
    entityType: string,
  ): EntityContract {
    let contract = map.get(entityType);
    if (!contract) {
      contract = {
        entityType,
        serviceName: this.serviceName,
        version: '1.0.0',
        messages: {},
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
      };
      map.set(entityType, contract);
    }
    return contract;
  }

  private async publishContract(entityType: string, contract: EntityContract): Promise<void> {
    const key = this.getRegistryKey(entityType);

    const existing = await this.redis.get(key);
    if (existing) {
      const existingContract = JSON.parse(existing) as EntityContract;
      if (existingContract.serviceName !== this.serviceName) {
        this.logger.log(
          `Entity type '${entityType}' co-owned: merging with service '${existingContract.serviceName}'`,
        );
        contract.messages = { ...existingContract.messages, ...contract.messages };
      }
    }

    contract.lastHeartbeat = Date.now();
    await this.redis.set(key, JSON.stringify(contract), 'EX', this.registrationTTL);

    this.cache.set(entityType, contract);

    const change: RegistryChange = {
      entityType,
      action: existing ? 'updated' : 'registered',
      serviceName: this.serviceName,
    };
    await this.redis.publish(this.getUpdateChannel(), JSON.stringify(change));
  }

  private async refreshRegistrations(): Promise<void> {
    for (const entityType of this.ownedEntityTypes) {
      const key = this.getRegistryKey(entityType);
      const raw = await this.redis.get(key);
      if (raw) {
        const contract = JSON.parse(raw) as EntityContract;
        contract.lastHeartbeat = Date.now();
        await this.redis.set(key, JSON.stringify(contract), 'EX', this.registrationTTL);
      } else {
        this.logger.warn(`Registration for '${entityType}' expired — re-publishing`);
        await this.publishLocalContracts();
        return;
      }
    }
  }

  private handleRegistryUpdate(payload: string): void {
    try {
      const change = JSON.parse(payload) as RegistryChange;

      this.cache.delete(change.entityType);

      for (const listener of this.changeListeners) {
        try {
          listener(change);
        } catch (err) {
          this.logger.error(`Registry change listener error: ${(err as Error).message}`);
        }
      }

      if (this.config.verbose) {
        this.logger.debug(
          `Registry update: ${change.action} ${change.entityType} by ${change.serviceName}`,
        );
      }
    } catch {
      // Ignore malformed updates
    }
  }

  private validateJsonSchema(
    data: Record<string, any>,
    schema: Record<string, any>,
    entityType: string,
    messageName: string,
  ): void {
    if (schema.required && Array.isArray(schema.required)) {
      const missing = schema.required.filter((prop: string) => !(prop in data));
      if (missing.length > 0) {
        throw new Error(
          `[Registry] Schema validation failed for '${messageName}' on '${entityType}': ` +
            `missing required fields: [${missing.join(', ')}]`,
        );
      }
    }

    if (schema.properties && typeof schema.properties === 'object') {
      for (const [prop, propSchema] of Object.entries(schema.properties)) {
        if (prop in data) {
          const expectedType = (propSchema as any).type;
          const actualValue = data[prop];
          if (expectedType && actualValue !== undefined && actualValue !== null) {
            const actualType = typeof actualValue;
            const typeMatch =
              (expectedType === 'string' && actualType === 'string') ||
              (expectedType === 'number' && actualType === 'number') ||
              (expectedType === 'integer' &&
                actualType === 'number' &&
                Number.isInteger(actualValue)) ||
              (expectedType === 'boolean' && actualType === 'boolean') ||
              (expectedType === 'object' && actualType === 'object') ||
              (expectedType === 'array' && Array.isArray(actualValue));

            if (!typeMatch) {
              throw new Error(
                `[Registry] Schema validation failed for '${messageName}' on '${entityType}': ` +
                  `field '${prop}' expected ${expectedType}, got ${actualType}`,
              );
            }
          }
        }
      }
    }
  }

  private getRegistryKey(entityType: string): string {
    return `${this.keyPrefix}:registry:${entityType}`;
  }

  private getUpdateChannel(): string {
    return `${this.keyPrefix}:registry:updates`;
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    let cursor = '0';
    const keys: string[] = [];
    do {
      const [nextCursor, foundKeys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...foundKeys);
    } while (cursor !== '0');
    return keys;
  }
}
