import 'reflect-metadata';
import {
  createAtomicJobData,
  createDefaultJobOptions,
  createHighPriorityJobOptions,
  sleep,
  retry,
  getEntityQueueName,
  getEntityWorkerName,
  parseQueueName,
  createSigtermPayload,
  isSigtermJob,
  batch,
  withTimeout,
  debounce,
  throttle,
} from '../src/utils/helpers';

// ─── createAtomicJobData ────────────────────────────────────────────────────

describe('createAtomicJobData', () => {
  it('should create job data with all required fields', () => {
    const data = createAtomicJobData({
      entityType: 'user',
      entityId: 'u-123',
      type: 'command',
      commandName: 'SendMessage',
      payload: { text: 'hello' },
    });

    expect(data.uuid).toBeDefined();
    expect(typeof data.uuid).toBe('string');
    expect(data.entityType).toBe('user');
    expect(data.entityId).toBe('u-123');
    expect(data.type).toBe('command');
    expect(data.commandName).toBe('SendMessage');
    expect(data.payload).toEqual({ text: 'hello' });
  });

  it('should generate unique uuids', () => {
    const a = createAtomicJobData({ entityType: 't', entityId: '1', type: 'custom', payload: {} });
    const b = createAtomicJobData({ entityType: 't', entityId: '1', type: 'custom', payload: {} });
    expect(a.uuid).not.toBe(b.uuid);
  });

  it('should include optional metadata', () => {
    const meta = { source: 'api', priority: 'high' };
    const data = createAtomicJobData({
      entityType: 'order',
      entityId: 'o-1',
      type: 'query',
      payload: {},
      metadata: meta,
    });
    expect(data.metadata).toEqual(meta);
  });

  it('should leave metadata undefined when not provided', () => {
    const data = createAtomicJobData({
      entityType: 'x',
      entityId: '1',
      type: 'custom',
      payload: null,
    });
    expect(data.metadata).toBeUndefined();
  });

  it('should accept typed payloads', () => {
    interface MyPayload { amount: number }
    const data = createAtomicJobData<MyPayload>({
      entityType: 'account',
      entityId: 'a-1',
      type: 'command',
      payload: { amount: 100 },
    });
    expect(data.payload.amount).toBe(100);
  });
});

// ─── createDefaultJobOptions ────────────────────────────────────────────────

describe('createDefaultJobOptions', () => {
  it('should return sensible defaults', () => {
    const opts = createDefaultJobOptions();
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(false);
    expect(opts.attempts).toBe(Number.MAX_SAFE_INTEGER);
    expect(opts.backoff).toEqual({ type: 'fixed', delay: 1000 });
    expect(opts.priority).toBe(1);
  });

  it('should allow overriding individual fields', () => {
    const opts = createDefaultJobOptions({ attempts: 5, priority: 10 });
    expect(opts.attempts).toBe(5);
    expect(opts.priority).toBe(10);
    // non-overridden fields keep defaults
    expect(opts.removeOnComplete).toBe(true);
  });

  it('should allow overriding backoff', () => {
    const opts = createDefaultJobOptions({
      backoff: { type: 'exponential', delay: 2000 },
    });
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 2000 });
  });
});

// ─── createHighPriorityJobOptions ───────────────────────────────────────────

describe('createHighPriorityJobOptions', () => {
  it('should set priority to 0 (highest)', () => {
    const opts = createHighPriorityJobOptions();
    expect(opts.priority).toBe(0);
  });

  it('should allow further overrides', () => {
    const opts = createHighPriorityJobOptions({ attempts: 1 });
    expect(opts.priority).toBe(0);
    expect(opts.attempts).toBe(1);
  });
});

