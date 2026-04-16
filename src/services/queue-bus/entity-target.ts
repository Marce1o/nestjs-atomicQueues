import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueManagerService } from '../queue-manager/queue-manager.service';
import { QueueEventsManagerService } from '../queue-events-manager/queue-events-manager.service';
import { IEntityConfig } from '../../domain/interfaces';
import { EnqueueOptions } from './queue-bus.types';
import { getJobName, extractData, extractEntityIdExplicit } from './queue-bus.utils';

/**
 * EntityTarget - Fluent builder for targeting a specific entity type's queue
 * without needing a @WorkerProcessor class.
 *
 * This is the zero-boilerplate way to enqueue commands when you've configured
 * entity defaults in the module config.
 *
 * @example
 * await queueBus
 *   .forEntity('table')
 *   .enqueue(new MakeBetCommand(tableId, bets, player));
 */
export class EntityTarget {
  private readonly logger = new Logger(EntityTarget.name);

  constructor(
    private readonly queueManager: QueueManagerService,
    private readonly entityType: string,
    private readonly entityConfig: IEntityConfig | undefined,
    private readonly keyPrefix: string,
    private readonly queueEventsManager?: QueueEventsManagerService,
  ) {}

  /**
   * Get the queue name function from entity config or defaults
   */
  private getQueueNameFn(): (entityId: string) => string {
    if (this.entityConfig?.queueName) {
      return this.entityConfig.queueName;
    }

    // Default: {keyPrefix}-{entityType}-{entityId}-queue
    return (entityId: string) =>
      `${this.keyPrefix}-${this.entityType}-${entityId}-queue`;
  }

  /**
   * Extract entity ID using the priority chain (no processor-level default)
   */
  private extractEntityId(commandOrQuery: object, data: Record<string, any>): string {
    return extractEntityIdExplicit(
      commandOrQuery,
      data,
      undefined, // No processor default for forEntity()
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
   *   .forEntity('table')
   *   .enqueue(new MakeBetCommand(tableId, bets, player));
   */
  async enqueue<T extends object>(
    commandOrQuery: T,
    options?: EnqueueOptions,
  ): Promise<Job> {
    const jobName = getJobName(commandOrQuery);
    const data = extractData(commandOrQuery);
    const entityId = options?.entityId ?? this.extractEntityId(commandOrQuery, data);

    const queueNameFn = this.getQueueNameFn();
    const queueName = queueNameFn(entityId);

    this.logger.debug(
      `[forEntity:${this.entityType}] Adding job ${jobName} to queue ${queueName}`,
    );

    // Get queue and ensure event listening
    const queue = this.queueManager.getOrCreateQueue(queueName);
    if (this.queueEventsManager) {
      await this.queueEventsManager.ensureListening(queueName, this.entityType);
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
    if (this.queueEventsManager) {
      await this.queueEventsManager.ensureListening(queueName, this.entityType);
    }

    const bulkJobs = commandsOrQueries.map((cmd) => ({
      name: getJobName(cmd),
      data: extractData(cmd),
      opts: options?.jobOptions,
    }));

    this.logger.debug(
      `[forEntity:${this.entityType}] Adding ${bulkJobs.length} jobs to queue ${queueName}`,
    );

    return queue.addBulk(bulkJobs);
  }
}
