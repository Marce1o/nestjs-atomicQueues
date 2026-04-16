import { Inject, Injectable, Logger, Optional, Type } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueManagerService } from '../queue-manager/queue-manager.service';
import {
  getWorkerProcessorMetadata,
  WorkerProcessorOptions,
  getEntityType,
} from '../../decorators';
import { IAtomicQueuesModuleConfig } from '../../domain/interfaces';
import { ATOMIC_QUEUES_CONFIG } from '../constants';
import { resolveKeyPrefix } from '../../utils';
import { QueueBusExecuteOptions, EnqueueOptions, CommandRegistryEntry } from './queue-bus.types';
import { getJobName, extractData, extractEntityId } from './queue-bus.utils';
import { QueueTarget } from './queue-target';
import { EntityTarget } from './entity-target';

/**
 * QueueBus
 *
 * A bus that works like CommandBus/QueryBus but instead of executing
 * commands/queries directly, it adds them to a BullMQ queue for
 * async processing by a worker.
 *
 * Key Features:
 * - No decorators needed on commands/queries
 * - Job name = class name (MakeBetCommand)
 * - Worker looks up class by name and instantiates from job.data
 * - Works with @nestjs/cqrs CommandBus/QueryBus on worker side
 * - Fluent API: queueBus.forProcessor(Processor).enqueue(command)
 * - Zero-boilerplate API: queueBus.forEntity('type').enqueue(command)
 * - Direct routing: queueBus.enqueue(command) with @EntityType decorator
 *
 * @example
 * ```typescript
 * // Option 1: With @WorkerProcessor class (full control)
 * await this.queueBus
 *   .forProcessor(TableWorkerProcessor)
 *   .enqueue(new MakeBetCommand(tableId, bets, player));
 *
 * // Option 2: With entity type (zero boilerplate)
 * await this.queueBus
 *   .forEntity('table')
 *   .enqueue(new MakeBetCommand(tableId, bets, player));
 *
 * // Option 3: Direct enqueue with @EntityType on command
 * @EntityType('table')
 * class MakeBetCommand { ... }
 *
 * await this.queueBus.enqueue(new MakeBetCommand(tableId, bets, player));
 * ```
 */
@Injectable()
export class QueueBus {
  private readonly logger = new Logger(QueueBus.name);

  /**
   * Cache of processor options by class
   */
  private readonly processorCache = new Map<Type<any>, WorkerProcessorOptions>();

  /**
   * Global registry of command/query classes
   * Key: class name (e.g., 'MakeBetCommand')
   * Value: registry entry with class reference
   */
  private static readonly globalRegistry = new Map<string, CommandRegistryEntry>();

  /**
   * Module config for entity defaults
   */
  private readonly config: IAtomicQueuesModuleConfig | undefined;

  constructor(
    private readonly queueManager: QueueManagerService,
    @Optional() @Inject(ATOMIC_QUEUES_CONFIG) config?: IAtomicQueuesModuleConfig,
  ) {
    this.config = config;
  }

  /**
   * Get key prefix from config using resolveKeyPrefix utility
   */
  private get keyPrefix(): string {
    return resolveKeyPrefix(this.config ?? {});
  }

  /**
   * Get entity config from module config
   */
  private getEntityConfig(entityType: string) {
    return this.config?.entities?.[entityType];
  }

  /**
   * Target a specific processor's queue for enqueueing commands.
   * Use this when you have a @WorkerProcessor class with full config control.
   *
   * @param processorClass - The @WorkerProcessor decorated class
   * @returns QueueTarget builder for fluent API
   *
   * @example
   * await this.queueBus
   *   .forProcessor(TableWorkerProcessor)
   *   .enqueue(new MakeBetCommand(tableId, bets, player));
   */
  forProcessor(processorClass: Type<any>): QueueTarget {
    // Check cache first
    let options = this.processorCache.get(processorClass);

    if (!options) {
      // Get metadata from @WorkerProcessor decorator
      options = getWorkerProcessorMetadata(processorClass);

      if (!options) {
        throw new Error(
          `Class ${processorClass.name} is not decorated with @WorkerProcessor. ` +
          `Cannot determine queue configuration.`,
        );
      }

      // Cache for future use
      this.processorCache.set(processorClass, options);
    }

    // Get entity config for this processor's entityType
    const entityConfig = this.getEntityConfig(options.entityType);

    return new QueueTarget(this.queueManager, processorClass, options, entityConfig);
  }

