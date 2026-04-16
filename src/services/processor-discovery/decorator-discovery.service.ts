import {
  Injectable,
  Logger,
  Type,
  Inject,
  Optional,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  GET_ACTIVE_ENTITIES_METADATA,
  GET_DESIRED_WORKER_COUNT_METADATA,
  ON_SPAWN_WORKER_METADATA,
  ON_TERMINATE_WORKER_METADATA,
  WorkerProcessorOptions,
  EntityScalerOptions,
  getWorkerProcessorMetadata,
  getJobHandlerMetadata,
  getEntityScalerMetadata,
} from '../../decorators';
import { IAtomicQueuesModuleConfig } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { ATOMIC_QUEUES_CONFIG } from '../constants';
import { ProcessorRegistry, RegisteredProcessor, RegisteredScaler } from './processor-registry';

/**
 * DecoratorDiscoveryService
 *
 * Scans NestJS providers for @WorkerProcessor and @EntityScaler decorators
 * and registers them in the ProcessorRegistry. Also handles config-based
 * entity registration.
 */
@Injectable()
export class DecoratorDiscoveryService {
  private readonly logger = new Logger(DecoratorDiscoveryService.name);

  constructor(
    @Optional() private readonly discoveryService: DiscoveryService,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
  ) {}

  /**
   * Discover all @WorkerProcessor decorated classes and register them
   */
  discoverProcessors(registry: ProcessorRegistry): void {
    if (!this.discoveryService) return;

    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { instance, metatype } = wrapper;

      if (!instance || !metatype) continue;

      const targetClass = metatype as Type<any>;
      const options = getWorkerProcessorMetadata(targetClass);
      if (!options) continue;

      this.registerProcessor(registry, targetClass, instance, options);
    }

    this.logger.log(
      `Discovered ${registry.getAllProcessors().size} worker processor(s): ${Array.from(registry.getAllProcessors().keys()).join(', ')}`,
    );
  }

  /**
   * Discover all @EntityScaler decorated classes and register them
   */
  discoverScalers(registry: ProcessorRegistry): void {
    if (!this.discoveryService) return;

    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { instance, metatype } = wrapper;

      if (!instance || !metatype) continue;

      const targetClass = metatype as Type<any>;
      const options = getEntityScalerMetadata(targetClass);
      if (!options) continue;

      this.registerScaler(registry, targetClass, instance, options);
    }

    this.logger.log(
      `Discovered ${registry.getAllScalers().size} entity scaler(s): ${Array.from(registry.getAllScalers().keys()).join(', ')}`,
    );
  }

  /**
   * Register entity types from module config `entities` option.
   * Creates virtual processors for entities that don't have explicit @WorkerProcessor classes.
   */
  registerEntitiesFromConfig(registry: ProcessorRegistry): void {
    const entities = this.config.entities;
    if (!entities) {
      return;
    }

    const keyPrefix = resolveKeyPrefix(this.config);

    for (const [entityType, entityConfig] of Object.entries(entities)) {
      if (registry.hasProcessor(entityType)) {
        this.logger.debug(
          `Entity '${entityType}' already has a @WorkerProcessor, skipping config-based registration`,
        );
        continue;
      }

      this.logger.log(`Registering entity '${entityType}' from module config (no @WorkerProcessor needed)`);

      const queueNameFn = entityConfig.queueName
        ?? ((entityId: string) => `${keyPrefix}:${entityType}:${entityId}:queue`);

      const workerNameFn = entityConfig.workerName
        ?? ((entityId: string) => `${keyPrefix}:${entityType}:${entityId}:worker`);

      const processor: RegisteredProcessor = {
        entityType,
        processorInstance: null,
        options: {
          entityType,
          defaultEntityId: entityConfig.defaultEntityId,
          queueName: queueNameFn,
          workerName: workerNameFn,
          workerConfig: entityConfig.workerConfig,
          maxWorkersPerEntity: entityConfig.maxWorkersPerEntity ?? 1,
          idleTimeoutSeconds: entityConfig.idleTimeoutSeconds ?? 15,
          autoSpawn: entityConfig.autoSpawn !== false,
        },
        jobHandlers: new Map(),
        wildcardHandler: undefined,
        queueNameFn,
        workerNameFn,
      };

      registry.addProcessor(entityType, processor);

      this.logger.debug(
        `Registered config-based processor for '${entityType}' ` +
        `(maxWorkers: ${processor.options.maxWorkersPerEntity}, idle: ${processor.options.idleTimeoutSeconds}s)`,
      );
    }
  }

  /**
   * Register a processor from discovered or manual metadata
   */
  registerProcessor(
    registry: ProcessorRegistry,
    metatype: Type<any>,
    instance: any,
    options: WorkerProcessorOptions,
  ): void {
    const { entityType } = options;

    const handlers = getJobHandlerMetadata(metatype);
    const jobHandlers = new Map<string, { method: string; isWildcard: boolean }>();
    let wildcardHandler: { method: string } | undefined;

    for (const handler of handlers) {
      if (handler.isWildcard) {
        wildcardHandler = { method: handler.methodName };
      } else {
        jobHandlers.set(handler.jobName, {
          method: handler.methodName,
          isWildcard: false,
        });
      }
    }

    const keyPrefix = resolveKeyPrefix(this.config);
    const queueNameFn =
      typeof options.queueName === 'function'
        ? options.queueName
        : options.queueName
          ? () => options.queueName as string
          : (entityId: string) => `${keyPrefix}:${entityType}:${entityId}:queue`;

    const workerNameFn =
      typeof options.workerName === 'function'
        ? options.workerName
        : options.workerName
          ? () => options.workerName as string
          : (entityId: string) => `${keyPrefix}:${entityType}:${entityId}:worker`;

    const processor: RegisteredProcessor = {
      entityType,
      processorInstance: instance,
      options,
      jobHandlers,
      wildcardHandler,
      queueNameFn,
      workerNameFn,
    };

    registry.addProcessor(entityType, processor);

    this.logger.debug(
      `Registered processor for entity type '${entityType}' with ${jobHandlers.size} job handlers` +
        (wildcardHandler ? ' and wildcard handler' : ''),
    );
  }

  /**
   * Register a scaler from discovered or manual metadata
   */
  registerScaler(
    registry: ProcessorRegistry,
    metatype: Type<any>,
    instance: any,
    options: EntityScalerOptions,
  ): void {
    const { entityType } = options;

    const methods = {
      getActiveEntities: Reflect.getMetadata(
        GET_ACTIVE_ENTITIES_METADATA + ':method',
        metatype,
      ),
      getDesiredWorkerCount: Reflect.getMetadata(
        GET_DESIRED_WORKER_COUNT_METADATA + ':method',
        metatype,
      ),
      onSpawnWorker: Reflect.getMetadata(
        ON_SPAWN_WORKER_METADATA + ':method',
        metatype,
      ),
      onTerminateWorker: Reflect.getMetadata(
        ON_TERMINATE_WORKER_METADATA + ':method',
        metatype,
      ),
    };

    const scaler: RegisteredScaler = {
      entityType,
      scalerInstance: instance,
      options,
      methods,
    };

    registry.addScaler(entityType, scaler);

    this.logger.debug(
      `Registered scaler for entity type '${entityType}' with methods: ` +
        Object.entries(methods)
          .filter(([_, v]) => v)
          .map(([k, _]) => k)
          .join(', '),
    );
  }
}
