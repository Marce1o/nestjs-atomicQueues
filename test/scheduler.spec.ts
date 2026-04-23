import 'reflect-metadata';
import { SchedulerService } from '../src/services/scheduler/scheduler.service';
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
    maxAttempts: 3,
    ...overrides,
  };
}

describe('SchedulerService', () => {
  let scheduler: SchedulerService;
  let mockRedis: any;
  let mockLogService: any;
  let mockGateService: any;

  beforeEach(() => {
    mockRedis = {
      eval: jest.fn(),
      rpush: jest.fn().mockResolvedValue(1),
    };

    mockLogService = {
      getReadySetKey: () => 'test:ready',
      getLogKey: (entityKey: string) => `test:log:${entityKey}`,
      length: jest.fn().mockResolvedValue(0),
      markReady: jest.fn().mockResolvedValue(undefined),
      deadLetter: jest.fn().mockResolvedValue(undefined),
    };

    mockGateService = {
      release: jest.fn().mockResolvedValue(true),
    };

    scheduler = new SchedulerService(
      mockRedis,
      { redis: {}, keyPrefix: 'test', executor: { gateTTL: 30 } } as any,
      mockLogService,
      mockGateService,
    );
  });

  describe('pickNext', () => {
    it('should return null when no dispatchable work', async () => {
      mockRedis.eval.mockResolvedValue(null);
      const result = await scheduler.pickNext();
      expect(result).toBeNull();
    });

    it('should return a dispatch result when work is available', async () => {
      const msg = createMessage();
      mockRedis.eval.mockResolvedValue(['account:a-1', JSON.stringify(msg), 'owner-token-1']);

      const result = await scheduler.pickNext();
      expect(result).not.toBeNull();
      expect(result!.entityKey).toBe('account:a-1');
      expect(result!.message.name).toBe('TestCommand');
      expect(result!.ownerToken).toBe('owner-token-1');
    });

    it('should pass correct arguments to Lua script', async () => {
      mockRedis.eval.mockResolvedValue(null);
      await scheduler.pickNext();

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('SRANDMEMBER'),
        1,
        'test:ready',
        'test:gate:',
        'test:log:',
        expect.any(String),
        '30',
        '32',
      );
    });
  });

  describe('complete', () => {
    it('should release the gate with owner token', async () => {
      await scheduler.complete('account:a-1', 'token-1');
      expect(mockGateService.release).toHaveBeenCalledWith('account:a-1', 'token-1');
    });

    it('should re-mark entity ready if messages remain', async () => {
      mockLogService.length.mockResolvedValue(2);
      await scheduler.complete('account:a-1', 'token-1');
      expect(mockLogService.markReady).toHaveBeenCalledWith('account:a-1');
    });

    it('should not re-mark ready if no messages remain', async () => {
      mockLogService.length.mockResolvedValue(0);
      await scheduler.complete('account:a-1', 'token-1');
      expect(mockLogService.markReady).not.toHaveBeenCalled();
    });
  });

  describe('fail', () => {
    it('should re-enqueue message when attempts < maxAttempts', async () => {
      const msg = createMessage({ attempts: 0, maxAttempts: 3 });
      const error = new Error('handler failed');

      await scheduler.fail('account:a-1', 'token-1', msg, error);

      expect(mockGateService.release).toHaveBeenCalledWith('account:a-1', 'token-1');
      expect(msg.attempts).toBe(1);
      expect(mockRedis.rpush).toHaveBeenCalled();
      expect(mockLogService.markReady).toHaveBeenCalledWith('account:a-1');
    });

    it('should dead-letter when attempts >= maxAttempts', async () => {
      const msg = createMessage({ attempts: 2, maxAttempts: 3 });
      const error = new Error('handler failed');

      await scheduler.fail('account:a-1', 'token-1', msg, error);

      expect(msg.attempts).toBe(3);
      expect(mockLogService.deadLetter).toHaveBeenCalledWith('account', msg);
      expect(mockRedis.rpush).not.toHaveBeenCalled();
    });

    it('should use entity-specific retry config', async () => {
      const configScheduler = new SchedulerService(
        mockRedis,
        {
          redis: {},
          keyPrefix: 'test',
          entities: { account: { retry: { maxAttempts: 1 } } },
        } as any,
        mockLogService,
        mockGateService,
      );

      const msg = createMessage({ attempts: 0, maxAttempts: 1 });
      await configScheduler.fail('account:a-1', 'token-1', msg, new Error('fail'));

      expect(mockLogService.deadLetter).toHaveBeenCalled();
    });
  });
});
