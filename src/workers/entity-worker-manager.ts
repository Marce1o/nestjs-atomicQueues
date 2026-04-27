import { Injectable, Logger, Inject, Optional, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { IAtomicQueuesModuleConfig, ISerializedMessage } from '../domain';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';
import { HandlerExecutor } from '../services/handler-executor';
import { WalService } from '../wal';
import { fastId } from '../utils';
import { EntityWorker } from './entity-worker';

const DEFAULT_IDLE_TIMEOUT = 30000;

@Injectable()
export class EntityWorkerManager implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EntityWorkerManager.name);
  private readonly workers = new Map<string, EntityWorker>();
  private readonly isClusterMode: boolean;
  private readonly serverId: string;
  private readonly maxTotalWorkers: number;
  private readonly maxTotalQueueDepth: number;

  private readonly pendingResults = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  private onTeardownCallback: ((entityKey: string) => void) | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly handlerExecutor: HandlerExecutor,
    @Optional() private readonly walService?: WalService,
  ) {
    this.isClusterMode = config.grpc?.enabled ?? false;
    this.serverId = config.grpc?.serverId ?? 'local';
    this.maxTotalWorkers = config.maxTotalWorkers ?? 10000;
    this.maxTotalQueueDepth = config.maxTotalQueueDepth ?? 100000;
  }

  async onModuleInit(): Promise<void> {
    if (!this.walService || this.config.wal?.enabled === false) return;

    await this.walService.recover();

    const pending = await this.walService.getPendingMessages();
    for (const msg of pending) {
      const entityKey = `${msg.entityType}:${msg.entityId}`;
      let worker = this.workers.get(entityKey);
      if (!worker) worker = this.spawnWorker(entityKey);
      worker.enqueue(msg);
    }

    if (pending.length > 0) {
      this.logger.log(`WAL recovery: re-dispatched ${pending.length} pending messages`);
    }

    this.walService.startCleanup();
  }

  setOnTeardown(callback: (entityKey: string) => void): void {
    this.onTeardownCallback = callback;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.walService) {
      this.walService.stopCleanup();
    }

    const drainPromises: Promise<void>[] = [];
    for (const [, worker] of this.workers) {
      drainPromises.push(worker.drain());
    }
    await Promise.all(drainPromises);

    for (const [, worker] of this.workers) {
      worker.destroy();
    }
    this.workers.clear();

    for (const [, entry] of this.pendingResults) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Application shutting down'));
    }
    this.pendingResults.clear();
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  private get walEnabled(): boolean {
    return !!this.walService && this.config.wal?.enabled !== false;
  }

  async enqueue(entityKey: string, message: ISerializedMessage): Promise<void> {
    if (this.maxTotalWorkers > 0 && !this.workers.has(entityKey) && this.workers.size >= this.maxTotalWorkers) {
      throw new Error('WORKER_LIMIT_EXCEEDED');
    }
    if (this.maxTotalQueueDepth > 0 && this.totalQueueDepth() >= this.maxTotalQueueDepth) {
      throw new Error('QUEUE_DEPTH_EXCEEDED');
    }

    if (this.walEnabled) {
      await this.walService!.write(entityKey, message);
    }

    let worker = this.workers.get(entityKey);
    if (!worker) {
      worker = this.spawnWorker(entityKey);
    }
    worker.enqueue(message);
  }

  enqueueAndWait<R = unknown>(
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const correlationId = fastId();
      const taggedMessage = { ...message, correlationId };

      const cleanup = () => {
        this.pendingResults.delete(correlationId);
        clearTimeout(timer);
      };

      const timer = setTimeout(() => {
        this.pendingResults.delete(correlationId);
        reject(new Error(`Result timeout after ${timeout}ms for ${message.name} on ${entityKey}`));
      }, timeout);

      this.pendingResults.set(correlationId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      if (signal) {
        if (signal.aborted) {
          cleanup();
          reject(new Error('Stream cancelled by client'));
          return;
        }
        signal.addEventListener('abort', () => {
          if (this.pendingResults.has(correlationId)) {
            cleanup();
            reject(new Error('Stream cancelled by client'));
          }
        }, { once: true });
      }

      this.enqueue(entityKey, taggedMessage).catch((err) => {
        this.pendingResults.delete(correlationId);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  spawn(entityKey: string): boolean {
    if (this.workers.has(entityKey)) return false;
    this.spawnWorker(entityKey);
    return true;
  }

  async teardown(entityKey: string): Promise<void> {
    const worker = this.workers.get(entityKey);
    if (!worker) return;

    await worker.drain();
    worker.destroy();
    this.workers.delete(entityKey);
    this.logger.debug(`Worker torn down: ${entityKey}`);
  }

  hasWorker(entityKey: string): boolean {
    return this.workers.has(entityKey);
  }

  listWorkers(): string[] {
    return Array.from(this.workers.keys());
  }

  workerCount(): number {
    return this.workers.size;
  }

  totalQueueDepth(): number {
    let total = 0;
    for (const worker of this.workers.values()) {
      total += worker.queueDepth;
    }
    return total;
  }

  // =========================================================================
  // INTERNAL
  // =========================================================================

  private spawnWorker(entityKey: string): EntityWorker {
    const entityType = entityKey.split(':')[0];
    const entityConfig = this.config.entities?.[entityType];
    const idleTimeout = entityConfig?.workerIdleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    const maxQueueDepth = entityConfig?.workerMaxQueueDepth ?? 0;

    const worker = new EntityWorker(
      entityKey,
      async (message, ek) => {
        if (this.walEnabled) {
          await this.walService!.markDispatched(ek, message.id, 0);
        }
        return this.handlerExecutor.execute(message, ek);
      },
      (message, result) => {
        if (this.walEnabled) {
          this.walService!.markCompleted(entityKey, message.id).catch(() => {});
        }
        this.resolveResult(message, result);
      },
      (message, error) => {
        if (this.walEnabled) {
          this.walService!
            .markFailed(entityKey, message.id, error.message, error.stack)
            .catch(() => {});
        }
        this.rejectResult(message, error);
      },
      (ek) => this.handleWorkerIdle(ek),
      idleTimeout,
      maxQueueDepth,
    );

    this.workers.set(entityKey, worker);
    this.logger.debug(`Worker spawned: ${entityKey}`);
    return worker;
  }

  private resolveResult(message: ISerializedMessage, result: unknown): void {
    if (!message.correlationId) return;
    const pending = this.pendingResults.get(message.correlationId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingResults.delete(message.correlationId);
      pending.resolve(result);
    }
  }

  private rejectResult(message: ISerializedMessage, error: Error): void {
    if (!message.correlationId) return;
    const pending = this.pendingResults.get(message.correlationId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingResults.delete(message.correlationId);
      pending.reject(error);
    }
  }

  private handleWorkerIdle(entityKey: string): void {
    this.logger.debug(`Worker idle: ${entityKey}`);
    const worker = this.workers.get(entityKey);
    if (worker && !worker.isProcessing && worker.queueDepth === 0) {
      worker.destroy();
      this.workers.delete(entityKey);

      if (this.onTeardownCallback) {
        this.onTeardownCallback(entityKey);
      }
    }
  }
}
