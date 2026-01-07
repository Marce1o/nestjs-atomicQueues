import { SetMetadata, Type } from '@nestjs/common';
import { IWorkerConfig } from '../domain';

// =============================================================================
// METADATA KEYS
// =============================================================================

/**
 * Metadata keys for decorators
 */
export const ATOMIC_PROCESSOR_METADATA = 'atomic:processor';
export const ENTITY_TYPE_METADATA = 'atomic:entity-type';
export const JOB_TYPE_METADATA = 'atomic:job-type';
export const WORKER_PROCESSOR_METADATA = 'atomic:worker-processor';
export const JOB_HANDLER_METADATA = 'atomic:job-handler';
export const ENTITY_SCALER_METADATA = 'atomic:entity-scaler';
export const GET_ACTIVE_ENTITIES_METADATA = 'atomic:get-active-entities';
export const GET_DESIRED_WORKER_COUNT_METADATA = 'atomic:get-desired-worker-count';
export const ON_SPAWN_WORKER_METADATA = 'atomic:on-spawn-worker';
export const ON_TERMINATE_WORKER_METADATA = 'atomic:on-terminate-worker';

// =============================================================================
// DECORATOR OPTION INTERFACES
// =============================================================================

/**
 * Options for @WorkerProcessor decorator
 */
export interface WorkerProcessorOptions {
  /** Entity type this processor handles (e.g., 'table', 'user') */
  entityType: string;
  /** Function to generate queue name from entityId */
  queueName?: string | ((entityId: string) => string);
  /** Function to generate worker name from entityId */
  workerName?: string | ((entityId: string) => string);
  /** Worker configuration */
  workerConfig?: IWorkerConfig;
}

/**
 * Options for @EntityScaler decorator
 */
export interface EntityScalerOptions {
  /** Entity type this scaler handles */
  entityType: string;
  /** Maximum workers per entity */
  maxWorkersPerEntity?: number;
}

/**
 * Stored job handler metadata
 */
export interface JobHandlerMetadata {
  jobName: string;
  methodName: string;
  isWildcard: boolean;
}

/**
 * Stored worker processor metadata
 */
export interface WorkerProcessorMetadata {
  entityType: string;
  queueNameFn: (entityId: string) => string;
  workerNameFn: (entityId: string) => string;
  workerConfig: IWorkerConfig;
  targetClass: Type<any>;
  jobHandlers: Map<string, JobHandlerMetadata>;
  wildcardHandler?: JobHandlerMetadata;
}

/**
 * Stored entity scaler metadata
 */
export interface EntityScalerMetadata {
  entityType: string;
  maxWorkersPerEntity: number;
  targetClass: Type<any>;
  getActiveEntitiesMethod?: string;
  getDesiredWorkerCountMethod?: string;
  onSpawnWorkerMethod?: string;
  onTerminateWorkerMethod?: string;
}

// =============================================================================
// LEGACY DECORATORS (Preserved for backward compatibility)
// =============================================================================

/**
 * @AtomicProcessor decorator (LEGACY)
 *
 * Marks a method as an atomic job processor.
 * Can be used on handler methods to auto-register them.
 *
 * @deprecated Use @WorkerProcessor class decorator with @JobHandler method decorators instead
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class MessageProcessor {
 *   @AtomicProcessor('send-message')
 *   async handleSendMessage(job: Job<IAtomicJobData>) {
 *     // Process the job
 *   }
 * }
 * ```
 */
export const AtomicProcessor = (jobType: string): MethodDecorator => {
  return SetMetadata(ATOMIC_PROCESSOR_METADATA, jobType);
};

/**
 * @EntityType decorator (LEGACY)
 *
 * Marks a class or method with an entity type for automatic registration.
 *
 * @deprecated Use @WorkerProcessor or @EntityScaler class decorators instead
 */
export const EntityType = (entityType: string): ClassDecorator & MethodDecorator => {
  return SetMetadata(ENTITY_TYPE_METADATA, entityType);
};

/**
 * @JobType decorator (LEGACY)
 *
 * Specifies the job type for a processor method.
 *
 * @deprecated Use @JobHandler method decorator instead
 */
