import { Type } from '@nestjs/common';
import { JobsOptions } from 'bullmq';

/**
 * Options for QueueBus.execute()
 * @deprecated Use .forProcessor(ProcessorClass).enqueue(command) instead
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
 * Options for .enqueue()
 */
export interface EnqueueOptions {
  /**
   * Override the auto-extracted entityId
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
