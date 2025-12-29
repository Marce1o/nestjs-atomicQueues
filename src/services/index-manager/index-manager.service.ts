import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import {
  IIndexManager,
  IAtomicQueuesModuleConfig,
} from '../../domain';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

/**
 * IndexManagerService
 *
 * Manages Redis indices for tracking jobs, workers, queues, and their states.
 * Implements patterns from Whatsapi for tracking message queues, worker deaths,
 * and queue lifecycle.
 *
 * Key Features:
 * - Job indexing per entity
 * - Worker death tracking for graceful termination
 * - Queue lifecycle tracking
 * - Entity-based aggregations
 *
 * Redis Key Patterns:
 * - jobs-index:{entityType}:{entityId}:jobs -> Set of job IDs
 * - workerDeaths-index:{entityType}:{entityId}:deaths -> Set of death signal IDs
 * - queue-index:{entityType}:{entityId}:queue -> Queue existence marker
 * - queueDeaths-index:{entityType}:{entityId}:deaths -> Queue death signals
 */
@Injectable()
export class IndexManagerService implements IIndexManager {
  private readonly logger = new Logger(IndexManagerService.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.keyPrefix = config.keyPrefix || 'aq';
  }

  // =========================================================================
  // JOB INDEXING
  // =========================================================================

  /**
   * Index a job for an entity.
   */
  async indexJob(
    entityType: string,
    entityId: string,
    jobId: string,
  ): Promise<void> {
    const key = this.getJobIndexKey(entityType, entityId);
    const member = `job:${entityType}:${entityId}:${jobId}`;
    await this.redis.sadd(key, member);
    this.logger.debug(`Indexed job ${jobId} for ${entityType}/${entityId}`);
  }

  /**
   * Remove job index.
   */
  async removeJobIndex(
    entityType: string,
    entityId: string,
    jobId: string,
  ): Promise<void> {
    const key = this.getJobIndexKey(entityType, entityId);
    const member = `job:${entityType}:${entityId}:${jobId}`;
    await this.redis.srem(key, member);
    this.logger.debug(
      `Removed job index ${jobId} for ${entityType}/${entityId}`,
    );
  }

  /**
   * Get all job IDs for an entity.
   */
  async getEntityJobs(
    entityType: string,
    entityId: string,
  ): Promise<string[]> {
    const key = this.getJobIndexKey(entityType, entityId);
    const members = await this.redis.smembers(key);
    // Extract job IDs from the full member string
    return members.map((m) => m.split(':').pop()!);
  }

  /**
   * Get all entities with jobs and their job counts.
   */
  async getEntitiesWithJobs(
    entityType: string,
  ): Promise<Record<string, number>> {
    const pattern = `${this.keyPrefix}:jobs-index:${entityType}:*:jobs`;
    const keys = await this.scanKeys(pattern);
    const result: Record<string, number> = {};

    for (const key of keys) {
      const entityId = this.extractEntityIdFromKey(key, entityType);
      if (entityId) {
        const count = await this.redis.scard(key);
        result[entityId] = count;
      }
    }

    return result;
  }

  /**
   * Get job count for an entity.
   */
  async getEntityJobCount(
    entityType: string,
    entityId: string,
  ): Promise<number> {
    const key = this.getJobIndexKey(entityType, entityId);
    return this.redis.scard(key);
  }

  /**
   * Clear all job indices for an entity.
   */
  async clearEntityJobs(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const key = this.getJobIndexKey(entityType, entityId);
    await this.redis.del(key);
    this.logger.debug(`Cleared all job indices for ${entityType}/${entityId}`);
  }

  // =========================================================================
  // WORKER DEATH INDEXING
  // =========================================================================

  /**
   * Index a worker death signal.
   */
  async indexWorkerDeath(
    entityType: string,
    entityId: string,
    deathId: string,
  ): Promise<void> {
    const key = this.getWorkerDeathIndexKey(entityType, entityId);
    const member = `death:${entityType}:${entityId}:${deathId}`;
    await this.redis.sadd(key, member);
    this.logger.debug(
      `Indexed worker death ${deathId} for ${entityType}/${entityId}`,
    );
  }

  /**
   * Remove worker death index.
   */
  async removeWorkerDeathIndex(
    entityType: string,
    entityId: string,
    deathId: string,
  ): Promise<void> {
    const key = this.getWorkerDeathIndexKey(entityType, entityId);
    const member = `death:${entityType}:${entityId}:${deathId}`;
    await this.redis.srem(key, member);
    this.logger.debug(
      `Removed worker death index ${deathId} for ${entityType}/${entityId}`,
    );
  }

  /**
   * Get queued worker deaths for an entity.
   */
  async getQueuedWorkerDeaths(
    entityType: string,
    entityId: string,
  ): Promise<string[]> {
    const key = this.getWorkerDeathIndexKey(entityType, entityId);
    const members = await this.redis.smembers(key);
    return members.map((m) => m.split(':').pop()!);
  }

  /**
   * Get all entities with queued worker deaths.
   */
  async getEntitiesWithQueuedWorkerDeaths(
    entityType: string,
  ): Promise<string[]> {
    const pattern = `${this.keyPrefix}:workerDeaths-index:${entityType}:*:deaths`;
    const keys = await this.scanKeys(pattern);
    return keys
      .map((key) => this.extractEntityIdFromKey(key, entityType))
      .filter((id): id is string => id !== null);
  }

  /**
   * Clear all worker death indices for an entity.
   */
  async clearEntityWorkerDeaths(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const key = this.getWorkerDeathIndexKey(entityType, entityId);
    await this.redis.del(key);
    this.logger.debug(
      `Cleared all worker death indices for ${entityType}/${entityId}`,
    );
  }