export const JobType = (jobType: string): MethodDecorator => {
  return SetMetadata(JOB_TYPE_METADATA, jobType);
};

/**
 * @InjectAtomicQueue decorator
 *
 * Custom parameter decorator for injecting a specific queue.
 * Useful when you need direct access to a queue in a service.
 */
export const InjectAtomicQueue = (
  entityType: string,
  entityId?: string,
): ParameterDecorator => {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    const existingParams: Array<{ type: string; id?: string; index: number }> =
      Reflect.getMetadata('atomic:inject-queue', target, propertyKey!) || [];

    existingParams.push({
      type: entityType,
      id: entityId,
      index: parameterIndex,
    });

    Reflect.defineMetadata(
      'atomic:inject-queue',
      existingParams,
      target,
      propertyKey!,
    );
  };
};

// =============================================================================
// NEW DECORATORS - Worker-First Architecture
// =============================================================================

/**
 * @WorkerProcessor class decorator
 *
 * Marks a class as a worker processor for a specific entity type.
 * Combined with @JobHandler method decorators, this enables declarative
 * job processing with automatic worker creation and management.
 *
 * @example
 * ```typescript
 * @WorkerProcessor({
 *   entityType: 'table',
 *   queueName: (tableId) => `${tableId}-queue`,
 *   workerName: (tableId) => `table-worker-${tableId}`,
 *   workerConfig: {
 *     concurrency: 1,
 *     heartbeatTTL: 3,
 *   }
 * })
 * @Injectable()
 * export class TableWorkerProcessor {
 *   constructor(private readonly commandBus: CommandBus) {}
 *
 *   @JobHandler('make-bet')
 *   async handleMakeBet(job: Job<MakeBetData>, entityId: string) {
 *     return this.commandBus.execute(new MakeBetCommand(entityId, job.data));
 *   }
 *
 *   @JobHandler('*') // Wildcard handler for any unmatched job
 *   async handleDynamic(job: Job, entityId: string) {
 *     // Dynamic handling
 *   }
 * }
 * ```
 */
export function WorkerProcessor(options: WorkerProcessorOptions): ClassDecorator {
  return (target: Function) => {
    // Store the options on the class
    Reflect.defineMetadata(WORKER_PROCESSOR_METADATA, options, target);

    // Mark as injectable if not already
    if (!Reflect.hasMetadata('injectable', target)) {
      Reflect.defineMetadata('injectable', true, target);
    }
  };
}

/**
 * @JobHandler method decorator
 *
 * Marks a method as a handler for a specific job name.
 * Use '*' as jobName to create a wildcard handler that catches
 * any jobs not matched by specific handlers.
 *
 * @example
 * ```typescript
 * @JobHandler('make-bet')
 * async handleMakeBet(job: Job<MakeBetData>, entityId: string) {
 *   // Handle make-bet jobs
 * }
 *
 * @JobHandler('*')
 * async handleOther(job: Job, entityId: string) {
 *   // Handle any other jobs
 * }
 * ```
 */
export function JobHandler(jobName: string): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const methodName = String(propertyKey);
    const isWildcard = jobName === '*';

    // Store handler metadata on the method
    const metadata: JobHandlerMetadata = {
      jobName,
      methodName,
      isWildcard,
    };
    Reflect.defineMetadata(JOB_HANDLER_METADATA, metadata, target, propertyKey);

    // Collect all handlers on the class
    const existingHandlers: JobHandlerMetadata[] =
      Reflect.getMetadata(JOB_HANDLER_METADATA, target.constructor) || [];
    existingHandlers.push(metadata);
    Reflect.defineMetadata(JOB_HANDLER_METADATA, existingHandlers, target.constructor);

    return descriptor;
  };
}

