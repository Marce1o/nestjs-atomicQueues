import 'reflect-metadata';

// Mock BullMQ before importing the service
jest.mock('bullmq', () => {
  const EventEmitter = require('events');

  class MockWorker extends EventEmitter {
    constructor(
      public queueName: string,
      public processor: Function,
      public opts: any,
    ) {
      super();
    }
    close = jest.fn().mockResolvedValue(undefined);
  }

  return {
    Worker: jest.fn().mockImplementation(
      (queueName: string, processor: Function, opts: any) =>
        new MockWorker(queueName, processor, opts),
    ),
    Queue: jest.fn(),
    QueueEvents: jest.fn(),
    Job: jest.fn(),
  };
});

// Mock uuid
jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-node-id'),
}));

import { WorkerManagerService } from '../src/services/worker-manager/worker-manager.service';
import { IAtomicQueuesModuleConfig } from '../src/domain';

// ─── Mock Redis ─────────────────────────────────────────────────────────────

function createMockRedis() {
  const store = new Map<string, string>();

  const pipeline = {
    set: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };

  return {
    _store: store,
    duplicate: jest.fn().mockReturnThis(),
    set: jest.fn().mockImplementation((key: string, value: string, ...args: any[]) => {
      store.set(key, value);
      // Handle SET NX
      if (args.includes('NX')) {
        if (store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }
      return 'OK';
    }),
    get: jest.fn().mockImplementation((key: string) => store.get(key) ?? null),
    del: jest.fn().mockImplementation((key: string) => {
      store.delete(key);
      return 1;
    }),
    exists: jest.fn().mockImplementation((key: string) => (store.has(key) ? 1 : 0)),
    keys: jest.fn().mockResolvedValue([]),
    incrby: jest.fn().mockImplementation((key: string, increment: number) => {
      const val = parseInt(store.get(key) || '0', 10) + increment;
      store.set(key, String(val));
      return val;
    }),
    publish: jest.fn().mockResolvedValue(1),
    subscribe: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    off: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    pipeline: jest.fn().mockReturnValue(pipeline),
    _pipeline: pipeline,
  };
}

const mockConfig: IAtomicQueuesModuleConfig = {
  redis: { host: 'localhost', port: 6379 },
  keyPrefix: 'aq',
  workerDefaults: {
    concurrency: 1,
    heartbeatTTL: 3,
    heartbeatInterval: 1000,
  },
};

describe('WorkerManagerService', () => {
  let service: WorkerManagerService;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    jest.clearAllMocks();
    redis = createMockRedis();
    service = new WorkerManagerService(redis as any, mockConfig);
    service.onModuleInit();
  });

  afterEach(async () => {
    // Clean up heartbeat intervals and workers to prevent open handles
    try {
      await service.closeAllWorkers(100);
    } catch {
      // Ignore timeout errors during cleanup
    }
  });

  describe('getNodeId', () => {
    it('should return a node ID', () => {
      expect(service.getNodeId()).toBe('test-node-id');
    });
  });

  describe('workerExists', () => {
    it('should check global alive key', async () => {
      redis.exists.mockResolvedValue(0);
      const exists = await service.workerExists('my-worker');
      expect(exists).toBe(false);
      expect(redis.exists).toHaveBeenCalledWith('aq:worker-alive:my-worker');
    });

    it('should return true when worker is alive', async () => {
      redis.exists.mockResolvedValue(1);
      expect(await service.workerExists('alive-worker')).toBe(true);
    });
  });

  describe('workerExistsOnThisNode', () => {
    it('should check node-specific key', async () => {
      redis.exists.mockResolvedValue(0);
      const exists = await service.workerExistsOnThisNode('my-worker');
      expect(exists).toBe(false);
      expect(redis.exists).toHaveBeenCalledWith(
        'aq:worker:test-node-id:my-worker',
      );
    });
  });

  describe('claimWorkerSlot', () => {
    it('should use SET NX for atomic claim', async () => {
      redis.set.mockResolvedValue('OK');
      const claimed = await service.claimWorkerSlot('worker-1', 10);
      expect(claimed).toBe(true);
      expect(redis.set).toHaveBeenCalledWith(
        'aq:worker-claim:worker-1',
        'test-node-id',
        'EX',
        10,
        'NX',
      );
    });

    it('should return false when slot already claimed', async () => {
      redis.set.mockResolvedValue(null);
      const claimed = await service.claimWorkerSlot('worker-1');
      expect(claimed).toBe(false);
    });
  });

  describe('resetWorkerHeartbeat', () => {
    it('should set both node and alive keys via pipeline', async () => {
      await service.resetWorkerHeartbeat('w-1', 5);

      expect(redis.pipeline).toHaveBeenCalled();
      expect(redis._pipeline.set).toHaveBeenCalledWith(
        'aq:worker:test-node-id:w-1',
        '1',
        'EX',
        5,
      );
      expect(redis._pipeline.set).toHaveBeenCalledWith(
        'aq:worker-alive:w-1',
        'test-node-id',
        'EX',
        5,
      );
      expect(redis._pipeline.exec).toHaveBeenCalled();
    });

    it('should use default TTL from config', async () => {
      await service.resetWorkerHeartbeat('w-2');

      expect(redis._pipeline.set).toHaveBeenCalledWith(
        expect.stringContaining('w-2'),
        '1',
        'EX',
        3, // from workerDefaults.heartbeatTTL
      );
    });
  });

  describe('removeWorkerHeartbeat', () => {
    it('should delete node, alive, and idle keys via pipeline', async () => {
      await service.removeWorkerHeartbeat('w-1');

      expect(redis.pipeline).toHaveBeenCalled();
      expect(redis._pipeline.del).toHaveBeenCalledWith('aq:worker:test-node-id:w-1');
      expect(redis._pipeline.del).toHaveBeenCalledWith('aq:worker-alive:w-1');
      expect(redis._pipeline.del).toHaveBeenCalledWith('aq:worker-idle:w-1');
      expect(redis._pipeline.exec).toHaveBeenCalled();
    });
  });

  describe('signalWorkerClose', () => {
    it('should publish shutdown signal', async () => {
      await service.signalWorkerClose('w-1');
      expect(redis.publish).toHaveBeenCalledWith(
        'aq:worker:w-1:shutdown',
        'shutdown',
      );
    });
  });

  describe('getNodeWorkers', () => {
    it('should scan for node workers', async () => {
      redis.keys.mockResolvedValue([
        'aq:worker:test-node-id:worker-a',
        'aq:worker:test-node-id:worker-b',
      ]);

      const workers = await service.getNodeWorkers();
      expect(workers).toContain('worker-a');
      expect(workers).toContain('worker-b');
    });
  });

  describe('getAllWorkers', () => {
    it('should scan all nodes', async () => {
      redis.keys.mockResolvedValue([
        'aq:worker:node-1:w-1',
        'aq:worker:node-2:w-2',
      ]);

      const workers = await service.getAllWorkers();
      expect(workers).toContain('w-1');
      expect(workers).toContain('w-2');
    });
  });

  describe('getEntityWorkers', () => {
    it('should find workers for a specific entity', async () => {
      redis.keys.mockResolvedValue([
        'aq:worker:node-1:entity-1-worker',
      ]);

      const workers = await service.getEntityWorkers('table', 'entity-1');
      expect(workers).toContain('entity-1-worker');
    });
  });

  // ── Idle Tracking ─────────────────────────────────────────────────────────

  describe('Idle Tracking', () => {
    it('markWorkerActive should reset idle counter', () => {
      // This sets up internal state and calls resetWorkerIdleCounter
      service.markWorkerActive('w-1');
      expect(redis.set).toHaveBeenCalledWith('aq:worker-idle:w-1', '0');
    });

    it('getWorkerIdleSeconds should return idle counter', async () => {
      redis.get.mockResolvedValue('42');
      const idle = await service.getWorkerIdleSeconds('w-1');
      expect(idle).toBe(42);
    });

    it('getWorkerIdleSeconds should return 0 when no counter', async () => {
      redis.get.mockResolvedValue(null);
      const idle = await service.getWorkerIdleSeconds('w-1');
      expect(idle).toBe(0);
    });

    it('resetWorkerIdleCounter should set to 0', async () => {
      await service.resetWorkerIdleCounter('w-1');
      expect(redis.set).toHaveBeenCalledWith('aq:worker-idle:w-1', '0');
    });

    it('incrementWorkerIdleCounter should increment by specified amount', async () => {
      redis.incrby.mockResolvedValue(5);
      const result = await service.incrementWorkerIdleCounter('w-1', 5);
      expect(result).toBe(5);
      expect(redis.incrby).toHaveBeenCalledWith('aq:worker-idle:w-1', 5);
    });

    it('incrementWorkerIdleCounter should default to 1', async () => {
      redis.incrby.mockResolvedValue(1);
      await service.incrementWorkerIdleCounter('w-1');
      expect(redis.incrby).toHaveBeenCalledWith('aq:worker-idle:w-1', 1);
    });

    it('removeWorkerIdleCounter should delete the key', async () => {
      await service.removeWorkerIdleCounter('w-1');
      expect(redis.del).toHaveBeenCalledWith('aq:worker-idle:w-1');
    });

    it('isWorkerIdle should return true when over threshold', async () => {
      redis.get.mockResolvedValue('20');
      expect(await service.isWorkerIdle('w-1', 15)).toBe(true);
    });

    it('isWorkerIdle should return false when under threshold', async () => {
      redis.get.mockResolvedValue('5');
      expect(await service.isWorkerIdle('w-1', 15)).toBe(false);
    });

    it('isWorkerIdle should use default threshold of 15', async () => {
      redis.get.mockResolvedValue('15');
      expect(await service.isWorkerIdle('w-1')).toBe(true);
    });
  });

  describe('indexEntityWorker / removeEntityWorkerIndex', () => {
    it('should index entity worker with TTL', async () => {
      await service.indexEntityWorker('table', 't-1', 'worker-1', 5);
      expect(redis.set).toHaveBeenCalledWith(
        'aq:entity-worker:table:t-1:worker-1',
        '1',
        'EX',
        5,
      );
    });

    it('should remove entity worker index', async () => {
      await service.removeEntityWorkerIndex('table', 't-1', 'worker-1');
      expect(redis.del).toHaveBeenCalledWith('aq:entity-worker:table:t-1:worker-1');
    });
  });

  describe('createWorker', () => {
    it('should create a worker and set up heartbeat', async () => {
      redis.exists.mockResolvedValue(0); // Worker doesn't exist yet

      const worker = await service.createWorker({
        workerName: 'test-worker',
        queueName: 'test-queue',
        processor: async () => {},
      });

      expect(worker).toBeDefined();
      // Heartbeat should have been initialized via pipeline
      expect(redis.pipeline).toHaveBeenCalled();
    });

    it('should return existing worker if already exists locally', async () => {
      redis.exists.mockResolvedValue(0);

      const w1 = await service.createWorker({
        workerName: 'dup-worker',
        queueName: 'test-queue',
        processor: async () => {},
      });

      // Now pretend it exists
      redis.exists.mockResolvedValue(1);

      const w2 = await service.createWorker({
        workerName: 'dup-worker',
        queueName: 'test-queue',
        processor: async () => {},
      });

      expect(w1).toBe(w2);
    });
  });
});
