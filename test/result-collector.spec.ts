import 'reflect-metadata';
import { ResultCollector } from '../src/services/result-collector/result-collector.service';

describe('ResultCollector', () => {
  let collector: ResultCollector;
  let mockRedis: any;
  let mockSubscriber: any;
  let pmessageHandler: Function;

  beforeEach(async () => {
    pmessageHandler = () => {};
    mockSubscriber = {
      psubscribe: jest.fn().mockResolvedValue(undefined),
      punsubscribe: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      on: jest.fn().mockImplementation((event: string, handler: Function) => {
        if (event === 'pmessage') pmessageHandler = handler;
      }),
    };

    mockRedis = {
      duplicate: jest.fn().mockReturnValue(mockSubscriber),
    };

    collector = new ResultCollector(
      mockRedis as any,
      { redis: {}, keyPrefix: 'test' } as any,
    );

    await collector.onModuleInit();
  });

  afterEach(async () => {
    await collector.onApplicationShutdown();
  });

  it('should subscribe with pattern on init', () => {
    expect(mockSubscriber.psubscribe).toHaveBeenCalledWith('test:results:*');
  });

  it('should resolve wait when result arrives', async () => {
    const promise = collector.waitForResult('corr-1', 5000);
    expect(collector.pendingCount()).toBe(1);

    pmessageHandler('test:results:*', 'test:results:corr-1', JSON.stringify({ result: 42 }));

    const result = await promise;
    expect(result).toBe(42);
    expect(collector.pendingCount()).toBe(0);
  });

  it('should reject wait when error result arrives', async () => {
    const promise = collector.waitForResult('corr-err', 5000);

    pmessageHandler('test:results:*', 'test:results:corr-err', JSON.stringify({ error: 'boom' }));

    await expect(promise).rejects.toThrow('boom');
    expect(collector.pendingCount()).toBe(0);
  });

  it('should reject on timeout', async () => {
    const promise = collector.waitForResult('corr-timeout', 50);

    await expect(promise).rejects.toThrow(/Result timeout after 50ms/);
    expect(collector.pendingCount()).toBe(0);
  });

  it('should handle 100 concurrent waits with correct routing', async () => {
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(collector.waitForResult(`corr-${i}`, 5000));
    }

    expect(collector.pendingCount()).toBe(100);

    // Deliver results in reverse order to prove routing works
    for (let i = 99; i >= 0; i--) {
      pmessageHandler('test:results:*', `test:results:corr-${i}`, JSON.stringify({ result: i * 10 }));
    }

    const results = await Promise.all(promises);
    for (let i = 0; i < 100; i++) {
      expect(results[i]).toBe(i * 10);
    }
    expect(collector.pendingCount()).toBe(0);
  });

  it('should silently ignore results for unknown correlationIds', () => {
    expect(() => {
      pmessageHandler('test:results:*', 'test:results:unknown-id', JSON.stringify({ result: 'ignored' }));
    }).not.toThrow();
    expect(collector.pendingCount()).toBe(0);
  });

  it('should reject all pending waits on shutdown', async () => {
    const p1 = collector.waitForResult('corr-a', 5000);
    const p2 = collector.waitForResult('corr-b', 5000);

    expect(collector.pendingCount()).toBe(2);

    await collector.onApplicationShutdown();

    await expect(p1).rejects.toThrow('Application shutting down');
    await expect(p2).rejects.toThrow('Application shutting down');
    expect(collector.pendingCount()).toBe(0);
  });

  it('should reject on malformed JSON payload', async () => {
    const promise = collector.waitForResult('corr-bad', 5000);

    pmessageHandler('test:results:*', 'test:results:corr-bad', 'not-json');

    await expect(promise).rejects.toThrow(/Failed to parse result/);
  });
});
