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
  /**
   * Idle timeout in seconds before a worker is considered idle and can be terminated.
   * Workers self-report idle time via heartbeat. Default: 15 seconds.
   */
  idleTimeoutSeconds?: number;
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
