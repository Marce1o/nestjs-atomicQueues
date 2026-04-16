import { WORKER_PROCESSOR_METADATA, JOB_HANDLER_METADATA } from './constants';
import { WorkerProcessorOptions, JobHandlerMetadata } from './interfaces';

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
