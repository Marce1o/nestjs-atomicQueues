/**
 * =============================================================================
 * ATOMIC QUEUES - Core Domain Interfaces
 * =============================================================================
 *
 * This file defines all the core interfaces for the AtomicQueues library.
 * These abstractions enable atomic process handling per entity (user, table, etc.)
 * with features like:
 *
 * - Dynamic per-entity queue creation
 * - Worker lifecycle management with heartbeat TTL
 * - Distributed resource locking (Redis/Lua scripts)
 * - Graceful shutdown coordination via pub/sub
 * - Cron-based worker spawning/cleanup
 * - CQRS command/query dynamic execution
 */

import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

// =============================================================================
// CONFIGURATION INTERFACES
// =============================================================================

/**
 * Redis connection configuration
 */
export interface IRedisConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  url?: string;
  maxRetriesPerRequest?: number | null;
}

/**
 * Worker configuration options
 */
export interface IWorkerConfig {
  /** Number of concurrent jobs a worker can process */
  concurrency?: number;
  /** Interval in ms to check for stalled jobs */
  stalledInterval?: number;
  /** Duration in ms that a job lock is held */
  lockDuration?: number;
  /** Maximum number of times a job can be marked as stalled before failing */
  maxStalledCount?: number;
  /** Heartbeat TTL in seconds for worker liveness tracking */
  heartbeatTTL?: number;
  /** Interval in ms between heartbeat updates */
  heartbeatInterval?: number;
}

/**
 * Queue configuration options
 */
export interface IQueueConfig {
  /** Default job options for the queue */
  defaultJobOptions?: IJobOptions;
  /** Limiter configuration for rate limiting */
  limiter?: {
    groupKey?: string;
    max?: number;
    duration?: number;
  };
}

/**
 * Job configuration options
 */
export interface IJobOptions {
  /** Remove job from queue when completed */
  removeOnComplete?: boolean | number;
  /** Remove job from queue when failed */
  removeOnFail?: boolean | number;
  /** Number of attempts before marking as failed */
  attempts?: number;
  /** Backoff strategy for retries */
  backoff?: {
    type: 'fixed' | 'exponential';
    delay: number;
  };
  /** Job priority (lower = higher priority) */
  priority?: number;
  /** Delay in ms before the job becomes available */
  delay?: number;
}

/**
 * Main module configuration
 */
export interface IAtomicQueuesModuleConfig {
  /** Redis connection configuration */
  redis: IRedisConfig;
  /** Default worker configuration */
  workerDefaults?: IWorkerConfig;
  /** Default queue configuration */
  queueDefaults?: IQueueConfig;
  /** Enable cron-based worker management */
  enableCronManager?: boolean;
  /** Cron interval in ms for worker management cycle */
  cronInterval?: number;
  /** Prefix for all Redis keys */
  keyPrefix?: string;
}

// =============================================================================
// QUEUE MANAGEMENT INTERFACES
// =============================================================================

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

// =============================================================================
// WORKER MANAGEMENT INTERFACES
// =============================================================================

/**
 * Worker state tracking
 */
export interface IWorkerState {
  workerId: string;
  workerName: string;
  nodeId: string;
  entityId?: string;
  entityType?: string;
  status: 'starting' | 'ready' | 'processing' | 'closing' | 'closed';
  createdAt: Date;
  lastHeartbeat: Date;
}

/**
 * Worker lifecycle events
 */
export interface IWorkerEvents {
  onReady?: (worker: Worker, workerName: string) => void | Promise<void>;
  onCompleted?: (job: Job, workerName: string) => void | Promise<void>;
  onFailed?: (job: Job | undefined, error: Error, workerName: string) => void | Promise<void>;
  onProgress?: (job: Job, progress: number | object) => void | Promise<void>;
  onStalled?: (jobId: string, workerName: string) => void | Promise<void>;
  onClosing?: (workerName: string) => void | Promise<void>;
  onClosed?: (workerName: string) => void | Promise<void>;
}

/**
 * Worker creation options
 */
export interface IWorkerCreationOptions {
  workerName: string;
  queueName: string;
  config?: IWorkerConfig;
  events?: IWorkerEvents;
  processor: (job: Job) => Promise<unknown>;
}

/**
 * Worker manager service interface
 */
export interface IWorkerManager {
  /**
   * Create a new worker with automatic lifecycle management
   */
  createWorker(options: IWorkerCreationOptions): Promise<Worker>;

  /**
   * Check if a worker exists and is alive
   */
  workerExists(workerName: string): Promise<boolean>;

  /**
   * Get all running workers for current node
   */
  getNodeWorkers(): Promise<string[]>;

  /**
   * Get all running workers across all nodes
   */
  getAllWorkers(): Promise<string[]>;

  /**
   * Get all workers for a specific entity
   */
  getEntityWorkers(entityType: string, entityId: string): Promise<string[]>;

  /**
   * Signal a worker to close gracefully
   */
  signalWorkerClose(workerName: string): Promise<void>;

