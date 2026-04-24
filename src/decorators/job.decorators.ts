import { JOB_COMMAND_METADATA, JOB_QUERY_METADATA } from './constants';
import {
  JobCommandOptions,
  JobQueryOptions,
  JobCommandMetadata,
  JobQueryMetadata,
} from './interfaces';
import { deriveJobName, getConstructorParamNames } from './utils';

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
 * @JobCommand('place-order')
 * export class PlaceOrderCommand {
 *   constructor(
 *     public readonly orderId: string,    // entityId (first param)
 *     public readonly customerId: string,
 *     public readonly quantity: number,
 *   ) {}
 * }
 *
 * // Option 2: Auto-derived job name (PlaceOrderCommand -> 'place-order')
 * @JobCommand()
 * export class PlaceOrderCommand { ... }
 *
 * // Option 3: With options
 * @JobCommand({
 *   name: 'reserve-stock',
 *   entityType: 'warehouse',
 *   entityIdParam: 'warehouseId',  // or 0 for first param
 * })
 * export class ReserveStockCommand { ... }
 * ```
 */
export function JobCommand(options?: string | JobCommandOptions): ClassDecorator {
  return (target: Function) => {
    const opts: JobCommandOptions = typeof options === 'string' ? { name: options } : options || {};

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
 * @JobQuery('get-order-status')
 * export class GetOrderStatusQuery {
 *   constructor(
 *     public readonly orderId: string,
 *     public readonly includeHistory: boolean,
 *   ) {}
 * }
 *
 * // Auto-derived: GetInventoryLevelQuery -> 'get-inventory-level'
 * @JobQuery()
 * export class GetInventoryLevelQuery { ... }
 * ```
 */
export function JobQuery(options?: string | JobQueryOptions): ClassDecorator {
  return (target: Function) => {
    const opts: JobQueryOptions = typeof options === 'string' ? { name: options } : options || {};

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
