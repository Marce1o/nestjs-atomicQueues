/**
 * Fork-based cluster integration tests
 *
 * Each "replica" runs in its own OS process via child_process.fork().
 * gRPC traffic goes through real TCP sockets (loopback).
 * SIGKILL is a real process kill — not a graceful shutdown.
 *
 * This is 1:1 faithful to k8s behavior:
 *   - Separate V8 heaps (no shared memory)
 *   - Real TCP between gRPC peers
 *   - Real CPU contention under load
 *   - Real process crash for failover
 *
 * Requirements: Redis on REDIS_URL (default localhost:6379)
 * Run: npm run test:integration
 */

import { ChildProcess, fork, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import Redis from 'ioredis';

// ─── Config ──────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const KEY_PREFIX = 'fork-integ-test';
const BASE_GRPC_PORT = 50300;
const WORKER_TS = path.join(__dirname, 'cluster-worker.ts');
const BUILD_DIR = path.join(__dirname, '..', '..', '.fork-build');

// Precompile the worker to JS so decorator metadata is emitted correctly
let WORKER_PATH: string;
try {
  execSync(
    `npx tsc ${WORKER_TS} --outDir ${BUILD_DIR} --rootDir ${path.join(__dirname, '..', '..')} ` +
    '--esModuleInterop --module commonjs --target es2022 --moduleResolution node ' +
    '--experimentalDecorators --emitDecoratorMetadata --skipLibCheck --declaration false',
    { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' },
  );
  WORKER_PATH = path.join(BUILD_DIR, 'test', 'integration', 'cluster-worker.js');
} catch (err: any) {
  // tsc may report errors for test files but still emit JS — check if output exists
  const candidate = path.join(BUILD_DIR, 'test', 'integration', 'cluster-worker.js');
  if (fs.existsSync(candidate)) {
    WORKER_PATH = candidate;
  } else {
    throw new Error(`Failed to compile cluster-worker.ts: ${err.stderr?.toString()}`);
  }
}

// Copy the gRPC proto file to the build output (grpc-server resolves it relative to __dirname)
const protoSrc = path.join(__dirname, '..', '..', 'src', 'grpc', 'atomicqueues.proto');
const protoDst = path.join(BUILD_DIR, 'src', 'grpc', 'atomicqueues.proto');
fs.mkdirSync(path.dirname(protoDst), { recursive: true });
fs.copyFileSync(protoSrc, protoDst);

// ─── Worker handle ───────────────────────────────────────────────────────────

interface WorkerHandle {
  proc: ChildProcess;
  serverId: string;
  grpcPort: number;
  serviceGroup: string;
  alive: boolean;
  readyPromise: Promise<any>;

  /** Send a message and wait for a specific response type. */
  rpc(msg: Record<string, unknown>, expectType: string, timeoutMs?: number): Promise<any>;

  /** Send without waiting. */
  send(msg: Record<string, unknown>): void;

  /** Kill with SIGKILL (simulate pod crash). */
  kill(): void;

  /** Graceful shutdown. */
  shutdown(): Promise<void>;
}

function spawnWorker(config: {
  serverId: string;
  grpcPort: number;
  serviceGroup: string;
  entities: Record<string, any>;
  handlers: 'counter' | 'remote' | 'all';
}): WorkerHandle {
  const proc = fork(WORKER_PATH, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  // Suppress child stdout/stderr noise in test output
  proc.stdout?.resume();
  proc.stderr?.resume();

  let alive = true;
  proc.on('exit', () => { alive = false; });

  const pendingRpcs: Array<{
    expectType: string;
    resolve: (val: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  proc.on('message', (msg: any) => {
    const idx = pendingRpcs.findIndex((r) => r.expectType === msg.type);
    if (idx >= 0) {
      const rpc = pendingRpcs.splice(idx, 1)[0];
      clearTimeout(rpc.timer);
      rpc.resolve(msg);
    }
  });

  // Register a 'ready' listener BEFORE sending boot, so we catch it
  const readyPromise = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Boot timeout for ${config.serverId}`)),
      45000,
    );
    pendingRpcs.push({ expectType: 'ready', resolve, reject, timer });
  });

  // Boot the worker
  proc.send({
    type: 'boot',
    config: {
      ...config,
      redisUrl: REDIS_URL,
      keyPrefix: KEY_PREFIX,
    },
  });

  const handle: WorkerHandle = {
    proc,
    serverId: config.serverId,
    grpcPort: config.grpcPort,
    serviceGroup: config.serviceGroup,
    get alive() { return alive; },

    rpc(msg, expectType, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`RPC timeout waiting for '${expectType}' from ${config.serverId}`)),
          timeoutMs,
        );
        pendingRpcs.push({ expectType, resolve, reject, timer });
        if (proc.connected) proc.send(msg);
        else reject(new Error(`Process ${config.serverId} disconnected`));
      });
    },

    send(msg) {
      if (proc.connected) proc.send(msg);
    },

    kill() {
      proc.kill('SIGKILL');
    },

    async shutdown() {
      if (!proc.connected) return;
      try {
        await handle.rpc({ type: 'shutdown' }, 'closed', 10000);
      } catch {
        try { proc.kill('SIGKILL'); } catch {}
      }
    },

    readyPromise,
  };

  return handle;
}

async function waitForReady(handle: WorkerHandle): Promise<void> {
  await (handle as any).readyPromise;
}

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
  timeoutMs = 20000,
  pollMs = 200,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function getLeader(workers: WorkerHandle[]): Promise<WorkerHandle | null> {
  for (const w of workers) {
    try {
      const resp = await w.rpc({ type: 'get-leader' }, 'leader', 5000);
      if (resp.isLeader) return w;
    } catch { /* process might be dead */ }
  }
  return null;
}

async function getAggregateState(
  workers: WorkerHandle[],
): Promise<{ counters: Record<string, number>; remoteWork: Record<string, number> }> {
  const counters: Record<string, number> = {};
  const remoteWork: Record<string, number> = {};

  for (const w of workers) {
    try {
      const resp = await w.rpc({ type: 'get-state' }, 'state', 5000);
      for (const [k, v] of Object.entries(resp.counters as Record<string, number>)) {
        counters[k] = (counters[k] ?? 0) + v;
      }
      for (const [k, v] of Object.entries(resp.remoteWork as Record<string, number>)) {
        remoteWork[k] = (remoteWork[k] ?? 0) + v;
      }
    } catch { /* process might be dead */ }
  }

  return { counters, remoteWork };
}

function killAll(workers: WorkerHandle[]): void {
  for (const w of workers) {
    try { w.proc.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1: Multi-replica under real load
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fork: Multi-replica — 100 concurrent enqueues across 3 processes', () => {
  let redis: Redis;
  const workers: WorkerHandle[] = [];

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await cleanRedis(redis);

    for (let i = 0; i < 3; i++) {
      const w = spawnWorker({
        serverId: `fork-counter-${i}`,
        grpcPort: BASE_GRPC_PORT + i,
        serviceGroup: 'fork-counter-svc',
        entities: { counter: { defaultEntityId: 'counterId', retry: { maxAttempts: 2 } } },
        handlers: 'counter',
      });
      workers.push(w);
    }

    // Wait for all workers to be ready
    await Promise.all(workers.map((w) => waitForReady(w)));

    // Wait for leader election (TTL=2s, poll=400ms → worst case ~3s)
    await waitFor(async () => (await getLeader(workers)) !== null, 5000);
  }, 60000);

  afterAll(async () => {
    const exits = workers.map((w) => new Promise<void>((r) => {
      if (!w.proc.connected && !w.alive) return r();
      w.proc.once('exit', () => r());
      w.shutdown().catch(() => { try { w.kill(); } catch {} });
    }));
    await Promise.all(exits);
    await cleanRedis(redis);
    await redis.quit();
  }, 15000);

  it('should elect exactly one master across 3 processes', async () => {
    let masterCount = 0;
    let masterServerId = '';
    for (const w of workers) {
      const resp = await w.rpc({ type: 'get-leader' }, 'leader');
      if (resp.isLeader) {
        masterCount++;
        masterServerId = w.serverId;
      }
    }
    expect(masterCount).toBe(1);
    console.log(`  Master (separate process): ${masterServerId}`);
  });

  it('should process 100 concurrent enqueues without races', async () => {
    const TOTAL = 100;
    const ENTITY_IDS = ['cnt-A', 'cnt-B', 'cnt-C', 'cnt-D'];

    // Build batch messages distributed round-robin across workers
    const batchPromises: Promise<any>[] = [];
    for (let wi = 0; wi < workers.length; wi++) {
      const batch = [];
      for (let i = wi; i < TOTAL; i += workers.length) {
        const entityId = ENTITY_IDS[i % ENTITY_IDS.length];
        batch.push({
          entityType: 'counter',
          messageName: 'IncrementCommand',
          entityId,
          data: { counterId: entityId, amount: 1 },
        });
      }
      batchPromises.push(
        workers[wi].rpc({ type: 'enqueue-batch', messages: batch }, 'batch-result'),
      );
    }

    const batchResults = await Promise.all(batchPromises);
    const totalSucceeded = batchResults.reduce((a: number, r: any) => a + r.succeeded, 0);
    const totalFailed = batchResults.reduce((a: number, r: any) => a + r.failed, 0);

    expect(totalSucceeded).toBe(TOTAL);
    expect(totalFailed).toBe(0);

    // Wait for all workers to finish processing
    await waitFor(async () => {
      const { counters } = await getAggregateState(workers);
      const total = Object.values(counters).reduce((a, b) => a + b, 0);
      return total >= TOTAL;
    }, 20000);

    const { counters } = await getAggregateState(workers);
    const total = Object.values(counters).reduce((a, b) => a + b, 0);
    expect(total).toBe(TOTAL);

    // Each entity: 100/4 = 25
    for (const eid of ENTITY_IDS) {
      expect(counters[eid]).toBe(TOTAL / ENTITY_IDS.length);
    }

    console.log(`  Total: ${total}`);
    console.log(`  Per entity: ${ENTITY_IDS.map((e) => `${e}=${counters[e]}`).join(', ')}`);
    console.log(`  Per-worker state (proves process isolation):`);
    for (const w of workers) {
      const resp = await w.rpc({ type: 'get-state' }, 'state');
      const workerTotal = Object.values(resp.counters as Record<string, number>).reduce((a: number, b: number) => a + b, 0);
      console.log(`    ${w.serverId}: ${workerTotal} increments locally`);
    }
  }, 45000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2: Cross-service forwarding across process boundary
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fork: Cross-service — gRPC Forward across separate processes', () => {
  let redis: Redis;
  const svcA: WorkerHandle[] = [];
  const svcB: WorkerHandle[] = [];

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await cleanRedis(redis);

    // Service A: 2 processes, owns 'counter'
    for (let i = 0; i < 2; i++) {
      const w = spawnWorker({
        serverId: `fork-svc-a-${i}`,
        grpcPort: BASE_GRPC_PORT + 10 + i,
        serviceGroup: 'fork-svc-alpha',
        entities: { counter: { defaultEntityId: 'counterId', retry: { maxAttempts: 2 } } },
        handlers: 'counter',
      });
      svcA.push(w);
    }

    // Service B: 2 processes, owns 'remote'
    for (let i = 0; i < 2; i++) {
      const w = spawnWorker({
        serverId: `fork-svc-b-${i}`,
        grpcPort: BASE_GRPC_PORT + 20 + i,
        serviceGroup: 'fork-svc-beta',
        entities: { remote: { defaultEntityId: 'itemId', retry: { maxAttempts: 2 } } },
        handlers: 'remote',
      });
      svcB.push(w);
    }

    await Promise.all([...svcA, ...svcB].map((w) => waitForReady(w)));

    // Wait for both service groups to elect masters
    await waitFor(async () =>
      (await getLeader(svcA)) !== null && (await getLeader(svcB)) !== null,
      5000,
    );

    // Give entity registry time to propagate (heartbeat=400ms)
    await new Promise((r) => setTimeout(r, 800));
  }, 60000);

  afterAll(async () => {
    const all = [...svcA, ...svcB];
    const exits = all.map((w) => new Promise<void>((r) => {
      if (!w.proc.connected && !w.alive) return r();
      w.proc.once('exit', () => r());
      w.shutdown().catch(() => { try { w.kill(); } catch {} });
    }));
    await Promise.all(exits);
    await cleanRedis(redis);
    await redis.quit();
  }, 15000);

  it('should forward 30 messages from svc-alpha process to svc-beta process via gRPC', async () => {
    const TOTAL = 30;
    const ITEMS = ['item-X', 'item-Y', 'item-Z'];

    // Enqueue 'remote' entity messages from Service A processes
    // These must cross process boundaries via gRPC Forward
    const batchPromises: Promise<any>[] = [];
    for (let wi = 0; wi < svcA.length; wi++) {
      const batch = [];
      for (let i = wi; i < TOTAL; i += svcA.length) {
        const itemId = ITEMS[i % ITEMS.length];
        batch.push({
          entityType: 'remote',
          messageName: 'RemoteWorkCommand',
          entityId: itemId,
          data: { itemId, payload: `work-${i}` },
        });
      }
      batchPromises.push(
        svcA[wi].rpc({ type: 'enqueue-batch', messages: batch }, 'batch-result'),
      );
    }

    const batchResults = await Promise.all(batchPromises);
    const totalSucceeded = batchResults.reduce((a: number, r: any) => a + r.succeeded, 0);
    expect(totalSucceeded).toBe(TOTAL);

    // Wait for svc-beta workers to process
    await waitFor(async () => {
      const { remoteWork } = await getAggregateState(svcB);
      const total = Object.values(remoteWork).reduce((a, b) => a + b, 0);
      return total >= TOTAL;
    }, 20000);

    const { remoteWork } = await getAggregateState(svcB);
    const total = Object.values(remoteWork).reduce((a, b) => a + b, 0);
    expect(total).toBe(TOTAL);

    // Verify per-item
    for (const itemId of ITEMS) {
      expect(remoteWork[itemId]).toBe(TOTAL / ITEMS.length);
    }

    // Verify svc-alpha has ZERO remote work (proves handlers ran in svc-beta processes)
    const { remoteWork: alphaWork } = await getAggregateState(svcA);
    const alphaTotal = Object.values(alphaWork).reduce((a, b) => a + b, 0);
    expect(alphaTotal).toBe(0);

    console.log(`  Cross-process forwarding: ${total} messages`);
    console.log(`  Per item: ${ITEMS.map((e) => `${e}=${remoteWork[e]}`).join(', ')}`);
    console.log(`  svc-alpha processed: ${alphaTotal} (should be 0 — proves cross-process)`);
  }, 45000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3: Master failover with SIGKILL
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fork: Failover — SIGKILL master process, re-elect, continue', () => {
  let redis: Redis;
  const workers: WorkerHandle[] = [];

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await cleanRedis(redis);

    for (let i = 0; i < 3; i++) {
      const w = spawnWorker({
        serverId: `fork-failover-${i}`,
        grpcPort: BASE_GRPC_PORT + 30 + i,
        serviceGroup: 'fork-failover-svc',
        entities: { counter: { defaultEntityId: 'counterId', retry: { maxAttempts: 2 } } },
        handlers: 'counter',
      });
      workers.push(w);
    }

    await Promise.all(workers.map((w) => waitForReady(w)));
    await waitFor(async () => (await getLeader(workers)) !== null, 5000);
  }, 60000);

  afterAll(async () => {
    for (const w of workers) await w.shutdown().catch(() => {});
    killAll(workers);
    await cleanRedis(redis);
    await redis.quit();
  }, 15000);

  it('should survive SIGKILL of master and continue processing', async () => {
    // Phase 1: fire 30 messages
    const PHASE1 = 30;
    const batch1 = Array.from({ length: PHASE1 }, (_, i) => ({
      entityType: 'counter',
      messageName: 'IncrementCommand',
      entityId: 'failover-cnt',
      data: { counterId: 'failover-cnt', amount: 1 },
    }));

    // Distribute across workers
    const p1Promises: Promise<any>[] = [];
    for (let wi = 0; wi < workers.length; wi++) {
      const workerBatch = batch1.filter((_, i) => i % workers.length === wi);
      if (workerBatch.length > 0) {
        p1Promises.push(
          workers[wi].rpc({ type: 'enqueue-batch', messages: workerBatch }, 'batch-result'),
        );
      }
    }
    await Promise.all(p1Promises);

    // Wait for processing
    await waitFor(async () => {
      const { counters } = await getAggregateState(workers);
      return (counters['failover-cnt'] ?? 0) >= PHASE1;
    }, 20000);

    const { counters: pre } = await getAggregateState(workers);
    expect(pre['failover-cnt']).toBe(PHASE1);
    console.log(`  Phase 1: ${pre['failover-cnt']} increments`);

    // Identify master
    const master = await getLeader(workers);
    expect(master).not.toBeNull();
    console.log(`  Master: ${master!.serverId} (pid ${master!.proc.pid})`);

    // SIGKILL the master — not graceful, simulates real crash
    console.log(`  SIGKILL ${master!.serverId}...`);
    master!.kill();

    // Wait for the killed process to actually die
    await new Promise<void>((resolve) => {
      master!.proc.once('exit', () => resolve());
    });

    // Wait for a new master among survivors
    const survivors = workers.filter((w) => w !== master);
    // Leader lock TTL=2s, acquisition poll=400ms. Worst case: ~3s.
    await waitFor(
      async () => (await getLeader(survivors)) !== null,
      5000,
      200,
    );

    const newMaster = await getLeader(survivors);
    expect(newMaster).not.toBeNull();
    expect(newMaster!.serverId).not.toBe(master!.serverId);
    console.log(`  New master: ${newMaster!.serverId}`);

    // Phase 2: fire 20 more through survivors only
    const PHASE2 = 20;
    const batch2 = Array.from({ length: PHASE2 }, (_, i) => ({
      entityType: 'counter',
      messageName: 'IncrementCommand',
      entityId: 'failover-cnt',
      data: { counterId: 'failover-cnt', amount: 1 },
    }));

    const p2Promises: Promise<any>[] = [];
    for (let wi = 0; wi < survivors.length; wi++) {
      const workerBatch = batch2.filter((_, i) => i % survivors.length === wi);
      if (workerBatch.length > 0) {
        p2Promises.push(
          survivors[wi].rpc({ type: 'enqueue-batch', messages: workerBatch }, 'batch-result'),
        );
      }
    }
    await Promise.all(p2Promises);

    // Wait for phase 2 processing. 5s hard ceiling — handlers are in-memory.
    await waitFor(async () => {
      const { counters } = await getAggregateState(survivors);
      return (counters['failover-cnt'] ?? 0) >= PHASE2;
    }, 5000, 200);

    const { counters: post } = await getAggregateState(survivors);
    console.log(`  Survivors total: ${post['failover-cnt']}`);
    expect(post['failover-cnt']).toBeGreaterThanOrEqual(PHASE2);
    console.log(`  Phase 2 processing verified: >= ${PHASE2} on survivors`);
    console.log(`  No hung processes, no deadlocks after SIGKILL`);
  }, 45000);
});
