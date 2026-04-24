import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig, ISerializedMessage, IMessageRef } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { WalService } from '../../wal';
import { WorkerPoolService } from '../../workers';
import { ATOMIC_QUEUES_CONFIG } from '../constants';

/**
 * MessageRouter is the central decision layer for v3.
 *
 * It decides whether a message should be processed locally (via WorkerPool)
 * or forwarded to a remote server (via gRPC, when available).
 *
 * All enqueue paths (QueueBus.enqueue, QueueBus.enqueueAndWait, etc.)
 * route through MessageRouter.
 *
 * Flow:
 *   1. Dual-write: WAL (Redis, durability) + InMemoryDispatcher (speed) in parallel
 *   2. Dispatch to the correct worker via consistent hash
 *   3. On completion: mark WAL entry completed, deliver result
 */
@Injectable()
export class MessageRouter {
  private readonly logger = new Logger(MessageRouter.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly walService: WalService,
    private readonly workerPool: WorkerPoolService,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
  }

  /**
   * Route a message for processing (fire-and-forget).
   *
   * In single-server mode: enqueues locally via WAL + WorkerPool.
   * In multi-server mode (future): checks ServerRing and forwards via gRPC if remote.
   */
  async enqueue(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
    options?: { correlationId?: string; isQuery?: boolean; maxAttempts?: number },
  ): Promise<IMessageRef> {
    const entityKey = `${entityType}:${entityId}`;
    const retryConfig = this.config.entities?.[entityType]?.retry ?? this.config.retry;

    const message: ISerializedMessage = {
      id: uuidv4(),
      name: messageName,
      data,
      entityType,
      entityId,
      isQuery: options?.isQuery,
      correlationId: options?.correlationId,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? retryConfig?.maxAttempts ?? 1,
    };

    // TODO: when gRPC is enabled, check ServerRing here.
    // If entity is owned by a remote server, forward via gRPC instead.

    await this.enqueueLocal(entityKey, message);

    return { id: message.id, entityKey };
  }

  /**
   * Route a message and wait for the handler result.
   */
  async enqueueAndWait<R = unknown>(
    entityType: string,
    messageName: string,
    entityId: string,
    data: Record<string, unknown>,
    timeout?: number,
    options?: { maxAttempts?: number },
  ): Promise<R> {
    const entityKey = `${entityType}:${entityId}`;
    const retryConfig = this.config.entities?.[entityType]?.retry ?? this.config.retry;

    const resolvedTimeout = this.resolveTimeout(entityType, timeout);

    const message: ISerializedMessage = {
      id: uuidv4(),
      name: messageName,
      data,
      entityType,
      entityId,
      isQuery: true,
      correlationId: uuidv4(),
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? retryConfig?.maxAttempts ?? 1,
    };

    // TODO: when gRPC is enabled, check ServerRing and forward if remote.

    return this.enqueueLocalAndWait<R>(entityKey, message, resolvedTimeout);
  }

  // =========================================================================
  // LOCAL DISPATCH
  // =========================================================================

  private async enqueueLocal(entityKey: string, message: ISerializedMessage): Promise<void> {
    // Dual-write: WAL (durability) + WorkerPool dispatch (speed) in parallel
    await Promise.all([
      this.walService.write(entityKey, message),
      this.workerPool.dispatch(entityKey, message),
    ]);
  }

  private async enqueueLocalAndWait<R>(
    entityKey: string,
    message: ISerializedMessage,
    timeout: number,
  ): Promise<R> {
    // Write to WAL first for durability
    await this.walService.write(entityKey, message);

    // Dispatch and wait via WorkerPool
    return this.workerPool.dispatchAndWait<R>(entityKey, message, timeout);
  }

  // =========================================================================
  // TIMEOUT RESOLUTION
  // =========================================================================

  private resolveTimeout(entityType: string, explicit?: number): number {
    if (explicit !== undefined) return explicit;

    const entityConfig = this.config.entities?.[entityType];
    if (entityConfig?.replyTimeout) return entityConfig.replyTimeout;

    // Default: 60 seconds
    return 60000;
  }
}
