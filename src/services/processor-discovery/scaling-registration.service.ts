import {
  Injectable,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { IEntityScalingConfig, IAtomicQueuesModuleConfig } from '../../domain';
import { WorkerManagerService } from '../worker-manager';
import { QueueManagerService } from '../queue-manager';
import { CronManagerService } from '../cron-manager';
import { ServiceQueueManager } from '../service-queue';
import { QueueEventsManagerService } from '../queue-events-manager';
import { SpawnQueueService } from '../spawn-queue';
import { ATOMIC_QUEUES_CONFIG } from '../constants';
import { ProcessorRegistry } from './processor-registry';
import { WorkerFactoryService } from './worker-factory.service';

/**
 * ScalingRegistrationService
 *
 * Handles all scaling/spawn registration logic:
 * - Registering scalers with CronManager
 * - Registering scalerless processors for auto-spawn
 * - Registering with SpawnQueueService for distributed worker creation
 * - Setting up spawn worker handlers with ServiceQueueManager
 * - Setting up QueueEvents listening for job arrivals
 */
@Injectable()
export class ScalingRegistrationService {
  private readonly logger = new Logger(ScalingRegistrationService.name);

  constructor(
    private readonly workerManager: WorkerManagerService,
    private readonly queueManager: QueueManagerService,
    @Optional() private readonly cronManager: CronManagerService,
    @Optional() private readonly serviceQueueManager: ServiceQueueManager,
    @Optional() private readonly queueEventsManager: QueueEventsManagerService,
    @Optional() private readonly spawnQueueService: SpawnQueueService,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
  ) {}

  /**
   * Register all scaling-related handlers.
   * Called by the orchestrator during module init.
   */
  async registerAll(
    registry: ProcessorRegistry,
    workerFactory: WorkerFactoryService,
  ): Promise<void> {
    await this.registerScalersWithCronManager(registry, workerFactory);
    await this.registerScalerlessProcessors(registry, workerFactory);
    await this.registerSpawnWorkerHandler(registry, workerFactory);
    await this.registerWithSpawnQueue(registry, workerFactory);
    await this.setupQueueEventsListening(registry, workerFactory);
  }

  /**
   * Register scalers with CronManager for automatic scaling
   */
  private async registerScalersWithCronManager(
    registry: ProcessorRegistry,
    workerFactory: WorkerFactoryService,
  ): Promise<void> {
    if (!this.cronManager) {
      this.logger.warn(
        'CronManager not available. Automatic scaling disabled.',
      );
      return;
    }

    for (const [entityType, scaler] of registry.getAllScalers()) {
      const processor = registry.getProcessor(entityType);

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
          return 1;
        },

        onSpawnWorker: async (entityId: string): Promise<void> => {
          // First call custom spawn handler if defined
          if (scaler.methods.onSpawnWorker) {
            await scaler.scalerInstance[scaler.methods.onSpawnWorker](entityId);
          }

          // Auto-create worker if processor is registered
          if (processor) {
            await workerFactory.createWorkerForEntity(entityType, entityId);
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
   * Register processors that don't have an EntityScaler (scalerless mode).
   *
   * When SpawnQueueService is available, this registration is SKIPPED
   * because the spawn queue handles both on-demand worker creation
   * (distributed across pods) and idle cleanup (local sweep).
   */
  private async registerScalerlessProcessors(
    registry: ProcessorRegistry,
    workerFactory: WorkerFactoryService,
  ): Promise<void> {
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

    for (const [entityType, processor] of registry.getAllProcessors()) {
      if (registry.hasScaler(entityType)) {
        continue;
      }

      if (processor.options.autoSpawn === false) {
        this.logger.debug(`Auto-spawn disabled for ${entityType}, skipping scalerless registration`);
        continue;
      }

      this.logger.log(`Registering scalerless config for '${entityType}' (autoSpawn mode)`);

      const scalingConfig: IEntityScalingConfig = {
        entityType,
        maxWorkersPerEntity: processor.options.maxWorkersPerEntity ?? 1,
        idleTimeoutSeconds: processor.options.idleTimeoutSeconds ?? 15,

        getActiveEntityIds: async (): Promise<string[]> => {
          return [];
        },

        getDesiredWorkerCount: async (_entityId: string): Promise<number> => {
          return 1;
        },

        onSpawnWorker: async (entityId: string): Promise<void> => {
          await workerFactory.createWorkerForEntity(entityType, entityId);
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
   */
  private async registerWithSpawnQueue(
    registry: ProcessorRegistry,
    workerFactory: WorkerFactoryService,
  ): Promise<void> {
    if (!this.spawnQueueService) {
      this.logger.debug('SpawnQueueService not available, skipping spawn queue registration');
      return;
    }

    this.spawnQueueService.registerSpawnHandler(
      async (entityType: string, entityId: string) => {
        const scaler = registry.getScaler(entityType);
        const processor = registry.getProcessor(entityType);

        if (scaler?.methods.onSpawnWorker) {
          await scaler.scalerInstance[scaler.methods.onSpawnWorker](entityId);
        }

        if (processor) {
          await workerFactory.createWorkerForEntity(entityType, entityId);
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
    for (const [entityType, processor] of registry.getAllProcessors()) {
      const idleTimeout = processor.options.idleTimeoutSeconds ?? 15;
      this.spawnQueueService.registerIdleTimeout(entityType, idleTimeout);
    }
    for (const [entityType, scaler] of registry.getAllScalers()) {
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
   */
  private async setupQueueEventsListening(
    registry: ProcessorRegistry,
    workerFactory: WorkerFactoryService,
  ): Promise<void> {
    if (!this.queueEventsManager) {
      this.logger.debug('QueueEventsManager not available, skipping event listening setup');
      return;
    }

    // Wire up QueueManager with QueueEventsManager for auto-listening
    this.queueManager.setQueueEventsManager(this.queueEventsManager);

    // Set up the callback for job arrivals
    this.queueEventsManager.setOnJobArrivedCallback(
      async (entityType: string, entityId: string, _queueName: string) => {
        const processor = registry.getProcessor(entityType);
        const scaler = registry.getScaler(entityType);

        if (scaler?.methods.onSpawnWorker) {
          await scaler.scalerInstance[scaler.methods.onSpawnWorker](entityId);
        }

        if (processor) {
          await workerFactory.createWorkerForEntity(entityType, entityId);
        }
      },
    );

    // Register entity patterns for all processors
    for (const [entityType, processor] of registry.getAllProcessors()) {
      this.queueEventsManager.registerEntityPattern(
        entityType,
        processor.queueNameFn,
        processor.workerNameFn,
      );
    }

    this.logger.log('Queue events listening setup complete');
  }

  /**
   * Register spawn worker handler with ServiceQueueManager.
   */
  private async registerSpawnWorkerHandler(
    registry: ProcessorRegistry,
    workerFactory: WorkerFactoryService,
  ): Promise<void> {
    if (!this.serviceQueueManager) {
      this.logger.debug('ServiceQueueManager not available, skipping spawn handler registration');
      return;
    }

    this.serviceQueueManager.registerSpawnWorkerHandler(
      async (entityType: string, entityId: string) => {
        const scaler = registry.getScaler(entityType);
        const processor = registry.getProcessor(entityType);

        if (scaler?.methods.onSpawnWorker) {
          await scaler.scalerInstance[scaler.methods.onSpawnWorker](entityId);
        }

        if (processor) {
          await workerFactory.createWorkerForEntity(entityType, entityId);
        }

        if (!scaler?.methods.onSpawnWorker && !processor) {
          this.logger.warn(
            `No spawn handler for entity type '${entityType}'. ` +
            `Either add @OnSpawnWorker() to your scaler or register a @WorkerProcessor.`,
          );
        }
      },
    );

    this.logger.debug('Spawn worker handler registered with ServiceQueueManager');
  }
}
