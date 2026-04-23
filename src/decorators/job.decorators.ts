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
