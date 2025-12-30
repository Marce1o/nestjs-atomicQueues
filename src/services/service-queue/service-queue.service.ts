import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig } from '../../domain';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

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

/**
 * ServiceQueueManager
 *
 * Manages the global service-level queue for operations that MUST be atomic
 * across the entire distributed system. Unlike per-entity queues that can have
 * one worker per entity, the service queue has EXACTLY ONE worker globally.
 *
 * Use cases:
 * - Querying global worker counts (can't race with worker creation/deletion)
 * - Ownership verification for resources
 * - Global state mutations
 * - Cross-node coordination
 *
 * Architecture:
 * - Uses a distributed lock to ensure only ONE service worker exists globally
 * - The worker can run on ANY node
 * - If the worker dies, another node will acquire the lock and spawn it
 * - All operations go through the single queue for serialization
 *
 * @example
 * ```typescript
 * // Execute a global atomic operation
 * const workerCount = await serviceQueue.executeServiceOperation(
 *   ServiceQueueJobNames.GET_GLOBAL_WORKER_COUNT,
 *   { entityType: 'table' },
 * );
 * ```
 */
@Injectable()
export class ServiceQueueManager implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ServiceQueueManager.name);
  private readonly keyPrefix: string;
  private readonly serviceQueueName: string;
  private readonly serviceWorkerName: string;
  private readonly lockKey: string;
  private readonly lockTTL = 10; // 10 seconds lock TTL
  private readonly lockRenewalInterval = 3000; // Renew every 3 seconds

  private serviceQueue: Queue | null = null;
  private serviceWorker: Worker | null = null;
  private lockRenewalTimer: NodeJS.Timeout | null = null;
  private subscriberClient: Redis | null = null;
  private hasLock = false;
  private readonly nodeId: string;

  // Pending operation callbacks (for request-response pattern)
  private readonly pendingOperations: Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();

  // Custom processors registered by the consuming application
  private readonly customProcessors: Map<
    string,
    (payload: unknown) => Promise<unknown>
  > = new Map();

  // Scaling cycle handler (registered by CronManager)
  private scalingCycleHandler: ((entityType: string) => Promise<unknown>) | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.keyPrefix = config.keyPrefix || 'aq';
    this.serviceQueueName =
      config.serviceQueue?.queueName || `${this.keyPrefix}-service-queue`;
    this.serviceWorkerName =
      config.serviceQueue?.workerName || `${this.keyPrefix}-service-worker`;
    this.lockKey = `${this.keyPrefix}:service-worker-lock`;
    this.nodeId = uuidv4();
  }

  /**
   * Initialize on module start.
   * Attempts to acquire the global service worker lock.
   */
  async onModuleInit(): Promise<void> {
    if (this.config.serviceQueue?.enabled === false) {
      this.logger.log('Service queue is disabled by configuration');
      return;
    }

    // Create the queue (all nodes need access to add jobs)
    this.serviceQueue = new Queue(this.serviceQueueName, {
      connection: this.redis.duplicate(),
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: 100,
      },
    });

    // Set up subscriber for response channel
    this.subscriberClient = this.redis.duplicate();

    // Try to acquire the lock and become the service worker
    await this.tryAcquireServiceWorkerLock();

    // Start periodic lock acquisition attempts (in case current holder dies)
    this.startLockAcquisitionLoop();

    this.logger.log(
      `ServiceQueueManager initialized on node ${this.nodeId}`,
    );
  }

  /**
   * Cleanup on shutdown.
   */
  async onApplicationShutdown(): Promise<void> {
    // Stop lock renewal
    if (this.lockRenewalTimer) {
      clearInterval(this.lockRenewalTimer);
      this.lockRenewalTimer = null;
    }

    // Close worker if we own it
    if (this.serviceWorker && this.hasLock) {
      await this.serviceWorker.close();
      this.serviceWorker = null;
    }

    // Release lock
    if (this.hasLock) {
      await this.releaseLock();
    }

    // Close queue
    if (this.serviceQueue) {
      await this.serviceQueue.close();
      this.serviceQueue = null;
    }

    // Close subscriber
    if (this.subscriberClient) {
      await this.subscriberClient.quit();
      this.subscriberClient = null;
    }

    // Reject all pending operations
    for (const [uuid, pending] of this.pendingOperations) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Service queue shutting down'));
      this.pendingOperations.delete(uuid);
    }

    this.logger.log('ServiceQueueManager shut down');
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  /**
   * Execute a service-level operation atomically.
   * This queues the operation to the service queue and waits for the result.
   *
   * @param jobName The type of operation to execute
   * @param payload The operation payload
   * @param timeoutMs Timeout in milliseconds (default: 30000)
   * @returns The operation result
   */
  async executeServiceOperation<T, R>(
    jobName: ServiceQueueJobNames,
    payload: T,
    timeoutMs = 30000,
  ): Promise<R> {
    if (!this.serviceQueue) {
      throw new Error('Service queue not initialized');
    }

    const uuid = uuidv4();
    const responseChannel = `${this.keyPrefix}:service-response:${uuid}`;

    const jobData: IServiceQueueJobData<T> = {
      uuid,
      jobName,
      payload,
      responseChannel,
    };

    // Set up response listener before adding job
    const resultPromise = this.waitForResponse<R>(uuid, responseChannel, timeoutMs);

    // Add job to service queue
    await this.serviceQueue.add(jobName, jobData);

    return resultPromise;
  }

  /**
   * Queue a service operation without waiting for result (fire-and-forget).
   */
  async queueServiceOperation<T>(
    jobName: ServiceQueueJobNames,
    payload: T,
  ): Promise<string> {
    if (!this.serviceQueue) {
      throw new Error('Service queue not initialized');
    }

    const uuid = uuidv4();

    const jobData: IServiceQueueJobData<T> = {
      uuid,
      jobName,
      payload,
    };

    await this.serviceQueue.add(jobName, jobData);
    return uuid;
  }

  /**
   * Register a custom processor for service-level operations.
   * This allows the consuming application to add custom atomic operations.
   */
  registerCustomProcessor(
    name: string,
    processor: (payload: unknown) => Promise<unknown>,
  ): void {
    this.customProcessors.set(name, processor);
    this.logger.debug(`Registered custom service processor: ${name}`);
  }

  /**
   * Check if this node is the service worker owner.
   */
  isServiceWorkerOwner(): boolean {
    return this.hasLock;
  }

  /**
   * Register the scaling cycle handler (called by CronManager).
   * This allows CronManager to register its internal scaling logic to be
   * executed atomically by the service worker.
   */
  registerScalingCycleHandler(
    handler: (entityType: string) => Promise<unknown>,
  ): void {
    this.scalingCycleHandler = handler;
    this.logger.debug('Scaling cycle handler registered');
  }

  /**
   * Spawn worker handler type - directly spawns a worker for a specific entity.
   */
  private spawnWorkerHandler?: (entityType: string, entityId: string) => Promise<void>;

  /**
   * Register the spawn worker handler (called by CronManager or TableWorkerScalingService).
   * This allows directly spawning a worker for a specific entity without waiting
   * for the next scaling cycle.
   */
  registerSpawnWorkerHandler(
    handler: (entityType: string, entityId: string) => Promise<void>,
  ): void {
    this.spawnWorkerHandler = handler;
    this.logger.debug('Spawn worker handler registered');
  }

  /**
   * Trigger a scaling cycle for an entity type.
   * This queues the job to the service queue - only the service worker will execute it.
   */
  async triggerScalingCycle(entityType: string): Promise<void> {
    if (!this.serviceQueue) {
      this.logger.warn('Service queue not initialized, cannot trigger scaling cycle');
      return;
    }

    // Fire-and-forget - we don't need to wait for the result
    await this.queueServiceOperation(ServiceQueueJobNames.RUN_SCALING_CYCLE, {
      entityType,
    });
  }

  /**
   * Request spawning a worker for a specific entity.
   * This is used when an entity (e.g., table) is opened and needs a worker immediately,
   * without waiting for the next scaling cycle.
   * 
   * The job is processed by the service worker to ensure atomic operation.
   * 
   * @param entityType The type of entity (e.g., 'table')
   * @param entityId The ID of the entity (e.g., tableId)
   */
  async requestSpawnEntityWorker(entityType: string, entityId: string): Promise<void> {
    if (!this.serviceQueue) {
      this.logger.warn('Service queue not initialized, cannot spawn entity worker');
      return;
    }

    this.logger.log(`Requesting worker spawn for ${entityType}/${entityId}`);
    
    // Fire-and-forget - we don't need to wait for the result
    await this.queueServiceOperation(ServiceQueueJobNames.SPAWN_ENTITY_WORKER, {
      entityType,
      entityId,
    });
  }

  /**
   * Get the service queue name.
   */
  getQueueName(): string {
    return this.serviceQueueName;
  }

  /**
   * Get the service worker name.
   */
  getWorkerName(): string {
    return this.serviceWorkerName;
  }

  /**
   * Get pending job count in the service queue.
   */
  async getQueueDepth(): Promise<number> {
    if (!this.serviceQueue) return 0;
    const counts = await this.serviceQueue.getJobCounts();
    return counts.waiting + counts.active + counts.delayed;
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * Try to acquire the global service worker lock.
   */
  private async tryAcquireServiceWorkerLock(): Promise<boolean> {
    // Use SET NX EX for atomic lock acquisition
    const result = await this.redis.set(
      this.lockKey,
      this.nodeId,
      'EX',
      this.lockTTL,
      'NX',
    );

    if (result === 'OK') {
      this.hasLock = true;
      this.logger.log(
        `Node ${this.nodeId} acquired service worker lock`,
      );

      // Start the service worker
      await this.startServiceWorker();

      // Start lock renewal
      this.startLockRenewal();

      return true;
    }

    // Log who holds the lock and its TTL
    const currentOwner = await this.redis.get(this.lockKey);
    const ttl = await this.redis.ttl(this.lockKey);
    this.logger.debug(
      `Service worker lock held by node ${currentOwner} (TTL: ${ttl}s). ` +
      `This node ${this.nodeId} will retry after lock expires.`,
    );

    return false;
  }

  /**
   * Release the service worker lock.
   */
  private async releaseLock(): Promise<void> {
    // Only release if we own the lock
    const currentOwner = await this.redis.get(this.lockKey);
    if (currentOwner === this.nodeId) {
      await this.redis.del(this.lockKey);
      this.hasLock = false;
      this.logger.log(`Node ${this.nodeId} released service worker lock`);
    }
  }

  /**
   * Start periodic lock renewal.
   */
  private startLockRenewal(): void {
    this.lockRenewalTimer = setInterval(async () => {
      if (!this.hasLock) return;

      try {
        // Only extend if we still own the lock
        const currentOwner = await this.redis.get(this.lockKey);
        if (currentOwner === this.nodeId) {
          await this.redis.expire(this.lockKey, this.lockTTL);
        } else {
          // We lost the lock somehow
          this.hasLock = false;
          this.logger.warn(
            `Node ${this.nodeId} lost service worker lock unexpectedly`,
          );
          await this.stopServiceWorker();
        }
      } catch (error) {
        this.logger.error(`Error renewing service worker lock: ${error}`);
      }
    }, this.lockRenewalInterval);
  }

  /**
   * Start periodic lock acquisition attempts.
   * Retries more frequently initially, then backs off to lockTTL interval.
   */
  private startLockAcquisitionLoop(): void {
    let retryCount = 0;
    const maxFastRetries = 5;
    const fastRetryInterval = 2000; // 2 seconds initially
    const normalRetryInterval = (this.lockTTL + 1) * 1000;

    const tryAcquire = async () => {
      if (this.hasLock) return;

      // Check if lock exists
      const lockExists = await this.redis.exists(this.lockKey);
      if (!lockExists) {
        const acquired = await this.tryAcquireServiceWorkerLock();
        if (acquired) return;
      }

      // Schedule next attempt
      retryCount++;
      const interval = retryCount <= maxFastRetries ? fastRetryInterval : normalRetryInterval;
      setTimeout(tryAcquire, interval);
    };

    // Start the acquisition loop after a short delay
    setTimeout(tryAcquire, fastRetryInterval);
  }

  /**
   * Start the service worker.
   */
  private async startServiceWorker(): Promise<void> {
    if (this.serviceWorker) {
      await this.serviceWorker.close();
    }

    this.serviceWorker = new Worker(
      this.serviceQueueName,
      async (job: Job<IServiceQueueJobData>) => {
        return this.processServiceJob(job);
      },
      {
        connection: this.redis.duplicate(),
        concurrency: 1, // MUST be 1 for atomic operations
      },
    );

    this.serviceWorker.on('ready', () => {
      this.logger.log(`Service worker ready on node ${this.nodeId}`);
    });

    this.serviceWorker.on('error', (error) => {
      this.logger.error(`Service worker error: ${error.message}`);
    });
  }

  /**
   * Stop the service worker.
   */
  private async stopServiceWorker(): Promise<void> {
    if (this.serviceWorker) {
      await this.serviceWorker.close();
      this.serviceWorker = null;
    }
  }

  /**
   * Process a service queue job.
   */
  private async processServiceJob(
    job: Job<IServiceQueueJobData>,
  ): Promise<unknown> {
    const { uuid, jobName, payload, responseChannel } = job.data;

    this.logger.debug(
      `Processing service job ${uuid}: ${jobName}`,
    );

    let result: unknown;
    let error: Error | null = null;

    try {
      switch (jobName) {
        case ServiceQueueJobNames.GET_GLOBAL_WORKER_COUNT:
          result = await this.handleGetGlobalWorkerCount(payload);
          break;

        case ServiceQueueJobNames.GET_ENTITY_WORKERS:
          result = await this.handleGetEntityWorkers(payload);
          break;

        case ServiceQueueJobNames.VERIFY_OWNERSHIP:
          result = await this.handleVerifyOwnership(payload);
          break;

        case ServiceQueueJobNames.ACQUIRE_GLOBAL_LOCK:
          result = await this.handleAcquireGlobalLock(payload);
          break;

        case ServiceQueueJobNames.RELEASE_GLOBAL_LOCK:
          result = await this.handleReleaseGlobalLock(payload);
          break;

        case ServiceQueueJobNames.RUN_SCALING_CYCLE:
          result = await this.handleRunScalingCycle(payload);
          break;

        case ServiceQueueJobNames.SPAWN_ENTITY_WORKER:
          result = await this.handleSpawnEntityWorker(payload);
          break;

        case ServiceQueueJobNames.CUSTOM:
          result = await this.handleCustomOperation(payload);
          break;

        default:
          throw new Error(`Unknown service job name: ${jobName}`);
      }
    } catch (err) {
      error = err as Error;
      this.logger.error(
        `Service job ${uuid} failed: ${error.message}`,
      );
    }

    // Send response if channel specified
    if (responseChannel) {
      await this.redis.publish(
        responseChannel,
        JSON.stringify({
          uuid,
          success: !error,
          result,
          error: error?.message,
        }),
      );
    }

    if (error) throw error;
    return result;
  }

  /**
   * Wait for a response on a channel.
   */
  private async waitForResponse<R>(
    uuid: string,
    channel: string,
    timeoutMs: number,
  ): Promise<R> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingOperations.delete(uuid);
        this.subscriberClient?.unsubscribe(channel).catch(() => {});
        reject(new Error(`Service operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingOperations.set(uuid, { 
        resolve: resolve as (result: unknown) => void, 
        reject, 
        timeout 
      });

      // Subscribe to response channel
      this.subscriberClient?.subscribe(channel).then(() => {
        const handler = (ch: string, message: string) => {
          if (ch === channel) {
            const response = JSON.parse(message);
            if (response.uuid === uuid) {
              clearTimeout(timeout);
              this.pendingOperations.delete(uuid);
              this.subscriberClient?.unsubscribe(channel).catch(() => {});
              this.subscriberClient?.off('message', handler);

              if (response.success) {
                resolve(response.result as R);
              } else {
                reject(new Error(response.error || 'Service operation failed'));
              }
            }
          }
        };

        this.subscriberClient?.on('message', handler);
      });
    });
  }

  // =========================================================================
  // BUILT-IN SERVICE HANDLERS
  // =========================================================================

  /**
   * Get global worker count across all nodes.
   */
  private async handleGetGlobalWorkerCount(
    payload: unknown,
  ): Promise<number> {
    const { entityType } = payload as { entityType?: string };
    const pattern = entityType
      ? `${this.keyPrefix}:worker:*:${entityType}-*`
      : `${this.keyPrefix}:worker:*:*`;

    const keys = await this.scanKeys(pattern);
    return keys.length;
  }

  /**
   * Get workers for a specific entity.
   * Uses the worker heartbeat TTL keys as the single source of truth.
   */
  private async handleGetEntityWorkers(
    payload: unknown,
  ): Promise<string[]> {
    const { entityType, entityId } = payload as {
      entityType: string;
      entityId: string;
    };
    // Worker heartbeat keys follow pattern: {prefix}:worker:{nodeId}:{workerName}
    // Worker names follow pattern: {entityId}-worker
    const workerName = `${entityId}-worker`;
    const pattern = `${this.keyPrefix}:worker:*:${workerName}`;
    const keys = await this.scanKeys(pattern);
    return keys.map((key) => key.split(':').pop()!);
  }

  /**
   * Verify ownership of a resource.
   */
  private async handleVerifyOwnership(
    payload: unknown,
  ): Promise<{ owned: boolean; owner?: string }> {
    const { resourceType, resourceId, expectedOwner } = payload as {
      resourceType: string;
      resourceId: string;
      expectedOwner: string;
    };

    const key = `${this.keyPrefix}:lock:${resourceType}:${resourceId}`;
    const owner = await this.redis.get(key);

    return {
      owned: owner === expectedOwner,
      owner: owner || undefined,
    };
  }

  /**
   * Acquire a global lock atomically.
   */
  private async handleAcquireGlobalLock(
    payload: unknown,
  ): Promise<{ acquired: boolean }> {
    const { lockName, ownerId, ttlSeconds = 30 } = payload as {
      lockName: string;
      ownerId: string;
      ttlSeconds?: number;
    };

    const key = `${this.keyPrefix}:global-lock:${lockName}`;
    const result = await this.redis.set(key, ownerId, 'EX', ttlSeconds, 'NX');

    return { acquired: result === 'OK' };
  }

  /**
   * Release a global lock atomically.
   */
  private async handleReleaseGlobalLock(
    payload: unknown,
  ): Promise<{ released: boolean }> {
    const { lockName, ownerId } = payload as {
      lockName: string;
      ownerId: string;
    };

    const key = `${this.keyPrefix}:global-lock:${lockName}`;

    // Only release if we own it (using Lua for atomicity)
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.redis.eval(script, 1, key, ownerId);
    return { released: result === 1 };
  }

  /**
   * Handle custom operation by delegating to registered processor.
   */
  private async handleCustomOperation(
    payload: unknown,
  ): Promise<unknown> {
    const { processorName, data } = payload as {
      processorName: string;
      data: unknown;
    };

    const processor = this.customProcessors.get(processorName);
    if (!processor) {
      throw new Error(`No custom processor registered for: ${processorName}`);
    }

    return processor(data);
  }

  /**
   * Handle scaling cycle request by delegating to registered CronManager handler.
   */
  private async handleRunScalingCycle(
    payload: unknown,
  ): Promise<unknown> {
    const { entityType } = payload as { entityType: string };

    if (!this.scalingCycleHandler) {
      this.logger.warn(`No scaling cycle handler registered for entity type: ${entityType}`);
      return { processed: false, reason: 'no_handler' };
    }

    try {
      const result = await this.scalingCycleHandler(entityType);
      return { processed: true, result };
    } catch (error) {
      this.logger.error(`Scaling cycle failed for ${entityType}: ${(error as Error).message}`);
      return { processed: false, error: (error as Error).message };
    }
  }

  /**
   * Handle spawn entity worker request.
   * This directly spawns a worker for the specific entity, bypassing the scaling cycle.
   * Used when opening a table/entity that needs a worker immediately.
   */
  private async handleSpawnEntityWorker(
    payload: unknown,
  ): Promise<unknown> {
    const { entityType, entityId } = payload as { entityType: string; entityId: string };

    this.logger.log(`Processing spawn worker request for ${entityType}/${entityId}`);

    if (!this.spawnWorkerHandler) {
      this.logger.warn(`No spawn worker handler registered, cannot spawn worker for ${entityType}/${entityId}`);
      return { spawned: false, reason: 'no_spawn_handler' };
    }

    try {
      // Directly spawn the worker for this specific entity
      await this.spawnWorkerHandler(entityType, entityId);
      this.logger.log(`Worker spawned for ${entityType}/${entityId}`);
      return { spawned: true, entityType, entityId };
    } catch (error) {
      this.logger.error(`Failed to spawn worker for ${entityType}/${entityId}: ${(error as Error).message}`);
      return { spawned: false, error: (error as Error).message };
    }
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
