import 'reflect-metadata';
import { ClusterDiscoveryService, ClusterNode } from '../src/cluster/cluster-discovery.service';
import { GrpcPeerMonitor, PeerLivenessState } from '../src/cluster/grpc-peer-monitor.service';
import { RedisHealthMonitor } from '../src/cluster/redis-health-monitor.service';

function createMockRedis() {
  const store: Record<string, Record<string, string>> = {};

  return {
    hset: jest.fn(async (key: string, data: Record<string, string>) => {
      store[key] = { ...store[key], ...data };
      return Object.keys(data).length;
    }),
    hgetall: jest.fn(async (key: string) => store[key] ?? {}),
    pexpire: jest.fn(async () => 1),
    del: jest.fn(async (...keys: string[]) => {
      for (const key of keys) delete store[key];
      return keys.length;
    }),
    set: jest.fn(async () => 'OK'),
    get: jest.fn(async () => null),
    incr: jest.fn(async () => 1),
    sadd: jest.fn(async () => 1),
    srem: jest.fn(async () => 1),
    smembers: jest.fn(async () => []),
    publish: jest.fn(async () => 1),
    scan: jest.fn(async () => ['0', [] as string[]]),
    eval: jest.fn(async () => '0'),
    pipeline: jest.fn(() => ({
      eval: jest.fn().mockReturnThis(),
      pexpire: jest.fn().mockReturnThis(),
      srem: jest.fn().mockReturnThis(),
      exec: jest.fn(async () => []),
    })),
    duplicate: jest.fn(() => ({
      subscribe: jest.fn(async () => {}),
      on: jest.fn(),
      unsubscribe: jest.fn(async () => {}),
      quit: jest.fn(async () => {}),
    })),
    _store: store,
  };
}

