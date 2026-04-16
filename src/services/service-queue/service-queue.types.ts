/**
 * Service-level job names for global atomic operations.
 * These operations MUST be processed by exactly ONE worker across the entire distributed system.
 */
export enum ServiceQueueJobNames {
  /** Get the count of all workers across all nodes */
  GET_GLOBAL_WORKER_COUNT = 'get-global-worker-count',
  /** Get workers for a specific entity across all nodes */
  GET_ENTITY_WORKERS = 'get-entity-workers',
  /** Verify ownership of a resource */
  VERIFY_OWNERSHIP = 'verify-ownership',
  /** Acquire global lock */
  ACQUIRE_GLOBAL_LOCK = 'acquire-global-lock',
  /** Release global lock */
  RELEASE_GLOBAL_LOCK = 'release-global-lock',
  /** Run scaling cycle for CronManager - triggers worker spawn/terminate decisions */
  RUN_SCALING_CYCLE = 'run-scaling-cycle',
  /** Spawn a worker for a specific entity - used when opening a table/entity */
  SPAWN_ENTITY_WORKER = 'spawn-entity-worker',
  /** Custom service operation */
  CUSTOM = 'custom',
}

/**
 * Job data for service queue operations
 */
export interface IServiceQueueJobData<T = unknown> {
  uuid: string;
  jobName: ServiceQueueJobNames;
  payload: T;
  responseChannel?: string;
}
