import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { ISerializedMessage } from '../domain';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';
import { ConsistentHashRing, HashRingNode } from './consistent-hash';
import { InMemoryDispatcher } from './in-memory-dispatcher';
import { LivenessMonitor } from './liveness-monitor';
import {
  WorkerBootstrapData,
  WorkerOutboundMessage,
  WorkerState,
  WORKER_SLOT_SIZE,
} from './worker-protocol';

interface WorkerHandle {
  workerId: number;
  worker: Worker;
  ready: boolean;
  /** Tickets currently in-flight on this worker: ticket → { entityKey, messageId, resolve, reject, timer } */
  inflight: Map<
    string,
    {
      entityKey: string;
      messageId: string;
      resolve?: (value: unknown) => void;
      reject?: (error: Error) => void;
      timer?: NodeJS.Timeout;
    }
  >;
}

interface WorkerPoolConfig {
  modulePath?: string;
  moduleExportName?: string;
  min?: number;
  max?: number;
  keyPrefix?: string;
  redisConfig?: Record<string, unknown>;
  scaling?: {
    evaluationInterval?: number;
    scaleUpThreshold?: number;
    scaleDownThreshold?: number;
    scaleDownCooldown?: number;
    scaleUpCooldown?: number;
  };
}

@Injectable()
export class WorkerPoolService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerPoolService.name);

  private readonly workers = new Map<number, WorkerHandle>();
  private readonly hashRing = new ConsistentHashRing<number>(150);
  private readonly dispatcher = new InMemoryDispatcher();

  private stateBuffer!: SharedArrayBuffer;
  private stateView!: Int32Array;
  private livenessMonitor!: LivenessMonitor;

  private readonly minWorkers: number;
  private readonly maxWorkers: number;
  private readonly modulePath: string;
  private readonly moduleExportName: string;
  private readonly keyPrefix: string;
  private readonly redisConfig: Record<string, unknown>;

  private nextWorkerId = 0;
  private running = false;

  /** Pending promises for enqueueAndWait: ticket → { resolve, reject } */
  private readonly pendingResults = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: any,
  ) {
    const wc: WorkerPoolConfig = config.workers ?? {};
    this.minWorkers = wc.min ?? 1;
    this.maxWorkers = wc.max ?? Math.max(1, os.cpus().length - 1);
    this.modulePath = wc.modulePath ?? '';
    this.moduleExportName = wc.moduleExportName ?? 'AppModule';
    this.keyPrefix = config.keyPrefix ?? 'aq';
    this.redisConfig = config.redis ?? {};
  }

  async onModuleInit(): Promise<void> {
    if (!this.modulePath) {
      this.logger.warn('No workers.modulePath configured — worker pool not started');
      return;
    }

    this.running = true;

    // Allocate SharedArrayBuffer for state communication
    this.stateBuffer = new SharedArrayBuffer(this.maxWorkers * WORKER_SLOT_SIZE);
    this.stateView = new Int32Array(this.stateBuffer);

    // Start liveness monitor
    this.livenessMonitor = new LivenessMonitor(
      this.stateView,
      this.maxWorkers,
      (workerId, reason) => this.handleWorkerDeath(workerId, reason),
    );
    this.livenessMonitor.start();

    // Spawn initial workers
    const initialCount = Math.max(this.minWorkers, 1);
    const readyPromises: Promise<void>[] = [];

    for (let i = 0; i < initialCount; i++) {
      readyPromises.push(this.spawnWorker());
    }

    await Promise.all(readyPromises);
    this.logger.log(`Worker pool started: ${this.workers.size} workers (min=${this.minWorkers}, max=${this.maxWorkers})`);
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    this.livenessMonitor?.stop();

    // Reject all pending results
    for (const [, entry] of this.pendingResults) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Application shutting down'));
    }
    this.pendingResults.clear();

    // Drain all workers
    const drainPromises: Promise<void>[] = [];
    for (const [, handle] of this.workers) {
      drainPromises.push(this.drainAndTerminate(handle, 30000));
    }

    await Promise.all(drainPromises);
    this.workers.clear();
  }

  // =========================================================================
  // PUBLIC API — dispatch messages
  // =========================================================================

  /**
   * Enqueue a message for processing (fire-and-forget).
   * The message is dispatched to the worker assigned by consistent hashing.
   */
  async dispatch(entityKey: string, message: ISerializedMessage): Promise<void> {
    this.dispatcher.push(entityKey, message);
    this.tryDispatch(entityKey);
  }

  /**
   * Enqueue a message and wait for the result.
   */
  async dispatchAndWait<R = unknown>(
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const ticket = uuidv4();

      const timer = setTimeout(() => {
        this.pendingResults.delete(ticket);
        reject(new Error(`Result timeout after ${timeout}ms for ${message.name} on ${entityKey}`));
      }, timeout);

      this.pendingResults.set(ticket, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      // Store ticket info so we can match it when the result comes back
      this.dispatcher.push(entityKey, { ...message, correlationId: ticket });
      this.tryDispatchWithTicket(entityKey, ticket);
    });
  }

  /**
   * Get the current number of active workers.
   */
  getWorkerCount(): number {
    return this.workers.size;
  }

  /**
   * Get the total queue depth across all entities.
   */
  getTotalQueueDepth(): number {
    return this.dispatcher.totalDepth();
  }

  /**
   * Get the in-memory dispatcher (for rebalancing / draining).
   */
  getDispatcher(): InMemoryDispatcher {
    return this.dispatcher;
  }

  /**
   * Get the hash ring (for inspection / testing).
   */
  getHashRing(): ConsistentHashRing<number> {
    return this.hashRing;
  }

  // =========================================================================
  // WORKER LIFECYCLE
  // =========================================================================

  async spawnWorker(): Promise<void> {
    const workerId = this.nextWorkerId++;

    const bootstrapPath = path.join(__dirname, 'worker-bootstrap.js');

    const bootstrapData: WorkerBootstrapData = {
      workerId,
      modulePath: this.modulePath,
      moduleExportName: this.moduleExportName,
      redisConfig: this.redisConfig,
      keyPrefix: this.keyPrefix,
      stateBuffer: this.stateBuffer,
      maxWorkers: this.maxWorkers,
    };

    const worker = new Worker(bootstrapPath, {
      workerData: bootstrapData,
    });

    const handle: WorkerHandle = {
      workerId,
      worker,
      ready: false,
      inflight: new Map(),
    };

    this.workers.set(workerId, handle);

    // Wire up message handling
    worker.on('message', (msg: WorkerOutboundMessage) => {
      this.handleWorkerMessage(workerId, msg);
    });

    worker.on('error', (err: Error) => {
      this.logger.error(`Worker ${workerId} error: ${err.message}`);
    });

    worker.on('exit', (code) => {
      if (code !== 0 && this.running) {
        this.logger.error(`Worker ${workerId} exited with code ${code}`);
        this.handleWorkerDeath(workerId, `exited with code ${code}`);
      }
    });

    // Wait for ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Worker ${workerId} failed to become ready within 30s`));
      }, 30000);

      const onMessage = (msg: WorkerOutboundMessage) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          handle.ready = true;
          this.hashRing.addNode({ id: `worker-${workerId}`, data: workerId });
          worker.removeListener('message', onMessage);
          resolve();
        } else if (msg.type === 'fatal') {
          clearTimeout(timeout);
          reject(new Error(`Worker ${workerId} fatal: ${msg.error}`));
        }
      };

      worker.on('message', onMessage);
    });
  }

  // =========================================================================
  // MESSAGE DISPATCH
  // =========================================================================

  private tryDispatch(entityKey: string): void {
    if (this.dispatcher.isProcessing(entityKey)) return;

    const message = this.dispatcher.peek(entityKey);
    if (!message) return;

    const node = this.hashRing.getNode(entityKey);
    if (!node) {
      this.logger.error(`No worker available for ${entityKey}`);
      return;
    }

    const handle = this.workers.get(node.data);
    if (!handle?.ready) return;

    const ticket = uuidv4();
    this.dispatcher.pop(entityKey);
    this.dispatcher.markProcessing(entityKey);

    handle.inflight.set(ticket, {
      entityKey,
      messageId: message.id,
    });

    handle.worker.postMessage({
      type: 'execute',
      ticket,
      entityKey,
      message,
    });
  }

  private tryDispatchWithTicket(entityKey: string, ticket: string): void {
    if (this.dispatcher.isProcessing(entityKey)) return;

    const message = this.dispatcher.peek(entityKey);
    if (!message) return;

    const node = this.hashRing.getNode(entityKey);
    if (!node) {
      this.logger.error(`No worker available for ${entityKey}`);
      return;
    }

    const handle = this.workers.get(node.data);
    if (!handle?.ready) return;

    this.dispatcher.pop(entityKey);
    this.dispatcher.markProcessing(entityKey);

    handle.inflight.set(ticket, {
      entityKey,
      messageId: message.id,
    });

    handle.worker.postMessage({
      type: 'execute',
      ticket,
      entityKey,
      message,
    });
  }

  // =========================================================================
  // WORKER MESSAGE HANDLING
  // =========================================================================

  private handleWorkerMessage(workerId: number, msg: WorkerOutboundMessage): void {
    const handle = this.workers.get(workerId);
    if (!handle) return;

    switch (msg.type) {
      case 'result': {
        const inflight = handle.inflight.get(msg.ticket);
        if (inflight) {
          handle.inflight.delete(msg.ticket);
          this.dispatcher.markIdle(inflight.entityKey);

          // Resolve enqueueAndWait if this ticket has a pending result
          const pending = this.pendingResults.get(msg.ticket);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingResults.delete(msg.ticket);
            pending.resolve(msg.result);
          }

          // Dispatch next message for this entity
          this.tryDispatch(inflight.entityKey);
        }
        break;
      }

      case 'error': {
        const inflight = handle.inflight.get(msg.ticket);
        if (inflight) {
          handle.inflight.delete(msg.ticket);
          this.dispatcher.markIdle(inflight.entityKey);

          // Reject enqueueAndWait
          const pending = this.pendingResults.get(msg.ticket);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingResults.delete(msg.ticket);
            pending.reject(new Error(msg.error));
          }

          // Dispatch next message for this entity
          this.tryDispatch(inflight.entityKey);
        }
        break;
      }

      case 'drained':
        this.logger.log(`Worker ${workerId} drained`);
        break;

      case 'metrics':
        this.logger.debug(
          `Worker ${workerId}: active=${msg.activeJobs} completed=${msg.completedTotal} failed=${msg.failedTotal} avg=${msg.avgExecutionMs.toFixed(1)}ms`,
        );
        break;

      case 'fatal':
        this.logger.error(`Worker ${workerId} fatal error: ${msg.error}`);
        this.handleWorkerDeath(workerId, `fatal: ${msg.error}`);
        break;

      case 'pong':
        // Heartbeat response — could be used for latency tracking
        break;
    }
  }

  // =========================================================================
  // WORKER DEATH HANDLING
  // =========================================================================

  private handleWorkerDeath(workerId: number, reason: string): void {
    const handle = this.workers.get(workerId);
    if (!handle) return;

    this.logger.error(`Worker ${workerId} died: ${reason}`);

    // 1. Fail all in-flight tickets
    for (const [ticket, inflight] of handle.inflight) {
      this.dispatcher.markIdle(inflight.entityKey);

      // Reject enqueueAndWait promises with the captured error
      const pending = this.pendingResults.get(ticket);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingResults.delete(ticket);
        pending.reject(new Error(`Worker crashed during handler execution: ${reason}`));
      }
    }
    handle.inflight.clear();

    // 2. Force-kill if still alive
    try {
      handle.worker.terminate();
    } catch {
      // Already dead
    }

    // 3. Remove from ring and pool
    this.hashRing.removeNode(`worker-${workerId}`);
    this.workers.delete(workerId);

    // 4. Reassign pending messages for dead worker's entities
    const dispatchable = this.dispatcher.getDispatchable();
    for (const entityKey of dispatchable) {
      this.tryDispatch(entityKey);
    }

    // 5. Spawn replacement if below minimum
    if (this.running && this.workers.size < this.minWorkers) {
      this.logger.log(`Spawning replacement worker (pool size: ${this.workers.size}/${this.minWorkers})`);
      this.spawnWorker().catch((e) => {
        this.logger.error(`Failed to spawn replacement worker: ${(e as Error).message}`);
      });
    }
  }

  // =========================================================================
  // DRAIN AND TERMINATE
  // =========================================================================

  private async drainAndTerminate(handle: WorkerHandle, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const deadline = Date.now() + timeoutMs;

      // Send drain command
      try {
        handle.worker.postMessage({ type: 'drain' });
      } catch {
        resolve();
        return;
      }

      const onMessage = (msg: WorkerOutboundMessage) => {
        if (msg.type === 'drained') {
          handle.worker.removeListener('message', onMessage);
          clearTimeout(timer);
          terminateWorker();
        }
      };

      const terminateWorker = () => {
        try {
          handle.worker.postMessage({
            type: 'shutdown',
            deadline: Date.now() + 5000,
          });
        } catch {
          // Already dead
        }

        setTimeout(() => {
          try {
            handle.worker.terminate();
          } catch {
            // Already dead
          }
          resolve();
        }, 5000);
      };

      handle.worker.on('message', onMessage);

      const timer = setTimeout(() => {
        handle.worker.removeListener('message', onMessage);
        this.logger.warn(`Worker ${handle.workerId} drain timeout, force terminating`);
        terminateWorker();
      }, Math.max(0, deadline - Date.now()));

      handle.worker.on('exit', () => {
        clearTimeout(timer);
        handle.worker.removeListener('message', onMessage);
        resolve();
      });
    });
  }
}
