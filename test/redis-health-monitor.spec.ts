import 'reflect-metadata';
import { RedisHealthMonitor } from '../src/cluster/redis-health-monitor.service';

function createMockRedis(pingFn?: () => Promise<string>) {
  return {
    ping: jest.fn(pingFn ?? (async () => 'PONG')),
  };
}

function createMonitor(
  redis: ReturnType<typeof createMockRedis>,
  overrides?: { checkMs?: number; threshold?: number },
): RedisHealthMonitor {
  return new RedisHealthMonitor(redis as any, {
    redis: { host: 'localhost' },
    grpc: {
      enabled: true,
      redisHealthCheckMs: overrides?.checkMs ?? 50,
      redisHealthFailureThreshold: overrides?.threshold ?? 3,
    },
  });
}

describe('RedisHealthMonitor', () => {
  let monitor: RedisHealthMonitor;

  afterEach(async () => {
    await monitor.onApplicationShutdown();
  });

  it('should start healthy', async () => {
    const redis = createMockRedis();
    monitor = createMonitor(redis);
    await monitor.onModuleInit();

    expect(monitor.isDegraded).toBe(false);
  });

  it('should stay healthy while PING succeeds', async () => {
    const redis = createMockRedis();
    monitor = createMonitor(redis, { checkMs: 20 });
    await monitor.onModuleInit();

    await new Promise((r) => setTimeout(r, 80));

    expect(monitor.isDegraded).toBe(false);
    expect(redis.ping).toHaveBeenCalled();
  });

  it('should enter degraded mode after consecutive failures', async () => {
    const redis = createMockRedis(async () => {
      throw new Error('ECONNREFUSED');
    });
    monitor = createMonitor(redis, { checkMs: 20, threshold: 3 });
    await monitor.onModuleInit();

    await new Promise((r) => setTimeout(r, 120));

    expect(monitor.isDegraded).toBe(true);
  });

  it('should notify listeners when entering degraded mode', async () => {
    const listener = jest.fn();
    const redis = createMockRedis(async () => {
      throw new Error('ECONNREFUSED');
    });
    monitor = createMonitor(redis, { checkMs: 20, threshold: 2 });
    monitor.onHealthChange(listener);
    await monitor.onModuleInit();

    await new Promise((r) => setTimeout(r, 100));

    expect(listener).toHaveBeenCalledWith(false);
  });

  it('should recover and notify listeners when PING succeeds again', async () => {
    let shouldFail = true;
    const redis = createMockRedis(async () => {
      if (shouldFail) throw new Error('ECONNREFUSED');
      return 'PONG';
    });
    monitor = createMonitor(redis, { checkMs: 20, threshold: 2 });

    const transitions: boolean[] = [];
    monitor.onHealthChange((healthy) => transitions.push(healthy));
    await monitor.onModuleInit();

    // Wait for degraded
    await new Promise((r) => setTimeout(r, 100));
    expect(monitor.isDegraded).toBe(true);
    expect(transitions).toContain(false);

    // Allow recovery
    shouldFail = false;
    await new Promise((r) => setTimeout(r, 60));
    expect(monitor.isDegraded).toBe(false);
    expect(transitions).toContain(true);
  });

  it('should unsubscribe listeners', async () => {
    const listener = jest.fn();
    const redis = createMockRedis(async () => {
      throw new Error('ECONNREFUSED');
    });
    monitor = createMonitor(redis, { checkMs: 20, threshold: 2 });
    const unsub = monitor.onHealthChange(listener);
    unsub();
    await monitor.onModuleInit();

    await new Promise((r) => setTimeout(r, 100));

    expect(listener).not.toHaveBeenCalled();
  });

  it('should not activate when grpc is disabled', async () => {
    const redis = createMockRedis();
    monitor = new RedisHealthMonitor(redis as any, {
      redis: { host: 'localhost' },
    });
    await monitor.onModuleInit();

    await new Promise((r) => setTimeout(r, 50));

    expect(redis.ping).not.toHaveBeenCalled();
    expect(monitor.isDegraded).toBe(false);
  });

  it('should clean up timer on shutdown', async () => {
    const redis = createMockRedis();
    monitor = createMonitor(redis, { checkMs: 20 });
    await monitor.onModuleInit();
    await monitor.onApplicationShutdown();

    const callCount = redis.ping.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));

    expect(redis.ping.mock.calls.length).toBe(callCount);
  });
});