  /**
   * Signal all workers on current node to close
   */
  signalNodeWorkersClose(): Promise<void>;

  /**
   * Wait for all node workers to close
   */
  waitForWorkersToClose(timeoutMs?: number): Promise<void>;

  /**
   * Reset worker heartbeat TTL
   */
  resetWorkerHeartbeat(workerName: string): Promise<void>;

  /**
   * Remove worker heartbeat (mark as dead)
   */
  removeWorkerHeartbeat(workerName: string): Promise<void>;

  /**
   * Get the node ID for this instance
   */
  getNodeId(): string;
}

// =============================================================================
// RESOURCE LOCKING INTERFACES
// =============================================================================

/**
 * Lock state for a resource
 */
export interface IResourceLock {
  resourceId: string;
  resourceType: string;
  ownerId: string;
  ownerType: string;
  acquiredAt: Date;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Lock acquisition result
 */
export interface ILockResult {
  acquired: boolean;
  lock?: IResourceLock;
  reason?: string;
}

/**
 * Resource lock service interface for distributed locking
 */
export interface IResourceLockService {
  /**
   * Acquire a lock on a resource
   */
  acquireLock(
    resourceType: string,
    resourceId: string,
    ownerId: string,
    ownerType: string,
    ttlSeconds?: number,
    metadata?: Record<string, unknown>,
  ): Promise<ILockResult>;

  /**
   * Release a lock on a resource
   */
  releaseLock(resourceType: string, resourceId: string): Promise<boolean>;

  /**
   * Check if a resource is locked
   */
  isLocked(resourceType: string, resourceId: string): Promise<boolean>;

  /**
   * Get lock info for a resource
   */
  getLockInfo(resourceType: string, resourceId: string): Promise<IResourceLock | null>;

  /**
   * Get all locked resources of a type for an owner
   */
  getOwnerLocks(ownerType: string, ownerId: string): Promise<IResourceLock[]>;

  /**
   * Get available (unlocked) resource from a pool
   */
  getAvailableResource(
    resourceType: string,
    candidateIds: string[],
    ownerId: string,
    ownerType: string,
    ttlSeconds?: number,
  ): Promise<ILockResult>;

  /**
   * Extend lock TTL
   */
  extendLock(resourceType: string, resourceId: string, ttlSeconds: number): Promise<boolean>;
}

// =============================================================================
// JOB PROCESSING INTERFACES
// =============================================================================

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

// =============================================================================
// CRON MANAGER INTERFACES
// =============================================================================

/**
 * Worker scaling decision
 */
export interface IScalingDecision {
  entityId: string;
  entityType: string;
  currentWorkers: number;
  desiredWorkers: number;
  action: 'spawn' | 'terminate' | 'none';
  count: number;
}

/**
 * Entity scaling configuration
 */
export interface IEntityScalingConfig {
  entityType: string;
  /** Function to get desired worker count for an entity */
  getDesiredWorkerCount: (entityId: string) => Promise<number>;
  /** Function to get all active entity IDs */
  getActiveEntityIds: () => Promise<string[]>;
  /** Maximum workers per entity */
  maxWorkersPerEntity?: number;
  /** Function called when spawning a worker */
  onSpawnWorker?: (entityId: string) => Promise<void>;
  /** Function called when terminating a worker */
  onTerminateWorker?: (entityId: string, workerId: string) => Promise<void>;
}

/**
 * Cron manager interface for worker lifecycle management
 */
export interface ICronManager {
  /**
   * Register an entity type for automatic scaling
   */
  registerEntityType(config: IEntityScalingConfig): void;

  /**
   * Run scaling cycle for all registered entity types
   */
  runScalingCycle(): Promise<IScalingDecision[]>;

  /**
   * Get current scaling state
   */
  getScalingState(): Promise<Map<string, IScalingDecision[]>>;

  /**
   * Start the cron manager
   */
  start(intervalMs?: number): void;

  /**
   * Stop the cron manager
   */
  stop(): void;

  /**
   * Check if cron manager is running
   */
  isRunning(): boolean;
}

// =============================================================================
// INDEX TRACKING INTERFACES
// =============================================================================

/**
 * Index entry for tracking jobs, workers, queues
 */
export interface IIndexEntry {
  id: string;
  type: 'job' | 'worker' | 'queue' | 'death' | 'custom';
  entityId: string;
  entityType: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Index manager interface for tracking various entities
 */
export interface IIndexManager {
  /**
   * Index a job for an entity
   */
  indexJob(entityType: string, entityId: string, jobId: string): Promise<void>;

  /**
   * Remove job index
   */
  removeJobIndex(entityType: string, entityId: string, jobId: string): Promise<void>;

  /**
   * Get all job IDs for an entity
   */
  getEntityJobs(entityType: string, entityId: string): Promise<string[]>;

  /**
   * Get all entities with jobs
   */
  getEntitiesWithJobs(entityType: string): Promise<Record<string, number>>;

  /**
   * Index a worker death signal
   */
  indexWorkerDeath(entityType: string, entityId: string, deathId: string): Promise<void>;

