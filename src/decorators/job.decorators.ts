import { JOB_COMMAND_METADATA, JOB_QUERY_METADATA } from './constants';
import {
  JobCommandOptions,
  JobQueryOptions,
  JobCommandMetadata,
  JobQueryMetadata,
} from './interfaces';
import { deriveJobName, getConstructorParamNames } from './utils';

/**
 * @deprecated Use `@EntityType` + `@QueueEntityId` (or `@QueueEntity`) with standard `@nestjs/cqrs`
 * `@CommandHandler` instead. This decorator will be removed in a future major version.
 */
export function JobCommand(options?: string | JobCommandOptions): ClassDecorator {
  return (target: Function) => {
    const opts: JobCommandOptions = typeof options === 'string' ? { name: options } : options || {};

    const jobName = opts.name || deriveJobName(target.name, 'Command');
    const paramNames = opts.params ?? getConstructorParamNames(target);

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
 * @deprecated Use `@EntityType` + `@QueueEntityId` (or `@QueueEntity`) with standard `@nestjs/cqrs`
 * `@QueryHandler` instead. This decorator will be removed in a future major version.
 */
export function JobQuery(options?: string | JobQueryOptions): ClassDecorator {
  return (target: Function) => {
    const opts: JobQueryOptions = typeof options === 'string' ? { name: options } : options || {};

    const jobName = opts.name || deriveJobName(target.name, 'Query');
    const paramNames = opts.params ?? getConstructorParamNames(target);

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
