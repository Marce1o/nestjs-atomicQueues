import 'reflect-metadata';
import { IndexManagerService } from '../src/services/index-manager/index-manager.service';
import { IAtomicQueuesModuleConfig } from '../src/domain';

// ─── Mock Redis ─────────────────────────────────────────────────────────────

function createMockRedis() {
  const sets = new Map<string, Set<string>>();
  const store = new Map<string, string>();

  return {
    sadd: jest.fn().mockImplementation((key: string, member: string) => {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key)!.add(member);
      return 1;
    }),
    srem: jest.fn().mockImplementation((key: string, member: string) => {
      const set = sets.get(key);
      if (set) {
        set.delete(member);
        return 1;
      }
      return 0;
    }),
    smembers: jest.fn().mockImplementation((key: string) => {
      const set = sets.get(key);
      return set ? Array.from(set) : [];
    }),
    scard: jest.fn().mockImplementation((key: string) => {
      const set = sets.get(key);
      return set ? set.size : 0;
    }),
    sismember: jest.fn().mockImplementation((key: string, member: string) => {
      const set = sets.get(key);
      return set && set.has(member) ? 1 : 0;
    }),
    del: jest.fn().mockImplementation((key: string) => {
      sets.delete(key);
      store.delete(key);
      return 1;
    }),
    get: jest.fn().mockImplementation((key: string) => store.get(key) ?? null),
    incr: jest.fn().mockImplementation((key: string) => {
      const val = parseInt(store.get(key) || '0', 10) + 1;
      store.set(key, String(val));
      return val;
    }),
    decr: jest.fn().mockImplementation((key: string) => {
      const val = parseInt(store.get(key) || '0', 10) - 1;
      store.set(key, String(Math.max(0, val)));
      return Math.max(0, val);
    }),
    expire: jest.fn().mockResolvedValue(1),
    scan: jest.fn().mockResolvedValue(['0', []]),
    _sets: sets,
    _store: store,
  };
}

