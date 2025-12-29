import { Injectable, Logger, Inject, OnModuleDestroy } from '@nestjs/common';
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

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
    private readonly workerManager: WorkerManagerService,
    private readonly indexManager: IndexManagerService,
  ) {
    this.keyPrefix = config.keyPrefix || 'aq';
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
   * This is the main logic that:
   * 1. Gets entities with queued jobs
   * 2. Gets entities with running workers
   * 3. Calculates scaling decisions
   * 4. Spawns missing workers
   * 5. Terminates excess workers
   * 6. Cleans up empty queues
   */
  async runScalingCycle(): Promise<IScalingDecision[]> {
    const decisions: IScalingDecision[] = [];

    for (const [entityType, config] of this.entityConfigs) {
      try {
        const entityDecisions = await this.runEntityScalingCycle(
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
   */
  private async runEntityScalingCycle(
    entityType: string,
    config: IEntityScalingConfig,
  ): Promise<IScalingDecision[]> {
    const decisions: IScalingDecision[] = [];

    // Get entities with queued jobs
    const entitiesWithJobs = await this.indexManager.getEntitiesWithJobs(entityType);
    const entityIdsWithJobs = new Set(Object.keys(entitiesWithJobs));

    // Get entities with running workers
    const entitiesWithWorkers = await this.getEntitiesWithWorkers(entityType);

    // Get entities with active queues
    const entitiesWithQueues = await this.indexManager.getEntitiesWithQueues(entityType);

    // Spawn missing workers for entities with jobs
    for (const entityId of entityIdsWithJobs) {
      const decision = await this.handleEntitySpawning(
        entityType,
        entityId,
        config,
        entitiesWithJobs[entityId],
      );
      if (decision) decisions.push(decision);
    }

    // Handle excess workers
    for (const entityId of entityIdsWithJobs) {
      const decision = await this.handleExcessWorkers(
        entityType,
        entityId,
        config,
      );
      if (decision) decisions.push(decision);
    }

    // Close workers for entities with no jobs but workers running
    const entitiesWithWorkersNoJobs = Array.from(entitiesWithWorkers).filter(
      (entityId) => !entityIdsWithJobs.has(entityId),
    );

    for (const entityId of entitiesWithWorkersNoJobs) {
      const decision = await this.handleWorkerClosure(
        entityType,
        entityId,
        config,
      );
      if (decision) decisions.push(decision);
    }

    // Clean up empty queues (no jobs, no workers)
    const emptyQueueEntities = entitiesWithQueues.filter(
      (entityId) =>
        !entityIdsWithJobs.has(entityId) &&
        !entitiesWithWorkers.has(entityId),
    );

    for (const entityId of emptyQueueEntities) {
      await this.handleQueueCleanup(entityType, entityId);
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

    // Track worker creation requests to avoid over-spawning
    const pendingCreations = await this.getPendingWorkerCreations(
      entityType,
      entityId,
    );
    const actualToSpawn = Math.max(0, toSpawn - pendingCreations);

    for (let i = 0; i < actualToSpawn; i++) {
      await this.incrementWorkerCreationRequest(entityType, entityId);
      if (config.onSpawnWorker) {
        try {
          await config.onSpawnWorker(entityId);
        } catch (error) {
          this.logger.error(
            `Failed to spawn worker for ${entityType}/${entityId}: ${(error as Error).message}`,
          );
          await this.decrementWorkerCreationRequest(entityType, entityId);
        }
      }
    }

    return {
      entityId,
      entityType,
      currentWorkers,
      desiredWorkers: targetWorkers,
      action: 'spawn',
      count: actualToSpawn,
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
   * Handle worker closure for entities with no jobs.
   */
  private async handleWorkerClosure(
    entityType: string,
    entityId: string,
    config: IEntityScalingConfig,
  ): Promise<IScalingDecision | null> {
    const workers = await this.workerManager.getEntityWorkers(entityType, entityId);

    if (workers.length === 0) {
      return null;
    }

    this.logger.debug(
      `Closing ${workers.length} workers for empty ${entityType}/${entityId}`,
    );

    // Signal all workers to close
    for (const workerId of workers) {
      if (config.onTerminateWorker) {
        await config.onTerminateWorker(entityId, workerId);
      } else {
        await this.workerManager.signalWorkerClose(workerId);
      }
    }

    return {
      entityId,
      entityType,
      currentWorkers: workers.length,
      desiredWorkers: 0,
      action: 'terminate',
      count: workers.length,
    };
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
   */
  private async getEntityWorkerCount(
    entityType: string,
    entityId: string,
  ): Promise<number> {
    const workers = await this.workerManager.getEntityWorkers(
      entityType,
      entityId,
    );
    return workers.length;
  }

  /**
   * Get all entities with workers.
   */
  private async getEntitiesWithWorkers(entityType: string): Promise<Set<string>> {
    const pattern = `${this.keyPrefix}:entity-worker:${entityType}:*:*`;
    const keys = await this.scanKeys(pattern);
    const entities = new Set<string>();

    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length >= 4) {
        entities.add(parts[3]); // entityId is at index 3
      }
    }

    return entities;
  }

  /**
   * Get pending worker creation requests count.
   */
  private async getPendingWorkerCreations(
    entityType: string,
    entityId: string,
  ): Promise<number> {
    const key = `${this.keyPrefix}:worker-creation:${entityType}:${entityId}`;
    const count = await this.redis.get(key);
    return count ? parseInt(count, 10) : 0;
  }

  /**
   * Increment worker creation request counter.
   */
  private async incrementWorkerCreationRequest(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const key = `${this.keyPrefix}:worker-creation:${entityType}:${entityId}`;
    await this.redis.incr(key);
    await this.redis.expire(key, 60); // TTL for cleanup
  }

  /**
   * Decrement worker creation request counter.
   */
  async decrementWorkerCreationRequest(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const key = `${this.keyPrefix}:worker-creation:${entityType}:${entityId}`;
    const current = await this.redis.get(key);

    if (current && parseInt(current, 10) > 0) {
      await this.redis.decr(key);
    }
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
