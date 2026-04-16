import { Logger, Type } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueManagerService } from '../queue-manager/queue-manager.service';
import { WorkerProcessorOptions } from '../../decorators';
import { IEntityConfig } from '../../domain/interfaces';
import { EnqueueOptions } from './queue-bus.types';
import { getJobName, extractData, extractEntityIdExplicit } from './queue-bus.utils';

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
    private readonly entityConfig?: IEntityConfig,
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

    // Check entity config for custom queue name function
    if (this.entityConfig?.queueName) {
      return this.entityConfig.queueName;
    }

    // Default: entityType-{entityId}-queue
    const { entityType } = this.processorOptions;
    return (entityId: string) => `${entityType}-${entityId}-queue`;
  }

  /**
   * Extract entity ID using the priority chain
   */
  private extractEntityId(commandOrQuery: object, data: Record<string, any>): string {
    return extractEntityIdExplicit(
      commandOrQuery,
      data,
      this.processorOptions.defaultEntityId,
      this.entityConfig,
      this.logger,
    );
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
    const entityId = options?.entityId ?? this.extractEntityId(commandOrQuery, data);

    // Get queue name from processor's queueName function
    const queueNameFn = this.getQueueNameFn();
    const queueName = queueNameFn(entityId);

    // Add job via QueueManager (which handles event listening setup)
    const { entityType } = this.processorOptions;

    this.logger.debug(
      `[${this.processorClass.name}] Adding job ${jobName} to queue ${queueName}`,
    );

    // Get queue and ensure event listening
    const queue = this.queueManager.getOrCreateQueue(queueName);
    const queueEventsManager = (this.queueManager as any).queueEventsManager;
    if (queueEventsManager) {
      await queueEventsManager.ensureListening(queueName, entityType);
    }

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
    const entityId = options?.entityId ?? this.extractEntityId(commandOrQuery, data);
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

    const firstCmd = commandsOrQueries[0];
    const firstData = extractData(firstCmd);
    const entityId = options?.entityId ?? this.extractEntityId(firstCmd, firstData);

    const queueNameFn = this.getQueueNameFn();
    const queueName = queueNameFn(entityId);
    const queue = this.queueManager.getOrCreateQueue(queueName);

    // Ensure listening is set up for auto-spawn
    const { entityType } = this.processorOptions;
    const queueEventsManager = (this.queueManager as any).queueEventsManager;
    if (queueEventsManager) {
      await queueEventsManager.ensureListening(queueName, entityType);
    }

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
