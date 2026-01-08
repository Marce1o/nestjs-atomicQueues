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
export const ENTITY_ID_METADATA = 'atomic:entity-id';
export const JOB_TYPE_METADATA = 'atomic:job-type';
export const WORKER_PROCESSOR_METADATA = 'atomic:worker-processor';
export const JOB_HANDLER_METADATA = 'atomic:job-handler';
export const ENTITY_SCALER_METADATA = 'atomic:entity-scaler';
export const GET_ACTIVE_ENTITIES_METADATA = 'atomic:get-active-entities';
export const GET_DESIRED_WORKER_COUNT_METADATA = 'atomic:get-desired-worker-count';
export const ON_SPAWN_WORKER_METADATA = 'atomic:on-spawn-worker';
export const ON_TERMINATE_WORKER_METADATA = 'atomic:on-terminate-worker';
export const JOB_COMMAND_METADATA = 'atomic:job-command';
export const JOB_QUERY_METADATA = 'atomic:job-query';

// Registry to track @EntityId usage per class (for duplicate detection)
const entityIdRegistry = new Map<Function, string>();

// =============================================================================
// DECORATOR OPTION INTERFACES
// =============================================================================

/**
 * Options for @WorkerProcessor decorator
 */
export interface WorkerProcessorOptions {
  /** Entity type this processor handles (e.g., 'table', 'user') */
  entityType: string;
  /** Default property name for entity ID extraction (optional) */
  defaultEntityId?: string;
  /** Function to generate queue name from entityId */
  queueName?: string | ((entityId: string) => string);
  /** Function to generate worker name from entityId */
  workerName?: string | ((entityId: string) => string);
  /** Worker configuration */
  workerConfig?: IWorkerConfig;
  /** 
   * If true, workerConfig fully replaces module workerDefaults (no merge).
   * If false (default), workerConfig is merged with workerDefaults.
   */
  overrideDefaults?: boolean;
  /**
   * Maximum workers per entity (default: 1).
   * Used when operating without an EntityScaler.
   */
  maxWorkersPerEntity?: number;
  /**
   * Idle timeout in seconds before a worker is considered idle and can be terminated.
   * Workers self-report idle time via heartbeat. Default: 15 seconds.
   * Used when operating without an EntityScaler.
   */
  idleTimeoutSeconds?: number;
  /**
   * If true, workers are automatically spawned when jobs arrive (scalerless mode).
   * When enabled, no @EntityScaler is required - workers spawn on job arrival
   * and terminate when idle. Default: true if no EntityScaler is registered.
   */
  autoSpawn?: boolean;
}

/**
 * Options for @EntityScaler decorator
 */
export interface EntityScalerOptions {
  /** Entity type this scaler handles */
  entityType: string;
  /** Maximum workers per entity */
  maxWorkersPerEntity?: number;
  /** 
   * Idle timeout in seconds before a worker is considered idle and can be terminated.
   * Workers self-report idle time via heartbeat. Default: 15 seconds.
   */
  idleTimeoutSeconds?: number;
}

/**
 * Options for @JobCommand decorator
 */
export interface JobCommandOptions {
  /** Job name (defaults to kebab-case of class name without 'Command' suffix) */
  name?: string;
  /** Entity type this command belongs to (optional, for scoped routing) */
  entityType?: string;
  /** Which constructor parameter is the entityId (default: 0 = first param) */
  entityIdParam?: number | string;
}

/**
 * Options for @JobQuery decorator
 */
export interface JobQueryOptions {
  /** Job name (defaults to kebab-case of class name without 'Query' suffix) */
  name?: string;
  /** Entity type this query belongs to (optional, for scoped routing) */
  entityType?: string;
  /** Which constructor parameter is the entityId (default: 0 = first param) */
  entityIdParam?: number | string;
}

/**
 * Stored job command metadata
 */
export interface JobCommandMetadata {
  jobName: string;
  entityType?: string;
  entityIdParam: number | string;
  targetClass: Function;
  paramNames: string[];
}

/**
 * Stored job query metadata
 */
