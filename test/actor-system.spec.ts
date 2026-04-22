import 'reflect-metadata';
import { ActorSystem } from '../src/services/actor-system/actor-system.service';

describe('ActorSystem', () => {
  let actorSystem: ActorSystem;
  let mockLogService: any;
  let mockExecutorPool: any;
  let mockResultCollector: any;

  beforeEach(() => {
    mockLogService = {
      append: jest.fn().mockResolvedValue(1),
    };

    mockExecutorPool = {
      tickle: jest.fn().mockResolvedValue(undefined),
    };

    mockResultCollector = {
      waitForResult: jest.fn(),
    };

    actorSystem = new ActorSystem(
      { redis: {}, keyPrefix: 'test' } as any,
      mockLogService,
      mockExecutorPool,
      mockResultCollector,
    );
  });

  describe('send', () => {
    it('should enqueue a message and tickle', async () => {
      class DepositCommand {
        constructor(public readonly amount: number) {}
      }

      const ref = await actorSystem.send('account', 'a-1', new DepositCommand(100));

      expect(ref.id).toBeDefined();
      expect(ref.entityKey).toBe('account:a-1');
      expect(mockLogService.append).toHaveBeenCalledTimes(1);
      expect(mockExecutorPool.tickle).toHaveBeenCalledTimes(1);

      const appendCall = mockLogService.append.mock.calls[0];
      expect(appendCall[0]).toBe('account:a-1');
      expect(appendCall[1].name).toBe('DepositCommand');
      expect(appendCall[1].data).toEqual({ amount: 100 });
      expect(appendCall[1].entityType).toBe('account');
      expect(appendCall[1].entityId).toBe('a-1');
    });

    it('should serialize message properties', async () => {
      class TransferCommand {
        constructor(
          public readonly from: string,
          public readonly to: string,
          public readonly amount: number,
        ) {}
      }

      await actorSystem.send('account', 'a-1', new TransferCommand('a-1', 'a-2', 50));

      const msg = mockLogService.append.mock.calls[0][1];
      expect(msg.data).toEqual({ from: 'a-1', to: 'a-2', amount: 50 });
    });

    it('should generate unique message IDs', async () => {
      class Cmd {
        constructor(public readonly v: number) {}
      }

      const ref1 = await actorSystem.send('account', 'a-1', new Cmd(1));
      const ref2 = await actorSystem.send('account', 'a-1', new Cmd(2));
      expect(ref1.id).not.toBe(ref2.id);
    });

    it('should use retry config from entity settings', async () => {
      const system = new ActorSystem(
        {
          redis: {},
          keyPrefix: 'test',
          entities: { account: { retry: { maxAttempts: 5 } } },
        } as any,
        mockLogService,
        mockExecutorPool,
        mockResultCollector,
      );

      class Cmd {
        constructor(public readonly v: number) {}
      }
      await system.send('account', 'a-1', new Cmd(1));

      const msg = mockLogService.append.mock.calls[0][1];
      expect(msg.maxAttempts).toBe(5);
    });
  });

  describe('sendAndWait', () => {
    it('should register wait before enqueueing and return result', async () => {
      class Cmd {
        constructor(public readonly v: number) {}
      }

      mockResultCollector.waitForResult.mockResolvedValue(42);

      const result = await actorSystem.sendAndWait('account', 'a-1', new Cmd(1), 5000);
      expect(result).toBe(42);
      expect(mockResultCollector.waitForResult).toHaveBeenCalledTimes(1);
      expect(mockLogService.append).toHaveBeenCalledTimes(1);

      // waitForResult must be called with a correlationId and timeout
      const [correlationId, timeout] = mockResultCollector.waitForResult.mock.calls[0];
      expect(typeof correlationId).toBe('string');
      expect(timeout).toBe(5000);
    });
  });
});
