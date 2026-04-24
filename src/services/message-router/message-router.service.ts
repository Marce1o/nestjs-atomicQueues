import { Injectable, Logger, Inject } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig, ISerializedMessage, IMessageRef } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { WalService } from '../../wal';
import { EntityWorkerManager } from '../../workers';
import { ATOMIC_QUEUES_CONFIG } from '../constants';

/**
 * MessageRouter — central dispatch layer.
 *
 * Routes messages to the EntityWorkerManager which spawns per-entity
 * workers on the event loop. In cluster mode (future), routes to the
 * MasterCoordinator which directs to the correct replica.
 *
 * Flow:
 *   1. Dual-write: WAL (Redis, durability) + EntityWorkerManager (speed)
 *   2. Worker spawns on first message for an entity
 *   3. Worker processes sequentially, tears down when idle
 */
@Injectable()
export class MessageRouter {
  private readonly logger = new Logger(MessageRouter.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly walService: WalService,
    private readonly workerManager: EntityWorkerManager,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
  }

  /**
   * Route a message for processing (fire-and-forget).
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

    // TODO: cluster mode — route to MasterCoordinator which forwards to correct replica

    // Dual-write: WAL (durability) + worker (speed) in parallel
    await Promise.all([
      this.walService.write(entityKey, message),
      Promise.resolve(this.workerManager.enqueue(entityKey, message)),
    ]);

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
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? retryConfig?.maxAttempts ?? 1,
    };

    // Write to WAL for durability
    await this.walService.write(entityKey, message);

    // Dispatch and wait — worker spawns on demand
    return this.workerManager.enqueueAndWait<R>(entityKey, message, resolvedTimeout);
  }

  private resolveTimeout(entityType: string, explicit?: number): number {
    if (explicit !== undefined) return explicit;
    const entityConfig = this.config.entities?.[entityType];
    if (entityConfig?.replyTimeout) return entityConfig.replyTimeout;
    return 60000;
  }
}