export interface JobQueryMetadata {
  jobName: string;
  entityType?: string;
  entityIdParam: number | string;
  targetClass: Function;
  paramNames: string[];
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
  defaultEntityId?: string;
  queueNameFn: (entityId: string) => string;
  workerNameFn: (entityId: string) => string;
  workerConfig: IWorkerConfig;
  overrideDefaults: boolean;
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
 * @EntityType decorator
 *
 * Marks a command/query class with its entity type for automatic routing.
 * When present, queueBus.enqueue(cmd) can auto-route without forEntity().
 *
 * @example
 * ```typescript
 * @EntityType('account')
 * export class WithdrawCommand {
 *   @EntityId()
 *   public readonly accountId: string;
 *   public readonly amount: number;
 * }
 *
 * // Can now use direct enqueue:
 * await queueBus.enqueue(new WithdrawCommand(accountId, amount));
 * ```
 */
export function EntityType(entityType: string): ClassDecorator {
  return (target: Function) => {
    Reflect.defineMetadata(ENTITY_TYPE_METADATA, entityType, target);
  };
}

/**
 * @EntityId decorator
 *
 * Marks a property OR constructor parameter as the entity ID for queue routing.
 * Only ONE @EntityId() allowed per class (enforced at decoration time).
 * Overrides module-level defaultEntityId configuration.
 *
 * @example Property decorator:
 * ```typescript
 * export class TransferCommand {
 *   @EntityId()
 *   public readonly sourceAccountId: string;
 *   public readonly amount: number;
 * }
 * ```
 *
 * @example Parameter decorator (recommended):
 * ```typescript
 * @QueueEntity('account')
 * export class TransferCommand {
 *   constructor(
 *     @EntityId() public readonly sourceAccountId: string,
 *     public readonly amount: number,
 *   ) {}
 * }
 * ```
 */
export function EntityId(): PropertyDecorator & ParameterDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex?: number,
  ) => {
    // Parameter decorator case (on constructor param)
    if (typeof parameterIndex === 'number') {
      const constructor = target as Function;
      const className = constructor.name;
      
      // Extract parameter name from constructor
      const paramName = getConstructorParamName(constructor, parameterIndex);
      if (!paramName) {
        throw new Error(
          `Cannot determine parameter name at index ${parameterIndex} in ${className}. ` +
          `Ensure you're using 'public readonly paramName' syntax.`
        );
      }
      
      // Check for duplicate
      const existing = entityIdRegistry.get(constructor);
      if (existing) {
        throw new Error(
          `Multiple @EntityId() decorators on ${className}. ` +
          `Found on '${existing}' and '${paramName}'. ` +
          `Only one parameter/property can be the entity ID.`
        );
      }
      
      entityIdRegistry.set(constructor, paramName);
      Reflect.defineMetadata(ENTITY_ID_METADATA, paramName, constructor);
      return;
    }
    
    // Property decorator case (on class property)
    const constructor = target.constructor;
    const className = constructor.name;
    const propName = String(propertyKey);
    
    // Check for duplicate @EntityId on same class
    const existing = entityIdRegistry.get(constructor);
    if (existing) {
      throw new Error(
        `Multiple @EntityId() decorators on ${className}. ` +
        `Found on '${existing}' and '${propName}'. ` +
        `Only one property can be the entity ID.`
      );
    }
    
    entityIdRegistry.set(constructor, propName);
    Reflect.defineMetadata(ENTITY_ID_METADATA, propName, constructor);
  };
}

/**
 * Extract parameter name from constructor function by parsing its string representation.
 * Works with TypeScript's 'public readonly paramName' shorthand.
 */
function getConstructorParamName(constructor: Function, index: number): string | undefined {
  const fnStr = constructor.toString();
  
  // Match constructor parameters - handles various formats
  const constructorMatch = fnStr.match(/constructor\s*\(([^)]*)\)/);
  if (!constructorMatch) return undefined;
  
  const paramsStr = constructorMatch[1];
  if (!paramsStr.trim()) return undefined;
  
  // Split by comma, but be careful with nested generics/objects
  const params = splitParams(paramsStr);
  if (index >= params.length) return undefined;
  
  const param = params[index].trim();
  
  // Extract the actual parameter name, handling:
  // - @Decorator() public readonly paramName: Type
  // - public readonly paramName: Type
  // - paramName: Type
  // - paramName
  const nameMatch = param.match(/(?:@\w+\([^)]*\)\s*)*(?:public\s+)?(?:readonly\s+)?(\w+)/);
  return nameMatch ? nameMatch[1] : undefined;
}

