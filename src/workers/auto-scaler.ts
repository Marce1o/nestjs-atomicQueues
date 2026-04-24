import { Logger } from '@nestjs/common';
import {
  WORKER_STATE_OFFSET,
  WORKER_DEPTH_OFFSET,
  WORKER_SLOT_SIZE,
  WorkerState,
} from './worker-protocol';

export interface ScalingConfig {
  evaluationInterval: number;
  scaleUpThreshold: number;
  scaleDownThreshold: number;
  scaleDownCooldown: number;
  scaleUpCooldown: number;
  minWorkers: number;
  maxWorkers: number;
}

export type ScaleDecision =
  | { action: 'none'; reason: string }
  | { action: 'scale-up'; reason: string }
  | { action: 'scale-down'; targetWorkerId?: number; reason: string };

export interface WorkerSnapshot {
  workerId: number;
  state: WorkerState;
  queueDepth: number;
}

/**
 * Auto-scaling decision engine for the worker thread pool.
 *
 * Reads worker state from SharedArrayBuffer and produces scaling decisions.
 * Does NOT execute the decisions — the WorkerPoolService does that.
 */
export class AutoScaler {
  private readonly logger = new Logger(AutoScaler.name);
  private lastScaleUp = 0;
  private lastScaleDown = 0;
  private belowThresholdSince = 0;

  constructor(private readonly config: ScalingConfig) {}

  /**
   * Evaluate the current pool state and produce a scaling decision.
   *
   * @param activeWorkerIds IDs of currently active workers
   * @param stateView SharedArrayBuffer Int32 view
   */
  evaluate(activeWorkerIds: number[], stateView: Int32Array): ScaleDecision {
    const now = Date.now();
    const workerCount = activeWorkerIds.length;

    if (workerCount === 0) {
      return { action: 'scale-up', reason: 'no active workers' };
    }

    // Read worker states
    const snapshots = this.readSnapshots(activeWorkerIds, stateView);
    const totalDepth = snapshots.reduce((sum, s) => sum + s.queueDepth, 0);
    const avgDepth = totalDepth / workerCount;

    // --- Scale UP ---
    if (avgDepth > this.config.scaleUpThreshold) {
      if (now - this.lastScaleUp < this.config.scaleUpCooldown) {
        return { action: 'none', reason: 'scale-up cooldown active' };
      }
      if (workerCount >= this.config.maxWorkers) {
        return { action: 'none', reason: `at max workers (${this.config.maxWorkers})` };
      }
      this.lastScaleUp = now;
      this.belowThresholdSince = 0;
      return {
        action: 'scale-up',
        reason: `avg depth ${avgDepth.toFixed(1)} > threshold ${this.config.scaleUpThreshold}`,
      };
    }

    // --- Scale DOWN ---
    if (avgDepth < this.config.scaleDownThreshold) {
      if (this.belowThresholdSince === 0) {
        this.belowThresholdSince = now;
      }
      const belowFor = now - this.belowThresholdSince;

      if (belowFor < this.config.scaleDownCooldown) {
        return {
          action: 'none',
          reason: `below threshold for ${belowFor}ms, need ${this.config.scaleDownCooldown}ms`,
        };
      }
      if (now - this.lastScaleDown < this.config.scaleDownCooldown) {
        return { action: 'none', reason: 'scale-down cooldown active' };
      }
      if (workerCount <= this.config.minWorkers) {
        return { action: 'none', reason: `at min workers (${this.config.minWorkers})` };
      }

      // Pick the least loaded worker to remove
      const target = this.pickLeastLoaded(snapshots);

      this.lastScaleDown = now;
      this.belowThresholdSince = 0;
      return {
        action: 'scale-down',
        targetWorkerId: target?.workerId,
        reason: `avg depth ${avgDepth.toFixed(1)} < threshold ${this.config.scaleDownThreshold} for ${belowFor}ms`,
      };
    }

    // Within acceptable range
    this.belowThresholdSince = 0;
    return { action: 'none', reason: 'within bounds' };
  }

  /**
   * Read worker snapshots from SharedArrayBuffer.
   */
  private readSnapshots(workerIds: number[], stateView: Int32Array): WorkerSnapshot[] {
    return workerIds.map((workerId) => {
      const baseIndex = (workerId * WORKER_SLOT_SIZE) / 4;
      return {
        workerId,
        state: Atomics.load(stateView, baseIndex + WORKER_STATE_OFFSET) as WorkerState,
        queueDepth: Atomics.load(stateView, baseIndex + WORKER_DEPTH_OFFSET),
      };
    });
  }

  /**
   * Pick the least loaded worker (lowest queue depth, prefer idle).
   */
  private pickLeastLoaded(snapshots: WorkerSnapshot[]): WorkerSnapshot | null {
    if (snapshots.length === 0) return null;

    return snapshots.reduce((best, current) => {
      // Prefer idle workers
      if (current.state === WorkerState.IDLE && best.state !== WorkerState.IDLE) return current;
      if (best.state === WorkerState.IDLE && current.state !== WorkerState.IDLE) return best;
      // Among same-state workers, pick lowest depth
      return current.queueDepth < best.queueDepth ? current : best;
    });
  }

  /**
   * Reset internal state (for testing).
   */
  reset(): void {
    this.lastScaleUp = 0;
    this.lastScaleDown = 0;
    this.belowThresholdSince = 0;
  }
}
