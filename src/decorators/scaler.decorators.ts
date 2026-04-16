import {
  ENTITY_SCALER_METADATA,
  GET_ACTIVE_ENTITIES_METADATA,
  GET_DESIRED_WORKER_COUNT_METADATA,
  ON_SPAWN_WORKER_METADATA,
  ON_TERMINATE_WORKER_METADATA,
} from './constants';
import { EntityScalerOptions } from './interfaces';

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
