import 'reflect-metadata';
import { LogService } from '../src/services/log/log.service';
import { ISerializedMessage } from '../src/domain';

function createMockRedis() {
  const store: Record<string, string[]> = {};
  const sets: Record<string, Set<string>> = {};

  return {
    pipeline: () => {
      const ops: Array<() => [null, any]> = [];
      return {
        lpush: (key: string, value: string) => {
          ops.push(() => {
            if (!store[key]) store[key] = [];
            store[key].unshift(value);
            return [null, store[key].length];
          });
        },
        sadd: (key: string, member: string) => {
          ops.push(() => {
            if (!sets[key]) sets[key] = new Set();
            sets[key].add(member);
            return [null, 1];
          });
        },
        exec: async () => ops.map((op) => op()),
      };
    },
    rpop: async (key: string) => {
      if (!store[key] || store[key].length === 0) return null;
      return store[key].pop()!;
    },
    lpush: async (key: string, value: string) => {
      if (!store[key]) store[key] = [];
      store[key].unshift(value);
      return store[key].length;
    },
    llen: async (key: string) => store[key]?.length ?? 0,
    lrange: async (key: string, start: number, end: number) => {
      if (!store[key]) return [];
      return store[key].slice(start, end + 1);
    },
    sadd: async (key: string, member: string) => {
      if (!sets[key]) sets[key] = new Set();
      sets[key].add(member);
      return 1;
    },
    srem: async (key: string, member: string) => {
      if (!sets[key]) return 0;
      sets[key].delete(member);
      return 1;
    },
    scard: async (key: string) => sets[key]?.size ?? 0,
    _store: store,
    _sets: sets,
  };
}

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

describe('LogService', () => {
  let logService: LogService;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    logService = new LogService(mockRedis as any, { redis: {}, keyPrefix: 'test' } as any);
  });

  it('should generate correct Redis keys', () => {
    expect(logService.getLogKey('account:a-1')).toBe('test:log:account:a-1');
    expect(logService.getReadySetKey()).toBe('test:ready');
    expect(logService.getDeadLetterKey('account')).toBe('test:dead:account');
  });

  it('should append a message and mark entity ready', async () => {
    const msg = createMessage();
    const depth = await logService.append('account:a-1', msg);

    expect(depth).toBe(1);
    expect(mockRedis._sets['test:ready']?.has('account:a-1')).toBe(true);
  });

  it('should pop messages in FIFO order', async () => {
    const msg1 = createMessage({ id: 'msg-1', name: 'First' });
    const msg2 = createMessage({ id: 'msg-2', name: 'Second' });

    await logService.append('account:a-1', msg1);
    await logService.append('account:a-1', msg2);

    const popped1 = await logService.popNext('account:a-1');
    expect(popped1!.name).toBe('First');

    const popped2 = await logService.popNext('account:a-1');
    expect(popped2!.name).toBe('Second');

    const popped3 = await logService.popNext('account:a-1');
    expect(popped3).toBeNull();
  });

  it('should report correct length', async () => {
    expect(await logService.length('account:a-1')).toBe(0);

    await logService.append('account:a-1', createMessage());
    expect(await logService.length('account:a-1')).toBe(1);

    await logService.append('account:a-1', createMessage({ id: 'msg-2' }));
    expect(await logService.length('account:a-1')).toBe(2);
  });

  it('should mark and unmark ready', async () => {
    await logService.markReady('account:a-1');
    expect(await logService.readyCount()).toBe(1);

    await logService.unmarkReady('account:a-1');
    expect(await logService.readyCount()).toBe(0);
  });

  it('should dead-letter a message', async () => {
    const msg = createMessage({ attempts: 3 });
    await logService.deadLetter('account', msg);

    const deadLetters = await logService.getDeadLetters('account');
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].id).toBe('msg-1');
    expect((deadLetters[0] as any).deadLetteredAt).toBeDefined();
  });
});