  /**
   * Target a specific entity type's queue without needing a @WorkerProcessor class.
   * This is the zero-boilerplate approach when you've configured entity defaults
   * in the module config.
   *
   * @param entityType - The entity type (e.g., 'table', 'account')
   * @returns EntityTarget builder for fluent API
   *
   * @example
   * // With module config:
   * // entities: { table: { defaultEntityId: 'tableId' } }
   *
   * await this.queueBus
   *   .forEntity('table')
   *   .enqueue(new MakeBetCommand(tableId, bets, player));
   */
  forEntity(entityType: string): EntityTarget {
    const entityConfig = this.getEntityConfig(entityType);
    return new EntityTarget(this.queueManager, entityType, entityConfig, this.keyPrefix);
  }

  /**
   * Direct enqueue using @EntityType decorator on the command class.
   * This is the most ergonomic approach for commands that have explicit routing.
   *
   * @param commandOrQuery - The command or query instance (must have @EntityType decorator)
   * @param options - Optional settings (entityId override, jobOptions)
   * @returns The created BullMQ job
   *
   * @example
   * @EntityType('account')
   * class WithdrawCommand {
   *   @QueueEntityId()
   *   accountId: string;
   *   // ...
   * }
   *
   * await this.queueBus.enqueue(new WithdrawCommand(accountId, amount));
   */
  async enqueue<T extends object>(
    commandOrQuery: T,
    options?: EnqueueOptions,
  ): Promise<Job> {
    const entityType = getEntityType(commandOrQuery.constructor);

    if (!entityType) {
      throw new Error(
        `Cannot enqueue ${commandOrQuery.constructor.name} directly. ` +
        `Add @EntityType('type') decorator to the class, ` +
        `or use .forProcessor(ProcessorClass).enqueue() or .forEntity('type').enqueue() instead.`,
      );
    }

    return this.forEntity(entityType).enqueue(commandOrQuery, options);
  }

  /**
   * Direct enqueue and wait using @EntityType decorator on the command class.
   */
  async enqueueAndWait<T extends object, R = any>(
    commandOrQuery: T,
    options?: EnqueueOptions & { timeout?: number },
  ): Promise<R> {
    const entityType = getEntityType(commandOrQuery.constructor);

    if (!entityType) {
      throw new Error(
        `Cannot enqueue ${commandOrQuery.constructor.name} directly. ` +
        `Add @EntityType('type') decorator to the class, ` +
        `or use .forProcessor(ProcessorClass).enqueueAndWait() or .forEntity('type').enqueueAndWait() instead.`,
      );
    }

    return this.forEntity(entityType).enqueueAndWait(commandOrQuery, options);
  }

  /**
   * Register a command class for worker-side instantiation
   *
   * @example
   * QueueBus.register(MakeBetCommand);
   * QueueBus.register(GetTableStateQuery, true); // isQuery = true
   */
  static register(targetClass: Type<any>, isQuery = false): void {
    const entry: CommandRegistryEntry = {
      className: targetClass.name,
      targetClass,
      isQuery,
    };
    QueueBus.globalRegistry.set(targetClass.name, entry);
  }

  /**
   * Register multiple commands at once
   */
  static registerCommands(...commands: Type<any>[]): void {
    for (const cmd of commands) {
      QueueBus.register(cmd, false);
    }
  }

  /**
   * Register multiple queries at once
   */
  static registerQueries(...queries: Type<any>[]): void {
    for (const query of queries) {
      QueueBus.register(query, true);
    }
  }

  /**
   * Get a registered class by name
   */
  static getRegistered(className: string): CommandRegistryEntry | undefined {
    return QueueBus.globalRegistry.get(className);
  }

  /**
   * Check if a class name is registered
   */
  static isRegistered(className: string): boolean {
    return QueueBus.globalRegistry.has(className);
  }

  /**
   * Get all registered entries
   */
  static getAllRegistered(): Map<string, CommandRegistryEntry> {
    return new Map(QueueBus.globalRegistry);
  }