  // =========================================================================
  // QUEUE INDEXING
  // =========================================================================

  /**
   * Index entity queue existence.
   */
  async indexEntityQueue(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const indexKey = this.getQueueIndexKey(entityType);
    const member = `queue:${entityType}:${entityId}`;
    await this.redis.sadd(indexKey, member);
    this.logger.debug(`Indexed queue for ${entityType}/${entityId}`);
  }

  /**
   * Remove entity queue index.
   */
  async removeEntityQueueIndex(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const indexKey = this.getQueueIndexKey(entityType);
    const member = `queue:${entityType}:${entityId}`;
    await this.redis.srem(indexKey, member);
    this.logger.debug(`Removed queue index for ${entityType}/${entityId}`);
  }

  /**
   * Get all entities with active queues.
   */
  async getEntitiesWithQueues(entityType: string): Promise<string[]> {
    const indexKey = this.getQueueIndexKey(entityType);
    const members = await this.redis.smembers(indexKey);
    return members.map((m) => m.split(':').pop()!);
  }

  /**
   * Check if entity has an active queue.
   */
  async hasEntityQueue(
    entityType: string,
    entityId: string,
  ): Promise<boolean> {
    const indexKey = this.getQueueIndexKey(entityType);
    const member = `queue:${entityType}:${entityId}`;
    const isMember = await this.redis.sismember(indexKey, member);
    return isMember === 1;
  }

  // =========================================================================
  // QUEUE DEATH INDEXING
  // =========================================================================

  /**
   * Index a queue death signal.
   */
  async indexQueueDeath(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const key = this.getQueueDeathIndexKey(entityType);
    const member = `death:${entityType}:${entityId}`;
    await this.redis.sadd(key, member);
    this.logger.debug(`Indexed queue death for ${entityType}/${entityId}`);
  }

  /**
   * Remove queue death index.
   */
  async removeQueueDeathIndex(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const key = this.getQueueDeathIndexKey(entityType);
    const member = `death:${entityType}:${entityId}`;
    await this.redis.srem(key, member);
    this.logger.debug(`Removed queue death index for ${entityType}/${entityId}`);
  }

  /**
   * Get all entities with queued queue deaths.
   */
  async getEntitiesWithQueuedQueueDeaths(
    entityType: string,
  ): Promise<string[]> {
    const key = this.getQueueDeathIndexKey(entityType);
    const members = await this.redis.smembers(key);
    return members.map((m) => m.split(':').pop()!);
  }

  // =========================================================================
  // WORKER CREATION REQUEST TRACKING
  // =========================================================================

  /**
   * Index a worker creation request.
   */
  async indexWorkerCreationRequest(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const key = `${this.keyPrefix}:worker-creation:${entityType}:${entityId}`;
    await this.redis.incr(key);
    await this.redis.expire(key, 60); // TTL for cleanup
  }

  /**
   * Decrement worker creation request count.
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
   * Get worker creation request count.
   */
  async getWorkerCreationRequestCount(
    entityType: string,
    entityId: string,
  ): Promise<number> {
    const key = `${this.keyPrefix}:worker-creation:${entityType}:${entityId}`;
    const count = await this.redis.get(key);
    return count ? parseInt(count, 10) : 0;
  }

  /**
   * Clear worker creation request index.
   */
  async clearWorkerCreationRequests(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const key = `${this.keyPrefix}:worker-creation:${entityType}:${entityId}`;
    await this.redis.del(key);
  }

  // =========================================================================
  // UTILITY METHODS
  // =========================================================================

  /**
   * Clean up all indices for an entity.
   * Call this when completely removing an entity from the system.
   */
  async cleanupEntityIndices(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    await Promise.all([
      this.clearEntityJobs(entityType, entityId),
      this.clearEntityWorkerDeaths(entityType, entityId),
      this.removeEntityQueueIndex(entityType, entityId),
      this.removeQueueDeathIndex(entityType, entityId),
      this.clearWorkerCreationRequests(entityType, entityId),
    ]);
    this.logger.debug(
      `Cleaned up all indices for ${entityType}/${entityId}`,
    );
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * Get the key for job index.
   */
  private getJobIndexKey(entityType: string, entityId: string): string {
    return `${this.keyPrefix}:jobs-index:${entityType}:${entityId}:jobs`;
  }

  /**
   * Get the key for worker death index.
   */
  private getWorkerDeathIndexKey(
    entityType: string,
    entityId: string,
  ): string {
    return `${this.keyPrefix}:workerDeaths-index:${entityType}:${entityId}:deaths`;
  }

  /**
   * Get the key for queue index.
   */
  private getQueueIndexKey(entityType: string): string {
    return `${this.keyPrefix}:queue-index:${entityType}:queues`;
  }

  /**
   * Get the key for queue death index.
   */
  private getQueueDeathIndexKey(entityType: string): string {
    return `${this.keyPrefix}:queueDeaths-index:${entityType}:deaths`;
  }

  /**
   * Extract entity ID from a Redis key.
   */
  private extractEntityIdFromKey(
    key: string,
    entityType: string,
  ): string | null {
    // Key format: {prefix}:{indexType}:{entityType}:{entityId}:{suffix}
    const parts = key.split(':');
    const entityTypeIndex = parts.indexOf(entityType);
    if (entityTypeIndex !== -1 && parts.length > entityTypeIndex + 1) {
      return parts[entityTypeIndex + 1];
    }
    return null;
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
