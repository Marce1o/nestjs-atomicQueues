import { Injectable, Logger, Inject, OnApplicationShutdown } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig, ISerializedMessage } from '../domain';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';
import { HandlerExecutor } from '../services/handler-executor';
import { EntityWorker } from './entity-worker';

const DEFAULT_IDLE_TIMEOUT = 30000;

/**
 * EntityWorkerManager — manages per-entity workers on this replica.
 *
 * Each entity:entityId gets its own EntityWorker (processor callback on the
 * event loop). Workers are spawned on first message and torn down after idle
 * timeout. Only ONE worker per entity exists across the entire cluster —
 * the MasterCoordinator ensures this.
 *
 * On a single server (no gRPC), this acts as both the worker manager
 * and the coordinator.
 */
@Injectable()
export class EntityWorkerManager implements OnApplicationShutdown {
  private readonly logger = new Logger(EntityWorkerManager.name);
  private readonly workers = new Map<string, EntityWorker>();

  /** Pending enqueueAndWait promises: correlationId -> { resolve, reject, timer } */
  private readonly pendingResults = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly handlerExecutor: HandlerExecutor,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // Drain all workers
    const drainPromises: Promise<void>[] = [];
    for (const [, worker] of this.workers) {
      drainPromises.push(worker.drain());
    }
    await Promise.all(drainPromises);

    // Destroy workers
    for (const [, worker] of this.workers) {
      worker.destroy();
    }
    this.workers.clear();

    // Reject pending results
    for (const [, entry] of this.pendingResults) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Application shutting down'));
    }
    this.pendingResults.clear();
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  /**
   * Enqueue a message. Spawns a worker if none exists for this entity.
   */
  enqueue(entityKey: string, message: ISerializedMessage): void {
    let worker = this.workers.get(entityKey);
    if (!worker) {
      worker = this.spawnWorker(entityKey);
    }
    worker.enqueue(message);
  }

  /**
   * Enqueue a message and wait for the result.
   */
  enqueueAndWait<R = unknown>(
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const correlationId = uuidv4();
      const taggedMessage = { ...message, correlationId };

      const timer = setTimeout(() => {
        this.pendingResults.delete(correlationId);
        reject(new Error(`Result timeout after ${timeout}ms for ${message.name} on ${entityKey}`));
      }, timeout);

      this.pendingResults.set(correlationId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.enqueue(entityKey, taggedMessage);
    });
  }

  /**
   * Spawn a worker for an entity (called by MasterCoordinator).
   * Returns true if spawned, false if already exists.
   */
  spawn(entityKey: string): boolean {
    if (this.workers.has(entityKey)) return false;
    this.spawnWorker(entityKey);
    return true;
  }

  /**
   * Teardown a worker (called by MasterCoordinator or idle timeout).
   */
  async teardown(entityKey: string): Promise<void> {
    const worker = this.workers.get(entityKey);
    if (!worker) return;

    await worker.drain();
    worker.destroy();
    this.workers.delete(entityKey);
    this.logger.debug(`Worker torn down: ${entityKey}`);
  }

  /**
   * Check if a worker exists for an entity.
   */
  hasWorker(entityKey: string): boolean {
    return this.workers.has(entityKey);
  }

  /**
   * List all active worker entity keys on this replica.
   */
  listWorkers(): string[] {
    return Array.from(this.workers.keys());
  }

  /**
   * Get the number of active workers.
   */
  workerCount(): number {
    return this.workers.size;
  }

  /**
   * Get total queued messages across all workers.
   */
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

    const worker = new EntityWorker(
      entityKey,
      // Processor: execute handler via NestJS DI on this event loop
      (message, ek) => this.handlerExecutor.execute(message, ek),
      // On result
      (message, result) => this.resolveResult(message, result),
      // On error
      (message, error) => this.rejectResult(message, error),
      // On idle
      (ek) => this.handleWorkerIdle(ek),
      idleTimeout,
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
    // In single-server mode, just teardown directly.
    // In cluster mode, MasterCoordinator handles this via gRPC.
    const worker = this.workers.get(entityKey);
    if (worker && !worker.isProcessing && worker.queueDepth === 0) {
      worker.destroy();
      this.workers.delete(entityKey);
    }
  }
}
