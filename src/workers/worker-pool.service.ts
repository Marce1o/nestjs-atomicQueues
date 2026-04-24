import { Injectable, Logger, Inject, OnApplicationShutdown } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig, ISerializedMessage } from '../domain';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';
import { InMemoryDispatcher } from './in-memory-dispatcher';
import { HandlerExecutor } from '../services/handler-executor';

/**
 * WorkerPoolService — main-loop dispatch.
 *
 * Executes handlers directly on the main thread's event loop using
 * the app's existing NestJS DI container. No Worker Threads, no
 * separate processes. Per-entity sequential guarantee via InMemoryDispatcher:
 * only one handler runs per entity at a time.
 *
 * Concurrent I/O across entities is handled naturally by the event loop —
 * handlers yield at each `await` point, allowing other entities' handlers
 * to proceed.
 */
@Injectable()
export class WorkerPoolService implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerPoolService.name);
  private readonly dispatcher = new InMemoryDispatcher();

  /** Pending promises for enqueueAndWait: ticket -> { resolve, reject, timer } */
  private readonly pendingResults = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly handlerExecutor: HandlerExecutor,
  ) {}

  async onApplicationShutdown(): Promise<void> {
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
   * Dispatch a message (fire-and-forget).
   * Queues per entity, executes on the main event loop.
   */
  async dispatch(entityKey: string, message: ISerializedMessage): Promise<void> {
    this.dispatcher.push(entityKey, message);
    this.tryDispatch(entityKey);
  }

  /**
   * Dispatch a message and wait for the handler result.
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

      this.dispatcher.push(entityKey, { ...message, correlationId: ticket });
      this.tryDispatch(entityKey);
    });
  }

  getWorkerCount(): number {
    return 1; // main thread
  }

  getTotalQueueDepth(): number {
    return this.dispatcher.totalDepth();
  }

  // =========================================================================
  // DISPATCH — sequential per entity, concurrent across entities
  // =========================================================================

  private tryDispatch(entityKey: string): void {
    if (this.dispatcher.isProcessing(entityKey)) return;

    const message = this.dispatcher.pop(entityKey);
    if (!message) return;

    this.dispatcher.markProcessing(entityKey);

    // Execute on the main event loop — async, non-blocking
    this.executeHandler(entityKey, message);
  }

  private async executeHandler(entityKey: string, message: ISerializedMessage): Promise<void> {
    try {
      const result = await this.handlerExecutor.execute(message, entityKey);

      // Resolve enqueueAndWait if this message has a correlationId
      if (message.correlationId) {
        const pending = this.pendingResults.get(message.correlationId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingResults.delete(message.correlationId);
          pending.resolve(result);
        }
      }
    } catch (err) {
      if (message.correlationId) {
        const pending = this.pendingResults.get(message.correlationId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingResults.delete(message.correlationId);
          pending.reject(err as Error);
        }
      }
    } finally {
      this.dispatcher.markIdle(entityKey);
      // Dispatch next message for this entity (sequential guarantee)
      this.tryDispatch(entityKey);
    }
  }
}
