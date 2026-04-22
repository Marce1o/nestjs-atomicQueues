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
 * Retry policy configuration
 */
export interface IRetryPolicy {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Backoff strategy */
  backoff?: 'fixed' | 'exponential';
  /** Base delay in ms (default: 1000) */
  backoffDelay?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelay?: number;
}

/**
 * Per-entity-type configuration
 */
export interface IEntityConfig {
  /** Default property name for entity ID extraction */
  defaultEntityId?: string;
  /** Gate TTL in seconds (default: 30) */
  gateTTL?: number;
  /** Retry policy for this entity type */
  retry?: IRetryPolicy;
  /** Idle timeout in ms before actor state is evicted from memory (default: 60000) */
  actorIdleTimeout?: number;
  /** Persist actor state to Redis on eviction (default: true) */
  statePersistence?: boolean;
}

/**
 * Executor pool configuration
 */
export interface IExecutorConfig {
  /** Number of concurrent executors (default: 1) */
  poolSize?: number;
  /** Default gate TTL in seconds (default: 30) */
  gateTTL?: number;
  /** Gate refresh interval in ms (default: gateTTL * 500) */
  gateRefreshInterval?: number;
}

/**
 * Distributed registry configuration (optional, for cross-service)
 */
export interface IRegistryConfig {
  /** Enable the distributed registry (default: false) */
  enabled?: boolean;
  /** Service name for identification in the registry */
  serviceName?: string;
  /** Validate payload schemas on send (default: false) */
  schemaValidation?: boolean;
  /** Heartbeat interval in ms (default: 10000) */
  heartbeatInterval?: number;
  /** Registration TTL in seconds (default: 30) */
  registrationTTL?: number;
}

/**
 * Main module configuration
 */
export interface IAtomicQueuesModuleConfig {
  /** Redis connection configuration */
  redis: IRedisConfig;

  /** Executor pool configuration */
  executor?: IExecutorConfig;

  /** Default retry policy */
  retry?: IRetryPolicy;

  /** Per-entity-type overrides */
  entities?: Record<string, IEntityConfig>;

  /** Distributed registry (cross-service communication) */
  registry?: IRegistryConfig;

  /** Prefix for all Redis keys (default: 'aq') */
  keyPrefix?: string;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Auto-register commands from @nestjs/cqrs handlers (default: true) */
  autoRegisterCommands?: boolean;
}
