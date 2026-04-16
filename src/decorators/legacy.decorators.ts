import { SetMetadata } from '@nestjs/common';
import { ATOMIC_PROCESSOR_METADATA, JOB_TYPE_METADATA } from './constants';

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
