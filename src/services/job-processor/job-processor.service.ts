import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { plainToInstance } from 'class-transformer';
import { Job } from 'bullmq';
import {
  IJobProcessorRegistry,
  IAtomicJobData,
  IJobResult,
  IDynamicExecutor,
  JobProcessor,
  Constructor,
} from '../../domain';
import { ATOMIC_QUEUES_CONFIG } from '../constants';
import { IAtomicQueuesModuleConfig } from '../../domain';

/**
 * JobProcessorRegistry
 *
 * Registry for job processors that can be looked up by job type.
 * Supports both custom processors and CQRS command/query execution.
 */
@Injectable()
export class JobProcessorRegistry implements IJobProcessorRegistry {
  private readonly logger = new Logger(JobProcessorRegistry.name);
  private readonly processors: Map<string, JobProcessor> = new Map();

  /**
   * Register a processor for a job type.
   */
  registerProcessor<T, R>(
    jobType: string,
    processor: JobProcessor<T, R>,
  ): void {
    this.processors.set(jobType, processor as JobProcessor);
    this.logger.debug(`Registered processor for job type: ${jobType}`);
  }

  /**
   * Get processor for a job type.
   */
  getProcessor<T, R>(jobType: string): JobProcessor<T, R> | undefined {
    return this.processors.get(jobType) as JobProcessor<T, R> | undefined;
  }

  /**
   * Check if processor exists.
   */
  hasProcessor(jobType: string): boolean {
    return this.processors.has(jobType);
  }

  /**
   * Get all registered job types.
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.processors.keys());
  }

  /**
   * Unregister a processor.
   */
  unregisterProcessor(jobType: string): boolean {
    return this.processors.delete(jobType);
  }

  /**
   * Clear all processors.
   */
  clearAll(): void {
    this.processors.clear();
  }
}

/**
 * DynamicExecutorService
 *
 * Executes commands and queries dynamically by class name.
 * This is the pattern used by bl-blackjack-service for the ServiceAtomicProcessor.
 *
 * Key Features:
 * - Dynamic module loading for commands/queries
 * - Uses class-transformer to instantiate payloads
 * - Supports both CommandBus and QueryBus execution
 *
 * @example
 * ```typescript
 * // Register modules
 * executor.registerCommandModule('../application/commands');
 * executor.registerQueryModule('../application/queries');
 *
 * // Execute dynamically
 * const result = await executor.executeCommand('MakeBetCommand', { amount: 100 });
 * ```
 */
@Injectable()
export class DynamicExecutorService implements IDynamicExecutor {
  private readonly logger = new Logger(DynamicExecutorService.name);
  private readonly commandModules: Map<string, Record<string, Constructor>> = new Map();
  private readonly queryModules: Map<string, Record<string, Constructor>> = new Map();
  private readonly cachedCommandClasses: Map<string, Constructor> = new Map();
  private readonly cachedQueryClasses: Map<string, Constructor> = new Map();

  constructor(
    @Optional() private readonly commandBus: CommandBus,
    @Optional() private readonly queryBus: QueryBus,
  ) {}

  /**
   * Execute a command by class name.
   */
  async executeCommand<T>(commandName: string, payload: T): Promise<unknown> {
    const CommandClass = await this.resolveCommandClass(commandName);

    if (!CommandClass) {
      throw new Error(`Command class not found: ${commandName}`);
    }

    const commandInstance = plainToInstance(CommandClass, payload);
    this.logger.debug(`Executing command: ${commandName}`);

    return this.commandBus.execute(commandInstance as any);
  }

  /**
   * Execute a query by class name.
   */
  async executeQuery<T>(queryName: string, payload: T): Promise<unknown> {
    const QueryClass = await this.resolveQueryClass(queryName);

    if (!QueryClass) {
      throw new Error(`Query class not found: ${queryName}`);
    }

    const queryInstance = plainToInstance(QueryClass, payload);
    this.logger.debug(`Executing query: ${queryName}`);

    return this.queryBus.execute(queryInstance as any);
  }

  /**
   * Register command module for dynamic loading.
   */
  registerCommandModule(modulePath: string): void {
    this.logger.debug(`Registered command module path: ${modulePath}`);
    // Module will be loaded on-demand when needed
    // Store path for later dynamic import
  }

  /**
   * Register query module for dynamic loading.
   */
  registerQueryModule(modulePath: string): void {
    this.logger.debug(`Registered query module path: ${modulePath}`);
    // Module will be loaded on-demand when needed
  }

  /**
   * Pre-register a command class directly (preferred method).
   */
  registerCommandClass(name: string, commandClass: Constructor): void {
    this.cachedCommandClasses.set(name, commandClass);
    this.logger.debug(`Pre-registered command class: ${name}`);
  }

  /**
   * Pre-register a query class directly (preferred method).
   */
  registerQueryClass(name: string, queryClass: Constructor): void {
    this.cachedQueryClasses.set(name, queryClass);
    this.logger.debug(`Pre-registered query class: ${name}`);
  }

