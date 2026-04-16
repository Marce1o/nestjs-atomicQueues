import 'reflect-metadata';
import { ResourceLockService } from '../src/services/resource-lock/resource-lock.service';
import { IAtomicQueuesModuleConfig } from '../src/domain';

// ─── Mock Redis ─────────────────────────────────────────────────────────────

function createMockRedis() {
  const store = new Map<string, string>();

  return {
    _store: store,
    eval: jest.fn(),
    get: jest.fn().mockImplementation((key: string) => store.get(key) ?? null),
    set: jest.fn().mockImplementation((key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn().mockImplementation((key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
    exists: jest.fn().mockImplementation((key: string) => (store.has(key) ? 1 : 0)),
    expire: jest.fn().mockResolvedValue(1),
    scan: jest.fn().mockResolvedValue(['0', []]),
  };
}

const mockConfig: IAtomicQueuesModuleConfig = {
  redis: { host: 'localhost', port: 6379 },
  keyPrefix: 'test',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ResourceLockService', () => {
  let service: ResourceLockService;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
    service = new ResourceLockService(redis as any, mockConfig);
  });

  describe('acquireLock', () => {
    it('should acquire a lock successfully', async () => {
      redis.eval.mockResolvedValue(1); // Lock acquired

      const result = await service.acquireLock(
        'context', 'ctx-1', 'user-1', 'user', 60,
      );

      expect(result.acquired).toBe(true);
      expect(result.lock).toBeDefined();
      expect(result.lock!.resourceId).toBe('ctx-1');
      expect(result.lock!.resourceType).toBe('context');
      expect(result.lock!.ownerId).toBe('user-1');
      expect(result.lock!.ownerType).toBe('user');
      expect(result.lock!.acquiredAt).toBeInstanceOf(Date);
      expect(result.lock!.expiresAt).toBeInstanceOf(Date);
    });

    it('should fail when lock is already held', async () => {
      redis.eval.mockResolvedValue(0); // Already held

      const result = await service.acquireLock(
        'context', 'ctx-1', 'user-2', 'user',
      );

      expect(result.acquired).toBe(false);
      expect(result.reason).toBe('Resource is already locked');
    });

    it('should handle Redis errors gracefully', async () => {
      redis.eval.mockRejectedValue(new Error('Redis down'));

      const result = await service.acquireLock(
        'context', 'ctx-1', 'user-1', 'user',
      );

      expect(result.acquired).toBe(false);
      expect(result.reason).toContain('Redis down');
    });

    it('should include metadata in lock data', async () => {
      redis.eval.mockResolvedValue(1);

      const result = await service.acquireLock(
        'context', 'ctx-1', 'user-1', 'user', 60,
        { source: 'api' },
      );

      expect(result.lock!.metadata).toEqual({ source: 'api' });
    });

    it('should use default TTL of 60', async () => {
      redis.eval.mockResolvedValue(1);

      await service.acquireLock('type', 'id', 'owner', 'ownerType');

      // The Lua script is called with ttl as string
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        'test:lock:type:id',
        expect.any(String),
        '60',
      );
    });
  });

  describe('releaseLock', () => {
    it('should release a lock', async () => {
      const result = await service.releaseLock('context', 'ctx-1');
      expect(result).toBe(true);
      expect(redis.del).toHaveBeenCalledWith('test:lock:context:ctx-1');
    });

    it('should handle errors gracefully', async () => {
      redis.del.mockRejectedValue(new Error('Redis error'));
      const result = await service.releaseLock('context', 'ctx-1');
      expect(result).toBe(false);
    });
  });

  describe('releaseOwnedLock', () => {
    it('should release lock when owner matches', async () => {
      redis.eval.mockResolvedValue(1);
      const result = await service.releaseOwnedLock('ctx', 'id', 'owner-1');
      expect(result).toBe(true);
    });

    it('should fail when owner does not match', async () => {
      redis.eval.mockResolvedValue(0);
      const result = await service.releaseOwnedLock('ctx', 'id', 'wrong-owner');
      expect(result).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      redis.eval.mockRejectedValue(new Error('fail'));
      const result = await service.releaseOwnedLock('ctx', 'id', 'owner');
      expect(result).toBe(false);
    });
  });

  describe('isLocked', () => {
    it('should return true when lock exists', async () => {
      redis.exists.mockResolvedValue(1);
      expect(await service.isLocked('ctx', 'id')).toBe(true);
    });

    it('should return false when lock does not exist', async () => {
      redis.exists.mockResolvedValue(0);
      expect(await service.isLocked('ctx', 'id')).toBe(false);
    });
  });

  describe('getLockInfo', () => {
    it('should return parsed lock data', async () => {
      const lockData = {
        resourceId: 'ctx-1',
        resourceType: 'context',
        ownerId: 'user-1',
        ownerType: 'user',
        acquiredAt: '2024-01-01T00:00:00.000Z',
        expiresAt: '2024-01-01T00:01:00.000Z',
      };
      redis.get.mockResolvedValue(JSON.stringify(lockData));

      const lock = await service.getLockInfo('context', 'ctx-1');
      expect(lock).toBeDefined();
      expect(lock!.ownerId).toBe('user-1');
      expect(lock!.acquiredAt).toBeInstanceOf(Date);
      expect(lock!.expiresAt).toBeInstanceOf(Date);
    });

    it('should return null when no lock exists', async () => {
      redis.get.mockResolvedValue(null);
      const lock = await service.getLockInfo('context', 'ctx-1');
      expect(lock).toBeNull();
    });

    it('should return null for malformed data', async () => {
      redis.get.mockResolvedValue('not-json');
      const lock = await service.getLockInfo('context', 'ctx-1');
      expect(lock).toBeNull();
    });
  });

  describe('extendLock', () => {
    it('should extend lock TTL', async () => {
      redis.eval.mockResolvedValue(1);
      const result = await service.extendLock('ctx', 'id', 120);
      expect(result).toBe(true);
    });

    it('should return false when lock does not exist', async () => {
      redis.eval.mockResolvedValue(0);
      const result = await service.extendLock('ctx', 'id', 120);
      expect(result).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      redis.eval.mockRejectedValue(new Error('fail'));
      const result = await service.extendLock('ctx', 'id', 120);
      expect(result).toBe(false);
    });
  });

  describe('verifyLockOwnership', () => {
    it('should return true when owner matches', async () => {
      const lockData = {
        resourceId: 'ctx-1',
        resourceType: 'context',
        ownerId: 'user-1',
        ownerType: 'user',
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      };
      redis.get.mockResolvedValue(JSON.stringify(lockData));

      expect(await service.verifyLockOwnership('context', 'ctx-1', 'user-1')).toBe(true);
    });

    it('should return false when owner does not match', async () => {
      const lockData = {
        resourceId: 'ctx-1',
        resourceType: 'context',
        ownerId: 'user-1',
        ownerType: 'user',
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      };
      redis.get.mockResolvedValue(JSON.stringify(lockData));

      expect(await service.verifyLockOwnership('context', 'ctx-1', 'user-2')).toBe(false);
    });

    it('should return false when no lock exists', async () => {
      redis.get.mockResolvedValue(null);
      expect(await service.verifyLockOwnership('context', 'ctx-1', 'user-1')).toBe(false);
    });
  });

  describe('getAvailableResource', () => {
    it('should return the first available resource', async () => {
      // First candidate locked, second available
      redis.eval
        .mockResolvedValueOnce(0) // first locked
        .mockResolvedValueOnce(1); // second available

      const result = await service.getAvailableResource(
        'context',
        ['ctx-1', 'ctx-2'],
        'user-1',
        'user',
      );

      // Due to shuffle, we just check that it acquired one
      expect(result.acquired).toBe(true);
    });

    it('should return failure when all resources are locked', async () => {
      redis.eval.mockResolvedValue(0); // All locked

      const result = await service.getAvailableResource(
        'context',
        ['ctx-1', 'ctx-2', 'ctx-3'],
        'user-1',
        'user',
      );

      expect(result.acquired).toBe(false);
      expect(result.reason).toBe('No available resources in pool');
    });

    it('should handle empty candidate list', async () => {
      const result = await service.getAvailableResource(
        'context', [], 'user-1', 'user',
      );
      expect(result.acquired).toBe(false);
    });
  });

  describe('getOwnerLocks', () => {
    it('should return locks owned by the specified owner', async () => {
      const lockData = {
        resourceId: 'ctx-1',
        resourceType: 'context',
        ownerId: 'user-1',
        ownerType: 'user',
        acquiredAt: '2024-01-01T00:00:00.000Z',
        expiresAt: '2024-01-01T00:01:00.000Z',
      };

      redis.scan.mockResolvedValue(['0', ['test:lock:context:ctx-1']]);
      redis.get.mockResolvedValue(JSON.stringify(lockData));

      const locks = await service.getOwnerLocks('user', 'user-1');
      expect(locks).toHaveLength(1);
      expect(locks[0].ownerId).toBe('user-1');
    });

    it('should filter out locks from other owners', async () => {
      const lockData = {
        resourceId: 'ctx-1',
        resourceType: 'context',
        ownerId: 'user-2',
        ownerType: 'user',
        acquiredAt: '2024-01-01T00:00:00.000Z',
        expiresAt: '2024-01-01T00:01:00.000Z',
      };

      redis.scan.mockResolvedValue(['0', ['test:lock:context:ctx-1']]);
      redis.get.mockResolvedValue(JSON.stringify(lockData));

      const locks = await service.getOwnerLocks('user', 'user-1');
      expect(locks).toHaveLength(0);
    });
  });

  describe('clearOwnerLocks', () => {
    it('should clear all locks for an owner', async () => {
      const lockData = {
        resourceId: 'ctx-1',
        resourceType: 'context',
        ownerId: 'user-1',
        ownerType: 'user',
        acquiredAt: '2024-01-01T00:00:00.000Z',
        expiresAt: '2024-01-01T00:01:00.000Z',
      };

      redis.scan.mockResolvedValue(['0', ['test:lock:context:ctx-1']]);
      redis.get.mockResolvedValue(JSON.stringify(lockData));

      const cleared = await service.clearOwnerLocks('user', 'user-1');
      expect(cleared).toBe(1);
      expect(redis.del).toHaveBeenCalledWith('test:lock:context:ctx-1');
    });
  });
});
