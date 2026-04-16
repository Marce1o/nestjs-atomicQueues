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
 * Service queue configuration for global singleton operations
 */
export interface IServiceQueueConfig {
  /** Whether to enable the service queue (default: true) */
  enabled?: boolean;
  /** Custom queue name (default: {keyPrefix}-service-queue) */
  queueName?: string;
  /** Custom worker name (default: {keyPrefix}-service-worker) */
  workerName?: string;
}

/**
 * Entity-specific configuration for per-entity queue defaults
 * Used in module-level `entities` config to define defaults per entity type.
 *
 * When configured in the module, entities automatically get:
 * - Worker spawning when jobs arrive (via QueueEvents)
 * - Idle worker termination (via CronManager)
 * - Job routing via CQRS CommandBus/QueryBus
 *
 * No @WorkerProcessor class needed!
 *
 * @example
 * ```typescript
 * AtomicQueuesModule.forRoot({
 *   redis: { host: 'localhost', port: 6379 },
 *   enableCronManager: true,
 *   entities: {
 *     account: {
 *       queueName: (id) => `${id}-queue`,
 *       workerName: (id) => `${id}-worker`,
 *       maxWorkersPerEntity: 1,
 *       idleTimeoutSeconds: 15,
 *     },
 *   },
 * })
 * ```
 */
export interface IEntityConfig {
  /**
   * Default property name to use for entity ID extraction.
   * This is used when commands don't have an @QueueEntityId() decorator.
   * Example: 'tableId', 'accountId', 'userId'
   */
  defaultEntityId?: string;

  /**
   * Custom queue name generator for this entity type.
   * If not provided, uses: {keyPrefix}:{entityType}:{entityId}:queue
   */
  queueName?: (entityId: string) => string;

  /**
   * Custom worker name generator for this entity type.
   * If not provided, uses: {keyPrefix}:{entityType}:{entityId}:worker
   */
  workerName?: (entityId: string) => string;

  /** Worker configuration overrides for this entity type */
  workerConfig?: Partial<IWorkerConfig>;

  /**
   * Maximum workers per entity (default: 1).
   * Determines how many concurrent workers can process jobs for a single entity.
   */
  maxWorkersPerEntity?: number;

  /**
   * Idle timeout in seconds before a worker is terminated (default: 15).
   * Workers are terminated when they have no jobs to process for this duration.
   */
  idleTimeoutSeconds?: number;

  /**
   * If true, workers are automatically spawned when jobs arrive (default: true).
   * When enabled, no @WorkerProcessor or @EntityScaler is required.
   */
  autoSpawn?: boolean;
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
  /** Service queue configuration for global atomic operations */
  serviceQueue?: IServiceQueueConfig;
  /** Enable verbose logging (debug logs for service jobs, scaling cycles, etc.) */
  verbose?: boolean;
  /**
   * Auto-register commands from @nestjs/cqrs handlers (default: true)
   * When enabled, all @CommandHandler and @QueryHandler decorated classes
   * are automatically discovered and registered with QueueBus.
   */
  autoRegisterCommands?: boolean;
  /**
   * Per-entity type configuration.
   * Allows setting defaults for specific entity types (e.g., 'table', 'account').
   * These defaults are merged with processor-level and command-level settings.
   *
   * Priority chain (highest to lowest):
   * 1. @QueueEntityId() decorator on command property
   * 2. @WorkerProcessor({ defaultEntityId })
   * 3. entities[entityType].defaultEntityId
   * 4. Error (no fallback to magic extraction)
   *
   * @example
   * ```typescript
   * entities: {
   *   table: {
   *     defaultEntityId: 'tableId',
   *     workerConfig: { concurrency: 1 }
   *   },
   *   account: {
   *     defaultEntityId: 'accountId',
   *     queueName: (id) => `accounts-${id}-queue`
   *   }
   * }
   * ```
   */
  entities?: Record<string, IEntityConfig>;
}
