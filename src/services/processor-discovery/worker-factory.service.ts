import {
  Injectable,
  Logger,
  Type,
  Inject,
  Optional,
} from '@nestjs/common';
import { Job } from 'bullmq';
import { IWorkerConfig, ICommandBus, IQueryBus, IAtomicQueuesModuleConfig } from '../../domain';
import { WorkerManagerService } from '../worker-manager';
import { QueueManagerService } from '../queue-manager';
import { CommandDiscoveryService } from '../command-discovery';
import { QueueBus } from '../queue-bus';
import { ATOMIC_QUEUES_CONFIG } from '../constants';
import { ProcessorRegistry, RegisteredProcessor } from './processor-registry';

/**
 * WorkerFactoryService
 *
 * Responsible for creating workers for entities and processing jobs
 * through the registered handler pipeline.
 */
@Injectable()
export class WorkerFactoryService {
  private readonly logger = new Logger(WorkerFactoryService.name);

  private registry: ProcessorRegistry;
  private commandBus: ICommandBus | null = null;
  private queryBus: IQueryBus | null = null;

  constructor(
    private readonly workerManager: WorkerManagerService,
    private readonly queueManager: QueueManagerService,
    @Optional() private readonly commandDiscovery: CommandDiscoveryService,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
  ) {}

  /**
   * Set the ProcessorRegistry reference (called by orchestrator after construction)
   */
  setRegistry(registry: ProcessorRegistry): void {
    this.registry = registry;
  }

  /**
   * Set the CommandBus for executing commands from QueueBus registry
   */
  setCommandBus(bus: ICommandBus): void {
    this.commandBus = bus;
  }

  /**
   * Set the QueryBus for executing queries from QueueBus registry
   */
  setQueryBus(bus: IQueryBus): void {
    this.queryBus = bus;
  }

  /**
   * Create a worker for an entity using the registered processor
   */
  async createWorkerForEntity(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const processor = this.registry.getProcessor(entityType);
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
          this.registry.addActiveWorker(entityType, entityId);
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
          this.registry.removeActiveWorker(entityType, entityId);
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
  async processJob(
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
}
