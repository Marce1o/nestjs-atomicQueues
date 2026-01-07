import {
  Injectable,
  Logger,
  OnModuleInit,
  Type,
  Inject,
  Optional,
} from '@nestjs/common';
import { ModuleRef, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { Job } from 'bullmq';
import {
  WORKER_PROCESSOR_METADATA,
  JOB_HANDLER_METADATA,
  ENTITY_SCALER_METADATA,
  GET_ACTIVE_ENTITIES_METADATA,
  GET_DESIRED_WORKER_COUNT_METADATA,
  ON_SPAWN_WORKER_METADATA,
  ON_TERMINATE_WORKER_METADATA,
  WorkerProcessorOptions,
  EntityScalerOptions,
  JobHandlerMetadata,
  getWorkerProcessorMetadata,
  getJobHandlerMetadata,
  getEntityScalerMetadata,
} from '../../decorators';
import { IWorkerConfig, IEntityScalingConfig } from '../../domain';
import { WorkerManagerService } from '../worker-manager';
import { QueueManagerService } from '../queue-manager';
import { CronManagerService } from '../cron-manager';
import { ATOMIC_QUEUES_CONFIG } from '../constants';
import { IAtomicQueuesModuleConfig } from '../../domain';

/**
 * Registered processor info
 */
export interface RegisteredProcessor {
  entityType: string;
  processorInstance: any;
  options: WorkerProcessorOptions;
  jobHandlers: Map<string, { method: string; isWildcard: boolean }>;
  wildcardHandler?: { method: string };
  queueNameFn: (entityId: string) => string;
  workerNameFn: (entityId: string) => string;
}

/**
 * Registered scaler info
 */
export interface RegisteredScaler {
  entityType: string;
  scalerInstance: any;
  options: EntityScalerOptions;
  methods: {
    getActiveEntities?: string;
    getDesiredWorkerCount?: string;
    onSpawnWorker?: string;
    onTerminateWorker?: string;
  };
}

/**
 * ProcessorDiscoveryService
 *
 * Automatically discovers and registers classes decorated with:
 * - @WorkerProcessor - For job processing
 * - @EntityScaler - For entity scaling logic
 *
 * This service bridges the decorator-based API with the core services:
 * - WorkerManagerService - For worker lifecycle
 * - QueueManagerService - For queue management
 * - CronManagerService - For automatic scaling
 *
 * @example
 * ```typescript
 * // Classes are auto-discovered from module providers
 * @WorkerProcessor({ entityType: 'table' })
 * @Injectable()
 * export class TableProcessor {
 *   @JobHandler('make-bet')
 *   async handleMakeBet(job: Job, entityId: string) { ... }
 * }
 *
 * @EntityScaler({ entityType: 'table' })
 * @Injectable()
 * export class TableScaler {
 *   @GetActiveEntities()
 *   async getAllTables() { ... }
 * }
 * ```
 */
@Injectable()
export class ProcessorDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(ProcessorDiscoveryService.name);
  private readonly processors: Map<string, RegisteredProcessor> = new Map();
  private readonly scalers: Map<string, RegisteredScaler> = new Map();
  private readonly activeWorkers: Map<string, Set<string>> = new Map(); // entityType -> Set of entityIds with workers

  constructor(
    @Optional() private readonly discoveryService: DiscoveryService,
    @Optional() private readonly metadataScanner: MetadataScanner,
    private readonly moduleRef: ModuleRef,
    private readonly workerManager: WorkerManagerService,
    private readonly queueManager: QueueManagerService,
    @Optional() private readonly cronManager: CronManagerService,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.discoveryService) {
      this.logger.warn(
        'DiscoveryService not available. Manual registration required.',
      );
      return;
    }

    await this.discoverProcessors();
    await this.discoverScalers();
    await this.registerScalersWithCronManager();
  }

  /**
   * Discover all @WorkerProcessor decorated classes
   */
  private async discoverProcessors(): Promise<void> {
    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { instance, metatype } = wrapper;

      if (!instance || !metatype) continue;

      // Cast to Type<any> for metadata functions
      const targetClass = metatype as Type<any>;
      const options = getWorkerProcessorMetadata(targetClass);
      if (!options) continue;

      this.registerProcessor(targetClass, instance, options);
    }

    this.logger.log(
      `Discovered ${this.processors.size} worker processor(s): ${Array.from(this.processors.keys()).join(', ')}`,
    );
  }

  /**
   * Discover all @EntityScaler decorated classes
   */
  private async discoverScalers(): Promise<void> {
    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { instance, metatype } = wrapper;

      if (!instance || !metatype) continue;

      // Cast to Type<any> for metadata functions
      const targetClass = metatype as Type<any>;
      const options = getEntityScalerMetadata(targetClass);
      if (!options) continue;

      this.registerScaler(targetClass, instance, options);
    }

    this.logger.log(
      `Discovered ${this.scalers.size} entity scaler(s): ${Array.from(this.scalers.keys()).join(', ')}`,
    );
  }

  /**
   * Register a processor from discovered metadata
   */
  private registerProcessor(
    metatype: Type<any>,
    instance: any,
    options: WorkerProcessorOptions,
  ): void {
    const { entityType } = options;

    // Build job handlers map
    const handlers = getJobHandlerMetadata(metatype);
    const jobHandlers = new Map<string, { method: string; isWildcard: boolean }>();
    let wildcardHandler: { method: string } | undefined;

    for (const handler of handlers) {
      if (handler.isWildcard) {
        wildcardHandler = { method: handler.methodName };
      } else {
        jobHandlers.set(handler.jobName, {
          method: handler.methodName,
          isWildcard: false,
        });
      }
    }

    // Build queue and worker name functions
    const keyPrefix = this.config.keyPrefix || 'aq';
    const queueNameFn =
      typeof options.queueName === 'function'
        ? options.queueName
        : options.queueName
          ? () => options.queueName as string
          : (entityId: string) => `${keyPrefix}:${entityType}:${entityId}:queue`;

    const workerNameFn =
      typeof options.workerName === 'function'
        ? options.workerName
        : options.workerName
          ? () => options.workerName as string
          : (entityId: string) => `${keyPrefix}:${entityType}:${entityId}:worker`;

    const processor: RegisteredProcessor = {
      entityType,
      processorInstance: instance,
      options,
      jobHandlers,
      wildcardHandler,
      queueNameFn,
      workerNameFn,
    };

    this.processors.set(entityType, processor);
    this.activeWorkers.set(entityType, new Set());

    this.logger.debug(
      `Registered processor for entity type '${entityType}' with ${jobHandlers.size} job handlers` +
        (wildcardHandler ? ' and wildcard handler' : ''),
    );
  }

  /**
   * Register a scaler from discovered metadata
   */
  private registerScaler(
    metatype: Type<any>,
    instance: any,
    options: EntityScalerOptions,
  ): void {
    const { entityType } = options;

    // Find decorated methods
    const methods = {
      getActiveEntities: Reflect.getMetadata(
        GET_ACTIVE_ENTITIES_METADATA + ':method',
        metatype,
      ),
      getDesiredWorkerCount: Reflect.getMetadata(
        GET_DESIRED_WORKER_COUNT_METADATA + ':method',
        metatype,
      ),
      onSpawnWorker: Reflect.getMetadata(
        ON_SPAWN_WORKER_METADATA + ':method',
        metatype,
      ),
      onTerminateWorker: Reflect.getMetadata(
        ON_TERMINATE_WORKER_METADATA + ':method',
        metatype,
      ),
    };

    const scaler: RegisteredScaler = {
      entityType,
      scalerInstance: instance,
      options,
      methods,
    };

    this.scalers.set(entityType, scaler);

    this.logger.debug(
      `Registered scaler for entity type '${entityType}' with methods: ` +
        Object.entries(methods)
          .filter(([_, v]) => v)
          .map(([k, _]) => k)
          .join(', '),
    );
  }

  /**
   * Register scalers with CronManager for automatic scaling
   */
  private async registerScalersWithCronManager(): Promise<void> {
    if (!this.cronManager) {
      this.logger.warn(
        'CronManager not available. Automatic scaling disabled.',
      );
      return;
    }

    for (const [entityType, scaler] of this.scalers) {
      const processor = this.processors.get(entityType);

      const scalingConfig: IEntityScalingConfig = {
        entityType,
        maxWorkersPerEntity: scaler.options.maxWorkersPerEntity ?? 1,

        getActiveEntityIds: async (): Promise<string[]> => {
          if (scaler.methods.getActiveEntities) {
            return scaler.scalerInstance[scaler.methods.getActiveEntities]();
          }
          return [];
        },

        getDesiredWorkerCount: async (entityId: string): Promise<number> => {
          if (scaler.methods.getDesiredWorkerCount) {
            return scaler.scalerInstance[scaler.methods.getDesiredWorkerCount](
              entityId,
            );
          }
          return 1; // Default to 1 worker
        },

        onSpawnWorker: async (entityId: string): Promise<void> => {
          // First call custom spawn handler if defined
          if (scaler.methods.onSpawnWorker) {
            await scaler.scalerInstance[scaler.methods.onSpawnWorker](entityId);
          }

          // Auto-create worker if processor is registered
          if (processor) {
            await this.createWorkerForEntity(entityType, entityId);
          }
        },

        onTerminateWorker: async (
          entityId: string,
          workerId: string,
        ): Promise<void> => {
          // First call custom terminate handler if defined
          if (scaler.methods.onTerminateWorker) {
            await scaler.scalerInstance[scaler.methods.onTerminateWorker](
              entityId,
              workerId,
            );
          }

          // Auto-terminate worker if processor is registered
          if (processor) {
            const workerName = processor.workerNameFn(entityId);
            await this.workerManager.signalWorkerClose(workerName);
          }
        },
      };

      this.cronManager.registerEntityType(scalingConfig);
      this.logger.log(`Registered scaling config for entity type '${entityType}'`);
    }
  }

  /**
   * Create a worker for an entity using the registered processor
   */
  async createWorkerForEntity(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const processor = this.processors.get(entityType);
    if (!processor) {
      throw new Error(`No processor registered for entity type: ${entityType}`);
    }

    const workerName = processor.workerNameFn(entityId);
    const queueName = processor.queueNameFn(entityId);

    // Check if worker already exists
    if (await this.workerManager.workerExists(workerName)) {
      this.logger.debug(`Worker ${workerName} already exists, skipping`);
      return;
    }

    this.logger.log(`Creating worker ${workerName} for ${entityType}:${entityId}`);

    // Ensure queue exists
    this.queueManager.getOrCreateQueue(queueName);

    // Create the worker with the processor
    const workerConfig: IWorkerConfig = {
      concurrency: 1,
      stalledInterval: 1000,
      lockDuration: 30000,
      heartbeatTTL: 3,
      heartbeatInterval: 1000,
      ...this.config.workerDefaults,
      ...processor.options.workerConfig,
    };

    await this.workerManager.createWorker({
      workerName,
      queueName,
      config: workerConfig,
      processor: async (job: Job): Promise<unknown> => {
        return this.processJob(processor, job, entityId);
      },
      events: {
        onReady: async () => {
          this.logger.log(`Worker ${workerName} ready`);
          this.activeWorkers.get(entityType)?.add(entityId);
        },
        onCompleted: async (job) => {
          this.logger.debug(`Worker ${workerName}: Job ${job.id} completed`);
        },
        onFailed: async (job, error) => {
          this.logger.error(
            `Worker ${workerName}: Job ${job?.id} failed: ${error.message}`,
          );
        },
        onClosed: async () => {
          this.logger.log(`Worker ${workerName} closed`);
          this.activeWorkers.get(entityType)?.delete(entityId);
        },
      },
    });
  }

  /**
   * Process a job using the registered handlers
   */
  private async processJob(
    processor: RegisteredProcessor,
    job: Job,
    entityId: string,
  ): Promise<unknown> {
    const { processorInstance, jobHandlers, wildcardHandler } = processor;
    const jobName = job.name;

    // Try to find specific handler
    const handler = jobHandlers.get(jobName);
    if (handler) {
      return processorInstance[handler.method](job, entityId);
    }

    // Fall back to wildcard handler
    if (wildcardHandler) {
      return processorInstance[wildcardHandler.method](job, entityId);
    }

    // No handler found
    this.logger.warn(
      `No handler found for job '${jobName}' on entity type '${processor.entityType}'`,
    );
    return null;
  }

  // ==========================================================================
  // PUBLIC API - Manual Registration
  // ==========================================================================

  /**
   * Manually register a processor class
   * Use this when auto-discovery is not available or for dynamic registration
   */
  async registerProcessorClass<T>(
    processorClass: Type<T>,
    instance?: T,
  ): Promise<void> {
    const options = getWorkerProcessorMetadata(processorClass);
    if (!options) {
      throw new Error(
        `Class ${processorClass.name} is not decorated with @WorkerProcessor`,
      );
    }

    const resolvedInstance = instance || this.moduleRef.get(processorClass, { strict: false });
    this.registerProcessor(processorClass, resolvedInstance, options);
  }

  /**
   * Manually register a scaler class
   */
  async registerScalerClass<T>(
    scalerClass: Type<T>,
    instance?: T,
  ): Promise<void> {
    const options = getEntityScalerMetadata(scalerClass);
    if (!options) {
      throw new Error(
        `Class ${scalerClass.name} is not decorated with @EntityScaler`,
      );
    }

    const resolvedInstance = instance || this.moduleRef.get(scalerClass, { strict: false });
    this.registerScaler(scalerClass, resolvedInstance, options);
  }

  /**
   * Get registered processor for an entity type
   */
  getProcessor(entityType: string): RegisteredProcessor | undefined {
    return this.processors.get(entityType);
  }

  /**
   * Get registered scaler for an entity type
   */
  getScaler(entityType: string): RegisteredScaler | undefined {
    return this.scalers.get(entityType);
  }

  /**
   * Get all registered entity types
   */
  getRegisteredEntityTypes(): string[] {
    return Array.from(
      new Set([...this.processors.keys(), ...this.scalers.keys()]),
    );
  }

  /**
   * Check if a worker exists for an entity
   */
  hasActiveWorker(entityType: string, entityId: string): boolean {
    return this.activeWorkers.get(entityType)?.has(entityId) ?? false;
  }

  /**
   * Get all active workers for an entity type
   */
  getActiveWorkers(entityType: string): string[] {
    return Array.from(this.activeWorkers.get(entityType) || []);
  }
}
