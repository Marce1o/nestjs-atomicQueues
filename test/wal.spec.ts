import 'reflect-metadata';
import { WalService } from '../src/wal/wal.service';
import { ISerializedMessage } from '../src/domain';

function createMessage(overrides?: Partial<ISerializedMessage>): ISerializedMessage {
  return {
    id: 'msg-1',
    name: 'TestCommand',
    data: { foo: 'bar' },
    entityType: 'account',
    entityId: 'a-1',
    enqueuedAt: Date.now(),
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

function createMockRedis() {
  const store: Record<string, Record<string, string>> = {};
  const sortedSets: Record<string, Map<string, number>> = {};
  const lists: Record<string, string[]> = {};

  return {
    hset: jest.fn(async (key: string, data: Record<string, string>) => {
      store[key] = { ...store[key], ...data };
      return Object.keys(data).length;
    }),
    hgetall: jest.fn(async (key: string) => store[key] ?? {}),
    hget: jest.fn(async (key: string, field: string) => store[key]?.[field] ?? null),
    expire: jest.fn(async () => 1),
    del: jest.fn(async (key: string) => {
      delete store[key];
      return 1;
    }),
    zadd: jest.fn(async (key: string, score: number, member: string) => {
      if (!sortedSets[key]) sortedSets[key] = new Map();
      sortedSets[key].set(member, score);
      return 1;
    }),
    zrange: jest.fn(async (key: string) => {
      if (!sortedSets[key]) return [];
      return Array.from(sortedSets[key].keys());
    }),
    zrem: jest.fn(async (key: string, member: string) => {
      sortedSets[key]?.delete(member);
      return 1;
    }),
    lpush: jest.fn(async (key: string, value: string) => {
      if (!lists[key]) lists[key] = [];
      lists[key].unshift(value);
      return lists[key].length;
    }),
    lrange: jest.fn(async (key: string, start: number, end: number) => {
      if (!lists[key]) return [];
      return lists[key].slice(start, end + 1);
    }),
    pipeline: jest.fn(() => {
      const ops: Array<() => void> = [];
      const pipe = {
        hset: (key: string, data: Record<string, string>) => {
          ops.push(() => {
            store[key] = { ...store[key], ...data };
          });
          return pipe;
        },
        expire: (_key: string, _ttl: number) => {
          ops.push(() => {});
          return pipe;
        },
        zadd: (key: string, score: number, member: string) => {
          ops.push(() => {
            if (!sortedSets[key]) sortedSets[key] = new Map();
            sortedSets[key].set(member, score);
          });
          return pipe;
        },
        exec: async () => {
          ops.forEach((op) => op());
          return ops.map(() => [null, 'OK']);
        },
      };
      return pipe;
    }),
    eval: jest.fn(
      async (
        script: string,
        numKeys: number,
        ...args: string[]
      ): Promise<number> => {
        // Simulate Lua script behavior
        const key = args[0];

        if (script.includes('"enqueued"') && script.includes('"dispatched"')) {
          // DISPATCH_SCRIPT
          if (store[key]?.state === 'enqueued') {
            store[key].state = 'dispatched';
            store[key].dispatched_at = args[numKeys];
            store[key].worker_id = args[numKeys + 1];
            return 1;
          }
          return 0;
        }

        if (script.includes('"completed"') && script.includes('ZREM')) {
          // COMPLETE_SCRIPT
          if (store[key]?.state === 'dispatched') {
            const indexKey = args[1];
            const indexMember = args[numKeys + 1];
            store[key].state = 'completed';
            store[key].completed_at = args[numKeys];
            sortedSets[indexKey]?.delete(indexMember);
            delete store[key];
            return 1;
          }
          return 0;
        }

        if (script.includes('"failed"')) {
          // FAIL_SCRIPT
          if (store[key]?.state === 'dispatched') {
            store[key].state = 'failed';
            store[key].completed_at = args[numKeys];
            store[key].error = args[numKeys + 1];
            store[key].error_stack = args[numKeys + 2];
            return 1;
          }
          return 0;
        }

        if (script.includes('"interrupted"')) {
          // INTERRUPT_SCRIPT
          if (store[key]?.state === 'dispatched') {
            store[key].state = 'interrupted';
            store[key].completed_at = args[numKeys];
            store[key].error = args[numKeys + 1];
            return 1;
          }
          return 0;
        }

        return 0;
      },
    ),
    _store: store,
    _sortedSets: sortedSets,
    _lists: lists,
  };
}

describe('WalService', () => {
  let wal: WalService;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
    wal = new WalService(
      redis as any,
      { keyPrefix: 'test', wal: { entryTTL: 86400, cleanupInterval: 5000 } },
      'server-1',
    );
  });

  describe('key generation', () => {
    it('should generate correct WAL entry key', () => {
      expect(wal.walEntryKey('account:a-1', 'msg-1')).toBe(
        'test:wal:server-1:account:a-1:msg-1',
      );
    });

    it('should generate correct WAL index key', () => {
      expect(wal.walIndexKey()).toBe('test:wal:server-1:index');
    });

    it('should generate correct dead letter key', () => {
      expect(wal.deadLetterKey('account')).toBe('test:dead:account');
    });
  });

  describe('write', () => {
    it('should write a WAL entry with pipeline', async () => {
      const msg = createMessage();
      await wal.write('account:a-1', msg);

      expect(redis.pipeline).toHaveBeenCalled();
      const entryKey = wal.walEntryKey('account:a-1', 'msg-1');
      expect(redis._store[entryKey]).toBeDefined();
      expect(redis._store[entryKey].state).toBe('enqueued');
      expect(redis._store[entryKey].entity_key).toBe('account:a-1');
    });

    it('should add to sorted set index', async () => {
      const msg = createMessage();
      await wal.write('account:a-1', msg);

      const indexKey = wal.walIndexKey();
      expect(redis._sortedSets[indexKey]).toBeDefined();
      expect(redis._sortedSets[indexKey].has('account:a-1:msg-1')).toBe(true);
    });
  });

  describe('state transitions', () => {
    it('should transition enqueued → dispatched', async () => {
      const msg = createMessage();
      await wal.write('account:a-1', msg);

      const result = await wal.markDispatched('account:a-1', 'msg-1', 3);
      expect(result).toBe(true);

      const entryKey = wal.walEntryKey('account:a-1', 'msg-1');
      expect(redis._store[entryKey].state).toBe('dispatched');
      expect(redis._store[entryKey].worker_id).toBe('3');
    });

    it('should reject dispatched when not enqueued', async () => {
      // No entry exists
      const result = await wal.markDispatched('account:a-1', 'msg-1', 0);
      expect(result).toBe(false);
    });

    it('should transition dispatched → completed', async () => {
      const msg = createMessage();
      await wal.write('account:a-1', msg);
      await wal.markDispatched('account:a-1', 'msg-1', 0);

      const result = await wal.markCompleted('account:a-1', 'msg-1');
      expect(result).toBe(true);
    });

    it('should reject completed when not dispatched', async () => {
      const msg = createMessage();
      await wal.write('account:a-1', msg);
      // Still in 'enqueued' state
      const result = await wal.markCompleted('account:a-1', 'msg-1');
      expect(result).toBe(false);
    });

    it('should transition dispatched → failed with error details', async () => {
      const msg = createMessage();
      await wal.write('account:a-1', msg);
      await wal.markDispatched('account:a-1', 'msg-1', 0);

      const result = await wal.markFailed(
        'account:a-1',
        'msg-1',
        'Handler threw an error',
        'Error: Handler threw an error\n    at ...',
      );
      expect(result).toBe(true);

      const entryKey = wal.walEntryKey('account:a-1', 'msg-1');
      expect(redis._store[entryKey].state).toBe('failed');
      expect(redis._store[entryKey].error).toBe('Handler threw an error');
      expect(redis._store[entryKey].error_stack).toContain('Error:');
    });

    it('should transition dispatched → interrupted', async () => {
      const msg = createMessage();
      await wal.write('account:a-1', msg);
      await wal.markDispatched('account:a-1', 'msg-1', 0);

      const result = await wal.markInterrupted(
        'account:a-1',
        'msg-1',
        'interrupted: process crashed during execution',
      );
      expect(result).toBe(true);

      const entryKey = wal.walEntryKey('account:a-1', 'msg-1');
      expect(redis._store[entryKey].state).toBe('interrupted');
    });
  });

  describe('getEntry', () => {
    it('should return null for non-existent entry', async () => {
      const entry = await wal.getEntry('account:a-1', 'msg-nonexistent');
      expect(entry).toBeNull();
    });

    it('should return a parsed WAL entry', async () => {
      const msg = createMessage({ correlationId: 'corr-1' });
      await wal.write('account:a-1', msg);

      const entry = await wal.getEntry('account:a-1', 'msg-1');
      expect(entry).not.toBeNull();
      expect(entry!.state).toBe('enqueued');
      expect(entry!.messageId).toBe('msg-1');
      expect(entry!.entityKey).toBe('account:a-1');
      expect(entry!.correlationId).toBe('corr-1');
      expect(entry!.message.name).toBe('TestCommand');
    });
  });

  describe('recovery', () => {
    it('should re-enqueue pending (enqueued) messages', async () => {
      const msg = createMessage({ id: 'pending-1' });
      await wal.write('account:a-1', msg);

      const result = await wal.recover();
      expect(result.reEnqueued).toBe(1);
      expect(result.interrupted).toBe(0);
    });

    it('should dead-letter interrupted (dispatched) messages by default', async () => {
      const msg = createMessage({ id: 'inflight-1' });
      await wal.write('account:a-1', msg);
      await wal.markDispatched('account:a-1', 'inflight-1', 0);

      const result = await wal.recover();
      expect(result.interrupted).toBe(1);
      expect(redis._lists['test:dead:account']).toHaveLength(1);

      const deadLettered = JSON.parse(redis._lists['test:dead:account'][0]);
      expect(deadLettered.deadLetterReason).toContain('interrupted');
    });

    it('should retry interrupted messages when policy is retry', async () => {
      const msg = createMessage({ id: 'inflight-2', attempts: 0, maxAttempts: 3 });
      await wal.write('account:a-1', msg);
      await wal.markDispatched('account:a-1', 'inflight-2', 0);

      const result = await wal.recover({ account: 'retry' });
      expect(result.reEnqueued).toBe(1);
      expect(result.interrupted).toBe(0);
    });

    it('should dead-letter when retry exceeds max attempts', async () => {
      const msg = createMessage({ id: 'inflight-3', attempts: 2, maxAttempts: 3 });
      await wal.write('account:a-1', msg);
      await wal.markDispatched('account:a-1', 'inflight-3', 0);

      const result = await wal.recover({ account: 'retry' });
      expect(result.interrupted).toBe(1);
      expect(redis._lists['test:dead:account']).toHaveLength(1);
    });

    it('should clean stale completed entries', async () => {
      const msg = createMessage({ id: 'old-1' });
      await wal.write('account:a-1', msg);
      await wal.markDispatched('account:a-1', 'old-1', 0);
      // Manually set state to completed (simulating missed cleanup)
      const entryKey = wal.walEntryKey('account:a-1', 'old-1');
      redis._store[entryKey].state = 'completed';

      const result = await wal.recover();
      expect(result.cleaned).toBe(1);
    });
  });

  describe('dead letter', () => {
    it('should push to dead letter list', async () => {
      const msg = createMessage();
      await wal.deadLetter('account', msg, 'test reason');

      expect(redis._lists['test:dead:account']).toHaveLength(1);
      const dead = JSON.parse(redis._lists['test:dead:account'][0]);
      expect(dead.deadLetterReason).toBe('test reason');
      expect(dead.deadLetteredAt).toBeDefined();
    });

    it('should retrieve dead letters', async () => {
      const msg = createMessage();
      await wal.deadLetter('account', msg, 'reason');

      const letters = await wal.getDeadLetters('account');
      expect(letters).toHaveLength(1);
      expect(letters[0].id).toBe('msg-1');
    });
  });
});
