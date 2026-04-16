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
