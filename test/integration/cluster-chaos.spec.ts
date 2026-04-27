/**
 * Chaos cluster integration test
 *
 * Full multi-replica-set cluster with random kills during continuous operation.
 *
 * Topology:
 *   Service "alpha" — 3 replicas, owns 'counter' entity
 *   Service "beta"  — 3 replicas, owns 'remote'  entity
 *   Cross-service:    alpha enqueues to beta, beta enqueues to alpha
 *
 * Phases:
 *   1. Warm-up:  verify local + cross-service routing works
 *   2. Chaos:    fire messages in waves, kill random nodes between waves
 *   3. Cooldown: let survivors drain, verify aggregate state
 *
 * Kills include masters AND sub-nodes, from both service groups.
 * After each kill, the test waits for re-election before the next wave.
 *
 * Run: npm run test:integration -- --testPathPattern chaos
 */

import { ChildProcess, fork, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import Redis from 'ioredis';

// ─── Config ──────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const KEY_PREFIX = 'chaos-integ-test';
const BASE_PORT = 50400;

// ─── Precompile worker ──────────────────────────────────────────────────────

const BUILD_DIR = path.join(__dirname, '..', '..', '.fork-build');
const WORKER_TS = path.join(__dirname, 'cluster-worker.ts');
let WORKER_JS: string;

try {
  execSync(
    `npx tsc ${WORKER_TS} --outDir ${BUILD_DIR} --rootDir ${path.join(__dirname, '..', '..')} ` +
    '--esModuleInterop --module commonjs --target es2022 --moduleResolution node ' +
    '--experimentalDecorators --emitDecoratorMetadata --skipLibCheck --declaration false',
    { cwd: path.join(__dirname, '..', '..'), stdio: 'pipe' },
  );
  WORKER_JS = path.join(BUILD_DIR, 'test', 'integration', 'cluster-worker.js');
} catch {
  WORKER_JS = path.join(BUILD_DIR, 'test', 'integration', 'cluster-worker.js');
}

const protoSrc = path.join(__dirname, '..', '..', 'src', 'grpc', 'atomicqueues.proto');
const protoDst = path.join(BUILD_DIR, 'src', 'grpc', 'atomicqueues.proto');
fs.mkdirSync(path.dirname(protoDst), { recursive: true });
fs.copyFileSync(protoSrc, protoDst);

// ─── Worker handle (same as cluster-fork, inlined for self-containment) ──────

interface WorkerHandle {
  proc: ChildProcess;
  serverId: string;
  grpcPort: number;
  serviceGroup: string;
  alive: boolean;
  readyPromise: Promise<any>;
  rpc(msg: Record<string, unknown>, expectType: string, timeoutMs?: number): Promise<any>;
  send(msg: Record<string, unknown>): void;
  kill(): void;
}

function spawnWorker(config: {
  serverId: string;
  grpcPort: number;
  serviceGroup: string;
  entities: Record<string, any>;
  handlers: 'counter' | 'remote' | 'all';
}): WorkerHandle {
  const proc = fork(WORKER_JS, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  proc.stdout?.resume();
  proc.stderr?.resume();

  const pendingRpcs: Array<{
    expectType: string;
    resolve: (val: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  let alive = true;
  proc.on('exit', () => { alive = false; });

  proc.on('message', (msg: any) => {
    const idx = pendingRpcs.findIndex((r) => r.expectType === msg.type);
    if (idx >= 0) {
      const rpc = pendingRpcs.splice(idx, 1)[0];
      clearTimeout(rpc.timer);
      rpc.resolve(msg);
    }
  });

  const readyPromise = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Boot timeout: ${config.serverId}`)), 45000);
    pendingRpcs.push({ expectType: 'ready', resolve, reject, timer });
  });

  proc.send({
    type: 'boot',
    config: { ...config, redisUrl: REDIS_URL, keyPrefix: KEY_PREFIX },
  });

  const handle: WorkerHandle = {
    proc,
    serverId: config.serverId,
    grpcPort: config.grpcPort,
    serviceGroup: config.serviceGroup,
    get alive() { return alive; },
    set alive(v) { alive = v; },
    readyPromise,

    rpc(msg, expectType, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        if (!alive) return reject(new Error(`${config.serverId} is dead`));
        const timer = setTimeout(
          () => reject(new Error(`RPC timeout '${expectType}' from ${config.serverId}`)),
          timeoutMs,
        );
        pendingRpcs.push({ expectType, resolve, reject, timer });
        if (proc.connected) proc.send(msg);
        else reject(new Error(`${config.serverId} disconnected`));
      });
    },
    send(msg) { if (proc.connected) proc.send(msg); },
    kill() { alive = false; proc.kill('SIGKILL'); },
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
  timeoutMs = 5000,
  pollMs = 200,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function aliveWorkers(workers: WorkerHandle[]): WorkerHandle[] {
  return workers.filter((w) => w.alive);
}

async function findLeader(workers: WorkerHandle[]): Promise<WorkerHandle | null> {
  for (const w of aliveWorkers(workers)) {
    try {
      const r = await w.rpc({ type: 'get-leader' }, 'leader', 5000);
      if (r.isLeader) return w;
    } catch {}
  }
  return null;
}

async function getAggregateState(workers: WorkerHandle[]): Promise<{
  counters: Record<string, number>;
  remoteWork: Record<string, number>;
}> {
  const counters: Record<string, number> = {};
  const remoteWork: Record<string, number> = {};
  for (const w of aliveWorkers(workers)) {
    try {
      const r = await w.rpc({ type: 'get-state' }, 'state', 5000);
      for (const [k, v] of Object.entries(r.counters as Record<string, number>))
        counters[k] = (counters[k] ?? 0) + v;
      for (const [k, v] of Object.entries(r.remoteWork as Record<string, number>))
        remoteWork[k] = (remoteWork[k] ?? 0) + v;
    } catch {}
  }
  return { counters, remoteWork };
}

/** Fire a batch of messages through a random alive worker. Returns succeeded count. */
async function fireBatch(
  workers: WorkerHandle[],
  messages: Array<{ entityType: string; messageName: string; entityId: string; data: any }>,
): Promise<{ succeeded: number; failed: number }> {
  const live = aliveWorkers(workers);
  if (live.length === 0) return { succeeded: 0, failed: messages.length };

  // Spread across alive workers
  const perWorker = new Map<WorkerHandle, typeof messages>();
  messages.forEach((m, i) => {
    const w = live[i % live.length];
    if (!perWorker.has(w)) perWorker.set(w, []);
    perWorker.get(w)!.push(m);
  });

  let succeeded = 0;
  let failed = 0;

  const results = await Promise.allSettled(
    Array.from(perWorker.entries()).map(([w, batch]) =>
      w.rpc({ type: 'enqueue-batch', messages: batch }, 'batch-result', 20000),
    ),
  );

  for (const r of results) {
    if (r.status === 'fulfilled') {
      succeeded += r.value.succeeded;
      failed += r.value.failed;
    } else {
      // Worker died mid-batch — count as failed
      failed += messages.length / perWorker.size;
    }
  }

  return { succeeded, failed: Math.round(failed) };
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function killAll(workers: WorkerHandle[]): void {
  for (const w of workers) {
    try { w.proc.kill('SIGKILL'); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAOS TEST
// ═══════════════════════════════════════════════════════════════════════════════

describe('Chaos: Multi-replica-set cluster with random kills during operation', () => {
  let redis: Redis;
  const alpha: WorkerHandle[] = []; // 3 replicas, owns 'counter'
  const beta: WorkerHandle[] = [];  // 3 replicas, owns 'remote'
  const allWorkers = () => [...alpha, ...beta];

  const log = (msg: string) => console.log(`  ${msg}`);

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    await cleanRedis(redis);

    // Boot 3 alpha replicas
    for (let i = 0; i < 3; i++) {
      alpha.push(spawnWorker({
        serverId: `alpha-${i}`,
        grpcPort: BASE_PORT + i,
        serviceGroup: 'chaos-alpha',
        entities: { counter: { defaultEntityId: 'counterId', retry: { maxAttempts: 2 } } },
        handlers: 'counter',
      }));
    }

    // Boot 3 beta replicas
    for (let i = 0; i < 3; i++) {
      beta.push(spawnWorker({
        serverId: `beta-${i}`,
        grpcPort: BASE_PORT + 10 + i,
        serviceGroup: 'chaos-beta',
        entities: { remote: { defaultEntityId: 'itemId', retry: { maxAttempts: 2 } } },
        handlers: 'remote',
      }));
    }

    // Wait for all to boot
    await Promise.all(allWorkers().map((w) => w.readyPromise));

    // Wait for both service groups to elect masters (TTL=2s, poll=400ms)
    await waitFor(async () =>
      (await findLeader(alpha)) !== null && (await findLeader(beta)) !== null,
      5000,
    );

    // Let entity registry propagate (heartbeat=400ms)
    await new Promise((r) => setTimeout(r, 800));

    const am = await findLeader(alpha);
    const bm = await findLeader(beta);
    log(`Cluster booted: alpha master=${am?.serverId}, beta master=${bm?.serverId}`);
    log(`Total processes: ${allWorkers().length}`);
  }, 90000);

  afterAll(async () => {
    // Kill all and WAIT for each process to fully exit before cleaning Redis.
    // Without this, dying processes may still write heartbeats/leader keys
    // that leak into the next test suite's Redis keyspace.
    const exitPromises = allWorkers().map((w) => new Promise<void>((resolve) => {
      if (!w.alive) return resolve();
      w.proc.once('exit', () => resolve());
      w.kill();
    }));
    await Promise.all(exitPromises);

    // Double-clean: dying processes may have written keys after our first clean
    await cleanRedis(redis);
    await cleanRedis(redis);
    await redis.quit();
  }, 15000);

  it('Phase 1: warm-up — local + cross-service routing works', async () => {
    // Local: 30 counter messages to alpha
    const localBatch = Array.from({ length: 30 }, (_, i) => ({
      entityType: 'counter',
      messageName: 'IncrementCommand',
      entityId: `warmup-${i % 3}`,
      data: { counterId: `warmup-${i % 3}`, amount: 1 },
    }));
    const localResult = await fireBatch(alpha, localBatch);
    expect(localResult.succeeded).toBe(30);

    // Cross-service: 20 remote messages from alpha → beta
    const crossBatch = Array.from({ length: 20 }, (_, i) => ({
      entityType: 'remote',
      messageName: 'RemoteWorkCommand',
      entityId: `cross-${i % 2}`,
      data: { itemId: `cross-${i % 2}`, payload: `warm-${i}` },
    }));
    const crossResult = await fireBatch(alpha, crossBatch);
    expect(crossResult.succeeded).toBe(20);

    // Wait for processing
    await waitFor(async () => {
      const { counters } = await getAggregateState(alpha);
      const total = Object.values(counters).reduce((a, b) => a + b, 0);
      return total >= 30;
    }, 5000);

    await waitFor(async () => {
      const { remoteWork } = await getAggregateState(beta);
      const total = Object.values(remoteWork).reduce((a, b) => a + b, 0);
      return total >= 20;
    }, 5000);

    const { counters } = await getAggregateState(alpha);
    const { remoteWork } = await getAggregateState(beta);
    const counterTotal = Object.values(counters).reduce((a, b) => a + b, 0);
    const remoteTotal = Object.values(remoteWork).reduce((a, b) => a + b, 0);

    expect(counterTotal).toBe(30);
    expect(remoteTotal).toBe(20);
    log(`Warm-up: ${counterTotal} local + ${remoteTotal} cross-service = OK`);
  }, 45000);

  it('Phase 2: chaos — fire messages while killing random nodes', async () => {
    const WAVES = 5;
    const MSGS_PER_WAVE = 20;
    const ENTITY_IDS = ['chaos-A', 'chaos-B', 'chaos-C'];
    let totalEnqueued = 0;
    const kills: string[] = [];

    for (let wave = 0; wave < WAVES; wave++) {
      // ── Fire a wave of local messages ──
      const batch = Array.from({ length: MSGS_PER_WAVE }, (_, i) => ({
        entityType: 'counter',
        messageName: 'IncrementCommand',
        entityId: ENTITY_IDS[i % ENTITY_IDS.length],
        data: { counterId: ENTITY_IDS[i % ENTITY_IDS.length], amount: 1 },
      }));

      const result = await fireBatch(alpha, batch);
      totalEnqueued += result.succeeded;
      log(`Wave ${wave + 1}: enqueued ${result.succeeded}/${MSGS_PER_WAVE} (failed: ${result.failed})`);

      // ── Pick a random live node to kill ──
      // Alternate between killing from alpha and beta service groups
      const targetGroup = wave % 2 === 0 ? alpha : beta;
      const killCandidates = aliveWorkers(targetGroup);

      // Keep at least 1 alive per group so the cluster can recover
      if (killCandidates.length > 1) {
        const victim = pickRandom(killCandidates);
        const isLeader = await findLeader(targetGroup) === victim;
        const role = isLeader ? 'MASTER' : 'sub-node';

        log(`  Kill: ${victim.serverId} (${role}) via SIGKILL`);
        victim.kill();
        await new Promise<void>((resolve) => victim.proc.once('exit', resolve));
        kills.push(`${victim.serverId} (${role})`);

        // Wait for re-election if we killed a master (TTL=2s, poll=400ms)
        if (isLeader) {
          await waitFor(
            async () => (await findLeader(targetGroup)) !== null,
            5000,
            200,
          );
          const newLeader = await findLeader(targetGroup);
          log(`  Re-elected: ${newLeader?.serverId}`);
        }

        // Let cluster stabilize (dead node TTL=1.5s)
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    log(`\nChaos summary:`);
    log(`  Waves: ${WAVES}`);
    log(`  Total enqueued (succeeded): ${totalEnqueued}`);
    log(`  Nodes killed: ${kills.length}`);
    kills.forEach((k) => log(`    - ${k}`));
    log(`  Alpha alive: ${aliveWorkers(alpha).length}/3`);
    log(`  Beta alive: ${aliveWorkers(beta).length}/3`);

    // ── Wait for survivors to drain ──
    // With multiple nodes killed, we can't expect all enqueued messages to
    // be processed — entity workers on dead nodes are gone. Just let the
    // surviving cluster settle.
    await new Promise((r) => setTimeout(r, 1500));

    // ── Verify ──
    const { counters } = await getAggregateState(alpha);
    const totalProcessed = Object.values(counters).reduce((a, b) => a + b, 0);
    const chaosProcessed = totalProcessed - 30; // subtract warm-up

    log(`\nVerification:`);
    log(`  Chaos messages processed: ${chaosProcessed}/${totalEnqueued}`);
    log(`  Processing rate: ${((chaosProcessed / Math.max(totalEnqueued, 1)) * 100).toFixed(0)}%`);

    // Core assertions:
    // 1. Some chaos messages were processed (proves cluster didn't fully die)
    expect(chaosProcessed).toBeGreaterThan(0);
    // 2. At least one node per service group survived
    expect(aliveWorkers(alpha).length).toBeGreaterThanOrEqual(1);
    expect(aliveWorkers(beta).length).toBeGreaterThanOrEqual(1);
    // 3. Each service group still has a master
    const am = await findLeader(alpha);
    const bm = await findLeader(beta);
    expect(am).not.toBeNull();
    expect(bm).not.toBeNull();
    log(`  Alpha master after chaos: ${am?.serverId}`);
    log(`  Beta master after chaos:  ${bm?.serverId}`);
  }, 120000);

  it('Phase 3: post-chaos — surviving cluster MUST recover and process within TTL bounds', async () => {
    // ──────────────────────────────────────────────────────────────────────
    // STRICT: No retries. No generous waits. The library's contract says:
    //   - Leader lock TTL: 2s
    //   - Heartbeat: 400ms
    //   - Node TTL: 1500ms
    //   - Acquisition interval: 400ms
    //
    // After chaos, the surviving nodes should be fully operational within
    // ONE node TTL cycle (1.5s). If they're not, that's a library bug.
    // ──────────────────────────────────────────────────────────────────────

    // Wait one node TTL cycle — the hard contract for dead-node detection.
    log('Waiting 1.5s (one node TTL cycle) for cluster to self-heal...');
    await new Promise((r) => setTimeout(r, 1500));

    // Verify masters exist (re-election must have happened during chaos)
    const am = await findLeader(alpha);
    const bm = await findLeader(beta);
    expect(am).not.toBeNull();
    expect(bm).not.toBeNull();
    log(`Alpha master: ${am!.serverId}`);
    log(`Beta master:  ${bm!.serverId}`);

    // ── LOCAL: 30 messages, zero tolerance ──
    const LOCAL_BATCH = 30;
    const batch = Array.from({ length: LOCAL_BATCH }, (_, i) => ({
      entityType: 'counter',
      messageName: 'IncrementCommand',
      entityId: 'post-chaos',
      data: { counterId: 'post-chaos', amount: 1 },
    }));

    const result = await fireBatch(alpha, batch);
    log(`Post-chaos local enqueue: ${result.succeeded}/${LOCAL_BATCH} (errors: ${(result as any).errors?.join('; ') ?? 'none'})`);
    expect(result.succeeded).toBe(LOCAL_BATCH);

    // Processing must complete within 5s (messages are in-memory, no I/O)
    await waitFor(async () => {
      const { counters } = await getAggregateState(alpha);
      return (counters['post-chaos'] ?? 0) >= LOCAL_BATCH;
    }, 5000, 200);

    const { counters } = await getAggregateState(alpha);
    expect(counters['post-chaos']).toBe(LOCAL_BATCH);
    log(`Post-chaos local processed: ${counters['post-chaos']}/${LOCAL_BATCH}`);

    // ── CROSS-SERVICE: 10 messages, zero tolerance ──
    const CROSS_BATCH = 10;
    const crossBatch = Array.from({ length: CROSS_BATCH }, (_, i) => ({
      entityType: 'remote',
      messageName: 'RemoteWorkCommand',
      entityId: 'post-chaos-cross',
      data: { itemId: 'post-chaos-cross', payload: `post-${i}` },
    }));

    const crossResult = await fireBatch(alpha, crossBatch);
    log(`Post-chaos cross-service enqueue: ${crossResult.succeeded}/${CROSS_BATCH} (errors: ${(crossResult as any).errors?.join('; ') ?? 'none'})`);
    expect(crossResult.succeeded).toBe(CROSS_BATCH);

    await waitFor(async () => {
      const { remoteWork } = await getAggregateState(beta);
      return (remoteWork['post-chaos-cross'] ?? 0) >= CROSS_BATCH;
    }, 5000, 200);

    const { remoteWork } = await getAggregateState(beta);
    expect(remoteWork['post-chaos-cross']).toBe(CROSS_BATCH);
    log(`Post-chaos cross-service processed: ${remoteWork['post-chaos-cross']}/${CROSS_BATCH}`);

    // ── Final state ──
    log(`\nFinal cluster:`);
    log(`  Alpha: ${aliveWorkers(alpha).map((w) => w.serverId).join(', ')} (master: ${am!.serverId})`);
    log(`  Beta:  ${aliveWorkers(beta).map((w) => w.serverId).join(', ')} (master: ${bm!.serverId})`);
  }, 30000);
});
