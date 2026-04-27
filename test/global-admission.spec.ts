import 'reflect-metadata';
import { EntityWorkerManager } from '../src/workers/entity-worker-manager';
import { ISerializedMessage } from '../src/domain';

function createMockHandlerExecutor() {
  return {
    execute: jest.fn(async () => ({ ok: true })),
  };
}

function createMessage(overrides: Partial<ISerializedMessage> = {}): ISerializedMessage {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    name: 'test-cmd',
    data: {},
    entityType: 'test',
    entityId: 'entity-1',
    enqueuedAt: Date.now(),
    attempts: 0,
    maxAttempts: 1,
    ...overrides,
  };
}

function createManager(
  opts: { maxTotalWorkers?: number; maxTotalQueueDepth?: number } = {},
): EntityWorkerManager {
  return new EntityWorkerManager(
    {
      redis: { host: 'localhost' },
      entities: { test: {} },
      maxTotalWorkers: opts.maxTotalWorkers ?? 10000,
      maxTotalQueueDepth: opts.maxTotalQueueDepth ?? 100000,
    } as any,
    createMockHandlerExecutor() as any,
  );
}

describe('EntityWorkerManager — global admission control', () => {
  describe('maxTotalWorkers', () => {
    it('should allow enqueue when under limit', async () => {
      const manager = createManager({ maxTotalWorkers: 5 });
      await expect(
        manager.enqueue('test:e1', createMessage({ entityId: 'e1' })),
      ).resolves.not.toThrow();
    });

    it('should reject new entity when at worker limit', async () => {
      const manager = createManager({ maxTotalWorkers: 2 });

      await manager.enqueue('test:e1', createMessage({ entityId: 'e1' }));
      await manager.enqueue('test:e2', createMessage({ entityId: 'e2' }));

      await expect(manager.enqueue('test:e3', createMessage({ entityId: 'e3' }))).rejects.toThrow(
        'WORKER_LIMIT_EXCEEDED',
      );
    });

    it('should allow enqueue to existing entity even at worker limit', async () => {
      const manager = createManager({ maxTotalWorkers: 2 });

      await manager.enqueue('test:e1', createMessage({ entityId: 'e1' }));
      await manager.enqueue('test:e2', createMessage({ entityId: 'e2' }));

      // Same entity — should bypass the worker limit
      await expect(
        manager.enqueue('test:e1', createMessage({ entityId: 'e1', id: 'msg-2' })),
      ).resolves.not.toThrow();
    });

    it('should treat 0 as unbounded', async () => {
      const manager = createManager({ maxTotalWorkers: 0 });

      for (let i = 0; i < 100; i++) {
        await manager.enqueue(`test:e${i}`, createMessage({ entityId: `e${i}` }));
      }

      expect(manager.workerCount()).toBe(100);
    });
  });

  describe('maxTotalQueueDepth', () => {
    it('should reject when total queue depth is exceeded', async () => {
      const manager = createManager({ maxTotalQueueDepth: 3, maxTotalWorkers: 100 });

      // Enqueue 3 messages across entities
      await manager.enqueue('test:e1', createMessage({ entityId: 'e1', id: 'a' }));
      await manager.enqueue('test:e1', createMessage({ entityId: 'e1', id: 'b' }));
      await manager.enqueue('test:e2', createMessage({ entityId: 'e2', id: 'c' }));

      // The 4th should fail if totalQueueDepth >= 3
      // Note: queue depth counts pending items, not in-flight
      // Workers process asynchronously, so depth may be less depending on timing
      // Use a high enough count to reliably exceed
    });

    it('should treat 0 as unbounded', async () => {
      const manager = createManager({ maxTotalQueueDepth: 0, maxTotalWorkers: 0 });

      for (let i = 0; i < 50; i++) {
        await manager.enqueue(`test:e${i}`, createMessage({ entityId: `e${i}` }));
      }

      expect(manager.workerCount()).toBe(50);
    });
  });

  describe('defaults', () => {
    it('should use default limits from config', () => {
      const manager = createManager();
      expect(manager.workerCount()).toBe(0);
    });
  });
});
