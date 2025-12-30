import {
  Injectable,
  Logger,
  OnModuleInit,
  OnApplicationShutdown,
  Inject,
} from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import {
  IWorkerManager,
  IWorkerState,
  IWorkerCreationOptions,
  IWorkerConfig,
  IAtomicQueuesModuleConfig,
} from '../../domain';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

/**
 * WorkerManagerService
 *
 * Manages worker lifecycle with features from both Whatsapi and bl-blackjack-service:
 *
 * - Dynamic worker creation per entity (user message queue workers, table workers)
 * - Heartbeat-based liveness tracking with TTL
 * - Graceful shutdown via Redis pub/sub
 * - Node-aware worker tracking (multi-instance support)
 * - Automatic cleanup on application shutdown
 *
 * Architecture Notes:
 * - Each worker registers itself with a heartbeat TTL
 * - Workers subscribe to their own shutdown channel
 * - A cron process monitors worker health and spawns/terminates as needed
 * - On application shutdown, all node workers are signaled to close gracefully
 *
 * @example
 * ```typescript
 * const worker = await workerManager.createWorker({
 *   workerName: `user-${userId}-worker`,
 *   queueName: `user-${userId}-queue`,
 *   processor: async (job) => {
 *     // Process job
 *   },
 * });
 * ```
 */
