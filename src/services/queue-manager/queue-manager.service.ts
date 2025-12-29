import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Job } from 'bullmq';
import Redis from 'ioredis';
import {
  IQueueManager,
  IManagedQueue,
  IJobOptions,
  IQueueConfig,
} from '../../domain';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';
import { Inject } from '@nestjs/common';
import { IAtomicQueuesModuleConfig } from '../../domain';

/**
 * QueueManagerService
 *
 * Manages dynamic queue creation and destruction per entity.
 * This is the core service for creating queues on-demand for users, tables,
 * or any other entity type that requires atomic processing.
 *
 * Key Features:
 * - Dynamic queue creation with lazy initialization
 * - Entity-specific queue naming conventions
 * - Automatic cleanup on module destroy
 * - Job management (add, delete)
 * - Queue lifecycle management
 *
 * @example
 * ```typescript
 * // Get or create a queue for a user
 * const queue = queueManager.getOrCreateEntityQueue('user', '123');
 *
 * // Add a job to the queue
 * await queueManager.addJob('user-123-queue', 'process-message', { text: 'hello' });
 * ```
 */
@Injectable()
export class QueueManagerService implements IQueueManager, OnModuleDestroy {
  private readonly logger = new Logger(QueueManagerService.name);
  private readonly queues: Map<string, IManagedQueue> = new Map();
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.keyPrefix = config.keyPrefix || 'aq';
  }

  /**
   * Get or create a queue by name.
   * If the queue doesn't exist, it will be created with default configuration.
   */
  getOrCreateQueue(queueName: string): Queue {
    const normalizedName = this.normalizeQueueName(queueName);

    if (this.queues.has(normalizedName)) {
      return this.queues.get(normalizedName)!.queue;
    }

    this.logger.debug(`Creating new queue: ${normalizedName}`);

    const queue = this.createQueue(normalizedName);

    const managedQueue: IManagedQueue = {
      name: normalizedName,
      queue,
      createdAt: new Date(),
      entityId: '',
      entityType: 'generic',
    };

    this.queues.set(normalizedName, managedQueue);
    return queue;
  }

  /**
   * Get or create an entity-specific queue.
   * Uses naming convention: {entityType}-{entityId}-queue
   */
  getOrCreateEntityQueue(entityType: string, entityId: string): Queue {
    const queueName = this.getEntityQueueName(entityType, entityId);

    if (this.queues.has(queueName)) {
      return this.queues.get(queueName)!.queue;
    }

    this.logger.debug(`Creating entity queue: ${queueName}`);

    const queue = this.createQueue(queueName);

    const managedQueue: IManagedQueue = {
      name: queueName,
      queue,
      createdAt: new Date(),
      entityId,
      entityType,
    };

    this.queues.set(queueName, managedQueue);
    return queue;
  }

  /**
   * Close and remove a specific queue.
   * This will gracefully close the queue and clean up resources.
   */
  async closeQueue(queueName: string): Promise<void> {
    const normalizedName = this.normalizeQueueName(queueName);
    const managedQueue = this.queues.get(normalizedName);

    if (!managedQueue) {
      this.logger.warn(`Queue ${normalizedName} not found for closing.`);
      return;
    }

    this.logger.debug(`Closing queue: ${normalizedName}`);

    try {
      await managedQueue.queue.close();
      this.queues.delete(normalizedName);
      this.logger.debug(`Closed queue: ${normalizedName}`);
    } catch (error) {
      this.logger.error(`Error closing queue ${normalizedName}:`, error);
      throw error;
    }
  }

  /**
   * Close all managed queues.
   * Called automatically on module destroy.
   */
  async closeAllQueues(): Promise<void> {
    this.logger.debug('Closing all queues...');

    const closePromises = Array.from(this.queues.entries()).map(
      async ([queueName, managedQueue]) => {
        try {
          await managedQueue.queue.close();
          this.logger.debug(`Closed queue: ${queueName}`);
        } catch (error) {
          this.logger.error(`Error closing queue ${queueName}:`, error);
        }
      },
    );

    await Promise.all(closePromises);
    this.queues.clear();
    this.logger.debug('All queues closed.');
  }

  /**
   * Get all managed queue names.
   */
  getQueueNames(): string[] {
    return Array.from(this.queues.keys());
  }

  /**
   * Get all queues for a specific entity type.
   */
  getEntityTypeQueues(entityType: string): IManagedQueue[] {
    return Array.from(this.queues.values()).filter(
      (q) => q.entityType === entityType,
    );
  }

  /**
   * Delete a specific job from a queue.
   */
  async deleteJob(queueName: string, jobId: string): Promise<void> {
    try {
      const queue = this.getOrCreateQueue(queueName);
      const result = await queue.remove(jobId);
      this.logger.debug(
        `Deleted job ${jobId} from queue ${queueName}, result: ${result}`,
      );
    } catch (error) {
      this.logger.error(
        `Error deleting job ${jobId} from queue ${queueName}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Add a job to a queue with optional configuration.
   */
  async addJob<T>(
    queueName: string,
    jobName: string,
    data: T,
    options?: IJobOptions,
  ): Promise<Job<T>> {
    const queue = this.getOrCreateQueue(queueName);
    const mergedOptions = this.mergeJobOptions(options);

    try {
      const job = await queue.add(jobName, data, mergedOptions);
      this.logger.debug(
        `Added job ${job.id} (${jobName}) to queue ${queueName}`,
      );
      return job as Job<T>;
    } catch (error) {
      this.logger.error(`Error adding job to queue ${queueName}:`, error);
      throw error;
    }
  }

  /**
   * Obliterate a queue (remove all jobs and the queue itself).
   * Use with caution - this is destructive.
   */
  async obliterateQueue(queueName: string): Promise<void> {
    const normalizedName = this.normalizeQueueName(queueName);
    const managedQueue = this.queues.get(normalizedName);

    if (!managedQueue) {
      this.logger.warn(`Queue ${normalizedName} not found for obliteration.`);
      return;
    }

    this.logger.warn(`Obliterating queue: ${normalizedName}`);

    try {
      await managedQueue.queue.obliterate({ force: true });
      this.queues.delete(normalizedName);
      this.logger.debug(`Obliterated queue: ${normalizedName}`);
    } catch (error) {
      this.logger.error(`Error obliterating queue ${normalizedName}:`, error);
      throw error;
    }
  }

  /**
   * Get jobs from a queue by state.
   */
  async getJobs(
    queueName: string,
    states: ('active' | 'waiting' | 'completed' | 'failed' | 'delayed')[],
    start = 0,
    end = 100,
  ): Promise<Job[]> {
    const queue = this.getOrCreateQueue(queueName);
    return queue.getJobs(states, start, end);
  }

  /**
   * Get the job count for a queue.
   */
  async getJobCounts(
    queueName: string,
  ): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const queue = this.getOrCreateQueue(queueName);
    return queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    ) as Promise<{
      waiting: number;
      active: number;
      completed: number;
      failed: number;
      delayed: number;
    }>;
  }

  /**
   * Pause a queue.
   */
  async pauseQueue(queueName: string): Promise<void> {
    const queue = this.getOrCreateQueue(queueName);
    await queue.pause();
    this.logger.debug(`Paused queue: ${queueName}`);
  }

  /**
   * Resume a paused queue.
   */
  async resumeQueue(queueName: string): Promise<void> {
    const queue = this.getOrCreateQueue(queueName);
    await queue.resume();
    this.logger.debug(`Resumed queue: ${queueName}`);
  }

  /**
   * Check if a queue exists.
   */
  hasQueue(queueName: string): boolean {
    return this.queues.has(this.normalizeQueueName(queueName));
  }

  /**
   * Get managed queue info.
   */
  getManagedQueue(queueName: string): IManagedQueue | undefined {
    return this.queues.get(this.normalizeQueueName(queueName));
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * Create a new BullMQ Queue instance with configuration.
   */
  private createQueue(queueName: string, config?: IQueueConfig): Queue {
    const defaultConfig = this.config.queueDefaults || {};
    const mergedConfig = { ...defaultConfig, ...config };

    return new Queue(queueName, {
      connection: this.redis.duplicate(),
      defaultJobOptions: mergedConfig.defaultJobOptions,
      ...(mergedConfig.limiter && {
        limiter: mergedConfig.limiter,
      }),
    });
  }

  /**
   * Generate queue name for an entity.
   */
  private getEntityQueueName(entityType: string, entityId: string): string {
    return `${this.keyPrefix}:${entityType}:${entityId}:queue`;
  }

  /**
   * Normalize queue name to ensure consistency.
   */
  private normalizeQueueName(queueName: string): string {
    // If already has prefix or is a full queue name, return as is
    if (queueName.startsWith(this.keyPrefix) || queueName.includes(':')) {
      return queueName;
    }
    // Otherwise, add suffix if not present
    return queueName.endsWith('-queue') ? queueName : `${queueName}-queue`;
  }

  /**
   * Merge job options with defaults.
   */
  private mergeJobOptions(options?: IJobOptions): IJobOptions {
    const defaults: IJobOptions = {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: Number.MAX_SAFE_INTEGER,
      backoff: {
        type: 'fixed',
        delay: 1000,
      },
    };

    return { ...defaults, ...options };
  }

  /**
   * Cleanup on module destroy.
   */
  async onModuleDestroy(): Promise<void> {
    await this.closeAllQueues();
  }
}
