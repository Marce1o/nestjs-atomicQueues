import 'reflect-metadata';
import { GateService } from '../src/services/gate/gate.service';

function createMockRedis() {
  const store: Record<string, { value: string; ttl: number }> = {};

  return {
    set: async (key: string, value: string, ...args: any[]) => {
      const hasNX = args.includes('NX');
      const exIndex = args.indexOf('EX');
      const ttl = exIndex >= 0 ? args[exIndex + 1] : undefined;

      if (hasNX && store[key]) return null;

      store[key] = { value, ttl: ttl ?? 0 };
      return 'OK';
    },
    del: async (key: string) => {
      if (store[key]) {
        delete store[key];
        return 1;
      }
      return 0;
    },
    expire: async (key: string, ttl: number) => {
      if (store[key]) {
        store[key].ttl = ttl;
        return 1;
      }
      return 0;
    },
    exists: async (key: string) => (store[key] ? 1 : 0),
    _store: store,
  };
}

describe('GateService', () => {
  let gateService: GateService;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    gateService = new GateService(
      mockRedis as any,
      { redis: {}, keyPrefix: 'test', executor: { gateTTL: 30 } } as any,
    );
  });

  it('should generate correct gate keys', () => {
    expect(gateService.getGateKey('account:a-1')).toBe('test:gate:account:a-1');
  });

  it('should acquire a gate (SET NX)', async () => {
    const acquired = await gateService.acquire('account:a-1', 'token-1');
    expect(acquired).toBe(true);
    expect(mockRedis._store['test:gate:account:a-1'].value).toBe('token-1');
  });

  it('should reject second acquire (NX semantics)', async () => {
    await gateService.acquire('account:a-1', 'token-1');
    const acquired = await gateService.acquire('account:a-1', 'token-2');
    expect(acquired).toBe(false);
    expect(mockRedis._store['test:gate:account:a-1'].value).toBe('token-1');
  });

  it('should release a gate', async () => {
    await gateService.acquire('account:a-1', 'token-1');
    await gateService.release('account:a-1');
    expect(mockRedis._store['test:gate:account:a-1']).toBeUndefined();
  });

  it('should allow re-acquire after release', async () => {
    await gateService.acquire('account:a-1', 'token-1');
    await gateService.release('account:a-1');
    const acquired = await gateService.acquire('account:a-1', 'token-2');
    expect(acquired).toBe(true);
    expect(mockRedis._store['test:gate:account:a-1'].value).toBe('token-2');
  });

  it('should extend the gate TTL', async () => {
    await gateService.acquire('account:a-1', 'token-1', 10);
    expect(mockRedis._store['test:gate:account:a-1'].ttl).toBe(10);

    const extended = await gateService.extend('account:a-1', 60);
    expect(extended).toBe(true);
    expect(mockRedis._store['test:gate:account:a-1'].ttl).toBe(60);
  });

  it('should return false when extending non-existent gate', async () => {
    const extended = await gateService.extend('account:a-1', 60);
    expect(extended).toBe(false);
  });

  it('should check if gate is held', async () => {
    expect(await gateService.isHeld('account:a-1')).toBe(false);
    await gateService.acquire('account:a-1', 'token-1');
    expect(await gateService.isHeld('account:a-1')).toBe(true);
  });

  it('should use entity-specific TTL from config', () => {
    const service = new GateService(
      mockRedis as any,
      {
        redis: {},
        keyPrefix: 'test',
        executor: { gateTTL: 30 },
        entities: { account: { gateTTL: 60 } },
      } as any,
    );
    expect(service.getTTLForEntity('account')).toBe(60);
    expect(service.getTTLForEntity('unknown')).toBe(30);
  });
});
