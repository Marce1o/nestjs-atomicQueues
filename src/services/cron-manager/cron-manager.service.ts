import { Injectable, Logger, Inject, OnModuleDestroy, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import {
  ICronManager,
  IEntityScalingConfig,
  IScalingDecision,
  IAtomicQueuesModuleConfig,
} from '../../domain';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';
import { WorkerManagerService } from '../worker-manager';
import { IndexManagerService } from '../index-manager';
import { ServiceQueueManager, ServiceQueueJobNames } from '../service-queue';

/**
 * CronManagerService
 *
 * Manages worker lifecycle through periodic scaling cycles.
 * Implements the patterns from both Whatsapi's CronqProcessor and
 * bl-blackjack-service's WorkerManagerProcessor.
 *
 * Key Features:
 * - Automatic worker spawning when jobs are queued
 * - Worker termination when queues are empty
 * - Concurrency limits based on entity configuration
 * - Queue cleanup after all work is done
 * - Excess worker handling
 *
 * Architecture:
 * - Runs on a configurable interval
 * - Each entity type can register its own scaling logic
 * - Supports per-entity concurrency limits
 * - Integrates with WorkerManager for worker lifecycle
 * - Integrates with IndexManager for state tracking
 *
 * @example
 * ```typescript
 * // Register entity scaling configuration
 * cronManager.registerEntityType({
 *   entityType: 'user',
 *   getDesiredWorkerCount: async (userId) => {
 *     const plan = await getUserPlan(userId);
 *     return planConcurrencyMap[plan];
 *   },
 *   getActiveEntityIds: async () => {
 *     return indexManager.getEntitiesWithJobs('user');
 *   },
 *   maxWorkersPerEntity: 5,
 *   onSpawnWorker: async (userId) => {
 *     await commandBus.execute(new CreateUserWorkerCommand(userId));
 *   },
 * });
 *
 * // Start the cron manager
 * cronManager.start(5000); // Run every 5 seconds
 * ```
 */
@Injectable()
export class CronManagerService implements ICronManager, OnModuleDestroy {
  private readonly logger = new Logger(CronManagerService.name);
  private readonly entityConfigs: Map<string, IEntityScalingConfig> = new Map();
  private cronInterval: NodeJS.Timeout | null = null;
  private running = false;
  private readonly keyPrefix: string;
  private readonly useServiceQueue: boolean;
  private scalingHandlerRegistered = false;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
    private readonly workerManager: WorkerManagerService,
    private readonly indexManager: IndexManagerService,
    @Optional() private readonly serviceQueueManager?: ServiceQueueManager,
  ) {
    this.keyPrefix = config.keyPrefix || 'aq';
    // Use service queue for atomic operations if enabled
    this.useServiceQueue = config.serviceQueue?.enabled !== false;
    
    // Register the scaling cycle handler with the service queue
    this.registerScalingHandler();
  }

  /**
   * Register the scaling cycle handler with ServiceQueueManager.
   * This ensures scaling cycles are processed atomically by the service worker.
   */
  private registerScalingHandler(): void {
    if (this.scalingHandlerRegistered || !this.serviceQueueManager) {
      return;
    }

    this.serviceQueueManager.registerScalingCycleHandler(
      async (entityType: string) => {
        const config = this.entityConfigs.get(entityType);
        if (!config) {
          this.logger.warn(`No config registered for entity type: ${entityType}`);
          return { decisions: [] };
        }

        const decisions = await this.runEntityScalingCycleInternal(entityType, config);
        return { decisions };
      },
    );

    this.scalingHandlerRegistered = true;
    this.logger.debug('Scaling cycle handler registered with ServiceQueueManager');
  }

  /**
   * Register an entity type for automatic scaling.
   */
  registerEntityType(config: IEntityScalingConfig): void {
    this.entityConfigs.set(config.entityType, config);
    this.logger.log(`Registered entity type for scaling: ${config.entityType}`);
  }

  /**
   * Unregister an entity type.
   */
  unregisterEntityType(entityType: string): void {
    this.entityConfigs.delete(entityType);
    this.logger.log(`Unregistered entity type: ${entityType}`);
  }

  /**
   * Run a scaling cycle for all registered entity types.
   *
   * When service queue is enabled, this triggers scaling cycles through the
   * service queue to ensure atomic processing by the single service worker.
   * This prevents race conditions in distributed deployments.
   *
   * IMPORTANT: Only the service worker owner node triggers scaling cycles.
   * Other nodes skip the trigger to prevent duplicate jobs.
   *
   * This is the main logic that:
   * 1. Gets entities with queued jobs
   * 2. Gets entities with running workers
   * 3. Calculates scaling decisions
   * 4. Spawns missing workers
   * 5. Terminates excess workers
   * 6. Cleans up empty queues
   */
  async runScalingCycle(): Promise<IScalingDecision[]> {
    // If service queue is enabled, only the service worker owner should trigger
    if (this.useServiceQueue && this.serviceQueueManager) {
      // Only trigger if we're the service worker owner
      if (this.serviceQueueManager.isServiceWorkerOwner()) {
        await this.triggerScalingCyclesThroughServiceQueue();
      }
      // Return empty - actual decisions are processed by service worker
      return [];
    }

    // Fallback to direct processing (single instance mode)
    return this.runScalingCycleDirectly();
  }

  /**
   * Trigger scaling cycles through the service queue.
   * This ensures only the service worker processes scaling decisions.
   */
  private async triggerScalingCyclesThroughServiceQueue(): Promise<void> {
    for (const entityType of this.entityConfigs.keys()) {
      try {
        await this.serviceQueueManager!.triggerScalingCycle(entityType);
      } catch (error) {
        this.logger.error(
          `Failed to trigger scaling cycle for ${entityType}: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Run scaling cycles directly (single instance or fallback mode).
   */
  private async runScalingCycleDirectly(): Promise<IScalingDecision[]> {
    const decisions: IScalingDecision[] = [];

    for (const [entityType, config] of this.entityConfigs) {
      try {
        const entityDecisions = await this.runEntityScalingCycleInternal(
          entityType,
          config,
        );
        decisions.push(...entityDecisions);
      } catch (error) {
        this.logger.error(
          `Error in scaling cycle for ${entityType}: ${(error as Error).message}`,
        );
      }
    }

    return decisions;
  }

  /**
   * Get current scaling state for all entity types.
   */
  async getScalingState(): Promise<Map<string, IScalingDecision[]>> {
    const state = new Map<string, IScalingDecision[]>();

    for (const [entityType, config] of this.entityConfigs) {
      const entityIds = await config.getActiveEntityIds();
      const decisions: IScalingDecision[] = [];

      for (const entityId of entityIds) {
        const currentWorkers = await this.getEntityWorkerCount(
          entityType,
          entityId,
        );
        const desiredWorkers = await config.getDesiredWorkerCount(entityId);

        decisions.push({
          entityId,
          entityType,
          currentWorkers,
          desiredWorkers,
          action: this.determineAction(currentWorkers, desiredWorkers),
          count: Math.abs(desiredWorkers - currentWorkers),
        });
      }

      state.set(entityType, decisions);
    }

    return state;
  }

  /**
   * Start the cron manager.
   */
  start(intervalMs?: number): void {
    if (this.running) {
      this.logger.warn('CronManager is already running');
      return;
    }

    const interval = intervalMs || this.config.cronInterval || 5000;

    this.logger.log(`Starting CronManager with ${interval}ms interval`);
    this.running = true;

    // Run immediately once
    this.runScalingCycle().catch((error) => {
      this.logger.error(`Initial scaling cycle failed: ${error.message}`);
    });

    // Then run on interval
    this.cronInterval = setInterval(async () => {
      try {
        await this.runScalingCycle();
      } catch (error) {
        this.logger.error(`Scaling cycle failed: ${(error as Error).message}`);
      }
    }, interval);
  }

  /**
   * Stop the cron manager.
   */
  stop(): void {
    if (this.cronInterval) {
      clearInterval(this.cronInterval);
      this.cronInterval = null;
    }
    this.running = false;
    this.logger.log('CronManager stopped');
  }

  /**
   * Check if cron manager is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Cleanup on module destroy.
   */
  onModuleDestroy(): void {
    this.stop();
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * Run scaling cycle for a specific entity type.
   * This is the internal implementation called either directly or via service queue.
   * 
   * Supports two modes:
   * 1. Scaler mode: getActiveEntityIds returns active entities, workers spawn/terminate based on this
   * 2. Scalerless mode: getActiveEntityIds returns empty, workers spawn via QueueEvents and terminate when idle
   */
  private async runEntityScalingCycleInternal(
    entityType: string,
    config: IEntityScalingConfig,
  ): Promise<IScalingDecision[]> {
    const decisions: IScalingDecision[] = [];

    // Get active entities from the config's getActiveEntityIds (primary source)
    const activeEntityIds = await config.getActiveEntityIds();
    
    // Get entities with running workers (from heartbeat keys)
    const entitiesWithWorkers = await this.getEntitiesWithWorkers(entityType);
    
    const isScalerlessMode = activeEntityIds.length === 0;

    if (isScalerlessMode) {
      // SCALERLESS MODE: Workers spawn via QueueEvents, we just handle idle termination
      // All workers are managed based on their idle state
      for (const entityId of entitiesWithWorkers) {
        const decision = await this.handleIdleWorkersForActiveEntity(
          entityType,
          entityId,
          config,
        );
        if (decision) decisions.push(decision);
      }
    } else {
      // SCALER MODE: Traditional flow with active entities
      
      // Spawn missing workers for active entities
      for (const entityId of activeEntityIds) {
        const decision = await this.handleEntitySpawning(
          entityType,
          entityId,
          config,
          1, // At least 1 job assumed for active entities
        );
        if (decision) decisions.push(decision);
      }

      // Handle excess workers for active entities
      for (const entityId of activeEntityIds) {
        const decision = await this.handleExcessWorkers(
          entityType,
          entityId,
          config,
        );
        if (decision) decisions.push(decision);
      }

      // Check for idle workers on ACTIVE entities and terminate them
      // They will be re-spawned on the next cycle if still active
      for (const entityId of activeEntityIds) {
        const decision = await this.handleIdleWorkersForActiveEntity(
          entityType,
          entityId,
          config,
        );
        if (decision) decisions.push(decision);
      }

      // Close workers for entities with workers but no longer active
      const activeEntitySet = new Set(activeEntityIds);
      const entitiesWithWorkersNoLongerActive = Array.from(entitiesWithWorkers).filter(
        (entityId) => !activeEntitySet.has(entityId),
      );

      if (entitiesWithWorkersNoLongerActive.length > 0) {
        this.logger.debug(
          `[${entityType}] Found ${entitiesWithWorkersNoLongerActive.length} entities with workers but no longer active: ${entitiesWithWorkersNoLongerActive.join(', ')}`,
        );
      }

      for (const entityId of entitiesWithWorkersNoLongerActive) {
        const decision = await this.handleWorkerClosure(
          entityType,
          entityId,
          config,
        );
        if (decision) decisions.push(decision);
      }
    }

    return decisions;
  }

  /**
   * Handle worker spawning for an entity.
   */
  private async handleEntitySpawning(
    entityType: string,
    entityId: string,
    config: IEntityScalingConfig,
    queuedJobCount: number,
  ): Promise<IScalingDecision | null> {
    const currentWorkers = await this.getEntityWorkerCount(entityType, entityId);
    const desiredWorkers = await config.getDesiredWorkerCount(entityId);
    const maxWorkers = config.maxWorkersPerEntity || desiredWorkers;

    // Calculate how many workers we should have
    const targetWorkers = Math.min(desiredWorkers, maxWorkers, queuedJobCount);

    if (currentWorkers >= targetWorkers) {
      return null;
    }

    const toSpawn = targetWorkers - currentWorkers;

    this.logger.debug(
      `Spawning ${toSpawn} workers for ${entityType}/${entityId}`,
    );

    // Spawn workers - workerExists check in createWorkerForEntity prevents duplicates
    // Service queue atomicity handles distributed coordination
    for (let i = 0; i < toSpawn; i++) {
      if (config.onSpawnWorker) {
        try {
          await config.onSpawnWorker(entityId);
        } catch (error) {
          this.logger.error(
            `Failed to spawn worker for ${entityType}/${entityId}: ${(error as Error).message}`,
          );
        }
      }
    }

    return {
      entityId,
      entityType,
      currentWorkers,
      desiredWorkers: targetWorkers,
      action: 'spawn',
      count: toSpawn,
    };
  }

  /**
   * Handle excess workers for an entity.
   */
  private async handleExcessWorkers(
    entityType: string,
    entityId: string,
    config: IEntityScalingConfig,
  ): Promise<IScalingDecision | null> {
    const currentWorkers = await this.getEntityWorkerCount(entityType, entityId);
    const desiredWorkers = await config.getDesiredWorkerCount(entityId);
    const maxWorkers = config.maxWorkersPerEntity || desiredWorkers;

    if (currentWorkers <= maxWorkers) {
      return null;
    }

    const excess = currentWorkers - maxWorkers;

    this.logger.debug(
      `Terminating ${excess} excess workers for ${entityType}/${entityId}`,
    );

    // Queue worker termination
    const pendingDeaths = await this.indexManager.getQueuedWorkerDeaths(
      entityType,
      entityId,
    );

    if (pendingDeaths.length === 0 && excess > 0) {
      await this.queueWorkerTermination(entityType, entityId, config);
    }

    return {
      entityId,
      entityType,
      currentWorkers,
      desiredWorkers: maxWorkers,
      action: 'terminate',
      count: excess,
    };
  }

  /**
   * Handle idle workers for ACTIVE entities.
   * Even if an entity is active, if workers are idle beyond the threshold,
   * they should be terminated to save resources. They'll be re-spawned
   * on the next scaling cycle if the entity is still active.
   */
  private async handleIdleWorkersForActiveEntity(
    entityType: string,
    entityId: string,
    config: IEntityScalingConfig,
  ): Promise<IScalingDecision | null> {
    const workers = await this.workerManager.getEntityWorkers(entityType, entityId);

    if (workers.length === 0) {
      return null;
    }

    // Get idle timeout threshold (default: 15 seconds)
    const idleTimeoutSeconds = config.idleTimeoutSeconds ?? 15;

    // Check each worker's idle time
    const idleWorkers: string[] = [];
    for (const workerName of workers) {
      const isIdle = await this.workerManager.isWorkerIdle(workerName, idleTimeoutSeconds);
      if (isIdle) {
        idleWorkers.push(workerName);
      }
    }

    if (idleWorkers.length === 0) {
      return null;
    }

    this.logger.log(
      `[handleIdleWorkers] Terminating ${idleWorkers.length} idle workers for active ${entityType}/${entityId} (idle >= ${idleTimeoutSeconds}s)`,
    );

    // Signal idle workers to close
    for (const workerName of idleWorkers) {
      const idleSeconds = await this.workerManager.getWorkerIdleSeconds(workerName);
      this.logger.debug(`[handleIdleWorkers] Terminating idle worker: ${workerName} (idle: ${idleSeconds}s)`);
      if (config.onTerminateWorker) {
        await config.onTerminateWorker(entityId, workerName);
      } else {
        await this.workerManager.signalWorkerClose(workerName);
      }
    }

    return {
      entityId,
      entityType,
      currentWorkers: workers.length,
      desiredWorkers: workers.length - idleWorkers.length,
      action: 'terminate',
      count: idleWorkers.length,
    };
  }

  /**
   * Handle worker closure for entities with no jobs.
   * Uses worker self-reported idle time for reliable detection.
   * Workers increment idle counter on heartbeat, reset on job completion.
   */
  private async handleWorkerClosure(
    entityType: string,
    entityId: string,
    config: IEntityScalingConfig,
  ): Promise<IScalingDecision | null> {
    const workers = await this.workerManager.getEntityWorkers(entityType, entityId);

    if (workers.length === 0) {
      this.logger.debug(
        `[handleWorkerClosure] ${entityType}/${entityId} - No workers found, skipping`,
      );
      return null;
    }

    this.logger.debug(
      `[handleWorkerClosure] ${entityType}/${entityId} - Found ${workers.length} workers to potentially close: ${workers.join(', ')}`,
    );

    // Get idle timeout threshold (default: 15 seconds)
    const idleTimeoutSeconds = config.idleTimeoutSeconds ?? 15;

    // Check each worker's idle time
    const idleWorkers: string[] = [];
    for (const workerName of workers) {
      const isIdle = await this.workerManager.isWorkerIdle(workerName, idleTimeoutSeconds);
      if (isIdle) {
        idleWorkers.push(workerName);
      }
    }

    if (idleWorkers.length === 0) {
      this.logger.debug(
        `[handleWorkerClosure] ${entityType}/${entityId} - No idle workers (threshold: ${idleTimeoutSeconds}s), skipping termination`,
      );
      return null;
    }

    this.logger.log(
      `[handleWorkerClosure] Closing ${idleWorkers.length} idle workers for ${entityType}/${entityId} (idle >= ${idleTimeoutSeconds}s)`,
    );

    // Signal idle workers to close
    for (const workerName of idleWorkers) {
      const idleSeconds = await this.workerManager.getWorkerIdleSeconds(workerName);
      this.logger.debug(`[handleWorkerClosure] Terminating worker: ${workerName} (idle: ${idleSeconds}s)`);
      if (config.onTerminateWorker) {
        await config.onTerminateWorker(entityId, workerName);
      } else {
        await this.workerManager.signalWorkerClose(workerName);
      }
    }

    return {
      entityId,
      entityType,
      currentWorkers: workers.length,
      desiredWorkers: workers.length - idleWorkers.length,
      action: 'terminate',
      count: idleWorkers.length,
    };
  }

  /**
   * Check if a queue has any waiting or active jobs.
   * Uses BullMQ's internal key structure with the configured prefix.
   * 
   * NOTE: This is kept as a backup/utility method, but idle detection
   * now primarily uses worker self-reported idle counters.
   * 
   * BullMQ v4+ key structure:
   * - {prefix}:{queueName}:wait (list) - jobs waiting to be processed
   * - {prefix}:{queueName}:active (list) - jobs currently being processed
   * - {prefix}:{queueName}:delayed (sorted set) - jobs scheduled for future
   * - {prefix}:{queueName}:paused (list) - jobs in paused queue
   */
  private async checkQueueHasJobs(queueName: string): Promise<boolean> {
    try {
      // BullMQ uses 'bull' as default prefix for queue keys
      const bullPrefix = 'bull';
      
      // Check wait list (BullMQ v4+ uses 'wait' not 'waiting')
      const waitKey = `${bullPrefix}:${queueName}:wait`;
      const waitCount = await this.redis.llen(waitKey);
      if (waitCount > 0) {
        this.logger.debug(`Queue ${queueName} has ${waitCount} waiting jobs`);
        return true;
      }

      // Check active list
      const activeKey = `${bullPrefix}:${queueName}:active`;
      const activeCount = await this.redis.llen(activeKey);
      if (activeCount > 0) {
        this.logger.debug(`Queue ${queueName} has ${activeCount} active jobs`);
        return true;
      }

      // Check delayed set
      const delayedKey = `${bullPrefix}:${queueName}:delayed`;
      const delayedCount = await this.redis.zcard(delayedKey);
      if (delayedCount > 0) {
        this.logger.debug(`Queue ${queueName} has ${delayedCount} delayed jobs`);
        return true;
      }

      // Check paused list (in case queue is paused)
      const pausedKey = `${bullPrefix}:${queueName}:paused`;
      const pausedCount = await this.redis.llen(pausedKey);
      if (pausedCount > 0) {
        this.logger.debug(`Queue ${queueName} has ${pausedCount} paused jobs`);
        return true;
      }

      this.logger.debug(`Queue ${queueName} is empty - no jobs found`);
      return false;
    } catch (error) {
      this.logger.warn(`Error checking queue ${queueName} for jobs: ${(error as Error).message}`);
      // If we can't check, don't terminate (safer)
      return true;
    }
  }

  /**
   * Handle queue cleanup for entities with no jobs and no workers.
   */
  private async handleQueueCleanup(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    // Check if there's already a queue death queued
    const pendingQueueDeaths =
      await this.indexManager.getEntitiesWithQueuedQueueDeaths(entityType);

    if (pendingQueueDeaths.includes(entityId)) {
      return;
    }

    this.logger.debug(`Cleaning up queue for ${entityType}/${entityId}`);

    // Index the queue death
    await this.indexManager.indexQueueDeath(entityType, entityId);

    // The actual queue cleanup should be handled by a separate processor
    // or by the entity's cleanup callback
  }

  /**
   * Queue worker termination via the entity's queue.
   */
  private async queueWorkerTermination(
    entityType: string,
    entityId: string,
    config: IEntityScalingConfig,
  ): Promise<void> {
    // This is a placeholder - actual implementation would queue a SIGTERM
    // job to the entity's queue, which the worker would pick up and
    // gracefully terminate itself (like in Whatsapi)
    this.logger.debug(
      `Queued worker termination for ${entityType}/${entityId}`,
    );
  }

  /**
   * Get the number of workers for an entity.
   * Uses the worker heartbeat TTL keys as the single source of truth.
   * This is a direct Redis query - no service queue needed since we're just reading keys.
   */
  private async getEntityWorkerCount(
    entityType: string,
    entityId: string,
  ): Promise<number> {
    // Direct query to worker heartbeat TTL keys - the single source of truth
    const workers = await this.workerManager.getEntityWorkers(
      entityType,
      entityId,
    );
    return workers.length;
  }

  /**
   * Get all entities with workers.
   * Uses the worker heartbeat TTL keys as the single source of truth.
   * Worker names follow pattern: {entityId}-worker
   */
  private async getEntitiesWithWorkers(entityType: string): Promise<Set<string>> {
    // Worker heartbeat keys follow pattern: {prefix}:worker:{nodeId}:{entityId}-worker
    const pattern = `${this.keyPrefix}:worker:*:*-worker`;
    const keys = await this.scanKeys(pattern);
    const entities = new Set<string>();

    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length >= 4) {
        // workerName is last part, extract entityId by removing '-worker' suffix
        const workerName = parts[parts.length - 1];
        if (workerName.endsWith('-worker')) {
          const entityId = workerName.slice(0, -7); // Remove '-worker' suffix
          entities.add(entityId);
        }
      }
    }

    return entities;
  }

  /**
   * Determine the scaling action based on current vs desired.
   */
  private determineAction(
    current: number,
    desired: number,
  ): 'spawn' | 'terminate' | 'none' {
    if (current < desired) return 'spawn';
    if (current > desired) return 'terminate';
    return 'none';
  }

  /**
   * Scan Redis keys matching a pattern.
   */
  private async scanKeys(pattern: string): Promise<string[]> {
    let cursor = '0';
    const keys: string[] = [];

    do {
      const [nextCursor, scanKeys] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      keys.push(...scanKeys);
    } while (cursor !== '0');

    return keys;
  }
}