const mockConfig: IAtomicQueuesModuleConfig = {
  redis: { host: 'localhost', port: 6379 },
  keyPrefix: 'aq',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('IndexManagerService', () => {
  let service: IndexManagerService;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
    service = new IndexManagerService(redis as any, mockConfig);
  });

  // ── Job Indexing ──────────────────────────────────────────────────────────

  describe('Job Indexing', () => {
    it('should index a job', async () => {
      await service.indexJob('user', 'u-1', 'job-1');
      expect(redis.sadd).toHaveBeenCalledWith(
        'aq:jobs-index:user:u-1:jobs',
        'job:user:u-1:job-1',
      );
    });

    it('should remove a job index', async () => {
      await service.indexJob('user', 'u-1', 'job-1');
      await service.removeJobIndex('user', 'u-1', 'job-1');
      expect(redis.srem).toHaveBeenCalledWith(
        'aq:jobs-index:user:u-1:jobs',
        'job:user:u-1:job-1',
      );
    });

    it('should get entity jobs', async () => {
      await service.indexJob('user', 'u-1', 'job-1');
      await service.indexJob('user', 'u-1', 'job-2');

      const jobs = await service.getEntityJobs('user', 'u-1');
      expect(jobs).toContain('job-1');
      expect(jobs).toContain('job-2');
    });

    it('should return empty array when no jobs', async () => {
      const jobs = await service.getEntityJobs('user', 'u-999');
      expect(jobs).toEqual([]);
    });

    it('should get entity job count', async () => {
      await service.indexJob('user', 'u-1', 'j1');
      await service.indexJob('user', 'u-1', 'j2');
      await service.indexJob('user', 'u-1', 'j3');

      const count = await service.getEntityJobCount('user', 'u-1');
      expect(count).toBe(3);
    });

    it('should clear all entity jobs', async () => {
      await service.indexJob('user', 'u-1', 'j1');
      await service.indexJob('user', 'u-1', 'j2');

      await service.clearEntityJobs('user', 'u-1');
      expect(redis.del).toHaveBeenCalledWith('aq:jobs-index:user:u-1:jobs');
    });
  });

  // ── Worker Death Indexing ─────────────────────────────────────────────────

  describe('Worker Death Indexing', () => {
    it('should index a worker death', async () => {
      await service.indexWorkerDeath('table', 't-1', 'death-1');
      expect(redis.sadd).toHaveBeenCalledWith(
        'aq:workerDeaths-index:table:t-1:deaths',
        'death:table:t-1:death-1',
      );
    });

    it('should remove a worker death index', async () => {
      await service.removeWorkerDeathIndex('table', 't-1', 'death-1');
      expect(redis.srem).toHaveBeenCalledWith(
        'aq:workerDeaths-index:table:t-1:deaths',
        'death:table:t-1:death-1',
      );
    });

    it('should get queued worker deaths', async () => {
      await service.indexWorkerDeath('table', 't-1', 'death-1');
      await service.indexWorkerDeath('table', 't-1', 'death-2');

      const deaths = await service.getQueuedWorkerDeaths('table', 't-1');
      expect(deaths).toContain('death-1');
      expect(deaths).toContain('death-2');
    });

    it('should clear entity worker deaths', async () => {
      await service.indexWorkerDeath('table', 't-1', 'd-1');
      await service.clearEntityWorkerDeaths('table', 't-1');
      expect(redis.del).toHaveBeenCalledWith(
        'aq:workerDeaths-index:table:t-1:deaths',
      );
    });
  });

  // ── Queue Indexing ────────────────────────────────────────────────────────

  describe('Queue Indexing', () => {
    it('should index an entity queue', async () => {
      await service.indexEntityQueue('game', 'g-1');
      expect(redis.sadd).toHaveBeenCalledWith(
        'aq:queue-index:game:queues',
        'queue:game:g-1',
      );
    });

    it('should remove entity queue index', async () => {
      await service.removeEntityQueueIndex('game', 'g-1');
      expect(redis.srem).toHaveBeenCalledWith(
        'aq:queue-index:game:queues',
        'queue:game:g-1',
      );
    });

    it('should get entities with queues', async () => {
      await service.indexEntityQueue('game', 'g-1');
      await service.indexEntityQueue('game', 'g-2');

      const entities = await service.getEntitiesWithQueues('game');
      expect(entities).toContain('g-1');
      expect(entities).toContain('g-2');
    });

    it('should check if entity has a queue', async () => {
      await service.indexEntityQueue('game', 'g-1');
      expect(await service.hasEntityQueue('game', 'g-1')).toBe(true);
    });

    it('should return false for entity without queue', async () => {
      expect(await service.hasEntityQueue('game', 'g-nope')).toBe(false);
    });
  });

  // ── Queue Death Indexing ──────────────────────────────────────────────────

  describe('Queue Death Indexing', () => {
    it('should index a queue death', async () => {
      await service.indexQueueDeath('table', 't-1');
      expect(redis.sadd).toHaveBeenCalledWith(
        'aq:queueDeaths-index:table:deaths',
        'death:table:t-1',
      );
    });

    it('should remove queue death index', async () => {
      await service.removeQueueDeathIndex('table', 't-1');
      expect(redis.srem).toHaveBeenCalledWith(
        'aq:queueDeaths-index:table:deaths',
        'death:table:t-1',
      );
    });

    it('should get entities with queued queue deaths', async () => {
      await service.indexQueueDeath('table', 't-1');
      await service.indexQueueDeath('table', 't-2');

      const entities = await service.getEntitiesWithQueuedQueueDeaths('table');
      expect(entities).toContain('t-1');
      expect(entities).toContain('t-2');
    });
  });

  // ── Worker Creation Request Tracking ──────────────────────────────────────

  describe('Worker Creation Request Tracking', () => {
    it('should increment creation request count', async () => {
      await service.indexWorkerCreationRequest('table', 't-1');
      expect(redis.incr).toHaveBeenCalled();
      expect(redis.expire).toHaveBeenCalled();
    });

    it('should decrement creation request count', async () => {
      redis._store.set('aq:worker-creation:table:t-1', '2');
      await service.decrementWorkerCreationRequest('table', 't-1');
      expect(redis.decr).toHaveBeenCalled();
    });

    it('should not decrement below zero', async () => {
      redis._store.set('aq:worker-creation:table:t-1', '0');
      await service.decrementWorkerCreationRequest('table', 't-1');
      // decr should not be called when count is 0
      expect(redis.decr).not.toHaveBeenCalled();
    });

    it('should get creation request count', async () => {
      redis._store.set('aq:worker-creation:table:t-1', '5');
      const count = await service.getWorkerCreationRequestCount('table', 't-1');
      expect(count).toBe(5);
    });

    it('should return 0 when no requests exist', async () => {
      const count = await service.getWorkerCreationRequestCount('table', 't-nope');
      expect(count).toBe(0);
    });

    it('should clear creation requests', async () => {
      await service.clearWorkerCreationRequests('table', 't-1');
      expect(redis.del).toHaveBeenCalledWith('aq:worker-creation:table:t-1');
    });
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────

  describe('cleanupEntityIndices', () => {
    it('should clean up all indices for an entity', async () => {
      await service.cleanupEntityIndices('table', 't-1');

      // Should call del for jobs, worker deaths, creation requests
      // and srem for queue index and queue death index
      expect(redis.del).toHaveBeenCalled();
      expect(redis.srem).toHaveBeenCalled();
    });
  });
});
