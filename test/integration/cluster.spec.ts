/**
 * V3 Cluster Integration Tests
 *
 * Self-contained Jest tests that spin up multiple AtomicQueuesModule instances
 * in the same process, each with a different gRPC port and serverId.
 * All share the same Redis instance and keyPrefix.
 *
 * Covers:
 *   1. Multi-replica single service — 100 concurrent enqueues, load-balanced
 *   2. Cross-service forwarding — two service groups, gRPC Forward RPC
 *   3. Master failover — kill master, re-elect, verify continued processing
 *
 * Requirements:
 *   - Redis running on REDIS_URL (default redis://localhost:6379)
 *   - No Docker, no k8s, no candy-shop
 *
 * Run: npm run test:integration
 */

import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Module, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler, QueryHandler, IQueryHandler, CqrsModule } from '@nestjs/cqrs';
import Redis from 'ioredis';

import {
  AtomicQueuesModule,
  QueueBus,
  EntityType,
  LeaderElectionService,
  MasterCoordinator,
} from '../../src';

// ─── Config ──────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const KEY_PREFIX = 'cluster-integ-test';
const BASE_GRPC_PORT = 50200; // use high ports to avoid conflicts

// ─── Test commands / queries ─────────────────────────────────────────────────

/** Simple counter command — tracks total calls per entityId in shared state. */
@EntityType('counter')
class IncrementCommand {
  constructor(
    public readonly counterId: string,
    public readonly amount: number,
  ) {}
}

/** Query to read the counter. */
@EntityType('counter')
class GetCounterQuery {
  constructor(public readonly counterId: string) {}
}

/** Cross-service command handled by a different service group. */
@EntityType('remote')
class RemoteWorkCommand {
  constructor(
    public readonly itemId: string,
    public readonly payload: string,
  ) {}
}

// ─── Shared state (in-memory, visible to all handlers in-process) ────────────

const counters = new Map<string, number>();
const remoteWork = new Map<string, string[]>();
const handlerLog: Array<{ command: string; entityId: string; handler: string }> = [];

function resetSharedState(): void {
  counters.clear();
  remoteWork.clear();
  handlerLog.length = 0;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

@Injectable()
@CommandHandler(IncrementCommand)
class IncrementHandler implements ICommandHandler<IncrementCommand, void> {
  async execute(cmd: IncrementCommand): Promise<void> {
    const current = counters.get(cmd.counterId) ?? 0;
    counters.set(cmd.counterId, current + cmd.amount);
    handlerLog.push({ command: 'Increment', entityId: cmd.counterId, handler: 'IncrementHandler' });
  }
}

@Injectable()
@QueryHandler(GetCounterQuery)
class GetCounterHandler implements IQueryHandler<GetCounterQuery> {
  async execute(query: GetCounterQuery): Promise<{ counterId: string; value: number }> {
    return { counterId: query.counterId, value: counters.get(query.counterId) ?? 0 };
  }
}

@Injectable()
@CommandHandler(RemoteWorkCommand)
class RemoteWorkHandler implements ICommandHandler<RemoteWorkCommand, void> {
  async execute(cmd: RemoteWorkCommand): Promise<void> {
    const list = remoteWork.get(cmd.itemId) ?? [];
    list.push(cmd.payload);
    remoteWork.set(cmd.itemId, list);
    handlerLog.push({ command: 'RemoteWork', entityId: cmd.itemId, handler: 'RemoteWorkHandler' });
  }
}

// ─── NestJS test modules ─────────────────────────────────────────────────────

@Module({
  imports: [CqrsModule],
  providers: [IncrementHandler, GetCounterHandler],
})
class CounterHandlerModule {}

@Module({
  imports: [CqrsModule],
  providers: [RemoteWorkHandler],
})
class RemoteHandlerModule {}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function cleanRedis(redis: Redis): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
}

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  pollMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface ClusterNode {
  app: INestApplication;
  module: TestingModule;
  queueBus: QueueBus;
  leaderElection: LeaderElectionService;
  masterCoordinator: MasterCoordinator;
  serverId: string;
  grpcPort: number;
}