  /**
   * Remove worker death index
   */
  removeWorkerDeathIndex(entityType: string, entityId: string, deathId: string): Promise<void>;

  /**
   * Get queued worker deaths for an entity
   */
  getQueuedWorkerDeaths(entityType: string, entityId: string): Promise<string[]>;

  /**
   * Index entity queue
   */
  indexEntityQueue(entityType: string, entityId: string): Promise<void>;

  /**
   * Remove entity queue index
   */
  removeEntityQueueIndex(entityType: string, entityId: string): Promise<void>;

  /**
   * Get all entities with active queues
   */
  getEntitiesWithQueues(entityType: string): Promise<string[]>;

  /**
   * Index a queue death signal
   */
  indexQueueDeath(entityType: string, entityId: string): Promise<void>;

  /**
   * Remove queue death index
   */
  removeQueueDeathIndex(entityType: string, entityId: string): Promise<void>;

  /**
   * Get all entities with queued queue deaths
   */
  getEntitiesWithQueuedQueueDeaths(entityType: string): Promise<string[]>;
}

// =============================================================================
// SOCKET/CONNECTION TRACKING INTERFACES
// =============================================================================

/**
 * Socket connection tracking interface
 */
export interface IConnectionTracker {
  /**
   * Track a socket connection for an entity
   */
  trackConnection(
    entityType: string,
    entityId: string,
    socketId: string,
    nodeId: string,
  ): Promise<void>;

  /**
   * Untrack a socket connection
   */
  untrackConnection(entityType: string, entityId: string, socketId: string): Promise<void>;

  /**
   * Get all socket connections for an entity
   */
  getEntityConnections(entityType: string, entityId: string): Promise<string[]>;

  /**
   * Get entity connections for a specific node
   */
  getEntityNodeConnections(
    entityType: string,
    entityId: string,
    nodeId: string,
  ): Promise<string[]>;

  /**
   * Untrack all connections for current node
   */
  untrackNodeConnections(): Promise<void>;

  /**
   * Check if entity has active connections
   */
  hasActiveConnections(entityType: string, entityId: string): Promise<boolean>;

  /**
   * Get node ID for a socket connection
   */
  getNodeForSocket(entityType: string, entityId: string, socketId: string): Promise<string | null>;
}

// =============================================================================
// EVENT INTERFACES
// =============================================================================

/**
 * Event types for pub/sub communication
 */
export type AtomicQueueEventType =
  | 'worker:shutdown'
  | 'worker:ready'
  | 'worker:closed'
  | 'job:completed'
  | 'job:failed'
  | 'job:progress'
  | 'queue:closed'
  | 'custom';

/**
 * Event payload structure
 */
export interface IAtomicQueueEvent<T = unknown> {
  type: AtomicQueueEventType;
  nodeId: string;
  workerId?: string;
  entityId?: string;
  entityType?: string;
  timestamp: Date;
  data?: T;
}

/**
 * Event bus interface for internal pub/sub
 */
export interface IEventBus {
  /**
   * Publish an event
   */
  publish<T>(channel: string, event: IAtomicQueueEvent<T>): Promise<void>;

  /**
   * Subscribe to a channel
   */
  subscribe(
    channel: string,
    handler: (event: IAtomicQueueEvent) => void | Promise<void>,
  ): Promise<void>;

  /**
   * Unsubscribe from a channel
   */
  unsubscribe(channel: string): Promise<void>;

  /**
   * Subscribe to worker shutdown events for a specific worker
   */
  subscribeToWorkerShutdown(
    workerName: string,
    handler: () => void | Promise<void>,
  ): Promise<void>;
}

// =============================================================================
// ATOMIC PROCESS STATUS INTERFACES
// =============================================================================

/**
 * Atomic process status
 */
export type AtomicProcessStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Atomic process state
 */
export interface IAtomicProcessState {
  uuid: string;
  status: AtomicProcessStatus;
  entityId: string;
  entityType: string;
  commandName?: string;
  createdAt: Date;
  updatedAt: Date;
  result?: unknown;
  error?: string;
}

/**
 * Atomic process status tracker interface
 */
export interface IAtomicProcessTracker {
  /**
   * Set process status
   */
  setStatus(uuid: string, status: AtomicProcessStatus): Promise<void>;

  /**
   * Get process status
   */
  getStatus(uuid: string): Promise<IAtomicProcessState | null>;

  /**
   * Set process result
   */
  setResult(uuid: string, result: unknown): Promise<void>;

  /**
   * Set process error
   */
  setError(uuid: string, error: string): Promise<void>;

  /**
   * Clean up old process states
   */
  cleanup(maxAgeMs?: number): Promise<number>;
}

// =============================================================================
// UTILITY TYPES
// =============================================================================

/**
 * Deep partial type utility
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Constructor type
 */
export type Constructor<T = unknown> = new (...args: unknown[]) => T;

/**
 * Async factory function type
 */
export type AsyncFactory<T> = () => Promise<T> | T;
