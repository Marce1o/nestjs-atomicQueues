import { Job } from 'bullmq';

/**
 * Job data structure for atomic processing
 */
export interface IAtomicJobData<T = unknown> {
  /** Unique job identifier */
  uuid: string;
  /** Entity ID this job belongs to */
  entityId: string;
  /** Entity type (user, table, etc.) */
  entityType: string;
  /** Command/Query class name to execute */
  commandName?: string;
  /** Type of operation */
  type: 'command' | 'query' | 'custom';
  /** Payload data */
  payload: T;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Job processing result
 */
export interface IJobResult<T = unknown> {
  success: boolean;
  result?: T;
  error?: string;
  processingTime: number;
}

/**
 * Job processor function type
 */
export type JobProcessor<T = unknown, R = unknown> = (
  job: Job<IAtomicJobData<T>>,
) => Promise<R>;

/**
 * Job processor registry interface
 */
export interface IJobProcessorRegistry {
  /**
   * Register a processor for a job type
   */
  registerProcessor<T, R>(
    jobType: string,
    processor: JobProcessor<T, R>,
  ): void;

  /**
   * Get processor for a job type
   */
  getProcessor<T, R>(jobType: string): JobProcessor<T, R> | undefined;

  /**
   * Check if processor exists
   */
  hasProcessor(jobType: string): boolean;

  /**
   * Get all registered job types
   */
  getRegisteredTypes(): string[];
}

/**
 * Dynamic command/query executor interface
 */
export interface IDynamicExecutor {
  /**
   * Execute a command by class name
   */
  executeCommand<T>(commandName: string, payload: T): Promise<unknown>;

  /**
   * Execute a query by class name
   */
  executeQuery<T>(queryName: string, payload: T): Promise<unknown>;

  /**
   * Register command module for dynamic loading
   */
  registerCommandModule(modulePath: string): void;

  /**
   * Register query module for dynamic loading
   */
  registerQueryModule(modulePath: string): void;
}