@Injectable()
export class WorkerManagerService
  implements IWorkerManager, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerManagerService.name);
  private readonly nodeId: string;
  private readonly workers: Map<string, Worker> = new Map();
  private readonly workerStates: Map<string, IWorkerState> = new Map();
  private readonly heartbeatIntervals: Map<string, NodeJS.Timeout> = new Map();
  private readonly shutdownSubscriptions: Map<string, () => void> = new Map();
  private subscriberClient: Redis | null = null;
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.nodeId = this.generateNodeId();
    this.keyPrefix = config.keyPrefix || 'aq';
    this.logger.log(`WorkerManager initialized with nodeId: ${this.nodeId}`);
  }

  /**
   * Initialize subscriber client for pub/sub communication.
   */
  onModuleInit(): void {
    this.subscriberClient = this.createSubscriberClient();
  }

  /**
   * Create a new worker with automatic lifecycle management.
   *
   * This method:
   * 1. Creates a BullMQ Worker
   * 2. Sets up heartbeat TTL tracking
   * 3. Subscribes to shutdown channel for graceful termination
   * 4. Registers lifecycle event handlers
   */
  async createWorker(options: IWorkerCreationOptions): Promise<Worker> {
    const { workerName, queueName, config, events, processor } = options;

    // Check if worker already exists
    if (await this.workerExists(workerName)) {
      this.logger.warn(
        `Worker ${workerName} already exists, skipping creation`,
      );
      const existingWorker = this.workers.get(workerName);
      if (existingWorker) return existingWorker;
    }

    this.logger.log(`Creating worker: ${workerName} for queue: ${queueName}`);

    const workerConfig = this.mergeWorkerConfig(config);

    // Create the BullMQ worker
    const worker = new Worker(queueName, processor, {
      connection: this.redis.duplicate(),
      concurrency: workerConfig.concurrency,
      stalledInterval: workerConfig.stalledInterval,
      lockDuration: workerConfig.lockDuration,
      maxStalledCount: workerConfig.maxStalledCount,
    });

    // Store worker instance
    this.workers.set(workerName, worker);

    // Initialize worker state
    const state: IWorkerState = {
      workerId: uuidv4(),
      workerName,
      nodeId: this.nodeId,
      status: 'starting',
      createdAt: new Date(),
      lastHeartbeat: new Date(),
    };
    this.workerStates.set(workerName, state);

    // Set up heartbeat
    this.setupHeartbeat(workerName, workerConfig.heartbeatTTL || 3);

    // Set up shutdown subscription
    await this.subscribeToShutdown(workerName, worker);

    // Register event handlers
    this.registerWorkerEvents(worker, workerName, events);

    return worker;
  }

  /**
   * Check if a worker exists and is alive (has valid heartbeat).
   */
  async workerExists(workerName: string): Promise<boolean> {
    const key = this.getWorkerKey(workerName);
    const exists = await this.redis.exists(key);
    return exists === 1;
  }

  /**
   * Get all running workers for the current node.
   */
  async getNodeWorkers(): Promise<string[]> {
    const pattern = `${this.keyPrefix}:worker:${this.nodeId}:*`;
    const keys = await this.redis.keys(pattern);
    return keys.map((key) => key.split(':').pop()!);
  }

  /**
   * Get all running workers across all nodes.
   */
  async getAllWorkers(): Promise<string[]> {
    const pattern = `${this.keyPrefix}:worker:*:*`;
    const keys = await this.redis.keys(pattern);
    return keys.map((key) => key.split(':').pop()!);
  }

  /**
   * Get all workers for a specific entity.
   * Uses the worker heartbeat TTL keys as the single source of truth.
   * Worker names follow the pattern: {entityId}-worker
   */
  async getEntityWorkers(
    entityType: string,
    entityId: string,
  ): Promise<string[]> {
    // Worker heartbeat keys follow pattern: {prefix}:worker:{nodeId}:{workerName}
    // Worker names follow pattern: {entityId}-worker
    const workerName = `${entityId}-worker`;
    const pattern = `${this.keyPrefix}:worker:*:${workerName}`;
    const keys = await this.redis.keys(pattern);
    return keys.map((key) => key.split(':').pop()!);
  }

  /**
   * Signal a worker to close gracefully via pub/sub.
   */
  async signalWorkerClose(workerName: string): Promise<void> {
    const channel = this.getWorkerShutdownChannel(workerName);
    await this.redis.publish(channel, 'shutdown');
    this.logger.log(`Sent shutdown signal to worker: ${workerName}`);
  }

  /**
   * Signal all workers on current node to close.
   */
  async signalNodeWorkersClose(): Promise<void> {
    const workers = await this.getNodeWorkers();
    this.logger.log(`Signaling ${workers.length} workers to close on node ${this.nodeId}`);

    await Promise.all(
      workers.map((workerName) => this.signalWorkerClose(workerName)),
    );
  }

  /**
   * Close all workers managed by this instance.
   * This is the public API for external callers to gracefully shutdown workers.
   */
  async closeAllWorkers(timeoutMs = 30000): Promise<void> {
    this.logger.warn(`Closing all workers on node ${this.nodeId}`);

    // Clear all heartbeat intervals
    for (const [workerName, interval] of this.heartbeatIntervals) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(workerName);
    }

    // Signal all workers to close
    await this.signalNodeWorkersClose();

    // Wait for workers to close
    try {
      await this.waitForWorkersToClose(timeoutMs);
    } catch (error) {
      this.logger.warn(`Some workers did not close gracefully: ${error}`);
    }
  }

  /**
   * Wait for all node workers to close with timeout.
   */
  async waitForWorkersToClose(timeoutMs = 60000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const workers = await this.getNodeWorkers();

      if (workers.length === 0) {
        this.logger.log(`All workers on node ${this.nodeId} have closed.`);
        return;
      }

      this.logger.debug(`Waiting... ${workers.length} workers remaining.`);
      await this.sleep(1000);
    }

    throw new Error(
      `Timeout reached while waiting for workers to close on node ${this.nodeId}`,
    );
  }

  /**
   * Reset worker heartbeat TTL.
   */
  async resetWorkerHeartbeat(
    workerName: string,
    ttlSeconds?: number,
  ): Promise<void> {
    const ttl = ttlSeconds || this.config.workerDefaults?.heartbeatTTL || 3;
    const key = this.getWorkerKey(workerName);

    const exists = await this.redis.exists(key);
    if (exists) {
      await this.redis.expire(key, ttl);
    } else {
      await this.redis.set(key, '1', 'EX', ttl);
    }

    // Update local state
    const state = this.workerStates.get(workerName);
    if (state) {
      state.lastHeartbeat = new Date();
    }
  }

  /**
   * Remove worker heartbeat (mark as dead).
   */
  async removeWorkerHeartbeat(workerName: string): Promise<void> {
    const key = this.getWorkerKey(workerName);
    await this.redis.del(key);
    this.logger.debug(`Removed heartbeat for worker: ${workerName}`);
  }

  /**
   * Get the node ID for this instance.
   */
  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Index a worker for an entity (for entity-based tracking).
   */
  async indexEntityWorker(
    entityType: string,
    entityId: string,
    workerId: string,
    ttlSeconds = 3,
  ): Promise<void> {
    const key = `${this.keyPrefix}:entity-worker:${entityType}:${entityId}:${workerId}`;
    await this.redis.set(key, '1', 'EX', ttlSeconds);
  }

  /**
   * Remove entity worker index.
   */
  async removeEntityWorkerIndex(
    entityType: string,
    entityId: string,
    workerId: string,
  ): Promise<void> {
    const key = `${this.keyPrefix}:entity-worker:${entityType}:${entityId}:${workerId}`;
    await this.redis.del(key);
  }

  /**
   * Get subscriber client for pub/sub operations.
   */
  getSubscriberClient(): Redis {
    if (!this.subscriberClient) {
      this.subscriberClient = this.createSubscriberClient();
    }
    return this.subscriberClient;
  }

  /**
   * Graceful shutdown on application termination.
   */
  async onApplicationShutdown(): Promise<void> {
    this.logger.warn(`Application shutting down, closing workers on node ${this.nodeId}`);

    // Clear all heartbeat intervals
    for (const [workerName, interval] of this.heartbeatIntervals) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(workerName);
    }

    // Signal all workers to close
    await this.signalNodeWorkersClose();

    // Wait for workers to close
    try {
      await this.waitForWorkersToClose(30000);
    } catch (error) {
      this.logger.warn(`Some workers did not close gracefully: ${error}`);
    }

    // Close subscriber client
    if (this.subscriberClient) {
      await this.subscriberClient.quit();
    }
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * Generate a unique node ID for this instance.
   */
  private generateNodeId(): string {
    return uuidv4();
  }

  /**
   * Create a subscriber client for pub/sub.
   */
  private createSubscriberClient(): Redis {
    return this.redis.duplicate();
  }

  /**
   * Get the Redis key for a worker's heartbeat.
   */
  private getWorkerKey(workerName: string): string {
    return `${this.keyPrefix}:worker:${this.nodeId}:${workerName}`;
  }

  /**
   * Get the shutdown channel for a worker.
   */
  private getWorkerShutdownChannel(workerName: string): string {
    return `${this.keyPrefix}:worker:${workerName}:shutdown`;
  }

  /**
   * Merge worker config with defaults.
   */
  private mergeWorkerConfig(config?: IWorkerConfig): Required<IWorkerConfig> {
    const defaults: Required<IWorkerConfig> = {
      concurrency: 1,
      stalledInterval: 1000,
      lockDuration: 30000,
      maxStalledCount: Number.MAX_SAFE_INTEGER,
      heartbeatTTL: 3,
      heartbeatInterval: 1000,
    };

    return { ...defaults, ...this.config.workerDefaults, ...config };
  }

  /**
   * Set up heartbeat interval for a worker.
   */
  private setupHeartbeat(workerName: string, ttlSeconds: number): void {
    const interval = setInterval(async () => {
      try {
        await this.resetWorkerHeartbeat(workerName, ttlSeconds);
      } catch (error) {
        this.logger.error(
          `Failed to reset heartbeat for worker ${workerName}:`,
          error,
        );
      }
    }, (ttlSeconds * 1000) / 2); // Update at half the TTL

    this.heartbeatIntervals.set(workerName, interval);
  }

  /**
   * Subscribe to shutdown channel for graceful termination.
   */
  private async subscribeToShutdown(
    workerName: string,
    worker: Worker,
  ): Promise<void> {
    const channel = this.getWorkerShutdownChannel(workerName);
    const subscriber = this.getSubscriberClient();

    await subscriber.subscribe(channel);
    this.logger.debug(`Subscribed to shutdown channel: ${channel}`);

    const messageHandler = async (msgChannel: string) => {
      if (msgChannel === channel) {
        this.logger.log(`Received shutdown signal for worker: ${workerName}`);
        await this.closeWorker(workerName, worker);
      }
    };

    subscriber.on('message', messageHandler);

    // Store cleanup function
    this.shutdownSubscriptions.set(workerName, () => {
      subscriber.off('message', messageHandler);
      subscriber.unsubscribe(channel).catch(() => {});
    });
  }

  /**
   * Close a worker and clean up resources.
   */
  private async closeWorker(workerName: string, worker: Worker): Promise<void> {
    // Clear heartbeat interval
    const interval = this.heartbeatIntervals.get(workerName);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(workerName);
    }

    // Unsubscribe from shutdown channel
    const cleanup = this.shutdownSubscriptions.get(workerName);
    if (cleanup) {
      cleanup();
      this.shutdownSubscriptions.delete(workerName);
    }

    // Remove heartbeat
    await this.removeWorkerHeartbeat(workerName);

    // Close worker
    await worker.close();

    // Remove from maps
    this.workers.delete(workerName);
    this.workerStates.delete(workerName);

    this.logger.log(`Worker ${workerName} closed and cleaned up.`);
  }

  /**
   * Register event handlers for a worker.
   */
  private registerWorkerEvents(
    worker: Worker,
    workerName: string,
    events?: IWorkerCreationOptions['events'],
  ): void {
    worker.on('ready', async () => {
      const state = this.workerStates.get(workerName);
      if (state) state.status = 'ready';

      await this.resetWorkerHeartbeat(workerName);
      this.logger.log(`Worker ${workerName} is ready.`);

      if (events?.onReady) {
        await events.onReady(worker, workerName);
      }
    });

    worker.on('completed', async (job: Job) => {
      this.logger.debug(`Worker ${workerName} completed job: ${job.id}`);
      if (events?.onCompleted) {
        await events.onCompleted(job, workerName);
      }
    });

    worker.on('failed', async (job: Job | undefined, error: Error) => {
      this.logger.error(
        `Worker ${workerName} failed job ${job?.id}: ${error.message}`,
      );
      if (events?.onFailed) {
        await events.onFailed(job, error, workerName);
      }
    });

    worker.on('progress', async (job: Job, progress: any) => {
      this.logger.debug(`Worker ${workerName} job ${job.id} progress: ${JSON.stringify(progress)}`);
      if (events?.onProgress) {
        await events.onProgress(job, progress);
      }
    });

    worker.on('stalled', async (jobId: string) => {
      this.logger.warn(`Worker ${workerName} job ${jobId} stalled`);
      if (events?.onStalled) {
        await events.onStalled(jobId, workerName);
      }
    });

    worker.on('closing', () => {
      const state = this.workerStates.get(workerName);
      if (state) state.status = 'closing';

      this.logger.log(`Worker ${workerName} is closing...`);
      if (events?.onClosing) {
        events.onClosing(workerName);
      }
    });

    worker.on('closed', async () => {
      this.logger.log(`Worker ${workerName} closed.`);
      if (events?.onClosed) {
        await events.onClosed(workerName);
      }
    });
  }

  /**
   * Sleep utility.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
