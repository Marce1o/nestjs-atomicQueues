import { Injectable, Logger, Type } from '@nestjs/common';
import { Queue, Job, JobsOptions } from 'bullmq';
import { QueueManagerService } from '../queue-manager/queue-manager.service';

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
 * Options for QueueBus.execute()
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
 * Registry entry for a command/query class
 */
export interface CommandRegistryEntry {
  className: string;
  targetClass: Type<any>;
  isQuery: boolean;
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
 * 
 * @example
 * ```typescript
 * // Producer side - add command to queue
 * await this.queueBus.execute(
 *   'table-worker-{entityId}',
 *   new MakeBetCommand(tableId, sessionId, amount),
 * );
 * 
 * // Or with explicit entityId:
 * await this.queueBus.execute(
 *   'table-worker-{entityId}',
 *   new MakeBetCommand(tableId, sessionId, amount),
 *   { entityId: tableId }
 * );
 * 
 * // Worker side (automatic):
 * // 1. Job arrives: { name: 'MakeBetCommand', data: { tableId, sessionId, amount } }
 * // 2. Worker looks up MakeBetCommand class
 * // 3. Instantiates with Object.assign(new MakeBetCommand(), data)
 * // 4. Executes via CommandBus
 * ```
 */
@Injectable()
export class QueueBus {
  private readonly logger = new Logger(QueueBus.name);
  
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
   * @param queuePattern - Queue name pattern with {entityId} placeholder
   * @param commandOrQuery - The command/query instance to execute
   * @param options - Optional settings (entityId, jobOptions)
   * @returns The created BullMQ job
   * 
   * @example
   * // Pattern with placeholder
   * await queueBus.execute(
   *   'table-worker-{entityId}',
   *   new MakeBetCommand(tableId, sessionId, amount),
   * );
   * 
   * // Static queue name (no placeholder)
   * await queueBus.execute(
   *   'payment-queue',
   *   new ProcessPaymentCommand(paymentId, amount),
   * );
   */
  async execute<T extends object>(
    queuePattern: string,
    commandOrQuery: T,
    options?: QueueBusExecuteOptions,
  ): Promise<Job> {
    const jobName = getJobName(commandOrQuery);
    const data = extractData(commandOrQuery);
    const entityId = options?.entityId ?? this.extractEntityId(data);
    
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
        options?.entityId ?? this.extractEntityId(extractData(commandOrQuery)),
      ),
    );
    
    return job.waitUntilFinished(queueEvents, options?.timeout) as Promise<R>;
  }
  
  /**
   * Add multiple commands/queries to the same queue in bulk
   */
  async executeBulk<T extends object>(
    queuePattern: string,
    commandsOrQueries: T[],
    options?: QueueBusExecuteOptions,
  ): Promise<Job[]> {
    if (commandsOrQueries.length === 0) return [];
    
    const entityId = options?.entityId ?? this.extractEntityId(
      extractData(commandsOrQueries[0]),
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
  
  /**
   * Extract entityId from command data
   * Tries common property names in order
   */
  private extractEntityId(data: Record<string, any>): string {
    const candidates = ['entityId', 'tableId', 'userId', 'id', 'gameId', 'playerId'];
    
    for (const key of candidates) {
      if (data[key] !== undefined && data[key] !== null) {
        return String(data[key]);
      }
    }
    
    // Log warning if no entityId found
    this.logger.warn(
      `Could not extract entityId from command data. Keys: ${Object.keys(data).join(', ')}`,
    );
    
    return 'default';
  }
}
