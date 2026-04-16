import { Queue, Job } from 'bullmq';
import { IJobOptions } from './config.interfaces';

/**
 * Represents a managed queue instance
 */
export interface IManagedQueue {
  name: string;
  queue: Queue;
  createdAt: Date;
  entityId: string;
  entityType: string;
}

/**
 * Queue manager service interface for dynamic queue creation/destruction
 */
export interface IQueueManager {
  /**
   * Get or create a queue for the given name
   */
  getOrCreateQueue(queueName: string): Queue;

  /**
   * Get or create an entity-specific queue
   */
  getOrCreateEntityQueue(entityType: string, entityId: string): Queue;

  /**
   * Close and remove a specific queue
   */
  closeQueue(queueName: string): Promise<void>;

  /**
   * Close all managed queues
   */
  closeAllQueues(): Promise<void>;

  /**
   * Get all queue names
   */
  getQueueNames(): string[];

  /**
   * Delete a specific job from a queue
   */
  deleteJob(queueName: string, jobId: string): Promise<void>;

  /**
   * Add a job to a queue
   */
  addJob<T>(
    queueName: string,
    jobName: string,
    data: T,
    options?: IJobOptions,
  ): Promise<Job<T>>;
}
