import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import {
  IResourceLockService,
  IResourceLock,
  ILockResult,
  IAtomicQueuesModuleConfig,
} from '../../domain';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

/**
 * ResourceLockService
 *
 * Provides distributed resource locking using Redis.
 * Implements patterns from both Whatsapi (context locking) and bl-blackjack-service.
 *
 * Key Features:
 * - Atomic lock acquisition using Lua scripts
 * - TTL-based lock expiration
 * - Lock ownership verification
 * - Pool-based resource allocation (get first available from pool)
 * - Lock extension for long-running operations
 *
 * Use Cases:
 * - Whatsapi: Lock WhatsApp contexts for message sending
 * - Blackjack: Lock table resources for game operations
 * - General: Any resource that needs exclusive access
 *
 * @example
 * ```typescript
 * // Acquire a lock on a context
 * const result = await lockService.acquireLock(
 *   'context',
 *   'context-123',
 *   'user-456',
 *   'user',
 *   60, // 60 second TTL
 * );
 *
 * if (result.acquired) {
 *   // Do work with the context
 *   await lockService.releaseLock('context', 'context-123');
 * }
 *
 * // Get first available context from a pool
 * const available = await lockService.getAvailableResource(
 *   'context',
 *   ['ctx-1', 'ctx-2', 'ctx-3'],
 *   'user-456',
 *   'user',
 * );
 * ```
 */
@Injectable()
export class ResourceLockService implements IResourceLockService {
  private readonly logger = new Logger(ResourceLockService.name);
  private readonly keyPrefix: string;

  // Lua script for atomic lock acquisition
  private readonly ACQUIRE_LOCK_SCRIPT = `
    local lockKey = KEYS[1]
    local lockValue = ARGV[1]
    local ttl = tonumber(ARGV[2])
    
    local current = redis.call("GET", lockKey)
    
    if not current then
      redis.call("SET", lockKey, lockValue, "EX", ttl)
      return 1  -- Lock acquired
    else
      return 0  -- Lock already held
    end
  `;

  // Lua script for atomic lock release with ownership check
  private readonly RELEASE_LOCK_SCRIPT = `
    local lockKey = KEYS[1]
    local expectedOwner = ARGV[1]
    
    local current = redis.call("GET", lockKey)
    
    if current then
      local lockData = cjson.decode(current)
      if lockData.ownerId == expectedOwner then
        redis.call("DEL", lockKey)
        return 1  -- Lock released
      else
        return 0  -- Not the owner
      end
    end
    
    return 1  -- Lock didn't exist
  `;