async function createNode(opts: {
  serverId: string;
  grpcPort: number;
  serviceGroup: string;
  entities: Record<string, { defaultEntityId?: string; retry?: { maxAttempts: number } }>;
  handlerModules: any[];
}): Promise<ClusterNode> {
  const mod = await Test.createTestingModule({
    imports: [
      AtomicQueuesModule.forRoot({
        redis: { url: REDIS_URL },
        keyPrefix: KEY_PREFIX,
        entities: opts.entities,
        grpc: {
          enabled: true,
          listenAddress: `0.0.0.0:${opts.grpcPort}`,
          advertisedAddress: `127.0.0.1:${opts.grpcPort}`,
          serverId: opts.serverId,
          serviceGroup: opts.serviceGroup,
        },
      }),
      ...opts.handlerModules,
    ],
  }).compile();

  const app = mod.createNestApplication();
  Logger.overrideLogger(['error', 'warn']); // quiet during tests
  await app.init();

  return {
    app,
    module: mod,
    queueBus: mod.get(QueueBus),
    leaderElection: mod.get(LeaderElectionService),
    masterCoordinator: mod.get(MasterCoordinator),
    serverId: opts.serverId,
    grpcPort: opts.grpcPort,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 1: Multi-replica single service
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 1: Multi-replica single service — 100 concurrent enqueues', () => {
  let redis: Redis;
  const nodes: ClusterNode[] = [];

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await cleanRedis(redis);
    resetSharedState();

    // Spin up 3 replicas in the same service group
    for (let i = 0; i < 3; i++) {
      const node = await createNode({
        serverId: `counter-node-${i}`,
        grpcPort: BASE_GRPC_PORT + i,
        serviceGroup: 'counter-service',
        entities: { counter: { defaultEntityId: 'counterId', retry: { maxAttempts: 2 } } },
        handlerModules: [CounterHandlerModule],
      });
      nodes.push(node);
    }

    // Wait for leader election to settle
    await waitFor(() => nodes.some((n) => n.leaderElection.getIsLeader()));
  }, 30000);

  afterAll(async () => {
    for (const n of nodes) await n.app.close().catch(() => {});
    await cleanRedis(redis);
    await redis.quit();
  }, 15000);

  it('should elect exactly one master', () => {
    const masters = nodes.filter((n) => n.leaderElection.getIsLeader());
    expect(masters.length).toBe(1);
    console.log(`  Master: ${masters[0].serverId}`);
  });

  it('should process 100 concurrent enqueues across 4 entity IDs without races', async () => {
    const TOTAL = 100;
    const ENTITY_IDS = ['cnt-A', 'cnt-B', 'cnt-C', 'cnt-D'];

    // Fire 100 concurrent enqueues, round-robin across entities and nodes
    const promises: Promise<any>[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const entityId = ENTITY_IDS[i % ENTITY_IDS.length];
      const node = nodes[i % nodes.length];
      promises.push(
        node.queueBus.enqueue(new IncrementCommand(entityId, 1)),
      );
    }

    await Promise.all(promises);

    // Wait for all workers to finish processing
    await waitFor(() => {
      const total = Array.from(counters.values()).reduce((a, b) => a + b, 0);
      return total >= TOTAL;
    }, 15000);

    // Verify totals
    const totalCount = Array.from(counters.values()).reduce((a, b) => a + b, 0);
    expect(totalCount).toBe(TOTAL);

    // Verify per-entity counts (round-robin: 100/4 = 25 each)
    for (const eid of ENTITY_IDS) {
      expect(counters.get(eid)).toBe(TOTAL / ENTITY_IDS.length);
    }

    console.log(`  Total increments: ${totalCount}`);
    console.log(`  Per entity: ${ENTITY_IDS.map((e) => `${e}=${counters.get(e)}`).join(', ')}`);
    console.log(`  Handler invocations logged: ${handlerLog.length}`);
  }, 30000);

  it('should have load-balanced workers across replicas', () => {
    const master = nodes.find((n) => n.leaderElection.getIsLeader())!;
    const assignments = master.masterCoordinator.getAssignments();
    const replicaLoad = master.masterCoordinator.getReplicaLoad();

    console.log(`  Workers assigned: ${assignments.size}`);
    for (const [replicaId, load] of replicaLoad) {
      console.log(`    ${replicaId}: ${load} workers`);
    }

    // All 4 entity workers should be assigned
    expect(assignments.size).toBe(4);
    // Load should be spread (not all on one replica)
    expect(replicaLoad.size).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 2: Cross-service forwarding
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 2: Cross-service forwarding — gRPC Forward RPC', () => {
  let redis: Redis;
  const svcA: ClusterNode[] = []; // owns 'counter' entity
  const svcB: ClusterNode[] = []; // owns 'remote' entity

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await cleanRedis(redis);
    resetSharedState();

    // Service A: 2 replicas, owns 'counter'
    for (let i = 0; i < 2; i++) {
      const node = await createNode({
        serverId: `svc-a-node-${i}`,
        grpcPort: BASE_GRPC_PORT + 10 + i,
        serviceGroup: 'svc-alpha',
        entities: { counter: { defaultEntityId: 'counterId', retry: { maxAttempts: 2 } } },
        handlerModules: [CounterHandlerModule],
      });
      svcA.push(node);
    }

    // Service B: 2 replicas, owns 'remote'
    for (let i = 0; i < 2; i++) {
      const node = await createNode({
        serverId: `svc-b-node-${i}`,
        grpcPort: BASE_GRPC_PORT + 20 + i,
        serviceGroup: 'svc-beta',
        entities: { remote: { defaultEntityId: 'itemId', retry: { maxAttempts: 2 } } },
        handlerModules: [RemoteHandlerModule],
      });
      svcB.push(node);
    }

    // Wait for both service groups to elect masters
    await waitFor(() =>
      svcA.some((n) => n.leaderElection.getIsLeader()) &&
      svcB.some((n) => n.leaderElection.getIsLeader()),
    );

    // Give entity registry time to propagate (heartbeat=400ms)
    await new Promise((r) => setTimeout(r, 600));
  }, 30000);

  afterAll(async () => {
    for (const n of [...svcA, ...svcB]) await n.app.close().catch(() => {});
    await cleanRedis(redis);
    await redis.quit();
  }, 15000);

  it('should elect one master per service group', () => {
    const mastersA = svcA.filter((n) => n.leaderElection.getIsLeader());
    const mastersB = svcB.filter((n) => n.leaderElection.getIsLeader());
    expect(mastersA.length).toBe(1);
    expect(mastersB.length).toBe(1);
    console.log(`  svc-alpha master: ${mastersA[0].serverId}`);
    console.log(`  svc-beta master:  ${mastersB[0].serverId}`);
  });

  it('should forward messages from Service A to Service B via gRPC Forward', async () => {
    const TOTAL = 30;
    const ITEMS = ['item-X', 'item-Y', 'item-Z'];

    // Enqueue 'remote' entity messages from Service A's QueueBus
    // These should be detected as foreign, forwarded to svc-beta master via gRPC
    const promises: Promise<any>[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const itemId = ITEMS[i % ITEMS.length];
      const node = svcA[i % svcA.length];
      promises.push(
        node.queueBus.enqueueRaw('remote', 'RemoteWorkCommand', itemId, {
          itemId,
          payload: `work-${i}`,
        }),
      );
    }

    await Promise.all(promises);

    // Wait for remote handlers to process
    await waitFor(() => {
      const total = Array.from(remoteWork.values()).reduce((a, b) => a + b.length, 0);
      return total >= TOTAL;
    });

    const totalProcessed = Array.from(remoteWork.values()).reduce((a, b) => a + b.length, 0);
    expect(totalProcessed).toBe(TOTAL);

    // Verify per-item counts (30/3 = 10 each)
    for (const itemId of ITEMS) {
      expect(remoteWork.get(itemId)?.length).toBe(TOTAL / ITEMS.length);
    }

    // Verify handlers ran (proves execution happened in svc-beta, not svc-alpha)
    const remoteInvocations = handlerLog.filter((l) => l.command === 'RemoteWork');
    expect(remoteInvocations.length).toBe(TOTAL);

    console.log(`  Cross-service messages forwarded and processed: ${totalProcessed}`);
    console.log(`  Per item: ${ITEMS.map((e) => `${e}=${remoteWork.get(e)?.length}`).join(', ')}`);
  }, 30000);

  it('should handle bidirectional cross-service', async () => {
    // Also test: Service B enqueues to 'counter' entity (owned by Service A)
    resetSharedState();

    const TOTAL = 20;
    const promises: Promise<any>[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const node = svcB[i % svcB.length];
      promises.push(
        node.queueBus.enqueueRaw('counter', 'IncrementCommand', 'bi-dir', {
          counterId: 'bi-dir',
          amount: 1,
        }),
      );
    }

    await Promise.all(promises);

    await waitFor(() => (counters.get('bi-dir') ?? 0) >= TOTAL);

    expect(counters.get('bi-dir')).toBe(TOTAL);
    console.log(`  Bidirectional cross-service: ${counters.get('bi-dir')} increments from svc-beta to svc-alpha`);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE 3: Master failover
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario 3: Master failover — kill master, re-elect, continue processing', () => {
  let redis: Redis;
  const nodes: ClusterNode[] = [];

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await cleanRedis(redis);
    resetSharedState();

    // 3 replicas
    for (let i = 0; i < 3; i++) {
      const node = await createNode({
        serverId: `failover-node-${i}`,
        grpcPort: BASE_GRPC_PORT + 30 + i,
        serviceGroup: 'failover-service',
        entities: { counter: { defaultEntityId: 'counterId', retry: { maxAttempts: 2 } } },
        handlerModules: [CounterHandlerModule],
      });
      nodes.push(node);
    }

    // Wait for leader election
    await waitFor(() => nodes.some((n) => n.leaderElection.getIsLeader()));
  }, 30000);

  afterAll(async () => {
    for (const n of nodes) await n.app.close().catch(() => {});
    await cleanRedis(redis);
    await redis.quit();
  }, 15000);

  it('should process orders, survive master kill, and continue after re-election', async () => {
    // Phase 1: Fire 30 messages through the current master
    const PHASE1 = 30;
    const promises1: Promise<any>[] = [];
    for (let i = 0; i < PHASE1; i++) {
      const node = nodes[i % nodes.length];
      promises1.push(node.queueBus.enqueue(new IncrementCommand('failover-cnt', 1)));
    }
    await Promise.all(promises1);

    await waitFor(() => (counters.get('failover-cnt') ?? 0) >= PHASE1);
    expect(counters.get('failover-cnt')).toBe(PHASE1);
    console.log(`  Phase 1: ${counters.get('failover-cnt')} increments processed`);

    // Identify and kill the master
    const masterIdx = nodes.findIndex((n) => n.leaderElection.getIsLeader());
    expect(masterIdx).toBeGreaterThanOrEqual(0);
    const killedNode = nodes[masterIdx];
    console.log(`  Killing master: ${killedNode.serverId}`);

    await killedNode.app.close();

    // Wait for a new master (lock TTL=2s, poll=400ms → worst case ~3s)
    const survivors = nodes.filter((_, i) => i !== masterIdx);
    await waitFor(
      () => survivors.some((n) => n.leaderElection.getIsLeader()),
      5000,
      200,
    );

    const newMaster = survivors.find((n) => n.leaderElection.getIsLeader())!;
    expect(newMaster).toBeDefined();
    console.log(`  New master elected: ${newMaster.serverId}`);

    // Phase 2: Fire 20 more messages through surviving nodes only
    const PHASE2 = 20;
    const promises2: Promise<any>[] = [];
    for (let i = 0; i < PHASE2; i++) {
      const node = survivors[i % survivors.length];
      promises2.push(node.queueBus.enqueue(new IncrementCommand('failover-cnt', 1)));
    }
    await Promise.all(promises2);

    await waitFor(
      () => (counters.get('failover-cnt') ?? 0) >= PHASE1 + PHASE2,
    );

    expect(counters.get('failover-cnt')).toBe(PHASE1 + PHASE2);
    console.log(`  Phase 2: ${counters.get('failover-cnt')} total increments (${PHASE1} + ${PHASE2})`);
    console.log(`  No lost messages after failover`);
  }, 60000);
});
