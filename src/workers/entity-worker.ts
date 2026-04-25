import { Logger } from '@nestjs/common';
import { ISerializedMessage } from '../domain';

/**
 * A virtual actor — one per entity:entityId.
 *
 * Owns a FIFO message queue and processes messages sequentially
 * on the event loop via the provided processor callback. When idle
 * for longer than the configured timeout, it signals for teardown.
 */
export class EntityWorker {
  private readonly logger = new Logger(`EntityWorker:${this.entityKey}`);
  private readonly queue: ISerializedMessage[] = [];
  private processing = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private _lastActiveAt = Date.now();
  private _totalProcessed = 0;
  private _totalFailed = 0;

  constructor(
    public readonly entityKey: string,
    private readonly processor: (
      message: ISerializedMessage,
      entityKey: string,
    ) => Promise<unknown>,
    private readonly onResult: (message: ISerializedMessage, result: unknown) => void,
    private readonly onError: (message: ISerializedMessage, error: Error) => void,
    private readonly onIdle: (entityKey: string) => void,
    private readonly idleTimeoutMs: number,
    private readonly maxQueueDepth: number = 0,
  ) {}

  /**
   * Enqueue a message. If not currently processing, starts immediately.
   */
  enqueue(message: ISerializedMessage): void {
    if (this.maxQueueDepth > 0 && this.queue.length >= this.maxQueueDepth) {
      throw new Error(
        `Backpressure: ${this.entityKey} queue depth ${this.queue.length} >= ${this.maxQueueDepth}`,
      );
    }
    this.queue.push(message);
    this.clearIdleTimer();
    this._lastActiveAt = Date.now();
    this.tryProcess();
  }

  /**
   * Current queue depth (pending messages not yet dispatched).
   */
  get queueDepth(): number {
    return this.queue.length;
  }

  /**
   * Whether the worker is currently executing a handler.
   */
  get isProcessing(): boolean {
    return this.processing;
  }

  get lastActiveAt(): number {
    return this._lastActiveAt;
  }

  get totalProcessed(): number {
    return this._totalProcessed;
  }

  get totalFailed(): number {
    return this._totalFailed;
  }

  /**
   * Drain: finish current handler, reject remaining queued messages.
   * Returns when the current handler (if any) completes.
   */
  async drain(): Promise<void> {
    this.clearIdleTimer();
    // Clear pending queue
    const pending = this.queue.splice(0);
    for (const msg of pending) {
      this.onError(msg, new Error('Worker draining'));
    }
    // Wait for current handler to finish
    if (this.processing) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!this.processing) {
            clearInterval(check);
            resolve();
          }
        }, 10);
      });
    }
  }

  /**
   * Destroy: clear timers. Call after drain.
   */
  destroy(): void {
    this.clearIdleTimer();
  }

  // =========================================================================
  // INTERNAL
  // =========================================================================

  private tryProcess(): void {
    if (this.processing) return;
    if (this.queue.length === 0) {
      this.startIdleTimer();
      return;
    }

    const message = this.queue.shift()!;
    this.processing = true;
    this._lastActiveAt = Date.now();

    // Execute on the event loop — async, yields at await points
    this.executeHandler(message);
  }

  private async executeHandler(message: ISerializedMessage): Promise<void> {
    try {
      const result = await this.processor(message, this.entityKey);
      this._totalProcessed++;
      this.onResult(message, result);
    } catch (err) {
      this._totalFailed++;
      this.onError(message, err as Error);
    } finally {
      this.processing = false;
      this._lastActiveAt = Date.now();
      // Process next message (sequential guarantee)
      this.tryProcess();
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0) return;

    this.idleTimer = setTimeout(() => {
      if (!this.processing && this.queue.length === 0) {
        this.onIdle(this.entityKey);
      }
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
