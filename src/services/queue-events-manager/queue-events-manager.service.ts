import {
  Injectable,
  Logger,
  Inject,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';
import { IAtomicQueuesModuleConfig } from '../../domain';
import { WorkerManagerService } from '../worker-manager';
import { ServiceQueueManager, ServiceQueueJobNames } from '../service-queue';

/**
 * Callback for spawning a worker for an entity.
 */
export type OnJobArrivedCallback = (
  entityType: string,
  entityId: string,
  queueName: string,
) => Promise<void>;

/**
 * Registered queue events info.
 */
interface RegisteredQueueEvents {
  queueName: string;
  entityType: string;
  queueEvents: QueueEvents;
  extractEntityId: (queueName: string) => string;
}

/**
 * QueueEventsManagerService
 *
 * Listens to BullMQ queue events using Redis pub/sub (ecological).
 * When a job is added to a queue and no worker exists, triggers worker spawning.
 *
 * This enables a "scalerless" architecture where:
 * - Workers are spawned on-demand when jobs arrive
 * - Workers terminate themselves when idle
 * - No need for @EntityScaler with @GetActiveEntities
 *
 * Key Features:
 * - Redis pub/sub based (ecological) - no polling
 * - Uses BullMQ's QueueEvents for reliable event delivery
 * - Checks for existing workers before spawning
 * - Integrates with ServiceQueue for distributed coordination
 *
 * @example
 * ```typescript
 * // Register a queue for event listening
 * queueEventsManager.registerQueue({
 *   queueName: 'aq:table:123:queue',
 *   entityType: 'table',
 *   extractEntityId: (qn) => qn.split(':')[2], // 123
 *   onJobArrived: async (entityType, entityId) => {
 *     await createWorkerForEntity(entityType, entityId);
 *   },
 * });
 * ```
 */
@Injectable()
export class QueueEventsManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueEventsManagerService.name);
  private readonly registeredQueues: Map<string, RegisteredQueueEvents> = new Map();
  private readonly keyPrefix: string;
  private readonly useServiceQueue: boolean;
  
  // Pattern-based listeners for dynamic queue spawning
  private readonly entityPatterns: Map<string, {
    queueNameFn: (entityId: string) => string;
    workerNameFn: (entityId: string) => string;
    extractEntityId: (queueName: string) => string | null;
  }> = new Map();
  
  // Global callback for spawning workers
  private onJobArrivedCallback: OnJobArrivedCallback | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
    private readonly workerManager: WorkerManagerService,
    @Optional() private readonly serviceQueueManager?: ServiceQueueManager,
  ) {
    this.keyPrefix = config.keyPrefix || 'aq';
    this.useServiceQueue = config.serviceQueue?.enabled !== false;
  }

  /**
   * Register a callback to be called when a job arrives for any queue
   * and no worker exists. Used by ProcessorDiscoveryService.
   */
  setOnJobArrivedCallback(callback: OnJobArrivedCallback): void {
    this.onJobArrivedCallback = callback;
    this.logger.debug('OnJobArrived callback registered');
  }

  /**
   * Register an entity type pattern for automatic queue event listening.
   * When a job is added to any queue matching this pattern, a worker spawn is triggered.
   */
  registerEntityPattern(
    entityType: string,
    queueNameFn: (entityId: string) => string,
    workerNameFn: (entityId: string) => string,
  ): void {
    // Create a regex pattern extractor by analyzing the queueNameFn
    // We pass a known placeholder and see where it appears in the result
    const placeholder = '__ENTITY_ID_PLACEHOLDER__';
    const sampleQueueName = queueNameFn(placeholder);
    
    // Escape regex special characters in the parts before/after the placeholder
    const parts = sampleQueueName.split(placeholder);
    const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    let extractRegex: RegExp;
    if (parts.length === 2) {
      // Standard case: prefix + entityId + suffix
      const [prefix, suffix] = parts;
      extractRegex = new RegExp(`^${escapeRegex(prefix)}(.+)${escapeRegex(suffix)}$`);
    } else {
      // Fallback: try common patterns
      extractRegex = new RegExp(`^(.+)-queue$`);
    }
    
    const extractEntityId = (queueName: string): string | null => {
      const match = queueName.match(extractRegex);
      return match ? match[1] : null;
    };

    // Log the derived pattern for debugging
    this.logger.debug(
      `[${entityType}] Derived queue pattern: ${extractRegex.source} from sample: ${sampleQueueName}`,
    );

    this.entityPatterns.set(entityType, {
      queueNameFn,
      workerNameFn,
      extractEntityId,
    });

    this.logger.log(
      `Registered entity pattern for '${entityType}' - will listen for job arrivals`,
    );
  }

  /**
   * Listen for job arrivals on a specific queue.
   * Creates a QueueEvents instance for the queue and listens for 'waiting' events.
   *
   * @param queueName The BullMQ queue name to listen to
   * @param entityType The entity type (e.g., 'table')
   * @param extractEntityId Function to extract entityId from queue name
   */
  async listenToQueue(
    queueName: string,
    entityType: string,
    extractEntityId: (queueName: string) => string,
  ): Promise<void> {
    if (this.registeredQueues.has(queueName)) {
      this.logger.debug(`Already listening to queue: ${queueName}`);
      return;
    }

    this.logger.debug(`Starting to listen to queue events: ${queueName}`);

    const queueEvents = new QueueEvents(queueName, {
      connection: this.redis.duplicate(),
    });

    // Listen for job added events (waiting state)
    queueEvents.on('waiting', async ({ jobId }) => {
      await this.handleJobArrived(queueName, entityType, extractEntityId, jobId);
    });

    // Also listen for delayed jobs becoming ready
    queueEvents.on('delayed', async ({ jobId }) => {
      this.logger.debug(`[QueueEvents] Job ${jobId} delayed in ${queueName}`);
    });

    // Store the registered queue
    this.registeredQueues.set(queueName, {
      queueName,
      entityType,
      queueEvents,
      extractEntityId,
    });

    this.logger.log(`Listening to queue events: ${queueName}`);
  }

  /**
   * Handle job arrival - check if worker exists and spawn if needed.
   */
  private async handleJobArrived(
    queueName: string,
    entityType: string,
    extractEntityId: (queueName: string) => string,
    jobId: string,
  ): Promise<void> {
    const entityId = extractEntityId(queueName);
    this.logger.debug(
      `[QueueEvents] Job ${jobId} waiting in ${queueName} (entity: ${entityType}/${entityId})`,
    );

    // Check if worker already exists for this entity
    const pattern = this.entityPatterns.get(entityType);
    if (!pattern) {
      this.logger.warn(`No pattern registered for entity type: ${entityType}`);
      return;
    }

    const workerName = pattern.workerNameFn(entityId);
    const workerExists = await this.workerManager.workerExists(workerName);

    if (workerExists) {
      this.logger.debug(
        `[QueueEvents] Worker ${workerName} already exists, job will be processed`,
      );
      return;
    }

    this.logger.log(
      `[QueueEvents] No worker for ${entityType}/${entityId}, triggering spawn`,
    );

    // Trigger worker spawn through service queue for distributed coordination
    if (this.useServiceQueue && this.serviceQueueManager) {
      try {
        await this.serviceQueueManager.requestSpawnEntityWorker(entityType, entityId);
        this.logger.debug(
          `[QueueEvents] Worker spawn triggered via service queue for ${entityType}/${entityId}`,
        );
      } catch (error) {
        this.logger.error(
          `[QueueEvents] Failed to trigger worker spawn: ${(error as Error).message}`,
        );
      }
    } else if (this.onJobArrivedCallback) {
      // Direct spawn (single instance mode)
      try {
        await this.onJobArrivedCallback(entityType, entityId, queueName);
        this.logger.debug(
          `[QueueEvents] Worker spawned directly for ${entityType}/${entityId}`,
        );
      } catch (error) {
        this.logger.error(
          `[QueueEvents] Failed to spawn worker: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Listen to all queues that match a pattern.
   * Uses Redis SCAN to find existing queues and listens to them.
   * Also sets up keyspace notifications for new queues (if enabled).
   */
  async listenToEntityTypeQueues(entityType: string): Promise<void> {
    const pattern = this.entityPatterns.get(entityType);
    if (!pattern) {
      this.logger.warn(`No pattern registered for entity type: ${entityType}`);
      return;
    }

    // Find existing queues matching the pattern
    const queuePattern = `${this.keyPrefix}:${entityType}:*:queue`;
    const bulkQueuePattern = `bull:${this.keyPrefix}:${entityType}:*:queue:*`;

    // Scan for existing BullMQ queue keys
    const keys = await this.scanKeys(bulkQueuePattern);
    const queueNames = new Set<string>();

    for (const key of keys) {
      // Extract queue name from BullMQ key
      // Format: bull:{queueName}:{suffix}
      const match = key.match(/^bull:([^:]+:[^:]+:[^:]+:queue):/);
      if (match) {
        queueNames.add(match[1]);
      }
    }

    this.logger.debug(
      `Found ${queueNames.size} existing queues for ${entityType}`,
    );

    // Listen to each existing queue
    for (const queueName of queueNames) {
      const extractFn = pattern.extractEntityId;
      if (!extractFn) continue;
      
      // Wrap the extractEntityId to handle null return
      const safeExtract = (qn: string): string => {
        const result = extractFn(qn);
        return result ?? 'unknown';
      };
      await this.listenToQueue(queueName, entityType, safeExtract);
    }
  }

  /**
   * Ensure we're listening to events for a specific queue.
   * Call this when adding a job to ensure we catch the event.
   */
  async ensureListening(queueName: string, entityType: string): Promise<void> {
    if (this.registeredQueues.has(queueName)) {
      return;
    }

    const pattern = this.entityPatterns.get(entityType);
    if (!pattern || !pattern.extractEntityId) {
      this.logger.debug(`No pattern for ${entityType}, can't auto-listen`);
      return;
    }

    // Wrap the extractEntityId to handle null return
    const extractFn = pattern.extractEntityId;
    const safeExtract = (qn: string): string => {
      const result = extractFn(qn);
      return result ?? 'unknown';
    };
    await this.listenToQueue(queueName, entityType, safeExtract);
  }

  /**
   * Stop listening to a specific queue.
   */
  async stopListening(queueName: string): Promise<void> {
    const registered = this.registeredQueues.get(queueName);
    if (!registered) {
      return;
    }

    try {
      await registered.queueEvents.close();
      this.registeredQueues.delete(queueName);
      this.logger.debug(`Stopped listening to queue: ${queueName}`);
    } catch (error) {
      this.logger.error(
        `Error stopping listener for ${queueName}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Get all registered queue names.
   */
  getRegisteredQueues(): string[] {
    return Array.from(this.registeredQueues.keys());
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

  /**
   * Cleanup on module destroy.
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.debug('Closing all queue event listeners...');

    const closePromises = Array.from(this.registeredQueues.values()).map(
      async (registered) => {
        try {
          await registered.queueEvents.close();
        } catch (error) {
          this.logger.error(
            `Error closing queue events for ${registered.queueName}:`,
            error,
          );
        }
      },
    );

    await Promise.all(closePromises);
    this.registeredQueues.clear();
    this.logger.debug('All queue event listeners closed');
  }
}