// ─── sleep ──────────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('should resolve after the given delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow timer jitter
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
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const result = await retry(fn, { maxAttempts: 3, baseDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should throw the last error when maxAttempts exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));

    await expect(
      retry(fn, { maxAttempts: 3, baseDelay: 10 }),
    ).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should call onRetry callback on each failure', async () => {
    const onRetry = jest.fn();
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('err1'))
      .mockRejectedValueOnce(new Error('err2'))
      .mockResolvedValue('done');

    await retry(fn, { maxAttempts: 3, baseDelay: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error));
  });

  it('should use fixed delay when exponential is false', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const start = Date.now();
    await retry(fn, { maxAttempts: 2, baseDelay: 50, exponential: false });
    const elapsed = Date.now() - start;
    // Should wait ~50ms, not 100ms (exponential would double)
    expect(elapsed).toBeLessThan(120);
  });

  it('should respect maxDelay cap', async () => {
    const fn = jest.fn()
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
    // Each retry should be capped at 50ms, not 1000ms or 2000ms
    expect(elapsed).toBeLessThan(200);
  });
});

// ─── getEntityQueueName / getEntityWorkerName ───────────────────────────────

describe('getEntityQueueName', () => {
  it('should generate name with default prefix', () => {
    expect(getEntityQueueName('user', '123')).toBe('aq:user:123:queue');
  });

  it('should accept custom prefix', () => {
    expect(getEntityQueueName('table', 't-1', 'myapp')).toBe('myapp:table:t-1:queue');
  });
});

describe('getEntityWorkerName', () => {
  it('should generate name with default prefix', () => {
    expect(getEntityWorkerName('user', '123')).toBe('aq:user:123:worker');
  });

  it('should accept custom prefix', () => {
    expect(getEntityWorkerName('table', 't-1', 'myapp')).toBe('myapp:table:t-1:worker');
  });
});

// ─── parseQueueName ─────────────────────────────────────────────────────────

describe('parseQueueName', () => {
  it('should parse a valid queue name', () => {
    const result = parseQueueName('aq:user:123:queue');
    expect(result).toEqual({
      prefix: 'aq',
      entityType: 'user',
      entityId: '123',
    });
  });

  it('should return null for names without :queue suffix', () => {
    expect(parseQueueName('aq:user:123:worker')).toBeNull();
  });

  it('should return null for short names', () => {
    expect(parseQueueName('aq:user')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseQueueName('')).toBeNull();
  });

  it('should handle custom prefixes', () => {
    const result = parseQueueName('myapp:table:t-5:queue');
    expect(result).toEqual({
      prefix: 'myapp',
      entityType: 'table',
      entityId: 't-5',
    });
  });
});

// ─── createSigtermPayload / isSigtermJob ────────────────────────────────────

describe('createSigtermPayload', () => {
  it('should create a SIGTERM payload', () => {
    const payload = createSigtermPayload('table', 't-1');
    expect(payload.entityType).toBe('table');
    expect(payload.entityId).toBe('t-1');
    expect(payload.type).toBe('custom');
    expect(payload.metadata).toEqual({ signal: 'SIGTERM' });
    expect((payload.payload as any).type).toBe('SIGTERM');
    expect(payload.uuid).toBeDefined();
  });
});

describe('isSigtermJob', () => {
  it('should return true for SIGTERM jobs', () => {
    const payload = createSigtermPayload('table', 't-1');
    expect(isSigtermJob(payload)).toBe(true);
  });

  it('should return false for regular jobs', () => {
    const data = createAtomicJobData({
      entityType: 'user',
      entityId: '1',
      type: 'command',
      payload: { msg: 'hi' },
    });
    expect(isSigtermJob(data)).toBe(false);
  });

  it('should return false for custom jobs that are not SIGTERM', () => {
    const data = createAtomicJobData({
      entityType: 'user',
      entityId: '1',
      type: 'custom',
      payload: { type: 'PING' },
    });
    expect(isSigtermJob(data)).toBe(false);
  });
});

// ─── batch ──────────────────────────────────────────────────────────────────

describe('batch', () => {
  it('should process items in chunks', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const chunks: number[][] = [];
    await batch(items, 3, async (chunk) => {
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
    await batch([1, 2], 100, async (chunk) => {
      chunks.push(chunk);
    });
    expect(chunks).toEqual([[1, 2]]);
  });

  it('should process sequentially', async () => {
    const order: number[] = [];
    await batch([1, 2, 3, 4], 2, async (chunk) => {
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
    debounced(); // reset
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