/**
 * Split parameter string by commas, respecting nested structures
 */
function splitParams(paramsStr: string): string[] {
  const params: string[] = [];
  let current = '';
  let depth = 0;
  
  for (const char of paramsStr) {
    if (char === '(' || char === '<' || char === '{' || char === '[') {
      depth++;
      current += char;
    } else if (char === ')' || char === '>' || char === '}' || char === ']') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      params.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  
  if (current.trim()) {
    params.push(current);
  }
  
  return params;
}

/**
 * Get the entity type from a command/query class decorated with @EntityType or @QueueEntity
 */
export function getEntityType(target: Function): string | undefined {
  return Reflect.getMetadata(ENTITY_TYPE_METADATA, target);
}

/**
 * Get the entity ID property name from a class decorated with @EntityId or @QueueEntity
 */
export function getEntityIdProperty(target: Function): string | undefined {
  return Reflect.getMetadata(ENTITY_ID_METADATA, target);
}

// =============================================================================
// NEW COMBINED DECORATOR - Less Invasive
// =============================================================================

/**
 * @QueueEntity decorator
 *
 * Single decorator that combines @EntityType and @EntityId into one.
 * This is the recommended way to mark commands/queries for queue routing.
 *
 * @param entityType - The entity type for routing (e.g., 'table', 'account')
 * @param entityIdProperty - Optional property name containing the entity ID.
 *                           If omitted, uses module-level defaultEntityId from entities config.
 *
 * @example
 * // With explicit property name:
 * @QueueEntity('table', 'tableId')
 * export class MakeBetCommand {
 *   constructor(
 *     public readonly tableId: string,  // ← unchanged!
 *     public readonly amount: number,
 *   ) {}
 * }
 *
 * @example
 * // Using module default (entities config has defaultEntityId: 'tableId'):
 * @QueueEntity('table')
 * export class DealCommand {
 *   constructor(
 *     public readonly tableId: string,
 *     public readonly card: string,
 *   ) {}
 * }
 *
 * @example
 * // Then just enqueue directly:
 * await queueBus.enqueue(new MakeBetCommand(tableId, 100));
 */
export function QueueEntity(entityType: string, entityIdProperty?: string): ClassDecorator {
  return (target: Function) => {
    // Always set entity type
    Reflect.defineMetadata(ENTITY_TYPE_METADATA, entityType, target);
    
    // Set entity ID property if provided (otherwise falls back to module config)
    if (entityIdProperty) {
      Reflect.defineMetadata(ENTITY_ID_METADATA, entityIdProperty, target);
    }
  };
}

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
    // Store the options with defaults
    const metadata = {
      ...options,
      overrideDefaults: options.overrideDefaults ?? false,
    };
    Reflect.defineMetadata(WORKER_PROCESSOR_METADATA, metadata, target);

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
// JOB COMMAND/QUERY DECORATORS - Zero-Boilerplate CQRS Integration
// =============================================================================

/**
 * Helper to convert class name to kebab-case job name
 * MakeBetCommand -> make-bet
 * ProcessPaymentCommand -> process-payment
 */
function deriveJobName(className: string, suffix: string): string {
  return className
    .replace(new RegExp(`${suffix}$`), '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Helper to extract constructor parameter names using reflection
 */
function getConstructorParamNames(target: Function): string[] {
  const paramTypes = Reflect.getMetadata('design:paramtypes', target) || [];
  
  // Try to extract parameter names from the constructor string
  const constructorStr = target.toString();
  const match = constructorStr.match(/constructor\s*\(([^)]*)\)/);
  
  if (match && match[1]) {
    return match[1]
      .split(',')
      .map((param) => {
        // Handle various patterns: 
        // "public readonly tableId: string" -> "tableId"
        // "tableId" -> "tableId"
        // "private tableId: string" -> "tableId"
        const cleaned = param.trim();
        const nameMatch = cleaned.match(/(?:public\s+)?(?:private\s+)?(?:protected\s+)?(?:readonly\s+)?(\w+)/);
        return nameMatch ? nameMatch[1] : cleaned;
      })
      .filter((name) => name.length > 0);
  }
  
  // Fallback: generate param0, param1, etc.
  return paramTypes.map((_: any, i: number) => `param${i}`);
}

/**
 * @JobCommand class decorator
 *
 * Marks a command class for automatic job routing. When a job with the
 * specified name arrives, the library will automatically instantiate
 * the command with entityId + job.data and execute it via CommandBus.
 *
 * This eliminates the need for @JobHandler boilerplate in processors.
 *
 * @example
 * ```typescript
 * // Option 1: Explicit job name
 * @JobCommand('make-bet')
 * export class MakeBetCommand {
 *   constructor(
 *     public readonly tableId: string,    // entityId (first param)
 *     public readonly playerId: string,
 *     public readonly amount: number,
 *   ) {}
 * }
 *
 * // Option 2: Auto-derived job name (MakeBetCommand -> 'make-bet')
 * @JobCommand()
 * export class MakeBetCommand { ... }
 *
 * // Option 3: With options
 * @JobCommand({
 *   name: 'place-bet',
 *   entityType: 'table',
 *   entityIdParam: 'tableId',  // or 0 for first param
 * })
 * export class PlaceBetCommand { ... }
 * ```
 */
export function JobCommand(options?: string | JobCommandOptions): ClassDecorator {
  return (target: Function) => {
    const opts: JobCommandOptions = typeof options === 'string' 
      ? { name: options } 
      : (options || {});
    
    const jobName = opts.name || deriveJobName(target.name, 'Command');
    const paramNames = getConstructorParamNames(target);
    
    const metadata: JobCommandMetadata = {
      jobName,
      entityType: opts.entityType,
      entityIdParam: opts.entityIdParam ?? 0,
      targetClass: target,
      paramNames,
    };
    
    Reflect.defineMetadata(JOB_COMMAND_METADATA, metadata, target);
  };
}

/**
 * @JobQuery class decorator
 *
 * Marks a query class for automatic job routing. When a job with the
 * specified name arrives, the library will automatically instantiate
 * the query with entityId + job.data and execute it via QueryBus.
 *
 * @example
 * ```typescript
 * @JobQuery('get-score')
 * export class GetScoreQuery {
 *   constructor(
 *     public readonly tableId: string,
 *     public readonly seatIndex: number,
 *   ) {}
 * }
 *
 * // Auto-derived: GetTableStateQuery -> 'get-table-state'
 * @JobQuery()
 * export class GetTableStateQuery { ... }
 * ```
 */
export function JobQuery(options?: string | JobQueryOptions): ClassDecorator {
  return (target: Function) => {
    const opts: JobQueryOptions = typeof options === 'string' 
      ? { name: options } 
      : (options || {});
    
    const jobName = opts.name || deriveJobName(target.name, 'Query');
    const paramNames = getConstructorParamNames(target);
    
    const metadata: JobQueryMetadata = {
      jobName,
      entityType: opts.entityType,
      entityIdParam: opts.entityIdParam ?? 0,
      targetClass: target,
      paramNames,
    };
    
    Reflect.defineMetadata(JOB_QUERY_METADATA, metadata, target);
  };
}

/**
 * Get JobCommand metadata from a class
 */
export function getJobCommandMetadata(target: Function): JobCommandMetadata | undefined {
  return Reflect.getMetadata(JOB_COMMAND_METADATA, target);
}

/**
 * Get JobQuery metadata from a class
 */
export function getJobQueryMetadata(target: Function): JobQueryMetadata | undefined {
  return Reflect.getMetadata(JOB_QUERY_METADATA, target);
}

/**
 * Check if a class is a JobCommand
 */
export function isJobCommand(target: Function): boolean {
  return Reflect.hasMetadata(JOB_COMMAND_METADATA, target);
}

/**
 * Check if a class is a JobQuery
 */
export function isJobQuery(target: Function): boolean {
  return Reflect.hasMetadata(JOB_QUERY_METADATA, target);
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
