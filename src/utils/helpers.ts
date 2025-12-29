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
 * Sleep utility for async operations.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry utility with exponential backoff.
 *
 * @example
 * ```typescript
 * const result = await retry(
 *   () => someUnreliableOperation(),
 *   { maxAttempts: 3, baseDelay: 1000 },
 * );
 * ```
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts: number;
    baseDelay: number;
    maxDelay?: number;
    exponential?: boolean;
    onRetry?: (attempt: number, error: Error) => void;
  },
): Promise<T> {
  const { maxAttempts, baseDelay, maxDelay = 30000, exponential = true, onRetry } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxAttempts) {
        throw lastError;
      }

      if (onRetry) {
        onRetry(attempt, lastError);
      }

      const delay = exponential
        ? Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay)
        : baseDelay;

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Generate a queue name for an entity.
 */
export function getEntityQueueName(
  entityType: string,
  entityId: string,
  prefix = 'aq',
): string {
  return `${prefix}:${entityType}:${entityId}:queue`;
}

/**
 * Generate a worker name for an entity.
 */
export function getEntityWorkerName(
  entityType: string,
  entityId: string,
  prefix = 'aq',
): string {
  return `${prefix}:${entityType}:${entityId}:worker`;
}

/**
 * Parse a queue name to extract entity info.
 */
export function parseQueueName(queueName: string): {
  prefix: string;
  entityType: string;
  entityId: string;
} | null {
  const parts = queueName.split(':');
  if (parts.length >= 4 && parts[3] === 'queue') {
    return {
      prefix: parts[0],
      entityType: parts[1],
      entityId: parts[2],
    };
  }
  return null;
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

/**
 * Batch utility for processing items in chunks.
 *
 * @example
 * ```typescript
 * await batch(items, 10, async (chunk) => {
 *   await Promise.all(chunk.map(processItem));
 * });
 * ```
 */
export async function batch<T>(
  items: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    await processor(chunk);
  }
}

/**
 * Create a timeout promise that rejects after specified ms.
 */
export function createTimeout(ms: number, message = 'Operation timed out'): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Run an operation with a timeout.
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   someAsyncOperation(),
 *   5000,
 *   'Operation took too long',
 * );
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string,
): Promise<T> {
  return Promise.race([promise, createTimeout(ms, message)]);
}

/**
 * Debounce utility for functions.
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Throttle utility for functions.
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let lastCall = 0;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= ms) {
      lastCall = now;
      fn(...args);
    }
  };
}
