import { AutoScaler, ScalingConfig } from '../src/workers/auto-scaler';
import {
  WORKER_STATE_OFFSET,
  WORKER_DEPTH_OFFSET,
  WORKER_SLOT_SIZE,
  WorkerState,
} from '../src/workers/worker-protocol';

function createConfig(overrides?: Partial<ScalingConfig>): ScalingConfig {
  return {
    evaluationInterval: 5000,
    scaleUpThreshold: 10,
    scaleDownThreshold: 2,
    scaleDownCooldown: 100, // short for tests
    scaleUpCooldown: 100,
    minWorkers: 1,
    maxWorkers: 8,
    ...overrides,
  };
}

function createStateBuffer(maxWorkers: number): { buffer: SharedArrayBuffer; view: Int32Array } {
  const buffer = new SharedArrayBuffer(maxWorkers * WORKER_SLOT_SIZE);
  const view = new Int32Array(buffer);
  return { buffer, view };
}

function setWorkerState(
  view: Int32Array,
  workerId: number,
  state: WorkerState,
  depth: number,
): void {
  const base = (workerId * WORKER_SLOT_SIZE) / 4;
  Atomics.store(view, base + WORKER_STATE_OFFSET, state);
  Atomics.store(view, base + WORKER_DEPTH_OFFSET, depth);
}

describe('AutoScaler', () => {
  describe('scale up', () => {
    it('should recommend scale-up when avg depth exceeds threshold', () => {
      const config = createConfig({ scaleUpThreshold: 5 });
      const scaler = new AutoScaler(config);
      const { view } = createStateBuffer(8);

      // 2 workers, each with depth 10 → avg = 10 > 5
      setWorkerState(view, 0, WorkerState.BUSY, 10);
      setWorkerState(view, 1, WorkerState.BUSY, 10);

      const decision = scaler.evaluate([0, 1], view);
      expect(decision.action).toBe('scale-up');
    });

    it('should not scale up when at max workers', () => {
      const config = createConfig({ scaleUpThreshold: 5, maxWorkers: 2 });
      const scaler = new AutoScaler(config);
      const { view } = createStateBuffer(8);

      setWorkerState(view, 0, WorkerState.BUSY, 20);
      setWorkerState(view, 1, WorkerState.BUSY, 20);

      const decision = scaler.evaluate([0, 1], view);
      expect(decision.action).toBe('none');
      expect(decision.reason).toContain('max workers');
    });

    it('should respect scale-up cooldown', () => {
      const config = createConfig({ scaleUpThreshold: 5, scaleUpCooldown: 60000 });
      const scaler = new AutoScaler(config);
      const { view } = createStateBuffer(8);

      setWorkerState(view, 0, WorkerState.BUSY, 20);

      // First call: scales up
      const first = scaler.evaluate([0], view);
      expect(first.action).toBe('scale-up');

      // Second call immediately: cooldown
      const second = scaler.evaluate([0, 1], view);
      expect(second.action).toBe('none');
      expect(second.reason).toContain('cooldown');
    });

    it('should scale up when no active workers', () => {
      const config = createConfig();
      const scaler = new AutoScaler(config);
      const { view } = createStateBuffer(8);

      const decision = scaler.evaluate([], view);
      expect(decision.action).toBe('scale-up');
      expect(decision.reason).toContain('no active workers');
    });
  });

  describe('scale down', () => {
    it('should recommend scale-down after sustained low depth', async () => {
      const config = createConfig({
        scaleDownThreshold: 2,
        scaleDownCooldown: 50, // 50ms for test
        minWorkers: 1,
      });
      const scaler = new AutoScaler(config);
      const { view } = createStateBuffer(8);

      setWorkerState(view, 0, WorkerState.IDLE, 0);
      setWorkerState(view, 1, WorkerState.IDLE, 1);
      setWorkerState(view, 2, WorkerState.IDLE, 0);

      // First check: records below-threshold start time
      const first = scaler.evaluate([0, 1, 2], view);
      expect(first.action).toBe('none');

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 60));

      // Second check: sustained below threshold
      const second = scaler.evaluate([0, 1, 2], view);
      expect(second.action).toBe('scale-down');
    });

    it('should not scale down when at min workers', () => {
      const config = createConfig({
        scaleDownThreshold: 2,
        scaleDownCooldown: 0,
        minWorkers: 2,
      });
      const scaler = new AutoScaler(config);
      const { view } = createStateBuffer(8);

      setWorkerState(view, 0, WorkerState.IDLE, 0);
      setWorkerState(view, 1, WorkerState.IDLE, 0);

      const decision = scaler.evaluate([0, 1], view);
      expect(decision.action).toBe('none');
      expect(decision.reason).toContain('min workers');
    });

    it('should pick the least loaded worker for scale-down', async () => {
      const config = createConfig({
        scaleDownThreshold: 5,
        scaleDownCooldown: 50,
      });
      const scaler = new AutoScaler(config);
      const { view } = createStateBuffer(8);

      // Worker 0: busy with depth 3
      // Worker 1: idle with depth 0  ← should be picked
      // Worker 2: busy with depth 2
      setWorkerState(view, 0, WorkerState.BUSY, 3);
      setWorkerState(view, 1, WorkerState.IDLE, 0);
      setWorkerState(view, 2, WorkerState.BUSY, 2);

      // First call: register below threshold
      scaler.evaluate([0, 1, 2], view);
      await new Promise((r) => setTimeout(r, 60));

      const decision = scaler.evaluate([0, 1, 2], view);
      expect(decision.action).toBe('scale-down');
      if (decision.action === 'scale-down') {
        expect(decision.targetWorkerId).toBe(1); // idle worker
      }
    });
  });

  describe('within bounds', () => {
    it('should not scale when depth is within thresholds', () => {
      const config = createConfig({
        scaleUpThreshold: 10,
        scaleDownThreshold: 2,
      });
      const scaler = new AutoScaler(config);
      const { view } = createStateBuffer(8);

      setWorkerState(view, 0, WorkerState.BUSY, 5);
      setWorkerState(view, 1, WorkerState.BUSY, 5);

      const decision = scaler.evaluate([0, 1], view);
      expect(decision.action).toBe('none');
      expect(decision.reason).toBe('within bounds');
    });
  });

  describe('reset', () => {
    it('should reset internal state', () => {
      const config = createConfig({ scaleUpCooldown: 60000 });
      const scaler = new AutoScaler(config);
      const { view } = createStateBuffer(8);

      setWorkerState(view, 0, WorkerState.BUSY, 20);
      scaler.evaluate([0], view); // triggers scale up, sets cooldown

      scaler.reset();

      // After reset, should be able to scale up again
      const decision = scaler.evaluate([0], view);
      expect(decision.action).toBe('scale-up');
    });
  });
});
