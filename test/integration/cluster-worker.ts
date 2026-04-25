/**
 * Cluster worker — one AtomicQueuesModule per OS process.
 *
 * Spawned by the fork-based integration test via child_process.fork().
 * Communicates with the parent test harness over IPC (process.send / process.on).
 *
 * Each worker boots NestJS with:
 *   - AtomicQueuesModule (gRPC, Redis, WAL)
 *   - One of: CounterHandlerModule or RemoteHandlerModule
 *
 * Handler state is process-local — no shared memory with other workers.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module, Injectable } from '@nestjs/common';
import { CommandHandler, ICommandHandler, CqrsModule } from '@nestjs/cqrs';
import { AtomicQueuesModule, QueueBus, QueueEntity, LeaderElectionService } from '../../src';

// ─── Messages ────────────────────────────────────────────────────────────────

@QueueEntity('counter', 'counterId')
class IncrementCommand {
  constructor(
    public readonly counterId: string,
    public readonly amount: number,
  ) {}
}

@QueueEntity('remote', 'itemId')
class RemoteWorkCommand {
  constructor(
    public readonly itemId: string,
    public readonly payload: string,
  ) {}
}

// ─── Process-local state ─────────────────────────────────────────────────────

const counters = new Map<string, number>();
const remoteWork = new Map<string, string[]>();

// ─── Handlers ────────────────────────────────────────────────────────────────

@Injectable()
@CommandHandler(IncrementCommand)
class IncrementHandler implements ICommandHandler<IncrementCommand, void> {
  async execute(cmd: IncrementCommand): Promise<void> {
    const current = counters.get(cmd.counterId) ?? 0;
    counters.set(cmd.counterId, current + cmd.amount);
  }
}

@Injectable()
@CommandHandler(RemoteWorkCommand)
class RemoteWorkHandler implements ICommandHandler<RemoteWorkCommand, void> {
  async execute(cmd: RemoteWorkCommand): Promise<void> {
    const list = remoteWork.get(cmd.itemId) ?? [];
    list.push(cmd.payload);
    remoteWork.set(cmd.itemId, list);
  }
}

// ─── Dynamic module ──────────────────────────────────────────────────────────

@Module({
  imports: [CqrsModule],
  providers: [IncrementHandler],
})
class CounterHandlerModule {}

@Module({
  imports: [CqrsModule],
  providers: [RemoteWorkHandler],
})
class RemoteHandlerModule {}

@Module({
  imports: [CqrsModule],
  providers: [IncrementHandler, RemoteWorkHandler],
})
class AllHandlersModule {}

// ─── IPC protocol ────────────────────────────────────────────────────────────

interface BootMessage {
  type: 'boot';
  config: {
    serverId: string;
    grpcPort: number;
    serviceGroup: string;
    entities: Record<string, { retry?: { maxAttempts: number } }>;
    handlers: 'counter' | 'remote' | 'all';
    redisUrl: string;
    keyPrefix: string;
  };
}

interface EnqueueMessage {
  type: 'enqueue';
  entityType: string;
  messageName: string;
  entityId: string;
  data: Record<string, unknown>;
}

interface EnqueueBatchMessage {
  type: 'enqueue-batch';
  messages: Array<{
    entityType: string;
    messageName: string;
    entityId: string;
    data: Record<string, unknown>;
  }>;
}

interface GetStateMessage { type: 'get-state'; }
interface GetLeaderMessage { type: 'get-leader'; }
interface ShutdownMessage { type: 'shutdown'; }

type WorkerMessage =
  | BootMessage
  | EnqueueMessage
  | EnqueueBatchMessage
  | GetStateMessage
  | GetLeaderMessage
  | ShutdownMessage;

// ─── Worker lifecycle ────────────────────────────────────────────────────────

let queueBus: QueueBus;
let leaderElection: LeaderElectionService;
let app: any;

function send(msg: Record<string, unknown>): void {
  if (process.send) process.send(msg);
}

async function boot(config: BootMessage['config']): Promise<void> {
  const handlerModule =
    config.handlers === 'counter' ? CounterHandlerModule :
    config.handlers === 'remote' ? RemoteHandlerModule :
    AllHandlersModule;

  @Module({
    imports: [
      AtomicQueuesModule.forRoot({
        redis: { url: config.redisUrl },
        keyPrefix: config.keyPrefix,
        entities: config.entities,
        grpc: {
          enabled: true,
          listenAddress: `0.0.0.0:${config.grpcPort}`,
          advertisedAddress: `127.0.0.1:${config.grpcPort}`,
          serverId: config.serverId,
          serviceGroup: config.serviceGroup,
        },
      }),
      handlerModule,
    ],
  })
  class WorkerAppModule {}

  app = await NestFactory.createApplicationContext(WorkerAppModule, {
    logger: ['error', 'warn'],
  });

  queueBus = app.get(QueueBus);
  leaderElection = app.get(LeaderElectionService);

  send({ type: 'ready', serverId: config.serverId });
}

async function handleEnqueue(msg: EnqueueMessage): Promise<void> {
  try {
    const ref = await queueBus.enqueueRaw(
      msg.entityType, msg.messageName, msg.entityId, msg.data,
    );
    send({ type: 'enqueue-result', id: ref.id, success: true });
  } catch (err: any) {
    send({ type: 'enqueue-result', id: null, success: false, error: err.message });
  }
}

async function handleEnqueueBatch(msg: EnqueueBatchMessage): Promise<void> {
  const results = await Promise.allSettled(
    msg.messages.map((m) =>
      queueBus.enqueueRaw(m.entityType, m.messageName, m.entityId, m.data),
    ),
  );
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason?.message ?? String(r.reason));
  send({
    type: 'batch-result',
    total: msg.messages.length,
    succeeded: results.filter((r) => r.status === 'fulfilled').length,
    failed: errors.length,
    errors: errors.slice(0, 5), // send first 5 error messages for diagnostics
  });
}

function handleGetState(): void {
  send({
    type: 'state',
    counters: Object.fromEntries(counters),
    remoteWork: Object.fromEntries(
      Array.from(remoteWork.entries()).map(([k, v]) => [k, v.length]),
    ),
  });
}

function handleGetLeader(): void {
  send({
    type: 'leader',
    isLeader: leaderElection?.getIsLeader() ?? false,
  });
}

async function handleShutdown(): Promise<void> {
  if (app) await app.close().catch(() => {});
  send({ type: 'closed' });
  process.exit(0);
}

// ─── Message router ──────────────────────────────────────────────────────────

process.on('message', async (msg: WorkerMessage) => {
  switch (msg.type) {
    case 'boot':       return boot(msg.config).catch((e) => { send({ type: 'error', error: e.message }); process.exit(1); });
    case 'enqueue':    return handleEnqueue(msg);
    case 'enqueue-batch': return handleEnqueueBatch(msg);
    case 'get-state':  return handleGetState();
    case 'get-leader': return handleGetLeader();
    case 'shutdown':   return handleShutdown();
  }
});

// Keep alive
process.on('disconnect', () => process.exit(0));
