/**
 * Index entry for tracking jobs, workers, queues
 */
export interface IIndexEntry {
  id: string;
  type: 'job' | 'worker' | 'queue' | 'death' | 'custom';
  entityId: string;
  entityType: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Index manager interface for tracking various entities
 */
export interface IIndexManager {
  /**
   * Index a job for an entity
   */
  indexJob(entityType: string, entityId: string, jobId: string): Promise<void>;

  /**
   * Remove job index
   */
  removeJobIndex(entityType: string, entityId: string, jobId: string): Promise<void>;

  /**
   * Get all job IDs for an entity
   */
  getEntityJobs(entityType: string, entityId: string): Promise<string[]>;

  /**
   * Get all entities with jobs
   */
  getEntitiesWithJobs(entityType: string): Promise<Record<string, number>>;

  /**
   * Index a worker death signal
   */
  indexWorkerDeath(entityType: string, entityId: string, deathId: string): Promise<void>;

  /**
   * Remove worker death index
   */
  removeWorkerDeathIndex(entityType: string, entityId: string, deathId: string): Promise<void>;

  /**
   * Get queued worker deaths for an entity
   */
  getQueuedWorkerDeaths(entityType: string, entityId: string): Promise<string[]>;

  /**
   * Index entity queue
   */
  indexEntityQueue(entityType: string, entityId: string): Promise<void>;

  /**
   * Remove entity queue index
   */
  removeEntityQueueIndex(entityType: string, entityId: string): Promise<void>;

  /**
   * Get all entities with active queues
   */
  getEntitiesWithQueues(entityType: string): Promise<string[]>;

  /**
   * Index a queue death signal
   */
  indexQueueDeath(entityType: string, entityId: string): Promise<void>;

  /**
   * Remove queue death index
   */
  removeQueueDeathIndex(entityType: string, entityId: string): Promise<void>;

  /**
   * Get all entities with queued queue deaths
   */
  getEntitiesWithQueuedQueueDeaths(entityType: string): Promise<string[]>;
}
