import { Injectable, Logger, Inject } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig, ISerializedMessage, IMessageRef } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { WalService } from '../../wal';
import { EntityWorkerManager } from '../../workers';
import { MasterCoordinator } from '../../cluster';
import { ATOMIC_QUEUES_CONFIG } from '../constants';

/**
 * MessageRouter — central dispatch layer.
 *
 * Routes through MasterCoordinator which resolves entity → replica.
 * Local entities dispatch to EntityWorkerManager (per-entity workers on
 * the event loop). Remote entities forward via gRPC to the owning replica.
 */
@Injectable()
export class MessageRouter {
  private readonly logger = new Logger(MessageRouter.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly walService: WalService,
    private readonly workerManager: EntityWorkerManager,
    private readonly masterCoordinator: MasterCoordinator,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
  }

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

    const resolution = this.masterCoordinator.resolve(entityKey);

    if (resolution.isLocal) {
      await Promise.all([
        this.walService.write(entityKey, message),
        Promise.resolve(this.workerManager.enqueue(entityKey, message)),
      ]);
    } else {
      // TODO: gRPC forward to resolution.replicaId
      await this.walService.write(entityKey, message);
      this.workerManager.enqueue(entityKey, message);
    }

    return { id: message.id, entityKey };
  }

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

    await this.walService.write(entityKey, message);

    // TODO: if !resolution.isLocal, forward via gRPC ForwardAndWait
    return this.workerManager.enqueueAndWait<R>(entityKey, message, resolvedTimeout);
  }

  private resolveTimeout(entityType: string, explicit?: number): number {
    if (explicit !== undefined) return explicit;
    const entityConfig = this.config.entities?.[entityType];
    if (entityConfig?.replyTimeout) return entityConfig.replyTimeout;
    return 60000;
  }
}
