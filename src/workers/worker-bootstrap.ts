#!/usr/bin/env node

/**
 * Worker Thread Entry Point
 *
 * This script runs inside each worker thread. It:
 * 1. Boots a NestJS ApplicationContext with the user's module
 * 2. Extracts the HandlerExecutor from DI
 * 3. Starts a heartbeat interval
 * 4. Enters the message receive loop
 *
 * Communication with the main thread is via MessagePort (parentPort).
 * State is shared via SharedArrayBuffer for liveness monitoring.
 */

import { parentPort, workerData } from 'worker_threads';
import {
  WorkerBootstrapData,
  WorkerInboundMessage,
  WorkerOutboundMessage,
  WorkerState,
  WORKER_STATE_OFFSET,
  WORKER_DEPTH_OFFSET,
  WORKER_SLOT_SIZE,
  writeTimestamp,
} from './worker-protocol';

if (!parentPort) {
  throw new Error('worker-bootstrap.ts must be run inside a Worker thread');
}

const port = parentPort;
const data = workerData as WorkerBootstrapData;

// SharedArrayBuffer view for state communication
const stateView = new Int32Array(data.stateBuffer);
const baseIndex = (data.workerId * WORKER_SLOT_SIZE) / 4;

let handlerExecutor: any = null;
let activeJobs = 0;
let completedTotal = 0;
let failedTotal = 0;
let totalExecutionMs = 0;
let heartbeatInterval: NodeJS.Timeout | null = null;
let draining = false;

// ─── State helpers ──────────────────────────────────────────────────────────

function setState(state: WorkerState): void {
  Atomics.store(stateView, baseIndex + WORKER_STATE_OFFSET, state);
}

function setDepth(depth: number): void {
  Atomics.store(stateView, baseIndex + WORKER_DEPTH_OFFSET, depth);
}

function heartbeat(): void {
  writeTimestamp(stateView, baseIndex, Date.now());
}

function send(msg: WorkerOutboundMessage): void {
  port.postMessage(msg);
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  try {
    // Dynamic import of NestJS — available because the worker runs in the same project
    const { NestFactory } = await import('@nestjs/core');

    // Import the user's module
    const moduleFile = await import(data.modulePath);
    const ModuleClass =
      moduleFile[data.moduleExportName] || moduleFile.default;

    if (!ModuleClass) {
      throw new Error(
        `Could not find export '${data.moduleExportName}' in ${data.modulePath}`,
      );
    }

    // Boot a standalone NestJS ApplicationContext (no HTTP server)
    const app = await NestFactory.createApplicationContext(ModuleClass, {
      logger: ['error', 'warn'],
    });

    // Extract the handler executor
    // We try to get HandlerExecutor from the DI container
    try {
      const { HandlerExecutor } = await import(
        '../services/handler-executor/handler-executor.service'
      );
      handlerExecutor = app.get(HandlerExecutor);
    } catch {
      throw new Error(
        'HandlerExecutor not found in DI container. Ensure AtomicQueuesModule is imported.',
      );
    }

    // Start heartbeat
    heartbeatInterval = setInterval(heartbeat, 1000);
    heartbeat(); // immediate first heartbeat

    setState(WorkerState.IDLE);
    setDepth(0);

    send({ type: 'ready', workerId: data.workerId });

    // Handle graceful shutdown
    port.on('close', async () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      setState(WorkerState.DEAD);
      await app.close();
    });
  } catch (err) {
    send({ type: 'fatal', error: (err as Error).message });
    setState(WorkerState.DEAD);
    process.exit(1);
  }
}

// ─── Message Handler ────────────────────────────────────────────────────────

port.on('message', async (msg: WorkerInboundMessage) => {
  switch (msg.type) {
    case 'execute':
      await handleExecute(msg);
      break;

    case 'drain':
      draining = true;
      setState(WorkerState.DRAINING);
      // If no active jobs, we're already drained
      if (activeJobs === 0) {
        send({ type: 'drained', workerId: data.workerId });
      }
      break;

    case 'shutdown': {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      setState(WorkerState.DEAD);

      const deadline = msg.deadline;
      const gracePeriod = deadline - Date.now();
      if (gracePeriod > 0) {
        // Wait for active jobs to finish, up to the deadline
        const check = setInterval(() => {
          if (activeJobs === 0 || Date.now() >= deadline) {
            clearInterval(check);
            process.exit(0);
          }
        }, 100);
      } else {
        process.exit(0);
      }
      break;
    }

    case 'ping':
      send({ type: 'pong', seq: msg.seq });
      break;
  }
});

async function handleExecute(msg: { ticket: string; entityKey: string; message: any }): Promise<void> {
  if (draining) {
    send({
      type: 'error',
      ticket: msg.ticket,
      error: 'Worker is draining, cannot accept new work',
    });
    return;
  }

  activeJobs++;
  setState(WorkerState.BUSY);
  setDepth(activeJobs);
  heartbeat();

  const startTime = Date.now();

  try {
    const result = await handlerExecutor.execute(msg.message, msg.entityKey);

    completedTotal++;
    totalExecutionMs += Date.now() - startTime;

    send({
      type: 'result',
      ticket: msg.ticket,
      result,
    });
  } catch (err) {
    failedTotal++;
    totalExecutionMs += Date.now() - startTime;

    send({
      type: 'error',
      ticket: msg.ticket,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
  } finally {
    activeJobs--;
    setDepth(activeJobs);
    heartbeat();

    if (activeJobs === 0) {
      setState(draining ? WorkerState.DRAINING : WorkerState.IDLE);

      if (draining) {
        send({ type: 'drained', workerId: data.workerId });
      }
    }

    // Periodic metrics report (every 10 completions)
    if ((completedTotal + failedTotal) % 10 === 0) {
      const total = completedTotal + failedTotal;
      send({
        type: 'metrics',
        workerId: data.workerId,
        activeJobs,
        completedTotal,
        failedTotal,
        avgExecutionMs: total > 0 ? totalExecutionMs / total : 0,
      });
    }
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────

bootstrap().catch((err) => {
  send({ type: 'fatal', error: (err as Error).message });
  process.exit(1);
});