  /**
   * Auto-discover and register all commands/queries from CQRS handlers
   *
   * This method discovers all classes decorated with @CommandHandler and @QueryHandler
   * from @nestjs/cqrs and automatically registers them with QueueBus.
   *
   * Call this during module init to enable zero-config command registration.
   *
   * @param discoveryService - NestJS DiscoveryService
   * @returns Number of commands and queries discovered
   *
   * @example
   * ```typescript
   * @Module({})
   * export class MyModule implements OnModuleInit {
   *   constructor(private discoveryService: DiscoveryService) {}
   *
   *   onModuleInit() {
   *     const { commands, queries } = QueueBus.discoverFromCqrs(this.discoveryService);
   *     console.log(`Auto-registered ${commands} commands, ${queries} queries`);
   *   }
   * }
   * ```
   */
  static discoverFromCqrs(discoveryService: any): { commands: number; queries: number } {
    // CQRS metadata keys (from @nestjs/cqrs)
    const COMMAND_HANDLER_METADATA = '__commandHandler__';
    const QUERY_HANDLER_METADATA = '__queryHandler__';

    let commandCount = 0;
    let queryCount = 0;

    const providers = discoveryService.getProviders?.() ?? [];

    for (const wrapper of providers) {
      const { metatype } = wrapper;
      if (!metatype) continue;

      // Check for @CommandHandler
      const commandClass = Reflect.getMetadata(COMMAND_HANDLER_METADATA, metatype);
      if (commandClass && typeof commandClass === 'function') {
        if (!QueueBus.globalRegistry.has(commandClass.name)) {
          QueueBus.register(commandClass, false);
          commandCount++;
        }
      }

      // Check for @QueryHandler
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

  /**
   * Execute a command/query by adding it to a queue
   *
   * @deprecated Use .forProcessor(ProcessorClass).enqueue(command) instead
   *
   * @param queuePattern - Queue name pattern with {entityId} placeholder
   * @param commandOrQuery - The command/query instance to execute
   * @param options - Optional settings (entityId, jobOptions)
   * @returns The created BullMQ job
   */
  async execute<T extends object>(
    queuePattern: string,
    commandOrQuery: T,
    options?: QueueBusExecuteOptions,
  ): Promise<Job> {
    const jobName = getJobName(commandOrQuery);
    const data = extractData(commandOrQuery);
    const entityId = options?.entityId ?? extractEntityId(data, this.logger);

    // Resolve queue name with entityId
    const queueName = this.resolveQueueName(queuePattern, entityId);

    // Get or create the queue
    const queue = this.queueManager.getOrCreateQueue(queueName);

    this.logger.debug(
      `Adding job ${jobName} to queue ${queueName} with entityId=${entityId}`,
    );

    // Add job to queue
    return queue.add(jobName, data, options?.jobOptions);
  }

  /**
   * Execute and wait for result (if supported by worker)
   * Uses BullMQ's waitUntilFinished
   *
   * @deprecated Use .forProcessor(ProcessorClass).enqueueAndWait(command) instead
   */
  async executeAndWait<T extends object, R = any>(
    queuePattern: string,
    commandOrQuery: T,
    options?: QueueBusExecuteOptions & { timeout?: number },
  ): Promise<R> {
    const job = await this.execute(queuePattern, commandOrQuery, options);

    const queueEvents = await this.queueManager.getQueueEvents(
      this.resolveQueueName(
        queuePattern,
        options?.entityId ?? extractEntityId(extractData(commandOrQuery), this.logger),
      ),
    );

    return job.waitUntilFinished(queueEvents, options?.timeout) as Promise<R>;
  }

  /**
   * Add multiple commands/queries to the same queue in bulk
   *
   * @deprecated Use .forProcessor(ProcessorClass).enqueueBulk(commands) instead
   */
  async executeBulk<T extends object>(
    queuePattern: string,
    commandsOrQueries: T[],
    options?: QueueBusExecuteOptions,
  ): Promise<Job[]> {
    if (commandsOrQueries.length === 0) return [];

    const entityId = options?.entityId ?? extractEntityId(
      extractData(commandsOrQueries[0]),
      this.logger,
    );
    const queueName = this.resolveQueueName(queuePattern, entityId);
    const queue = this.queueManager.getOrCreateQueue(queueName);

    const bulkJobs = commandsOrQueries.map((cmd) => ({
      name: getJobName(cmd),
      data: extractData(cmd),
      opts: options?.jobOptions,
    }));

    return queue.addBulk(bulkJobs);
  }

  /**
   * Resolve queue name by replacing {entityId} placeholder
   */
  private resolveQueueName(pattern: string, entityId: string): string {
    return pattern.replace('{entityId}', entityId);
  }
}
