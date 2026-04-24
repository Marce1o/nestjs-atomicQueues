import { ISerializedMessage } from '../domain';

/**
 * Per-entity in-memory message queue.
 *
 * Maintains a FIFO queue per entityKey. Messages are dispatched
 * one at a time per entity (sequential guarantee) but different
 * entities can be dispatched concurrently.
 */
export class InMemoryDispatcher {
  /** entityKey → ordered message queue */
  private readonly queues = new Map<string, ISerializedMessage[]>();
  /** entityKey → true if currently being processed by a worker */
  private readonly processing = new Set<string>();

  /**
   * Push a message onto the entity's queue.
   * Returns the current depth for this entity.
   */
  push(entityKey: string, message: ISerializedMessage): number {
    let queue = this.queues.get(entityKey);
    if (!queue) {
      queue = [];
      this.queues.set(entityKey, queue);
    }
    queue.push(message);
    return queue.length;
  }

  /**
   * Peek the next message for an entity without removing it.
   */
  peek(entityKey: string): ISerializedMessage | null {
    const queue = this.queues.get(entityKey);
    if (!queue || queue.length === 0) return null;
    return queue[0];
  }

  /**
   * Pop the next message for an entity (remove from front).
   * Returns null if the queue is empty.
   */
  pop(entityKey: string): ISerializedMessage | null {
    const queue = this.queues.get(entityKey);
    if (!queue || queue.length === 0) return null;

    const message = queue.shift()!;

    if (queue.length === 0) {
      this.queues.delete(entityKey);
    }

    return message;
  }

  /**
   * Mark an entity as currently being processed.
   */
  markProcessing(entityKey: string): void {
    this.processing.add(entityKey);
  }

  /**
   * Mark an entity as done processing.
   */
  markIdle(entityKey: string): void {
    this.processing.delete(entityKey);
  }

  /**
   * Check if an entity is currently being processed.
   */
  isProcessing(entityKey: string): boolean {
    return this.processing.has(entityKey);
  }

  /**
   * Get the queue depth for a specific entity.
   */
  depth(entityKey: string): number {
    return this.queues.get(entityKey)?.length ?? 0;
  }

  /**
   * Get total depth across all entities.
   */
  totalDepth(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Get all entity keys that have pending (non-processing) messages.
   * These are entities with messages queued AND not currently being processed.
   */
  getDispatchable(): string[] {
    const result: string[] = [];
    for (const [entityKey, queue] of this.queues) {
      if (queue.length > 0 && !this.processing.has(entityKey)) {
        result.push(entityKey);
      }
    }
    return result;
  }

  /**
   * Get all entity keys that have any messages (pending or processing).
   */
  getAllEntityKeys(): string[] {
    return Array.from(this.queues.keys());
  }

  /**
   * Drain all messages for a set of entity keys.
   * Returns the drained messages grouped by entity key.
   */
  drainEntities(entityKeys: string[]): Map<string, ISerializedMessage[]> {
    const drained = new Map<string, ISerializedMessage[]>();

    for (const entityKey of entityKeys) {
      const queue = this.queues.get(entityKey);
      if (queue && queue.length > 0) {
        drained.set(entityKey, [...queue]);
        this.queues.delete(entityKey);
      }
    }

    return drained;
  }

  /**
   * Transfer all pending messages for given entity keys
   * into this dispatcher (used during worker rebalancing).
   */
  absorbMessages(messages: Map<string, ISerializedMessage[]>): void {
    for (const [entityKey, msgs] of messages) {
      let queue = this.queues.get(entityKey);
      if (!queue) {
        queue = [];
        this.queues.set(entityKey, queue);
      }
      queue.push(...msgs);
    }
  }

  /**
   * Get total number of entities with pending messages.
   */
  entityCount(): number {
    return this.queues.size;
  }

  /**
   * Clear all queues and processing state.
   */
  clear(): void {
    this.queues.clear();
    this.processing.clear();
  }
}
