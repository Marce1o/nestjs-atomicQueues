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
  /** Max pending messages per entity worker (0 = unbounded, default: 0) */
  workerMaxQueueDepth?: number;
}

/**
 * gRPC RPC deadline configuration (all values in milliseconds)
 */
export interface IGrpcDeadlines {
  /** Deadline for fire-and-forget RPCs: forward(), petition(), enqueueToWorker() (default: 1500) */
  forwardMs?: number;
  /** Deadline for ping() RPC (default: 1000) */
  pingMs?: number;
  /** Default deadline for AndWait server-side handlers when no per-entity replyTimeout is set (default: 60000) */
  andWaitMs?: number;
  /** Deadline for listWorkers() during master table rebuild (default: 1000) */
  syncMs?: number;
  /** Deadline for peer connectivity watch loop re-arm (default: 30000) */
  connectivityWatchMs?: number;
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
  /** gRPC keepalive ping interval in ms (default: 10000, minimum enforced by grpc-js) */
  keepaliveTimeMs?: number;
  /** gRPC keepalive timeout in ms — connection dead if no response (default: 5000) */
  keepaliveTimeoutMs?: number;
  /** Enable gRPC peer connectivity monitoring for fast failure detection (default: true when grpc.enabled) */
  peerMonitorEnabled?: boolean;
  /** Debounce window in ms before declaring a peer suspected-dead (default: 500) */
  peerSuspectDebounceMs?: number;
  /** Redis PING health check interval in ms (default: 500) */
  redisHealthCheckMs?: number;
  /** Consecutive Redis PING failures before declaring degraded mode (default: 3) */
  redisHealthFailureThreshold?: number;
  /** Reconciliation interval in ms — how often to SCAN Redis for node changes (default: 2000) */
  reconcileIntervalMs?: number;
  /** Max concurrent petitions the master will process (default: 50, 0 = unbounded) */
  maxConcurrentPetitions?: number;
  /** Debounce window in ms for leader recomputation after ring changes (default: 800) */
  leaderDebounceMs?: number;
  /** RPC deadline overrides */
  deadlines?: IGrpcDeadlines;
  /** Circuit breaker: consecutive failures before opening circuit (default: 3) */
  circuitBreakerFailureThreshold?: number;
  /** Circuit breaker: cooldown in ms before half-open probe (default: 2000) */
  circuitBreakerCooldownMs?: number;
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

  /** Maximum total active workers across all entity types (default: 10000, 0 = unbounded) */
  maxTotalWorkers?: number;

  /** Maximum total queued messages across all workers (default: 100000, 0 = unbounded) */
  maxTotalQueueDepth?: number;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Auto-register commands from @nestjs/cqrs handlers (default: true) */
  autoRegisterCommands?: boolean;
}
