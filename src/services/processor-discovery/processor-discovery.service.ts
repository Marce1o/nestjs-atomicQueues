import {
  Injectable,
  Logger,
  OnModuleInit,
  Type,
  Inject,
  Optional,
} from '@nestjs/common';
import { ModuleRef, DiscoveryService } from '@nestjs/core';
import { ICommandBus, IQueryBus, IAtomicQueuesModuleConfig } from '../../domain';
import { CommandDiscoveryService } from '../command-discovery';
import { QueueBus } from '../queue-bus';
import { ATOMIC_QUEUES_CONFIG } from '../constants';
import { ProcessorRegistry, RegisteredProcessor, RegisteredScaler } from './processor-registry';
import { DecoratorDiscoveryService } from './decorator-discovery.service';
import { WorkerFactoryService } from './worker-factory.service';
import { ScalingRegistrationService } from './scaling-registration.service';

/**
 * ProcessorDiscoveryService
 *
 * Orchestrator that coordinates discovery, registration, worker creation,
 * and scaling setup. Delegates to focused services:
 *
 * - ProcessorRegistry: state management for processors/scalers/workers
 * - DecoratorDiscoveryService: NestJS provider scanning and registration
 * - WorkerFactoryService: worker creation and job processing
 * - ScalingRegistrationService: scaling/spawn registration logic
 *
 * @example
 * ```typescript
 * @WorkerProcessor({ entityType: 'table' })
 * @Injectable()
 * export class TableProcessor {
 *   @JobHandler('make-bet')
 *   async handleMakeBet(job: Job, entityId: string) { ... }
 * }
 *
 * @EntityScaler({ entityType: 'table' })
 * @Injectable()
 * export class TableScaler {
 *   @GetActiveEntities()
 *   async getAllTables() { ... }
 * }
 * ```
 */
