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
import { IWorkerConfig, IEntityScalingConfig, IEntityConfig } from '../../domain';
import { WorkerManagerService } from '../worker-manager';
import { QueueManagerService } from '../queue-manager';
import { CronManagerService } from '../cron-manager';
import { CommandDiscoveryService } from '../command-discovery';
import { ServiceQueueManager } from '../service-queue';
import { QueueBus } from '../queue-bus';
import { QueueEventsManagerService } from '../queue-events-manager';
import { SpawnQueueService } from '../spawn-queue';
import { ATOMIC_QUEUES_CONFIG } from '../constants';
import { IAtomicQueuesModuleConfig } from '../../domain';

// Import CQRS types but make them optional
interface ICommandBus {
  execute<T>(command: T): Promise<any>;
}

interface IQueryBus {
  execute<T>(query: T): Promise<any>;
}

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

  private commandBus: ICommandBus | null = null;
  private queryBus: IQueryBus | null = null;

  constructor(
    @Optional() private readonly discoveryService: DiscoveryService,
    @Optional() private readonly metadataScanner: MetadataScanner,
    private readonly moduleRef: ModuleRef,
    private readonly workerManager: WorkerManagerService,
    private readonly queueManager: QueueManagerService,
    @Optional() private readonly cronManager: CronManagerService,
    @Optional() private readonly commandDiscovery: CommandDiscoveryService,
    @Optional() private readonly serviceQueueManager: ServiceQueueManager,
    @Optional() private readonly queueEventsManager: QueueEventsManagerService,
    @Optional() private readonly spawnQueueService: SpawnQueueService,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
  ) {}

  /**
   * Set the CommandBus for executing commands from QueueBus registry
   */
  setCommandBus(commandBus: ICommandBus): void {
    this.commandBus = commandBus;
    // Also set on CommandDiscoveryService if available
    if (this.commandDiscovery) {
      this.commandDiscovery.setCommandBus(commandBus);
    }
  }

  /**
   * Set the QueryBus for executing queries from QueueBus registry
   */
  setQueryBus(queryBus: IQueryBus): void {
    this.queryBus = queryBus;
    // Also set on CommandDiscoveryService if available
    if (this.commandDiscovery) {
      this.commandDiscovery.setQueryBus(queryBus);
    }
  }

  async onModuleInit(): Promise<void> {
    if (!this.discoveryService) {
      this.logger.warn(
        'DiscoveryService not available. Manual registration required.',
      );
      return;
    }

    await this.discoverProcessors();
    await this.discoverScalers();
    await this.registerEntitiesFromConfig();
    await this.registerScalersWithCronManager();
    await this.registerScalerlessProcessors();
    await this.registerSpawnWorkerHandler();
    await this.registerWithSpawnQueue();
    await this.setupQueueEventsListening();
    
    // Auto-register commands from CQRS handlers (default: true)
    if (this.config.autoRegisterCommands !== false) {
      this.autoRegisterCommandsFromCqrs();
    }

    // Auto-wire CommandBus/QueryBus from @nestjs/cqrs if available
    this.autoWireCqrsBuses();
  }

  /**
   * Attempt to resolve CommandBus and QueryBus from the DI container.
   * This allows config-driven mode to work out of the box when the
   * consuming app imports CqrsModule, without requiring a manual bridge.
   */
  private autoWireCqrsBuses(): void {
    if (!this.discoveryService) return;

    const providers = this.discoveryService.getProviders();

    if (!this.commandBus) {
      const commandBusWrapper = providers.find(
        (w) => w.metatype?.name === 'CommandBus' && w.instance,
      );
      if (commandBusWrapper?.instance) {
        this.setCommandBus(commandBusWrapper.instance as ICommandBus);
        this.logger.log('Auto-wired CommandBus from @nestjs/cqrs');
      } else {
        this.logger.debug(
          'CommandBus not found in DI container. ' +
            'Import CqrsModule in your app or call setCommandBus() manually.',
        );
      }
    }

    if (!this.queryBus) {
      const queryBusWrapper = providers.find(
        (w) => w.metatype?.name === 'QueryBus' && w.instance,
      );
      if (queryBusWrapper?.instance) {
        this.setQueryBus(queryBusWrapper.instance as IQueryBus);
        this.logger.log('Auto-wired QueryBus from @nestjs/cqrs');
      } else {
        this.logger.debug(
          'QueryBus not found in DI container. ' +
            'Import CqrsModule in your app or call setQueryBus() manually.',
        );
      }
    }
  }
  
  /**
   * Register entity types from module config `entities` option.
   * This creates virtual processors for entities that don't have explicit @WorkerProcessor classes.
   * 
   * Benefits:
   * - No boilerplate @WorkerProcessor class needed
   * - Just configure in module and decorate commands with @QueueEntity
   * - Workers auto-spawn on job arrival and terminate when idle
   */
  private async registerEntitiesFromConfig(): Promise<void> {
    const entities = this.config.entities;
    if (!entities) {
      return;
    }

    const keyPrefix = this.config.keyPrefix || 'aq';

    for (const [entityType, entityConfig] of Object.entries(entities)) {
      // Skip if a processor is already registered for this entity type
      if (this.processors.has(entityType)) {
        this.logger.debug(
          `Entity '${entityType}' already has a @WorkerProcessor, skipping config-based registration`,
        );
        continue;
      }

      this.logger.log(`Registering entity '${entityType}' from module config (no @WorkerProcessor needed)`);

      // Build queue and worker name functions
      const queueNameFn = entityConfig.queueName 
        ?? ((entityId: string) => `${keyPrefix}:${entityType}:${entityId}:queue`);
      
      const workerNameFn = entityConfig.workerName 
        ?? ((entityId: string) => `${keyPrefix}:${entityType}:${entityId}:worker`);

      // Create a virtual processor entry
      const processor: RegisteredProcessor = {
        entityType,
        processorInstance: null, // No instance - we use generic processing
        options: {
          entityType,
          defaultEntityId: entityConfig.defaultEntityId,
          queueName: queueNameFn,
          workerName: workerNameFn,
          workerConfig: entityConfig.workerConfig,
          maxWorkersPerEntity: entityConfig.maxWorkersPerEntity ?? 1,
          idleTimeoutSeconds: entityConfig.idleTimeoutSeconds ?? 15,
          autoSpawn: entityConfig.autoSpawn !== false, // Default true
        },
        jobHandlers: new Map(), // No explicit handlers - use generic routing
        wildcardHandler: undefined,
        queueNameFn,
        workerNameFn,
      };

      this.processors.set(entityType, processor);
      this.activeWorkers.set(entityType, new Set());

      this.logger.debug(
        `Registered config-based processor for '${entityType}' ` +
        `(maxWorkers: ${processor.options.maxWorkersPerEntity}, idle: ${processor.options.idleTimeoutSeconds}s)`,
      );
    }
  }
  
  /**
   * Register processors that don't have an EntityScaler (scalerless mode).
   * These processors will auto-spawn workers when jobs arrive and
   * auto-terminate when idle.
   *
   * When SpawnQueueService is available, this registration is SKIPPED
   * because the spawn queue handles both on-demand worker creation
   * (distributed across pods) and idle cleanup (local sweep).
   * The old CronManager path creates workers eagerly via polling,
   * which defeats the purpose of distributed spawn.
   */
  private async registerScalerlessProcessors(): Promise<void> {
    // When SpawnQueueService is available, skip CronManager registration entirely.
    // The spawn queue + idle sweep replaces the cron-based scaling for scalerless processors.
    if (this.spawnQueueService) {
      this.logger.log(
        'SpawnQueueService detected — skipping CronManager registration for scalerless processors ' +
        '(spawn queue handles on-demand creation + idle sweep)',
      );
      return;
    }

    if (!this.cronManager) {
      this.logger.debug('CronManager not available, skipping scalerless processor registration');
      return;
    }

    for (const [entityType, processor] of this.processors) {
      // Skip if a scaler is already registered for this entity type
      if (this.scalers.has(entityType)) {
        continue;
      }

      // Check if autoSpawn is explicitly disabled
      if (processor.options.autoSpawn === false) {
        this.logger.debug(`Auto-spawn disabled for ${entityType}, skipping scalerless registration`);
        continue;
      }

      this.logger.log(`Registering scalerless config for '${entityType}' (autoSpawn mode)`);

      const scalingConfig: IEntityScalingConfig = {
        entityType,
        maxWorkersPerEntity: processor.options.maxWorkersPerEntity ?? 1,
        idleTimeoutSeconds: processor.options.idleTimeoutSeconds ?? 15,

        // In scalerless mode, we don't rely on getActiveEntityIds
        // Workers are spawned reactively when jobs arrive
        getActiveEntityIds: async (): Promise<string[]> => {
          // Return empty - workers are spawned by QueueEventsManager when jobs arrive
          return [];
        },

        getDesiredWorkerCount: async (_entityId: string): Promise<number> => {
          return 1; // Default to 1 worker per entity
        },

        onSpawnWorker: async (entityId: string): Promise<void> => {
          await this.createWorkerForEntity(entityType, entityId);
        },

        onTerminateWorker: async (entityId: string, _workerId: string): Promise<void> => {
          const workerName = processor.workerNameFn(entityId);
          await this.workerManager.signalWorkerClose(workerName);
        },
      };

      this.cronManager.registerEntityType(scalingConfig);
      this.logger.log(
        `Registered scalerless config for '${entityType}' (idleTimeout: ${scalingConfig.idleTimeoutSeconds}s)`,
      );
    }
  }

  /**
   * Register with SpawnQueueService for distributed worker creation.
   * This replaces the cron-based approach: every pod's SpawnQueueService
   * worker can pick up spawn jobs and create entity workers locally.
   */
  private async registerWithSpawnQueue(): Promise<void> {
    if (!this.spawnQueueService) {
      this.logger.debug('SpawnQueueService not available, skipping spawn queue registration');
      return;
    }

    // Register the spawn handler — this is what runs on the pod that picks up the spawn job
    this.spawnQueueService.registerSpawnHandler(
      async (entityType: string, entityId: string) => {
        const scaler = this.scalers.get(entityType);
        const processor = this.processors.get(entityType);

        // Call custom spawn handler if scaler has @OnSpawnWorker defined
        if (scaler?.methods.onSpawnWorker) {
          await scaler.scalerInstance[scaler.methods.onSpawnWorker](entityId);
        }

        // Auto-create worker if processor is registered
        if (processor) {
          await this.createWorkerForEntity(entityType, entityId);
        }

        if (!scaler?.methods.onSpawnWorker && !processor) {
          this.logger.warn(
            `No spawn handler for entity type '${entityType}'. ` +
            `Register a @WorkerProcessor or configure in entities config.`,
          );
        }
      },
    );

    // Register idle timeouts for each entity type
    for (const [entityType, processor] of this.processors) {
      const idleTimeout = processor.options.idleTimeoutSeconds ?? 15;
      this.spawnQueueService.registerIdleTimeout(entityType, idleTimeout);
    }
    for (const [entityType, scaler] of this.scalers) {
      const idleTimeout = scaler.options.idleTimeoutSeconds ?? 15;
      this.spawnQueueService.registerIdleTimeout(entityType, idleTimeout);
    }

    this.logger.log('Registered with SpawnQueueService for distributed worker creation');

    // Wire QueueEventsManager reference for hot-cache eviction on idle close
    if (this.queueEventsManager) {
      this.spawnQueueService.setQueueEventsManager(this.queueEventsManager);
    }
  }

  /**
   * Setup QueueEvents listening for job arrivals.
   * This enables automatic worker spawning when jobs are added.
   */
  private async setupQueueEventsListening(): Promise<void> {
    if (!this.queueEventsManager) {
      this.logger.debug('QueueEventsManager not available, skipping event listening setup');
      return;
    }

    // Wire up QueueManager with QueueEventsManager for auto-listening
    this.queueManager.setQueueEventsManager(this.queueEventsManager);

    // Set up the callback for job arrivals
    this.queueEventsManager.setOnJobArrivedCallback(
      async (entityType: string, entityId: string, _queueName: string) => {
        const processor = this.processors.get(entityType);
        const scaler = this.scalers.get(entityType);

        // If there's a scaler with @OnSpawnWorker, use it
        if (scaler?.methods.onSpawnWorker) {
          await scaler.scalerInstance[scaler.methods.onSpawnWorker](entityId);
        }

        // Also auto-create worker if processor is registered
        if (processor) {
          await this.createWorkerForEntity(entityType, entityId);
        }
      },
    );

    // Register entity patterns for all processors
    for (const [entityType, processor] of this.processors) {
      this.queueEventsManager.registerEntityPattern(
        entityType,
        processor.queueNameFn,
        processor.workerNameFn,
      );
    }

    this.logger.log('Queue events listening setup complete');
  }
  
  /**
   * Register spawn worker handler with ServiceQueueManager
   * This allows workers to be spawned on-demand via the service queue.
   * Uses the same logic as scaling cycle - calls scaler's @OnSpawnWorker first,
   * then auto-creates via processor if registered.
   */
  private async registerSpawnWorkerHandler(): Promise<void> {
    if (!this.serviceQueueManager) {
      this.logger.debug('ServiceQueueManager not available, skipping spawn handler registration');
      return;
    }
    
    this.serviceQueueManager.registerSpawnWorkerHandler(
      async (entityType: string, entityId: string) => {
        const scaler = this.scalers.get(entityType);
        const processor = this.processors.get(entityType);
        
        // First call custom spawn handler if scaler has @OnSpawnWorker defined
        if (scaler?.methods.onSpawnWorker) {
          await scaler.scalerInstance[scaler.methods.onSpawnWorker](entityId);
        }
        
        // Also auto-create worker if processor is registered (and scaler didn't create one)
        if (processor) {
          await this.createWorkerForEntity(entityType, entityId);
        }
        
        // If neither scaler nor processor can handle this, log a warning
        if (!scaler?.methods.onSpawnWorker && !processor) {
          this.logger.warn(
            `No spawn handler for entity type '${entityType}'. ` +
            `Either add @OnSpawnWorker() to your scaler or register a @WorkerProcessor.`
          );
        }
      },
    );
    
    this.logger.debug('Spawn worker handler registered with ServiceQueueManager');
  }
  
  /**
   * Auto-discover and register commands/queries from @nestjs/cqrs handlers
   */
  private autoRegisterCommandsFromCqrs(): void {
    const { commands, queries } = QueueBus.discoverFromCqrs(this.discoveryService);
    
    if (commands > 0 || queries > 0) {
      this.logger.log(
        `Auto-registered ${commands} commands and ${queries} queries from CQRS handlers`,
      );
    }
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
        idleTimeoutSeconds: scaler.options.idleTimeoutSeconds ?? 15,

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
      this.logger.log(`Registered scaling config for entity type '${entityType}' (idleTimeout: ${scalingConfig.idleTimeoutSeconds}s)`);
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
   *
   * Priority order:
   * 1. Explicit @JobHandler on the processor class (if instance exists)
   * 2. Auto-routing via @JobCommand/@JobQuery decorated classes
   * 3. QueueBus registry lookup (class name as job name)
   * 4. Wildcard @JobHandler('*') on the processor class (if instance exists)
   */
  private async processJob(
    processor: RegisteredProcessor,
    job: Job,
    entityId: string,
  ): Promise<unknown> {
    const { processorInstance, jobHandlers, wildcardHandler, entityType } = processor;
    const jobName = job.name;

    // 1. Try to find specific @JobHandler (only if processor has an instance)
    if (processorInstance) {
      const handler = jobHandlers.get(jobName);
      if (handler) {
        return processorInstance[handler.method](job, entityId);
      }
    }

    // 2. Try auto-routing via @JobCommand/@JobQuery
    if (this.commandDiscovery) {
      const result = await this.commandDiscovery.executeJob(job, entityId, entityType);
      if (result !== undefined) {
        return result;
      }
      
      // Check if a handler exists (even if it returned undefined)
      if (this.commandDiscovery.hasHandler(jobName, entityType)) {
        return result;
      }
    }

    // 3. Try QueueBus registry lookup (job.name = class name like 'MakeBetCommand')
    const registryEntry = QueueBus.getRegistered(jobName);
    if (registryEntry) {
      return this.executeFromRegistry(registryEntry, job, entityId);
    }

    // 4. Fall back to wildcard handler (only if processor has an instance)
    if (processorInstance && wildcardHandler) {
      return processorInstance[wildcardHandler.method](job, entityId);
    }

    // No handler found
    this.logger.warn(
      `No handler found for job '${jobName}' on entity type '${entityType}'`,
    );
    return null;
  }

  /**
   * Execute a command/query from QueueBus registry
   */
  private async executeFromRegistry(
    entry: { className: string; targetClass: Type<any>; isQuery: boolean },
    job: Job,
    entityId: string,
  ): Promise<unknown> {
    const { targetClass, isQuery, className } = entry;
    
    // Instantiate the command/query with job data
    const instance = Object.assign(new targetClass(), job.data);
    
    if (isQuery) {
      if (!this.queryBus) {
        this.logger.error(
          `QueryBus not set. Cannot execute query ${className}. Call setQueryBus() first.`,
        );
        return null;
      }
      return this.queryBus.execute(instance);
    } else {
      if (!this.commandBus) {
        this.logger.error(
          `CommandBus not set. Cannot execute command ${className}. Call setCommandBus() first.`,
        );
        return null;
      }
      return this.commandBus.execute(instance);
    }
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
