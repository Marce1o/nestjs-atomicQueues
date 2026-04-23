import 'reflect-metadata';
import {
  sleep,
  retry,
  batch,
  withTimeout,
  debounce,
  throttle,
  resolveKeyPrefix,
  DEFAULT_KEY_PREFIX,
} from '../src/utils';

// ─── sleep ──────────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('should resolve after the given delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

// ─── retry ──────────────────────────────────────────────────────────────────

describe('retry', () => {
  it('should return immediately on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await retry(fn, { maxAttempts: 3, baseDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and succeed on later attempt', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');

    const result = await retry(fn, { maxAttempts: 3, baseDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should throw the last error when maxAttempts exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));

    await expect(retry(fn, { maxAttempts: 3, baseDelay: 10 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should call onRetry callback on each failure', async () => {
    const onRetry = jest.fn();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('err1'))
      .mockRejectedValueOnce(new Error('err2'))
      .mockResolvedValue('done');

    await retry(fn, { maxAttempts: 3, baseDelay: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error));
  });

  it('should use fixed delay when exponential is false', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');

    const start = Date.now();
    await retry(fn, { maxAttempts: 2, baseDelay: 50, exponential: false });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(120);
  });

  it('should respect maxDelay cap', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const start = Date.now();
    await retry(fn, {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 50,
      exponential: true,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});

// ─── resolveKeyPrefix ───────────────────────────────────────────────────────

describe('resolveKeyPrefix', () => {
  it('should return default prefix when not configured', () => {
    expect(resolveKeyPrefix({})).toBe(DEFAULT_KEY_PREFIX);
    expect(resolveKeyPrefix({})).toBe('aq');
  });

  it('should return custom prefix when configured', () => {
    expect(resolveKeyPrefix({ keyPrefix: 'myapp' })).toBe('myapp');
  });
});

// ─── batch ──────────────────────────────────────────────────────────────────

describe('batch', () => {
  it('should process items in chunks', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const chunks: number[][] = [];
    await batch(items, 3, async (chunk: number[]) => {
      chunks.push(chunk);
    });
    expect(chunks).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('should handle empty array', async () => {
    const processor = jest.fn();
    await batch([], 10, processor);
    expect(processor).not.toHaveBeenCalled();
  });

  it('should handle batch size larger than array', async () => {
    const chunks: number[][] = [];
    await batch([1, 2], 100, async (chunk: number[]) => {
      chunks.push(chunk);
    });
    expect(chunks).toEqual([[1, 2]]);
  });

  it('should process sequentially', async () => {
    const order: number[] = [];
    await batch([1, 2, 3, 4], 2, async (chunk: number[]) => {
      order.push(chunk[0]);
      await sleep(10);
    });
    expect(order).toEqual([1, 3]);
  });
});

// ─── withTimeout ────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('should resolve when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('done'), 1000);
    expect(result).toBe('done');
  });

  it('should reject when timeout expires', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 50)).rejects.toThrow('Operation timed out');
  });

  it('should use custom timeout message', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 50, 'Too slow!')).rejects.toThrow('Too slow!');
  });
});

// ─── debounce ───────────────────────────────────────────────────────────────

describe('debounce', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('should delay execution', () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should reset timer on repeated calls', () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 100);

    debounced();
    jest.advanceTimersByTime(50);
    debounced();
    jest.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should pass arguments to the underlying function', () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 50);

    debounced('a', 'b');
    jest.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledWith('a', 'b');
  });
});

// ─── throttle ───────────────────────────────────────────────────────────────

describe('throttle', () => {
  it('should execute immediately on first call', () => {
    const fn = jest.fn();
    const throttled = throttle(fn, 100);

    throttled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should suppress calls within the throttle window', () => {
    const fn = jest.fn();
    const throttled = throttle(fn, 100);

    throttled();
    throttled();
    throttled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should allow calls after the throttle window', async () => {
    const fn = jest.fn();
    const throttled = throttle(fn, 50);

    throttled();
    expect(fn).toHaveBeenCalledTimes(1);

    await sleep(60);
    throttled();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