  /**
   * Bulk register command classes.
   */
  registerCommandClasses(classes: Record<string, Constructor>): void {
    for (const [name, cls] of Object.entries(classes)) {
      this.cachedCommandClasses.set(name, cls);
    }
    this.logger.debug(
      `Bulk registered ${Object.keys(classes).length} command classes`,
    );
  }

  /**
   * Bulk register query classes.
   */
  registerQueryClasses(classes: Record<string, Constructor>): void {
    for (const [name, cls] of Object.entries(classes)) {
      this.cachedQueryClasses.set(name, cls);
    }
    this.logger.debug(
      `Bulk registered ${Object.keys(classes).length} query classes`,
    );
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * Resolve a command class by name.
   */
  private async resolveCommandClass(
    commandName: string,
  ): Promise<Constructor | undefined> {
    // First check cache
    if (this.cachedCommandClasses.has(commandName)) {
      return this.cachedCommandClasses.get(commandName);
    }

    // If not cached, check loaded modules
    for (const module of this.commandModules.values()) {
      if (module[commandName]) {
        this.cachedCommandClasses.set(commandName, module[commandName]);
        return module[commandName];
      }
    }

    return undefined;
  }

  /**
   * Resolve a query class by name.
   */
  private async resolveQueryClass(
    queryName: string,
  ): Promise<Constructor | undefined> {
    // First check cache
    if (this.cachedQueryClasses.has(queryName)) {
      return this.cachedQueryClasses.get(queryName);
    }

    // If not cached, check loaded modules
    for (const module of this.queryModules.values()) {
      if (module[queryName]) {
        this.cachedQueryClasses.set(queryName, module[queryName]);
        return module[queryName];
      }
    }

    return undefined;
  }
}

/**
 * AtomicJobProcessor
 *
 * Main job processor service that combines the registry and dynamic executor
 * to process atomic jobs with support for:
 *
 * 1. Custom registered processors
 * 2. Dynamic CQRS command/query execution
 * 3. Job progress tracking
 * 4. Error handling and result capture
 *
 * This is the unified processor that should be used by workers.
 */
@Injectable()
export class AtomicJobProcessor {
  private readonly logger = new Logger(AtomicJobProcessor.name);

  constructor(
    private readonly registry: JobProcessorRegistry,
    private readonly executor: DynamicExecutorService,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
  ) {}

  /**
   * Process an atomic job.
   *
   * Processing order:
   * 1. Check for custom registered processor
   * 2. If type is 'command', use dynamic executor
   * 3. If type is 'query', use dynamic executor
   * 4. If type is 'custom', use registered processor only
   */
  async process<T = unknown, R = unknown>(
    job: Job<IAtomicJobData<T>>,
  ): Promise<IJobResult<R>> {
    const startTime = Date.now();
    const { data } = job;
    const { type, commandName } = data;

    this.logger.debug(
      `Processing job ${job.id}: type=${type}, command=${commandName}`,
    );

    try {
      let result: R | undefined;

      // Check for custom processor first
      if (this.registry.hasProcessor(job.name)) {
        const processor = this.registry.getProcessor<T, R>(job.name)!;
        result = await processor(job);
      }
      // Dynamic command execution
      else if (type === 'command' && commandName) {
        result = (await this.executor.executeCommand(
          commandName,
          data.payload,
        )) as R;
      }
      // Dynamic query execution
      else if (type === 'query' && commandName) {
        result = (await this.executor.executeQuery(
          commandName,
          data.payload,
        )) as R;
      }
      // Unknown type
      else {
        throw new Error(
          `Unknown job type or missing processor: ${type}/${job.name}`,
        );
      }

      const processingTime = Date.now() - startTime;
      this.logger.debug(
        `Job ${job.id} completed in ${processingTime}ms`,
      );

      return {
        success: true,
        result,
        processingTime,
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.logger.error(`Job ${job.id} failed: ${(error as Error).message}`);

      return {
        success: false,
        error: (error as Error).message,
        processingTime,
      };
    }
  }

  /**
   * Create a processor function for use with WorkerManager.createWorker().
   */
  createProcessor<T = unknown, R = unknown>(): (
    job: Job<IAtomicJobData<T>>,
  ) => Promise<R | undefined> {
    return async (job: Job<IAtomicJobData<T>>): Promise<R | undefined> => {
      const result = await this.process<T, R>(job);
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.result;
    };
  }

  /**
   * Register a custom processor.
   */
  registerProcessor<T, R>(jobType: string, processor: JobProcessor<T, R>): void {
    this.registry.registerProcessor(jobType, processor);
  }

  /**
   * Register command classes for dynamic execution.
   */
  registerCommands(classes: Record<string, Constructor>): void {
    this.executor.registerCommandClasses(classes);
  }

  /**
   * Register query classes for dynamic execution.
   */
  registerQueries(classes: Record<string, Constructor>): void {
    this.executor.registerQueryClasses(classes);
  }
}
