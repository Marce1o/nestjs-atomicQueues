/**
 * Lock state for a resource
 */
export interface IResourceLock {
  resourceId: string;
  resourceType: string;
  ownerId: string;
  ownerType: string;
  acquiredAt: Date;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Lock acquisition result
 */
export interface ILockResult {
  acquired: boolean;
  lock?: IResourceLock;
  reason?: string;
}

/**
 * Resource lock service interface for distributed locking
 */
export interface IResourceLockService {
  /**
   * Acquire a lock on a resource
   */
  acquireLock(
    resourceType: string,
    resourceId: string,
    ownerId: string,
    ownerType: string,
    ttlSeconds?: number,
    metadata?: Record<string, unknown>,
  ): Promise<ILockResult>;

  /**
   * Release a lock on a resource
   */
  releaseLock(resourceType: string, resourceId: string): Promise<boolean>;

  /**
   * Check if a resource is locked
   */
  isLocked(resourceType: string, resourceId: string): Promise<boolean>;

  /**
   * Get lock info for a resource
   */
  getLockInfo(resourceType: string, resourceId: string): Promise<IResourceLock | null>;

  /**
   * Get all locked resources of a type for an owner
   */
  getOwnerLocks(ownerType: string, ownerId: string): Promise<IResourceLock[]>;

  /**
   * Get available (unlocked) resource from a pool
   */
  getAvailableResource(
    resourceType: string,
    candidateIds: string[],
    ownerId: string,
    ownerType: string,
    ttlSeconds?: number,
  ): Promise<ILockResult>;

  /**
   * Extend lock TTL
   */
  extendLock(resourceType: string, resourceId: string, ttlSeconds: number): Promise<boolean>;
}