  // Lua script for extending lock TTL
  private readonly EXTEND_LOCK_SCRIPT = `
    local lockKey = KEYS[1]
    local newTtl = tonumber(ARGV[1])
    
    local exists = redis.call("EXISTS", lockKey)
    
    if exists == 1 then
      redis.call("EXPIRE", lockKey, newTtl)
      return 1  -- TTL extended
    else
      return 0  -- Lock doesn't exist
    end
  `;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.keyPrefix = config.keyPrefix || 'aq';
  }

  /**
   * Acquire a lock on a resource.
   *
   * Uses Lua script for atomic check-and-set operation.
   * The lock includes ownership information for later verification.
   */
  async acquireLock(
    resourceType: string,
    resourceId: string,
    ownerId: string,
    ownerType: string,
    ttlSeconds = 60,
    metadata?: Record<string, unknown>,
  ): Promise<ILockResult> {
    const lockKey = this.getLockKey(resourceType, resourceId);
    const now = new Date();

    const lockData: IResourceLock = {
      resourceId,
      resourceType,
      ownerId,
      ownerType,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      metadata,
    };

    try {
      const result = await this.redis.eval(
        this.ACQUIRE_LOCK_SCRIPT,
        1,
        lockKey,
        JSON.stringify(lockData),
        ttlSeconds.toString(),
      );

      if (result === 1) {
        this.logger.debug(
          `Lock acquired: ${resourceType}/${resourceId} by ${ownerType}/${ownerId}`,
        );
        return { acquired: true, lock: lockData };
      }

      this.logger.debug(
        `Lock not acquired (already held): ${resourceType}/${resourceId}`,
      );
      return {
        acquired: false,
        reason: 'Resource is already locked',
      };
    } catch (error) {
      this.logger.error(
        `Error acquiring lock for ${resourceType}/${resourceId}:`,
        error,
      );
      return {
        acquired: false,
        reason: `Error: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Release a lock on a resource.
   */
  async releaseLock(
    resourceType: string,
    resourceId: string,
  ): Promise<boolean> {
    const lockKey = this.getLockKey(resourceType, resourceId);

    try {
      await this.redis.del(lockKey);
      this.logger.debug(`Lock released: ${resourceType}/${resourceId}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Error releasing lock for ${resourceType}/${resourceId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Release a lock with ownership verification.
   * Only releases if the current owner matches the expected owner.
   */
  async releaseOwnedLock(
    resourceType: string,
    resourceId: string,
    ownerId: string,
  ): Promise<boolean> {
    const lockKey = this.getLockKey(resourceType, resourceId);

    try {
      const result = await this.redis.eval(
        this.RELEASE_LOCK_SCRIPT,
        1,
        lockKey,
        ownerId,
      );

      const released = result === 1;
      if (released) {
        this.logger.debug(
          `Lock released by owner: ${resourceType}/${resourceId}`,
        );
      } else {
        this.logger.warn(
          `Lock release failed (not owner): ${resourceType}/${resourceId}`,
        );
      }
      return released;
    } catch (error) {
      this.logger.error(
        `Error releasing owned lock for ${resourceType}/${resourceId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Check if a resource is locked.
   */
  async isLocked(resourceType: string, resourceId: string): Promise<boolean> {
    const lockKey = this.getLockKey(resourceType, resourceId);
    const exists = await this.redis.exists(lockKey);
    return exists === 1;
  }

  /**
   * Get lock info for a resource.
   */
  async getLockInfo(
    resourceType: string,
    resourceId: string,
  ): Promise<IResourceLock | null> {
    const lockKey = this.getLockKey(resourceType, resourceId);
    const data = await this.redis.get(lockKey);

    if (!data) return null;

    try {
      const lock = JSON.parse(data) as IResourceLock;
      // Convert date strings back to Date objects
      lock.acquiredAt = new Date(lock.acquiredAt);
      lock.expiresAt = new Date(lock.expiresAt);
      return lock;
    } catch (error) {
      this.logger.error(`Error parsing lock data for ${lockKey}:`, error);
      return null;
    }
  }

  /**
   * Get all locked resources of a type for an owner.
   */
  async getOwnerLocks(
    ownerType: string,
    ownerId: string,
  ): Promise<IResourceLock[]> {
    // Scan for all locks and filter by owner
    const pattern = `${this.keyPrefix}:lock:*`;
    const keys = await this.scanKeys(pattern);
    const locks: IResourceLock[] = [];

    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        try {
          const lock = JSON.parse(data) as IResourceLock;
          if (lock.ownerType === ownerType && lock.ownerId === ownerId) {
            lock.acquiredAt = new Date(lock.acquiredAt);
            lock.expiresAt = new Date(lock.expiresAt);
            locks.push(lock);
          }
        } catch {
          // Skip invalid entries
        }
      }
    }

    return locks;
  }

  /**
   * Get an available (unlocked) resource from a pool of candidates.
   * Shuffles the pool for fair distribution.
   * Atomically locks and returns the first available resource.
   *
   * This is the pattern used by Whatsapi to find an available WhatsApp context.
   */
  async getAvailableResource(
    resourceType: string,
    candidateIds: string[],
    ownerId: string,
    ownerType: string,
    ttlSeconds = 60,
  ): Promise<ILockResult> {
    // Shuffle candidates for fair distribution
    const shuffled = this.shuffleArray([...candidateIds]);

    for (const resourceId of shuffled) {
      const result = await this.acquireLock(
        resourceType,
        resourceId,
        ownerId,
        ownerType,
        ttlSeconds,
      );

      if (result.acquired) {
        this.logger.debug(
          `Found available resource: ${resourceType}/${resourceId}`,
        );
        return result;
      }
    }

    this.logger.debug(
      `No available resource found in pool for ${ownerType}/${ownerId}`,
    );
    return {
      acquired: false,
      reason: 'No available resources in pool',
    };
  }

  /**
   * Extend the TTL of an existing lock.
   */
  async extendLock(
    resourceType: string,
    resourceId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const lockKey = this.getLockKey(resourceType, resourceId);

    try {
      const result = await this.redis.eval(
        this.EXTEND_LOCK_SCRIPT,
        1,
        lockKey,
        ttlSeconds.toString(),
      );

      const extended = result === 1;
      if (extended) {
        this.logger.debug(
          `Lock TTL extended: ${resourceType}/${resourceId} to ${ttlSeconds}s`,
        );
      }
      return extended;
    } catch (error) {
      this.logger.error(
        `Error extending lock for ${resourceType}/${resourceId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Get all locks for a resource type.
   */
  async getResourceTypeLocks(resourceType: string): Promise<{
    locked: IResourceLock[];
    free: string[];
  }> {
    const pattern = `${this.keyPrefix}:lock:${resourceType}:*`;
    const keys = await this.scanKeys(pattern);
    const locked: IResourceLock[] = [];

    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        try {
          const lock = JSON.parse(data) as IResourceLock;
          lock.acquiredAt = new Date(lock.acquiredAt);
          lock.expiresAt = new Date(lock.expiresAt);
          locked.push(lock);
        } catch {
          // Skip invalid entries
        }
      }
    }

    return {
      locked,
      free: [], // This would need external resource registry to determine
    };
  }

  /**
   * Cross-verify that a lock is still held by the expected owner.
   * Useful for operations that need to verify lock ownership mid-operation.
   */
  async verifyLockOwnership(
    resourceType: string,
    resourceId: string,
    ownerId: string,
  ): Promise<boolean> {
    const lock = await this.getLockInfo(resourceType, resourceId);
    return lock !== null && lock.ownerId === ownerId;
  }

  /**
   * Clear all locks for an owner (useful for cleanup).
   */
  async clearOwnerLocks(ownerType: string, ownerId: string): Promise<number> {
    const locks = await this.getOwnerLocks(ownerType, ownerId);
    let cleared = 0;

    for (const lock of locks) {
      const released = await this.releaseLock(
        lock.resourceType,
        lock.resourceId,
      );
      if (released) cleared++;
    }

    this.logger.debug(
      `Cleared ${cleared} locks for ${ownerType}/${ownerId}`,
    );
    return cleared;
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * Get the Redis key for a lock.
   */
  private getLockKey(resourceType: string, resourceId: string): string {
    return `${this.keyPrefix}:lock:${resourceType}:${resourceId}`;
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
   * Fisher-Yates shuffle algorithm.
   */
  private shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }
}
