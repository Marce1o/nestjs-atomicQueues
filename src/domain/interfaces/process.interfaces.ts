/**
 * Atomic process status
 */
export type AtomicProcessStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Atomic process state
 */
export interface IAtomicProcessState {
  uuid: string;
  status: AtomicProcessStatus;
  entityId: string;
  entityType: string;
  commandName?: string;
  createdAt: Date;
  updatedAt: Date;
  result?: unknown;
  error?: string;
}

/**
 * Atomic process status tracker interface
 */
export interface IAtomicProcessTracker {
  /**
   * Set process status
   */
  setStatus(uuid: string, status: AtomicProcessStatus): Promise<void>;

  /**
   * Get process status
   */
  getStatus(uuid: string): Promise<IAtomicProcessState | null>;

  /**
   * Set process result
   */
  setResult(uuid: string, result: unknown): Promise<void>;

  /**
   * Set process error
   */
  setError(uuid: string, error: string): Promise<void>;

  /**
   * Clean up old process states
   */
  cleanup(maxAgeMs?: number): Promise<number>;
}
