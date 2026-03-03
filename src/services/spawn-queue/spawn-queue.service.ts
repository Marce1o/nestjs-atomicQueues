import {
  Injectable,
  Logger,
  Inject,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../../domain';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';
import { WorkerManagerService } from '../worker-manager';
import { QueueEventsManagerService } from '../queue-events-manager';

/**
 * Spawn job payload
 */
export interface ISpawnJobData {
  entityType: string;
  entityId: string;
}

/**
 * Handler callback that the ProcessorDiscoveryService registers
 * to actually create the entity worker on this pod.
 */
export type SpawnWorkerHandler = (
  entityType: string,
  entityId: string,
) => Promise<void>;

/**
 * SpawnQueueService
 *
 * Replaces the cron-based / service-queue-based worker creation model
 * with a distributed spawn queue.
 *
 * Architecture:
 * - One shared BullMQ queue: `{prefix}-spawn-queue`
 * - EVERY pod runs a BullMQ Worker on this queue (concurrency: 1)
 * - When QueueEventsManager detects a job for an entity with no worker,
 *   it enqueues a spawn-worker job here
 * - BullMQ distributes spawn jobs round-robin across pods
 * - Whichever pod picks up the job creates the entity worker locally
 * - Duplicate protection: before creating, check if worker already exists
 *   (heartbeat key in Redis). If yes, skip. Race-safe because BullMQ
 *   guarantees only ONE worker processes each job.
 *
 * Benefits over the old cron approach:
 * - Workers naturally distribute across all pods
 * - No single leader / no single point of bottleneck
 * - No distributed lock / leader election needed
 * - Reactive (spawn on demand) rather than polling
 *
 * Idle cleanup:
 * - Each pod runs a local interval that checks its OWN workers' idle time
 * - Idle workers are closed directly (no cross-pod signaling needed)
 */
@Injectable()
export class SpawnQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SpawnQueueService.name);
  private readonly keyPrefix: string;
  private readonly spawnQueueName: string;

  private spawnQueue: Queue | null = null;
  private spawnWorker: Worker | null = null;
  private idleSweepInterval: NodeJS.Timeout | null = null;

  /** Handler registered by ProcessorDiscoveryService */
  private spawnHandler: SpawnWorkerHandler | null = null;

  /** Idle timeout per entity type (set by ProcessorDiscovery) */
  private readonly idleTimeouts: Map<string, number> = new Map();

  /** Default idle timeout in seconds */
  private readonly defaultIdleTimeoutSeconds: number;

  /** Idle sweep interval in ms */
  private readonly idleSweepIntervalMs: number;

  /** Reference to QueueEventsManager for hot-cache eviction on idle close */
  private queueEventsManager: QueueEventsManagerService | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
    private readonly workerManager: WorkerManagerService,
  ) {
    this.keyPrefix = config.keyPrefix || 'aq';
    this.spawnQueueName = `${this.keyPrefix}-spawn-queue`;
    this.defaultIdleTimeoutSeconds = 15;
    this.idleSweepIntervalMs = config.cronInterval ?? 5000;
  }

  /**
   * Set the QueueEventsManagerService reference for hot-cache eviction.
   * Called by ProcessorDiscoveryService to avoid circular dependency.
   */
  setQueueEventsManager(manager: QueueEventsManagerService): void {
    this.queueEventsManager = manager;
  }

  /**
   * Register the handler that creates entity workers.
   * Called by ProcessorDiscoveryService during init.
   */
  registerSpawnHandler(handler: SpawnWorkerHandler): void {
    this.spawnHandler = handler;
    this.logger.debug('Spawn handler registered');
  }

  /**
   * Register idle timeout for an entity type.
   */
  registerIdleTimeout(entityType: string, timeoutSeconds: number): void {
    this.idleTimeouts.set(entityType, timeoutSeconds);
  }

  /**
   * Initialize: create the spawn queue and start the spawn worker + idle sweep.
   */
  async onModuleInit(): Promise<void> {
    // Create the spawn queue
    this.spawnQueue = new Queue(this.spawnQueueName, {
      connection: this.redis.duplicate(),
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: 100,
        attempts: 2,
        backoff: { type: 'fixed', delay: 500 },
      },
    });

    // Create a BullMQ worker on this pod to consume spawn jobs
    this.spawnWorker = new Worker(
      this.spawnQueueName,
      async (job: Job<ISpawnJobData>) => {
        await this.handleSpawnJob(job);
      },
      {
        connection: this.redis.duplicate(),
        concurrency: 3, // Allow a few concurrent spawns
      },
    );

    this.spawnWorker.on('ready', () => {
      this.logger.log(
        `Spawn worker ready on this pod — listening to ${this.spawnQueueName}`,
      );
    });

    this.spawnWorker.on('failed', (job, error) => {
      this.logger.error(
        `Spawn job ${job?.id} failed: ${error.message}`,
      );
    });

    // Start the local idle sweep
    this.startIdleSweep();

    this.logger.log('SpawnQueueService initialized');
  }

  /**
   * Enqueue a spawn-worker request.
   * Called by QueueEventsManager when a job arrives for an entity with no worker.
   *
   * Uses deduplication: jobId = `spawn-{entityType}-{entityId}` so BullMQ
   * will not create a duplicate if one is already queued/active.
   */
  async requestSpawn(entityType: string, entityId: string): Promise<void> {
    if (!this.spawnQueue) {
      this.logger.warn('Spawn queue not initialized yet');
      return;
    }

    const jobId = `spawn-${entityType}-${entityId}`;

    try {
      await this.spawnQueue.add(
        'spawn-worker',
        { entityType, entityId } satisfies ISpawnJobData,
        { jobId },
      );
      this.logger.debug(
        `Enqueued spawn request: ${entityType}/${entityId}`,
      );
    } catch (error) {
      // Duplicate job ID → already queued, that's fine
      const msg = (error as Error).message;
      if (msg.includes('duplicate')) {
        this.logger.debug(
          `Spawn already queued for ${entityType}/${entityId}`,
        );
      } else {
        this.logger.error(`Failed to enqueue spawn: ${msg}`);
      }
    }
  }

  /**
   * Handle a spawn job picked up by this pod's worker.
   */
  private async handleSpawnJob(job: Job<ISpawnJobData>): Promise<void> {
    const { entityType, entityId } = job.data;

    this.logger.log(
      `Processing spawn job: ${entityType}/${entityId} (job ${job.id})`,
    );

    if (!this.spawnHandler) {
      this.logger.warn(
        'No spawn handler registered — cannot create worker',
      );
      return;
    }

    try {
      await this.spawnHandler(entityType, entityId);
    } catch (error) {
      this.logger.error(
        `Spawn handler failed for ${entityType}/${entityId}: ${(error as Error).message}`,
      );
      throw error; // Let BullMQ retry
    }
  }

  /**
   * Direct spawn — bypasses the BullMQ queue entirely.
   * Called by QueueEventsManagerService when it wins the atomic claim
   * and wants to create the worker on this pod immediately.
   */
  async handleSpawnJobDirect(entityType: string, entityId: string): Promise<void> {
    if (!this.spawnHandler) {
      this.logger.warn('No spawn handler registered — cannot create worker (direct)');
      return;
    }

    this.logger.log(`Direct spawn: ${entityType}/${entityId} (no queue round-trip)`);
    await this.spawnHandler(entityType, entityId);
  }

  // =========================================================================
  // IDLE SWEEP — runs locally on each pod
  // =========================================================================

  /**
   * Start the local idle sweep interval.
   * Periodically checks all workers on THIS pod and closes idle ones.
   */
  private startIdleSweep(): void {
    this.idleSweepInterval = setInterval(async () => {
      try {
        await this.sweepIdleWorkers();
      } catch (error) {
        this.logger.error(
          `Idle sweep error: ${(error as Error).message}`,
        );
      }
    }, this.idleSweepIntervalMs);

    this.logger.debug(
      `Idle sweep started (interval: ${this.idleSweepIntervalMs}ms)`,
    );
  }

  /**
   * Sweep all workers on this pod, close any that are idle.
   */
  private async sweepIdleWorkers(): Promise<void> {
    const localWorkers = await this.workerManager.getNodeWorkers();

    if (localWorkers.length === 0) return;

    for (const workerName of localWorkers) {
      // Skip the spawn worker itself
      if (workerName.includes('spawn')) continue;

      // Determine idle timeout for this worker's entity type
      const entityType = this.extractEntityTypeFromWorkerName(workerName);
      const idleTimeout = entityType
        ? (this.idleTimeouts.get(entityType) ?? this.defaultIdleTimeoutSeconds)
        : this.defaultIdleTimeoutSeconds;

      const isIdle = await this.workerManager.isWorkerIdle(workerName, idleTimeout);

      if (isIdle) {
        const idleSeconds = await this.workerManager.getWorkerIdleSeconds(workerName);
        this.logger.log(
          `[IdleSweep] Closing idle worker: ${workerName} (idle ${idleSeconds}s >= ${idleTimeout}s threshold)`,
        );
        // Evict from hot cache BEFORE closing so the next job triggers a fresh spawn
        if (this.queueEventsManager) {
          this.queueEventsManager.evictFromHotCache(workerName);
        }
        await this.workerManager.signalWorkerClose(workerName);
      }
    }
  }

  /**
   * Extract entity type from worker name.
   * Worker names follow pattern: {entityType}-{entityId}-worker
   * e.g., "candy-abc123-worker" → "candy"
   */
  private extractEntityTypeFromWorkerName(workerName: string): string | null {
    // Worker names from config: e.g., "candy-{uuid}-worker"
    // We need to match against registered entity types
    for (const entityType of this.idleTimeouts.keys()) {
      if (workerName.startsWith(`${entityType}-`)) {
        return entityType;
      }
    }
    return null;
  }

  // =========================================================================
  // CLEANUP
  // =========================================================================

  async onModuleDestroy(): Promise<void> {
    // Stop idle sweep
    if (this.idleSweepInterval) {
      clearInterval(this.idleSweepInterval);
      this.idleSweepInterval = null;
    }

    // Close spawn worker
    if (this.spawnWorker) {
      await this.spawnWorker.close();
      this.spawnWorker = null;
    }

    // Close spawn queue
    if (this.spawnQueue) {
      await this.spawnQueue.close();
      this.spawnQueue = null;
    }

    this.logger.log('SpawnQueueService destroyed');
  }
}