@Injectable()
export class ProcessorDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(ProcessorDiscoveryService.name);

  constructor(
    @Optional() private readonly discoveryService: DiscoveryService,
    private readonly moduleRef: ModuleRef,
    private readonly registry: ProcessorRegistry,
    private readonly decoratorDiscovery: DecoratorDiscoveryService,
    private readonly workerFactory: WorkerFactoryService,
    private readonly scalingRegistration: ScalingRegistrationService,
    @Optional() private readonly commandDiscovery: CommandDiscoveryService,
    @Inject(ATOMIC_QUEUES_CONFIG)
    private readonly config: IAtomicQueuesModuleConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.discoveryService) {
      this.logger.warn(
        'DiscoveryService not available. Manual registration required.',
      );
      return;
    }

    // Phase 1: Discovery and registration
    this.decoratorDiscovery.discoverProcessors(this.registry);
    this.decoratorDiscovery.discoverScalers(this.registry);
    this.decoratorDiscovery.registerEntitiesFromConfig(this.registry);

    // Phase 2: Wire up worker factory
    this.workerFactory.setRegistry(this.registry);

    // Phase 3: Register all scaling handlers
    await this.scalingRegistration.registerAll(this.registry, this.workerFactory);

    // Phase 4: CQRS auto-wiring
    if (this.config.autoRegisterCommands !== false) {
      this.autoRegisterCommandsFromCqrs();
    }
    this.autoWireCqrsBuses();
  }

  // ==========================================================================
  // CQRS WIRING
  // ==========================================================================

  /**
   * Set the CommandBus for executing commands from QueueBus registry
   */
  setCommandBus(commandBus: ICommandBus): void {
    this.workerFactory.setCommandBus(commandBus);
    if (this.commandDiscovery) {
      this.commandDiscovery.setCommandBus(commandBus);
    }
  }

  /**
   * Set the QueryBus for executing queries from QueueBus registry
   */
  setQueryBus(queryBus: IQueryBus): void {
    this.workerFactory.setQueryBus(queryBus);
    if (this.commandDiscovery) {
      this.commandDiscovery.setQueryBus(queryBus);
    }
  }

  /**
   * Attempt to resolve CommandBus and QueryBus from the DI container.
   */
  private autoWireCqrsBuses(): void {
    if (!this.discoveryService) return;

    const providers = this.discoveryService.getProviders();

    const commandBusWrapper = providers.find(
      (w) => w.metatype?.name === 'CommandBus' && w.instance,
    );
    if (commandBusWrapper?.instance) {
      this.setCommandBus(commandBusWrapper.instance as ICommandBus);
      this.logger.log('Auto-wired CommandBus from @nestjs/cqrs');
    } else {
      this.logger.debug(
        'CommandBus not found in DI container. ' +
          'Import CqrsModule in your app or call setCommandBus() manually.',
      );
    }

    const queryBusWrapper = providers.find(
      (w) => w.metatype?.name === 'QueryBus' && w.instance,
    );
    if (queryBusWrapper?.instance) {
      this.setQueryBus(queryBusWrapper.instance as IQueryBus);
      this.logger.log('Auto-wired QueryBus from @nestjs/cqrs');
    } else {
      this.logger.debug(
        'QueryBus not found in DI container. ' +
          'Import CqrsModule in your app or call setQueryBus() manually.',
      );
    }
  }

  /**
   * Auto-discover and register commands/queries from @nestjs/cqrs handlers
   */
  private autoRegisterCommandsFromCqrs(): void {
    const { commands, queries } = QueueBus.discoverFromCqrs(this.discoveryService);

    if (commands > 0 || queries > 0) {
      this.logger.log(
        `Auto-registered ${commands} commands and ${queries} queries from CQRS handlers`,
      );
    }
  }

  // ==========================================================================
  // PUBLIC API — Delegated to Registry
  // ==========================================================================

  /**
   * Get registered processor for an entity type
   */
  getProcessor(entityType: string): RegisteredProcessor | undefined {
    return this.registry.getProcessor(entityType);
  }

  /**
   * Get registered scaler for an entity type
   */
  getScaler(entityType: string): RegisteredScaler | undefined {
    return this.registry.getScaler(entityType);
  }

  /**
   * Get all registered entity types
   */
  getRegisteredEntityTypes(): string[] {
    return this.registry.getRegisteredEntityTypes();
  }

  /**
   * Check if a worker exists for an entity
   */
  hasActiveWorker(entityType: string, entityId: string): boolean {
    return this.registry.hasActiveWorker(entityType, entityId);
  }

  /**
   * Get all active workers for an entity type
   */
  getActiveWorkers(entityType: string): string[] {
    return this.registry.getActiveWorkers(entityType);
  }

  // ==========================================================================
  // PUBLIC API — Delegated to WorkerFactory
  // ==========================================================================

  /**
   * Create a worker for an entity using the registered processor
   */
  async createWorkerForEntity(
    entityType: string,
    entityId: string,
  ): Promise<void> {
    return this.workerFactory.createWorkerForEntity(entityType, entityId);
  }

  // ==========================================================================
  // PUBLIC API — Manual Registration (Delegated to DecoratorDiscovery)
  // ==========================================================================

  /**
   * Manually register a processor class
   */
  async registerProcessorClass<T>(
    processorClass: Type<T>,
    instance?: T,
  ): Promise<void> {
    const { getWorkerProcessorMetadata } = await import('../../decorators');
    const options = getWorkerProcessorMetadata(processorClass);
    if (!options) {
      throw new Error(
        `Class ${processorClass.name} is not decorated with @WorkerProcessor`,
      );
    }

    const resolvedInstance = instance || this.moduleRef.get(processorClass, { strict: false });
    this.decoratorDiscovery.registerProcessor(this.registry, processorClass, resolvedInstance, options);
  }

  /**
   * Manually register a scaler class
   */
  async registerScalerClass<T>(
    scalerClass: Type<T>,
    instance?: T,
  ): Promise<void> {
    const { getEntityScalerMetadata } = await import('../../decorators');
    const options = getEntityScalerMetadata(scalerClass);
    if (!options) {
      throw new Error(
        `Class ${scalerClass.name} is not decorated with @EntityScaler`,
      );
    }

    const resolvedInstance = instance || this.moduleRef.get(scalerClass, { strict: false });
    this.decoratorDiscovery.registerScaler(this.registry, scalerClass, resolvedInstance, options);
  }
}
