import { SetMetadata } from '@nestjs/common';

/**
 * Metadata keys for decorators
 */
export const ATOMIC_PROCESSOR_METADATA = 'atomic:processor';
export const ENTITY_TYPE_METADATA = 'atomic:entity-type';
export const JOB_TYPE_METADATA = 'atomic:job-type';

/**
 * @AtomicProcessor decorator
 *
 * Marks a method as an atomic job processor.
 * Can be used on handler methods to auto-register them.
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
 * Marks a class or method with an entity type for automatic registration.
 *
 * @example
 * ```typescript
 * @Injectable()
 * @EntityType('user')
 * export class UserWorkerService {
 *   // All methods in this service are associated with 'user' entity type
 * }
 * ```
 */
export const EntityType = (entityType: string): ClassDecorator & MethodDecorator => {
  return SetMetadata(ENTITY_TYPE_METADATA, entityType);
};

/**
 * @JobType decorator
 *
 * Specifies the job type for a processor method.
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class TableProcessor {
 *   @JobType('make-bet')
 *   async handleMakeBet(job: Job) {
 *     // Process bet
 *   }
 * }
 * ```
 */
export const JobType = (jobType: string): MethodDecorator => {
  return SetMetadata(JOB_TYPE_METADATA, jobType);
};

/**
 * @InjectAtomicQueue decorator
 *
 * Custom parameter decorator for injecting a specific queue.
 * Useful when you need direct access to a queue in a service.
 *
 * Note: This is a placeholder - actual implementation would use
 * NestJS's custom parameter decorators with module injection.
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