function createMockPeerMonitor(states: Record<string, PeerLivenessState> = {}) {
  const listeners: Array<(serverId: string, state: PeerLivenessState) => void> = [];
  return {
    getPeerState: jest.fn((serverId: string) => states[serverId] ?? 'unknown'),
    onPeerStateChange: jest.fn((listener: (serverId: string, state: PeerLivenessState) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    syncPeers: jest.fn(),
    watchPeer: jest.fn(),
    unwatchPeer: jest.fn(),
    _listeners: listeners,
    _emit(serverId: string, state: PeerLivenessState) {
      for (const l of listeners) l(serverId, state);
    },
  } as unknown as GrpcPeerMonitor & {
    _listeners: typeof listeners;
    _emit: (s: string, st: PeerLivenessState) => void;
  };
}

function createMockRedisHealthMonitor(initialHealthy = true) {
  const listeners: Array<(healthy: boolean) => void> = [];
  return {
    get isDegraded() {
      return !initialHealthy;
    },
    onHealthChange: jest.fn((listener: (healthy: boolean) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    _listeners: listeners,
    _emit(healthy: boolean) {
      for (const l of listeners) l(healthy);
    },
  } as unknown as RedisHealthMonitor & {
    _listeners: typeof listeners;
    _emit: (h: boolean) => void;
  };
}

function createService(
  redis: ReturnType<typeof createMockRedis>,
  peerMonitor?: ReturnType<typeof createMockPeerMonitor>,
  redisHealthMonitor?: ReturnType<typeof createMockRedisHealthMonitor>,
): ClusterDiscoveryService {
  return new ClusterDiscoveryService(
    redis as any,
    {
      redis: { host: 'localhost' },
      grpc: {
        enabled: true,
        serverId: 'server-1',
        serviceGroup: 'default',
        advertisedAddress: '127.0.0.1:50051',
        heartbeatMs: 400,
        reconcileIntervalMs: 400,
        nodeTTLMs: 1500,
      },
      entities: { counter: {} },
    },
    peerMonitor as any,
    redisHealthMonitor as any,
  );
}

describe('ClusterDiscoveryService — hybrid liveness', () => {
  describe('isClusterHealthy', () => {
    it('should be healthy initially', () => {
      const redis = createMockRedis();
      const service = createService(redis);
      expect(service.isClusterHealthy()).toBe(true);
    });
  });

  describe('peer monitor integration', () => {
    it('should subscribe to peer state changes on init', async () => {
      const redis = createMockRedis();
      const peerMonitor = createMockPeerMonitor();
      const service = createService(redis, peerMonitor);

      await service.onModuleInit();

      expect(peerMonitor.onPeerStateChange).toHaveBeenCalled();

      await service.onApplicationShutdown();
    });

    it('should sync peers during reconcile', async () => {
      const redis = createMockRedis();
      const peerMonitor = createMockPeerMonitor();

      // Pre-populate a peer node in Redis — return server-2 only for reconcile scans, not stale cleanup
      // smembers returns the index for getNodes()
      (redis.smembers as jest.Mock).mockResolvedValue(['server-2']);
      redis.hgetall.mockImplementation(async (key: string): Promise<Record<string, string>> => {
        if (key === 'aq:cluster:nodes:server-2') {
          return {
            server_id: 'server-2',
            grpc_address: '127.0.0.1:50052',
            service_group: 'default',
            entity_types: 'counter',
            ring_version: '1',
            started_at: Date.now().toString(),
            heartbeat_at: Date.now().toString(),
          };
        }
        return {};
      });

      const service = createService(redis, peerMonitor);
      await service.onModuleInit();

      // Give reconcile a tick to run
      await new Promise((r) => setTimeout(r, 500));

      expect(peerMonitor.syncPeers).toHaveBeenCalled();
      const calls = (peerMonitor.syncPeers as jest.Mock).mock.calls;
      const lastCall = calls[calls.length - 1];
      if (lastCall) {
        const peers = lastCall[0] as Array<{ serverId: string }>;
        const peerIds = peers.map((p: { serverId: string }) => p.serverId);
        expect(peerIds).toContain('server-2');
        // Should not include self
        expect(peerIds).not.toContain('server-1');
      }

      await service.onApplicationShutdown();
    });
  });

  describe('Redis health step-down', () => {
    it('should notify with empty node list when Redis is lost', async () => {
      const redis = createMockRedis();
      const redisHealthMonitor = createMockRedisHealthMonitor();
      const service = createService(redis, undefined, redisHealthMonitor);

      const ringChanges: ClusterNode[][] = [];
      service.onRingChange((nodes) => ringChanges.push(nodes));

      await service.onModuleInit();

      // Simulate Redis going down
      redisHealthMonitor._emit(false);

      expect(service.isClusterHealthy()).toBe(false);
      expect(ringChanges.length).toBeGreaterThan(0);
      expect(ringChanges[ringChanges.length - 1]).toEqual([]);

      await service.onApplicationShutdown();
    });

    it('should re-register when Redis recovers', async () => {
      const redis = createMockRedis();
      const redisHealthMonitor = createMockRedisHealthMonitor();
      const service = createService(redis, undefined, redisHealthMonitor);

      await service.onModuleInit();

      // Simulate Redis going down then recovering
      redisHealthMonitor._emit(false);
      expect(service.isClusterHealthy()).toBe(false);

      redisHealthMonitor._emit(true);
      expect(service.isClusterHealthy()).toBe(true);

      // Should have called hset again (re-registration)
      const hsetCalls = redis.hset.mock.calls;
      const registrationCalls = hsetCalls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' && (call[0] as string).includes('cluster:nodes:server-1'),
      );
      expect(registrationCalls.length).toBeGreaterThanOrEqual(2);

      await service.onApplicationShutdown();
    });

    it('should skip reconcile when Redis is unavailable', async () => {
      const redis = createMockRedis();
      const redisHealthMonitor = createMockRedisHealthMonitor();
      const service = createService(redis, undefined, redisHealthMonitor);

      await service.onModuleInit();

      // Simulate Redis going down
      redisHealthMonitor._emit(false);

      // Reset scan call count
      redis.scan.mockClear();

      // Wait for potential reconcile cycle
      await new Promise((r) => setTimeout(r, 500));

      // scan should not have been called during degraded state
      expect(redis.scan).not.toHaveBeenCalled();

      await service.onApplicationShutdown();
    });
  });

  describe('cleanup', () => {
    it('should unsubscribe from peer monitor on shutdown', async () => {
      const redis = createMockRedis();
      const peerMonitor = createMockPeerMonitor();
      const service = createService(redis, peerMonitor);

      await service.onModuleInit();
      await service.onApplicationShutdown();

      // The unsubscribe function should have been called
      // Verify by checking no listeners remain
      expect(peerMonitor._listeners).toHaveLength(0);
    });

    it('should unsubscribe from redis health monitor on shutdown', async () => {
      const redis = createMockRedis();
      const redisHealthMonitor = createMockRedisHealthMonitor();
      const service = createService(redis, undefined, redisHealthMonitor);

      await service.onModuleInit();
      await service.onApplicationShutdown();

      expect(redisHealthMonitor._listeners).toHaveLength(0);
    });
  });
});
