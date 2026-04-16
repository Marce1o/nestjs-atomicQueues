import { Worker, Job } from 'bullmq';
import { IWorkerConfig } from './config.interfaces';

/**
 * Worker state tracking
 */
export interface IWorkerState {
  workerId: string;
  workerName: string;
  nodeId: string;
  entityId?: string;
  entityType?: string;
  status: 'starting' | 'ready' | 'processing' | 'closing' | 'closed';
  createdAt: Date;
  lastHeartbeat: Date;
}

/**
 * Worker lifecycle events
 */
export interface IWorkerEvents {
  onReady?: (worker: Worker, workerName: string) => void | Promise<void>;
  onCompleted?: (job: Job, workerName: string) => void | Promise<void>;
  onFailed?: (job: Job | undefined, error: Error, workerName: string) => void | Promise<void>;
  onProgress?: (job: Job, progress: number | object) => void | Promise<void>;
  onStalled?: (jobId: string, workerName: string) => void | Promise<void>;
  onClosing?: (workerName: string) => void | Promise<void>;
  onClosed?: (workerName: string) => void | Promise<void>;
}

/**
 * Worker creation options
 */
export interface IWorkerCreationOptions {
  workerName: string;
  queueName: string;
  config?: IWorkerConfig;
  events?: IWorkerEvents;
  processor: (job: Job) => Promise<unknown>;
}

/**
 * Worker manager service interface
 */
export interface IWorkerManager {
  /**
   * Create a new worker with automatic lifecycle management
   */
  createWorker(options: IWorkerCreationOptions): Promise<Worker>;

  /**
   * Check if a worker exists and is alive (across ALL nodes)
   */
  workerExists(workerName: string): Promise<boolean>;

  /**
   * Check if a worker exists on THIS node specifically
   */
  workerExistsOnThisNode(workerName: string): Promise<boolean>;

  /**
   * Get all running workers for current node
   */
  getNodeWorkers(): Promise<string[]>;

  /**
   * Get all running workers across all nodes
   */
  getAllWorkers(): Promise<string[]>;

  /**
   * Get all workers for a specific entity
   */
  getEntityWorkers(entityType: string, entityId: string): Promise<string[]>;

  /**
   * Signal a worker to close gracefully
   */
  signalWorkerClose(workerName: string): Promise<void>;

  /**
   * Signal all workers on current node to close
   */
  signalNodeWorkersClose(): Promise<void>;

  /**
   * Wait for all node workers to close
   */
  waitForWorkersToClose(timeoutMs?: number): Promise<void>;

  /**
   * Reset worker heartbeat TTL
   */
  resetWorkerHeartbeat(workerName: string): Promise<void>;

  /**
   * Remove worker heartbeat (mark as dead)
   */
  removeWorkerHeartbeat(workerName: string): Promise<void>;

  /**
   * Get the node ID for this instance
   */
  getNodeId(): string;

  // =========================================================================
  // IDLE TRACKING METHODS
  // =========================================================================

  /**
   * Mark that a worker has completed a job (resets idle counter).
   * Called internally when job completes.
   */
  markWorkerActive(workerName: string): void;

  /**
   * Get the idle seconds counter for a worker.
   * This is incremented by the heartbeat and reset when a job completes.
   */
  getWorkerIdleSeconds(workerName: string): Promise<number>;

  /**
   * Reset the idle counter for a worker (called when job completes).
   */
  resetWorkerIdleCounter(workerName: string): Promise<void>;

  /**
   * Increment the idle counter for a worker (called by heartbeat).
   * Returns the new idle seconds value.
   */
  incrementWorkerIdleCounter(workerName: string, incrementBy?: number): Promise<number>;

  /**
   * Remove the idle counter for a worker (cleanup).
   */
  removeWorkerIdleCounter(workerName: string): Promise<void>;

  /**
   * Check if a worker is idle based on threshold.
   * @param workerName - Worker name
   * @param thresholdSeconds - Idle threshold in seconds (default: 15)
   */
  isWorkerIdle(workerName: string, thresholdSeconds?: number): Promise<boolean>;
}
