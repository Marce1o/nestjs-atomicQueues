import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig, ISerializedMessage, IMessageRef } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { LogService } from '../log';
import { ExecutorPoolService } from '../executor-pool';
import { ResultCollector } from '../result-collector';
import { RegistryService } from '../registry';
import { ATOMIC_QUEUES_CONFIG } from '../constants';

@Injectable()
export class ActorSystem {
  private readonly logger = new Logger(ActorSystem.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly logService: LogService,
    private readonly executorPool: ExecutorPoolService,
    private readonly resultCollector: ResultCollector,
    @Optional() private readonly registryService?: RegistryService,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
  }

  async send<T extends object>(
    entityType: string,
    entityId: string,
    message: T,
  ): Promise<IMessageRef> {
    const entityKey = `${entityType}:${entityId}`;
    const serialized = this.serializeMessage(entityType, entityId, message);

    if (this.registryService?.isEnabled()) {
      await this.registryService.validate(entityType, message.constructor.name, serialized.data);
    }

    await this.logService.append(entityKey, serialized);
    await this.executorPool.tickle();
    return { id: serialized.id, entityKey };
  }

  async sendAndWait<T extends object, R = any>(
    entityType: string,
    entityId: string,
    message: T,
    timeout = 30000,
  ): Promise<R> {
    const correlationId = uuidv4();
    const entityKey = `${entityType}:${entityId}`;
    const serialized = this.serializeMessage(entityType, entityId, message, correlationId);

    if (this.registryService?.isEnabled()) {
      await this.registryService.validate(entityType, message.constructor.name, serialized.data);
    }

    const resultPromise = this.resultCollector.waitForResult<R>(correlationId, timeout);

    await this.logService.append(entityKey, serialized);
    await this.executorPool.tickle();

    return resultPromise;
  }

  private serializeMessage<T extends object>(
    entityType: string,
    entityId: string,
    message: T,
    correlationId?: string,
  ): ISerializedMessage {
    const data: Record<string, any> = {};
    for (const key of Object.keys(message)) {
      data[key] = (message as any)[key];
    }

    const retryConfig = this.config.entities?.[entityType]?.retry ?? this.config.retry;

    return {
      id: uuidv4(),
      name: message.constructor.name,
      data,
      entityType,
      entityId,
      correlationId,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: retryConfig?.maxAttempts ?? 3,
    };
  }
}
