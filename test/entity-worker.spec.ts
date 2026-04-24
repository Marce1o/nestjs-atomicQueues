import { EntityWorker } from '../src/workers/entity-worker';
import { ISerializedMessage } from '../src/domain';

function createMessage(overrides?: Partial<ISerializedMessage>): ISerializedMessage {
  return {
    id: 'msg-1',
    name: 'TestCommand',
    data: { foo: 'bar' },
    entityType: 'account',
    entityId: 'a-1',
    enqueuedAt: Date.now(),
    attempts: 0,
    maxAttempts: 1,
    ...overrides,
  };
}

describe('EntityWorker', () => {
  it('should process messages sequentially', async () => {
    const order: string[] = [];

    const worker = new EntityWorker(
      'account:a-1',
      async (msg) => {
        order.push(`start:${msg.id}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end:${msg.id}`);
        return msg.id;
      },
      () => {},
      () => {},
      () => {},
      0,
    );

    worker.enqueue(createMessage({ id: 'msg-1' }));
    worker.enqueue(createMessage({ id: 'msg-2' }));
    worker.enqueue(createMessage({ id: 'msg-3' }));

    // Wait for all to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(order).toEqual([
      'start:msg-1',
      'end:msg-1',
      'start:msg-2',
      'end:msg-2',
      'start:msg-3',
      'end:msg-3',
    ]);
    expect(worker.totalProcessed).toBe(3);
  });

  it('should call onResult for each completed message', async () => {
    const results: unknown[] = [];

    const worker = new EntityWorker(
      'account:a-1',
      async (msg) => `result-${msg.id}`,
      (_msg, result) => results.push(result),
      () => {},
      () => {},
      0,
    );

    worker.enqueue(createMessage({ id: 'msg-1' }));
    worker.enqueue(createMessage({ id: 'msg-2' }));

    await new Promise((r) => setTimeout(r, 50));

    expect(results).toEqual(['result-msg-1', 'result-msg-2']);
  });

  it('should call onError when handler throws', async () => {
    const errors: Error[] = [];

    const worker = new EntityWorker(
      'account:a-1',
      async () => {
        throw new Error('handler failed');
      },
      () => {},
      (_msg, err) => errors.push(err),
      () => {},
      0,
    );

    worker.enqueue(createMessage());
    await new Promise((r) => setTimeout(r, 50));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('handler failed');
    expect(worker.totalFailed).toBe(1);
  });

  it('should continue processing after a handler error', async () => {
    const results: string[] = [];

    const worker = new EntityWorker(
      'account:a-1',
      async (msg) => {
        if (msg.id === 'fail') throw new Error('fail');
        results.push(msg.id);
        return msg.id;
      },
      () => {},
      () => {},
      () => {},
      0,
    );

    worker.enqueue(createMessage({ id: 'ok-1' }));
    worker.enqueue(createMessage({ id: 'fail' }));
    worker.enqueue(createMessage({ id: 'ok-2' }));

    await new Promise((r) => setTimeout(r, 50));

    expect(results).toEqual(['ok-1', 'ok-2']);
    expect(worker.totalProcessed).toBe(2);
    expect(worker.totalFailed).toBe(1);
  });

  it('should call onIdle after idle timeout', async () => {
    const idleKeys: string[] = [];

    const worker = new EntityWorker(
      'account:a-1',
      async () => 'done',
      () => {},
      () => {},
      (key) => idleKeys.push(key),
      50, // 50ms idle timeout
    );

    worker.enqueue(createMessage());
    await new Promise((r) => setTimeout(r, 150));

    expect(idleKeys).toEqual(['account:a-1']);
    worker.destroy();
  });

  it('should not call onIdle if new messages arrive', async () => {
    const idleKeys: string[] = [];

    const worker = new EntityWorker(
      'account:a-1',
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'done';
      },
      () => {},
      () => {},
      (key) => idleKeys.push(key),
      80,
    );

    worker.enqueue(createMessage({ id: 'msg-1' }));

    // Enqueue more before idle fires
    setTimeout(() => worker.enqueue(createMessage({ id: 'msg-2' })), 30);
    setTimeout(() => worker.enqueue(createMessage({ id: 'msg-3' })), 60);

    await new Promise((r) => setTimeout(r, 200));

    // Should still have been idle eventually (after msg-3 completes + 80ms)
    expect(worker.totalProcessed).toBe(3);
    worker.destroy();
  });

  it('should drain pending messages', async () => {
    const errors: Error[] = [];

    const worker = new EntityWorker(
      'account:a-1',
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'done';
      },
      () => {},
      (_msg, err) => errors.push(err),
      () => {},
      0,
    );

    worker.enqueue(createMessage({ id: 'running' }));
    worker.enqueue(createMessage({ id: 'pending-1' }));
    worker.enqueue(createMessage({ id: 'pending-2' }));

    // Give first message time to start
    await new Promise((r) => setTimeout(r, 10));

    await worker.drain();

    // Pending messages should have been rejected
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toBe('Worker draining');

    // First message should have completed
    expect(worker.totalProcessed).toBe(1);
    worker.destroy();
  });
});
