import { Logger } from '@nestjs/common';
import {
  WORKER_STATE_OFFSET,
  WORKER_SLOT_SIZE,
  WorkerState,
  readTimestamp,
} from './worker-protocol';

export interface LivenessCheckResult {
  workerId: number;
  alive: boolean;
  lastHeartbeat: number;
  state: WorkerState;
  staleMs: number;
}

/**
 * Monitors worker thread liveness by checking SharedArrayBuffer heartbeats.
 *
 * Each worker writes its heartbeat timestamp (Date.now()) to its SharedArrayBuffer
 * slot every 1s. The liveness monitor reads these values and detects dead workers
 * when the heartbeat is stale beyond the threshold.
 */
export class LivenessMonitor {
  private readonly logger = new Logger(LivenessMonitor.name);
  private readonly staleThresholdMs: number;
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly stateView: Int32Array,
    private readonly maxWorkers: number,
    private readonly onWorkerDead: (workerId: number, reason: string) => void,
    staleThresholdMs = 5000,
  ) {
    this.staleThresholdMs = staleThresholdMs;
  }

  /**
   * Start periodic liveness checks.
   * @param intervalMs How often to check (default: 2000ms)
   */
  start(intervalMs = 2000): void {
    if (this.monitorInterval) return;

    this.monitorInterval = setInterval(() => {
      this.check();
    }, intervalMs);
  }

  /**
   * Stop the liveness monitor.
   */
  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Run a single liveness check across all worker slots.
   */
  check(): LivenessCheckResult[] {
    const now = Date.now();
    const results: LivenessCheckResult[] = [];

    for (let i = 0; i < this.maxWorkers; i++) {
      const baseIndex = (i * WORKER_SLOT_SIZE) / 4; // Int32 index
      const state = Atomics.load(this.stateView, baseIndex + WORKER_STATE_OFFSET) as WorkerState;

      // Skip empty slots (state = IDLE with no heartbeat = never assigned)
      if (state === WorkerState.DEAD) continue;

      const lastHeartbeat = readTimestamp(this.stateView, baseIndex);
      if (lastHeartbeat === 0) continue; // Slot never initialized

      const staleMs = now - lastHeartbeat;
      const alive = staleMs < this.staleThresholdMs;

      results.push({
        workerId: i,
        alive,
        lastHeartbeat,
        state,
        staleMs,
      });

      if (!alive) {
        this.logger.error(
          `Worker ${i} heartbeat stale by ${staleMs}ms (threshold: ${this.staleThresholdMs}ms)`,
        );
        // Mark as dead in SharedArrayBuffer
        Atomics.store(this.stateView, baseIndex + WORKER_STATE_OFFSET, WorkerState.DEAD);
        this.onWorkerDead(i, `heartbeat stale by ${staleMs}ms`);
      }
    }

    return results;
  }

  /**
   * Get the current state of a specific worker.
   */
  getWorkerState(workerId: number): { state: WorkerState; lastHeartbeat: number } {
    const baseIndex = (workerId * WORKER_SLOT_SIZE) / 4;
    return {
      state: Atomics.load(this.stateView, baseIndex + WORKER_STATE_OFFSET) as WorkerState,
      lastHeartbeat: readTimestamp(this.stateView, baseIndex),
    };
  }
}