/**
 * @EntityScaler class decorator
 *
 * Marks a class as an entity scaler provider for a specific entity type.
 * Methods decorated with @GetActiveEntities, @GetDesiredWorkerCount,
 * @OnSpawnWorker, and @OnTerminateWorker define the scaling behavior.
 *
 * @example
 * ```typescript
 * @EntityScaler({
 *   entityType: 'table',
 *   maxWorkersPerEntity: 1,
 * })
 * @Injectable()
 * export class TableEntityScaler {
 *   constructor(private readonly redis: Redis) {}
 *
 *   @GetActiveEntities()
 *   async getAllTables(): Promise<string[]> {
 *     // Return all table IDs that need workers
 *   }
 *
 *   @GetDesiredWorkerCount()
 *   async getWorkerCount(entityId: string): Promise<number> {
 *     return 1; // Each table gets 1 worker
 *   }
 *
 *   @OnSpawnWorker()
 *   async spawnWorker(entityId: string): Promise<void> {
 *     // Called when a worker should be spawned
 *   }
 * }
 * ```
 */
export function EntityScaler(options: EntityScalerOptions): ClassDecorator {
  return (target: Function) => {
    Reflect.defineMetadata(ENTITY_SCALER_METADATA, options, target);

    if (!Reflect.hasMetadata('injectable', target)) {
      Reflect.defineMetadata('injectable', true, target);
    }
  };
}

/**
 * @GetActiveEntities method decorator
 *
 * Marks a method that returns all active entity IDs for scaling decisions.
 * Used within an @EntityScaler class.
 */
export function GetActiveEntities(): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    Reflect.defineMetadata(GET_ACTIVE_ENTITIES_METADATA, true, target, propertyKey);
    Reflect.defineMetadata(
      GET_ACTIVE_ENTITIES_METADATA + ':method',
      String(propertyKey),
      target.constructor,
    );
    return descriptor;
  };
}

/**
 * @GetDesiredWorkerCount method decorator
 *
 * Marks a method that returns the desired worker count for an entity.
 * Used within an @EntityScaler class.
 */
export function GetDesiredWorkerCount(): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    Reflect.defineMetadata(GET_DESIRED_WORKER_COUNT_METADATA, true, target, propertyKey);
    Reflect.defineMetadata(
      GET_DESIRED_WORKER_COUNT_METADATA + ':method',
      String(propertyKey),
      target.constructor,
    );
    return descriptor;
  };
}

/**
 * @OnSpawnWorker method decorator
 *
 * Marks a method that is called when a worker should be spawned.
 * Used within an @EntityScaler class.
 */
export function OnSpawnWorker(): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    Reflect.defineMetadata(ON_SPAWN_WORKER_METADATA, true, target, propertyKey);
    Reflect.defineMetadata(
      ON_SPAWN_WORKER_METADATA + ':method',
      String(propertyKey),
      target.constructor,
    );
    return descriptor;
  };
}

/**
 * @OnTerminateWorker method decorator
 *
 * Marks a method that is called when a worker should be terminated.
 * Used within an @EntityScaler class.
 */
export function OnTerminateWorker(): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    Reflect.defineMetadata(ON_TERMINATE_WORKER_METADATA, true, target, propertyKey);
    Reflect.defineMetadata(
      ON_TERMINATE_WORKER_METADATA + ':method',
      String(propertyKey),
      target.constructor,
    );
    return descriptor;
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get WorkerProcessor metadata from a class
 */
export function getWorkerProcessorMetadata(target: Type<any>): WorkerProcessorOptions | undefined {
  return Reflect.getMetadata(WORKER_PROCESSOR_METADATA, target);
}

/**
 * Get all JobHandler metadata from a class
 */
export function getJobHandlerMetadata(target: Type<any>): JobHandlerMetadata[] {
  return Reflect.getMetadata(JOB_HANDLER_METADATA, target) || [];
}

/**
 * Get EntityScaler metadata from a class
 */
export function getEntityScalerMetadata(target: Type<any>): EntityScalerOptions | undefined {
  return Reflect.getMetadata(ENTITY_SCALER_METADATA, target);
}

/**
 * Check if a class is a WorkerProcessor
 */
export function isWorkerProcessor(target: Type<any>): boolean {
  return Reflect.hasMetadata(WORKER_PROCESSOR_METADATA, target);
}

/**
 * Check if a class is an EntityScaler
 */
export function isEntityScaler(target: Type<any>): boolean {
  return Reflect.hasMetadata(ENTITY_SCALER_METADATA, target);
}
