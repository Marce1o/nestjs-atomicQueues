import { Injectable, Logger, Type } from '@nestjs/common';
import { Job, JobsOptions } from 'bullmq';
import { QueueManagerService } from '../queue-manager/queue-manager.service';
import { getWorkerProcessorMetadata, WorkerProcessorOptions } from '../../decorators';

/**
 * Derive job name from class name
 * MakeBetCommand -> MakeBetCommand (keep as-is for lookup)
 */
function getJobName(commandOrQuery: object): string {
  return commandOrQuery.constructor.name;
}

/**
 * Extract all properties from a command/query instance
 */
function extractData(commandOrQuery: object): Record<string, any> {
  const data: Record<string, any> = {};
  
  // Get all enumerable properties
  for (const key of Object.keys(commandOrQuery)) {
    data[key] = (commandOrQuery as any)[key];
  }
  
  return data;
}

/**
 * Extract entityId from command data
 * Tries common property names in order
 */
function extractEntityId(data: Record<string, any>, logger?: Logger): string {
  const candidates = ['entityId', 'tableId', 'userId', 'id', 'gameId', 'playerId'];
  
  for (const key of candidates) {
    if (data[key] !== undefined && data[key] !== null) {
      return String(data[key]);
    }
  }
  
  // Log warning if no entityId found
  logger?.warn(
    `Could not extract entityId from command data. Keys: ${Object.keys(data).join(', ')}`,
  );
  
  return 'default';
}

/**
 * Options for QueueBus.execute()
 * @deprecated Use .forProcessor(ProcessorClass).enqueue(command) instead
 */
export interface QueueBusExecuteOptions {
  /**
   * The entity ID to use for queue name resolution.
   * If not provided, will try to extract from command properties:
   * entityId, tableId, userId, id (in that order)
   */
  entityId?: string;
  
  /**
   * BullMQ job options (priority, delay, attempts, etc.)
   */
  jobOptions?: JobsOptions;
}

/**
 * Options for .enqueue()
 */
export interface EnqueueOptions {
  /**
   * Override the auto-extracted entityId
   */
  entityId?: string;
  
  /**
   * BullMQ job options (priority, delay, attempts, etc.)
   */
  jobOptions?: JobsOptions;
}

/**
 * Registry entry for a command/query class
 */
export interface CommandRegistryEntry {
  className: string;
  targetClass: Type<any>;
  isQuery: boolean;
}

/**
 * QueueTarget - Fluent builder for targeting a specific processor's queue
 * 
 * @example
 * await queueBus
 *   .forProcessor(TableWorkerProcessor)
 *   .enqueue(new MakeBetCommand(tableId, bets, player));
 */
export class QueueTarget {
  private readonly logger = new Logger(QueueTarget.name);
  
  constructor(
    private readonly queueManager: QueueManagerService,
    private readonly processorClass: Type<any>,
    private readonly processorOptions: WorkerProcessorOptions,
  ) {}
  
  /**
   * Get the queue name function from the processor
   */
  private getQueueNameFn(): (entityId: string) => string {
    const { queueName } = this.processorOptions;
    
    if (typeof queueName === 'function') {
      return queueName;
    }
    
    if (typeof queueName === 'string') {
      // Static queue name or pattern with {entityId}
      return (entityId: string) => queueName.replace('{entityId}', entityId);
    }
    
    // Default: entityType-{entityId}-queue
    const { entityType } = this.processorOptions;
    return (entityId: string) => `${entityType}-${entityId}-queue`;
  }
  
  /**
   * Enqueue a command/query for processing
   * 
   * @param commandOrQuery - The command or query instance
   * @param options - Optional settings (entityId override, jobOptions)
   * @returns The created BullMQ job
   * 
   * @example
   * await queueBus
   *   .forProcessor(TableWorkerProcessor)
   *   .enqueue(new MakeBetCommand(tableId, bets, player));
   * 
   * // With job options
   * await queueBus
   *   .forProcessor(TableWorkerProcessor)
   *   .enqueue(new DealCommand(tableId), { jobOptions: { delay: 5000 } });
   */
  async enqueue<T extends object>(
    commandOrQuery: T,
    options?: EnqueueOptions,
  ): Promise<Job> {
    const jobName = getJobName(commandOrQuery);
    const data = extractData(commandOrQuery);
    const entityId = options?.entityId ?? extractEntityId(data, this.logger);
    
    // Get queue name from processor's queueName function
    const queueNameFn = this.getQueueNameFn();
    const queueName = queueNameFn(entityId);
    
    // Get or create the queue
    const queue = this.queueManager.getOrCreateQueue(queueName);
    
    this.logger.debug(
      `[${this.processorClass.name}] Adding job ${jobName} to queue ${queueName}`,
    );
    
    // Add job to queue
    return queue.add(jobName, data, options?.jobOptions);
  }
  
  /**
   * Enqueue and wait for result
   */
  async enqueueAndWait<T extends object, R = any>(
    commandOrQuery: T,
    options?: EnqueueOptions & { timeout?: number },
  ): Promise<R> {
    const job = await this.enqueue(commandOrQuery, options);
    
    const data = extractData(commandOrQuery);
    const entityId = options?.entityId ?? extractEntityId(data, this.logger);
    const queueNameFn = this.getQueueNameFn();
    const queueName = queueNameFn(entityId);
    
    const queueEvents = await this.queueManager.getQueueEvents(queueName);
    
    return job.waitUntilFinished(queueEvents, options?.timeout) as Promise<R>;
  }
  
  /**
   * Enqueue multiple commands/queries in bulk
   */
  async enqueueBulk<T extends object>(
    commandsOrQueries: T[],
    options?: EnqueueOptions,
  ): Promise<Job[]> {
    if (commandsOrQueries.length === 0) return [];
    
    const firstData = extractData(commandsOrQueries[0]);
    const entityId = options?.entityId ?? extractEntityId(firstData, this.logger);
    
    const queueNameFn = this.getQueueNameFn();
    const queueName = queueNameFn(entityId);
    const queue = this.queueManager.getOrCreateQueue(queueName);
    
    const bulkJobs = commandsOrQueries.map((cmd) => ({
      name: getJobName(cmd),
      data: extractData(cmd),
      opts: options?.jobOptions,
    }));
    
    this.logger.debug(
      `[${this.processorClass.name}] Adding ${bulkJobs.length} jobs to queue ${queueName}`,
    );
    
    return queue.addBulk(bulkJobs);
  }
}

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
 * 
 * @example
 * ```typescript
 * // Fluent API (recommended)
 * await this.queueBus
 *   .forProcessor(TableWorkerProcessor)
 *   .enqueue(new MakeBetCommand(tableId, bets, player));
 * 
 * // With job options
 * await this.queueBus
 *   .forProcessor(TableWorkerProcessor)
 *   .enqueue(new DealCommand(tableId), { jobOptions: { delay: 5000 } });
 * 
 * // Worker side (automatic):
 * // 1. Job arrives: { name: 'MakeBetCommand', data: { tableId, bets, player } }
 * // 2. Worker looks up MakeBetCommand class in QueueBus registry
 * // 3. Instantiates with entityId + data
 * // 4. Executes via CommandBus
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
  
  constructor(
    private readonly queueManager: QueueManagerService,
  ) {}
  
  /**
   * Target a specific processor's queue for enqueueing commands
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
    
    return new QueueTarget(this.queueManager, processorClass, options);
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
