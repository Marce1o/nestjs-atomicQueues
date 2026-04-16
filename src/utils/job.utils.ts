import { v4 as uuidv4 } from 'uuid';
import { IAtomicJobData, IJobOptions } from '../domain';

/**
 * Create an atomic job data payload.
 *
 * @example
 * ```typescript
 * const jobData = createAtomicJobData({
 *   entityType: 'user',
 *   entityId: '123',
 *   type: 'command',
 *   commandName: 'SendMessageCommand',
 *   payload: { message: 'Hello!' },
 * });
 *
 * await queueManager.addJob('user-123-queue', 'send-message', jobData);
 * ```
 */
export function createAtomicJobData<T = unknown>(options: {
  entityType: string;
  entityId: string;
  type: 'command' | 'query' | 'custom';
  commandName?: string;
  payload: T;
  metadata?: Record<string, unknown>;
}): IAtomicJobData<T> {
  return {
    uuid: uuidv4(),
    entityId: options.entityId,
    entityType: options.entityType,
    type: options.type,
    commandName: options.commandName,
    payload: options.payload,
    metadata: options.metadata,
  };
}

/**
 * Create default job options with common settings.
 *
 * @example
 * ```typescript
 * const options = createDefaultJobOptions({
 *   priority: 0, // Highest priority
 *   attempts: 5,
 * });
 * ```
 */
export function createDefaultJobOptions(
  overrides?: Partial<IJobOptions>,
): IJobOptions {
  return {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: Number.MAX_SAFE_INTEGER,
    backoff: {
      type: 'fixed',
      delay: 1000,
    },
    priority: 1,
    ...overrides,
  };
}

/**
 * Create high-priority job options (for SIGTERM signals, etc.)
 */
export function createHighPriorityJobOptions(
  overrides?: Partial<IJobOptions>,
): IJobOptions {
  return createDefaultJobOptions({
    priority: 0, // Highest priority
    ...overrides,
  });
}

/**
 * Create a SIGTERM job payload for worker termination.
 */
export function createSigtermPayload<T = unknown>(
  entityType: string,
  entityId: string,
): IAtomicJobData<T> {
  return {
    uuid: uuidv4(),
    entityId,
    entityType,
    type: 'custom',
    payload: { type: 'SIGTERM' } as T,
    metadata: { signal: 'SIGTERM' },
  };
}

/**
 * Check if a job is a SIGTERM signal.
 */
export function isSigtermJob(data: IAtomicJobData): boolean {
  return (
    data.type === 'custom' &&
    (data.payload as { type?: string })?.type === 'SIGTERM'
  );
}
