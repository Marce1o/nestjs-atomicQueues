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
  /** Maximum number of attempts (default: 1 — strictly once) */
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
  /** Retry policy for this entity type */
  retry?: IRetryPolicy;
  /** Default timeout in ms for enqueueAndWait on this entity type */
  replyTimeout?: number;
  /** Behavior when a message is found in "dispatched" state on recovery */
  onInterrupt?: 'dead-letter' | 'retry';
  /** Idle timeout in ms before worker teardown (default: 30000) */
  workerIdleTimeout?: number;
}

/**
 * gRPC inter-server communication configuration
 */
export interface IGrpcConfig {
  /** Enable gRPC transport (default: false) */
  enabled?: boolean;
  /** gRPC listen address (default: '0.0.0.0:50051') */
  listenAddress?: string;
  /** Advertised address for other servers (default: os.hostname() + ':50051') */
  advertisedAddress?: string;
  /** Unique server ID (default: auto-generated UUID) */
  serverId?: string;
  /** Replica group name — identifies which replicas run the same code */
  serviceGroup?: string;
  /** TLS configuration */
  tls?: { certPath: string; keyPath: string; caPath?: string };
  /** Max forwarding hops to prevent loops (default: 3) */
  maxForwardHops?: number;
  /** Heartbeat interval in ms (default: 400) */
  heartbeatMs?: number;
  /** Node considered dead after this many ms without heartbeat (default: 1500) */
  nodeTTLMs?: number;
  /** Leader lock TTL in ms (default: 2000) */
  leaderTTLMs?: number;
  /** Leader lock renewal interval in ms (default: 400) */
  leaderRenewalMs?: number;
  /** Leader acquisition poll interval in ms (default: 400) */
  leaderAcquisitionMs?: number;
}

/**
 * Write-ahead log configuration
 */
export interface IWalConfig {
  /** Enable WAL persistence (default: true) */
  enabled?: boolean;
  /** Cleanup batch interval in ms (default: 5000) */
  cleanupInterval?: number;
  /** Safety TTL for WAL entries in seconds (default: 86400 = 24h) */
  entryTTL?: number;
}

/**
 * Main module configuration — v3
 */
export interface IAtomicQueuesModuleConfig {
  /** Redis connection configuration */
  redis: IRedisConfig;

  /** Default retry policy */
  retry?: IRetryPolicy;

  /** Per-entity-type overrides */
  entities?: Record<string, IEntityConfig>;

  /** gRPC inter-server communication */
  grpc?: IGrpcConfig;

  /** Write-ahead log persistence */
  wal?: IWalConfig;

  /** Prefix for all Redis keys (default: 'aq') */
  keyPrefix?: string;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Auto-register commands from @nestjs/cqrs handlers (default: true) */
  autoRegisterCommands?: boolean;
}
