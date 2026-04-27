/**
 * Redis failure integration test
 *
 * Tests the voluntary step-down mechanism when a node loses Redis connectivity.
 * Uses the same fork-based infrastructure as cluster-fork.spec.ts.
 *
 * Scenarios:
 *   1. Master loses Redis → steps down → re-election → survivors continue
 *   2. Master recovers Redis → rejoins cluster
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
const KEY_PREFIX = 'redis-fail-integ';
const BASE_GRPC_PORT = 50400;
const WORKER_TS = path.join(__dirname, 'cluster-worker.ts');
const BUILD_DIR = path.join(__dirname, '..', '..', '.fork-build');

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
  const candidate = path.join(BUILD_DIR, 'test', 'integration', 'cluster-worker.js');
  if (fs.existsSync(candidate)) {
    WORKER_PATH = candidate;
  } else {
    throw new Error(`Failed to compile cluster-worker.ts: ${err.stderr?.toString()}`);
  }
}

const protoSrc = path.join(__dirname, '..', '..', 'src', 'grpc', 'atomicqueues.proto');
const protoDst = path.join(BUILD_DIR, 'src', 'grpc', 'atomicqueues.proto');
fs.mkdirSync(path.dirname(protoDst), { recursive: true });
fs.copyFileSync(protoSrc, protoDst);

// ─── Worker handle (same as cluster-fork.spec.ts) ───────────────────────────

interface WorkerHandle {
  proc: ChildProcess;
  serverId: string;
  grpcPort: number;
  alive: boolean;
  readyPromise: Promise<any>;
  rpc(msg: Record<string, unknown>, expectType: string, timeoutMs?: number): Promise<any>;
  send(msg: Record<string, unknown>): void;
  kill(): void;
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

  const readyPromise = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Boot timeout for ${config.serverId}`)),
      45000,
    );
    pendingRpcs.push({ expectType: 'ready', resolve, reject, timer });
  });

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
    if (!w.alive) continue;
    try {
      const resp = await w.rpc({ type: 'get-leader' }, 'leader', 5000);
      if (resp.isLeader) return w;
    } catch { /* process might be dead or disconnected */ }
  }
  return null;
}

async function getHealth(w: WorkerHandle): Promise<{ isLeader: boolean; isClusterHealthy: boolean }> {
  return w.rpc({ type: 'get-health' }, 'health', 5000);
}

async function getAggregateCounters(
  workers: WorkerHandle[],
): Promise<Record<string, number>> {
  const counters: Record<string, number> = {};
  for (const w of workers) {
    if (!w.alive) continue;
    try {
      const resp = await w.rpc({ type: 'get-state' }, 'state', 5000);
      for (const [k, v] of Object.entries(resp.counters as Record<string, number>)) {
        counters[k] = (counters[k] ?? 0) + v;
      }
    } catch { /* skip dead workers */ }
  }
  return counters;
}

// ─── Test ────────────────────────────────────────────────────────────────────

describe('Cluster — Redis failure and recovery', () => {
  let redis: Redis;
  let workers: WorkerHandle[] = [];

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await cleanRedis(redis);
  });

  afterAll(async () => {
    for (const w of workers) {
      try { await w.shutdown(); } catch {}
      try { w.kill(); } catch {}
    }
    await cleanRedis(redis);
    await redis.quit();
  });

  it('should step down master when Redis is lost and recover after reconnection', async () => {
    // ── Boot 3 nodes ──
    const entities = { counter: { retry: { maxAttempts: 1 } } };

    workers = [
      spawnWorker({ serverId: 'rf-a', grpcPort: BASE_GRPC_PORT, serviceGroup: 'rf-group', entities, handlers: 'counter' }),
      spawnWorker({ serverId: 'rf-b', grpcPort: BASE_GRPC_PORT + 1, serviceGroup: 'rf-group', entities, handlers: 'counter' }),
      spawnWorker({ serverId: 'rf-c', grpcPort: BASE_GRPC_PORT + 2, serviceGroup: 'rf-group', entities, handlers: 'counter' }),
    ];

    await Promise.all(workers.map((w) => w.readyPromise));

    // Wait for leader election to settle
    await waitFor(async () => {
      const leader = await getLeader(workers);
      return leader !== null;
    }, 10000);

    const leader = await getLeader(workers);
    expect(leader).not.toBeNull();
    expect(leader!.serverId).toBe('rf-a'); // lexicographically smallest

    // ── Verify normal processing ──
    for (let i = 0; i < 5; i++) {
      const w = workers[i % workers.length];
      w.send({
        type: 'enqueue',
        entityType: 'counter',
        messageName: 'IncrementCommand',
        entityId: `c-${i}`,
        data: { counterId: `c-${i}`, amount: 1 },
      });
    }

    await new Promise((r) => setTimeout(r, 3000));
    const countersBefore = await getAggregateCounters(workers);
    const totalBefore = Object.values(countersBefore).reduce((a, b) => a + b, 0);
    expect(totalBefore).toBe(5);

    // ── Pause Redis on master (rf-a) ──
    await workers[0].rpc({ type: 'pause-redis' }, 'redis-paused', 5000);

    // Wait for the RedisHealthMonitor to detect failure and step down
    // Default: 500ms check interval × 3 failures = ~1500ms, plus 1500ms node TTL
    await new Promise((r) => setTimeout(r, 5000));

    // Verify master stepped down
    const healthA = await getHealth(workers[0]);
    expect(healthA.isLeader).toBe(false);
    expect(healthA.isClusterHealthy).toBe(false);

    // Verify a new leader was elected among survivors
    await waitFor(async () => {
      for (const w of [workers[1], workers[2]]) {
        try {
          const resp = await w.rpc({ type: 'get-leader' }, 'leader', 3000);
          if (resp.isLeader) return true;
        } catch {}
      }
      return false;
    }, 10000);

    const newLeader = await getLeader([workers[1], workers[2]]);
    expect(newLeader).not.toBeNull();
    expect(newLeader!.serverId).toBe('rf-b'); // next lexicographic

    // ── Verify survivors can still process ──
    for (let i = 5; i < 10; i++) {
      const w = [workers[1], workers[2]][(i - 5) % 2];
      w.send({
        type: 'enqueue',
        entityType: 'counter',
        messageName: 'IncrementCommand',
        entityId: `c-${i}`,
        data: { counterId: `c-${i}`, amount: 1 },
      });
    }

    await new Promise((r) => setTimeout(r, 3000));
    const countersAfterFailure = await getAggregateCounters([workers[1], workers[2]]);
    const totalAfterFailure = Object.values(countersAfterFailure).reduce((a, b) => a + b, 0);
    expect(totalAfterFailure).toBeGreaterThanOrEqual(5);

    // ── Resume Redis on original master ──
    await workers[0].rpc({ type: 'resume-redis' }, 'redis-resumed', 10000);

    // Wait for rejoin
    await new Promise((r) => setTimeout(r, 5000));

    const healthARecovered = await getHealth(workers[0]);
    expect(healthARecovered.isClusterHealthy).toBe(true);
    // rf-a should reclaim leadership (smallest serverId)
    expect(healthARecovered.isLeader).toBe(true);
  }, 60000);
});
