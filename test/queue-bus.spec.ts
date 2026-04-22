import 'reflect-metadata';
import { QueueBus } from '../src/services/queue-bus/queue-bus.service';
import {
  EntityType,
  QueueEntityId,
  QueueEntity,
} from '../src/decorators';

// ─── Test classes ───────────────────────────────────────────────────────────

@QueueEntity('table', 'tableId')
class MakeBetCommand {
  constructor(
    public readonly tableId: string,
    public readonly amount: number,
  ) {}
}

@EntityType('account')
class WithdrawCommand {
  @QueueEntityId()
  public readonly accountId: string;
  public readonly amount: number;

  constructor(accountId: string, amount: number) {
    this.accountId = accountId;
    this.amount = amount;
  }
}

class UndecoratedCommand {
  constructor(public readonly id: string) {}
}

// ─── Static Registry ────────────────────────────────────────────────────────

describe('QueueBus static registry', () => {
  it('should register and retrieve a command class', () => {
    class RegisterTestCommand {}
    QueueBus.register(RegisterTestCommand as any, false);

    expect(QueueBus.isRegistered('RegisterTestCommand')).toBe(true);
    const entry = QueueBus.getRegistered('RegisterTestCommand');
    expect(entry).toBeDefined();
    expect(entry!.className).toBe('RegisterTestCommand');
    expect(entry!.isQuery).toBe(false);
  });

  it('should register queries with isQuery flag', () => {
    class RegisterTestQuery {}
    QueueBus.register(RegisterTestQuery as any, true);

    const entry = QueueBus.getRegistered('RegisterTestQuery');
    expect(entry!.isQuery).toBe(true);
  });

  it('should batch register commands', () => {
    class BatchCmd1 {}
    class BatchCmd2 {}
    QueueBus.registerCommands(BatchCmd1 as any, BatchCmd2 as any);

    expect(QueueBus.isRegistered('BatchCmd1')).toBe(true);
    expect(QueueBus.isRegistered('BatchCmd2')).toBe(true);
  });

  it('should batch register queries', () => {
    class BatchQuery1 {}
    class BatchQuery2 {}
    QueueBus.registerQueries(BatchQuery1 as any, BatchQuery2 as any);

    expect(QueueBus.isRegistered('BatchQuery1')).toBe(true);
    expect(QueueBus.isRegistered('BatchQuery2')).toBe(true);
  });

  it('should return false for unregistered class names', () => {
    expect(QueueBus.isRegistered('DoesNotExist')).toBe(false);
    expect(QueueBus.getRegistered('DoesNotExist')).toBeUndefined();
  });

  it('getAllRegistered should return a copy of the registry', () => {
    const all = QueueBus.getAllRegistered();
    expect(all).toBeInstanceOf(Map);
    expect(all.size).toBeGreaterThan(0);
  });
});

// ─── QueueBus instance methods (mocked dependencies) ────────────────────────

describe('QueueBus instance', () => {
  const mockRedis = {
    publish: jest.fn().mockResolvedValue(1),
    duplicate: jest.fn().mockReturnValue({
      subscribe: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
    }),
  };

  const mockLogService = {
    append: jest.fn().mockResolvedValue(1),
  };

  const mockExecutorPool = {
    tickle: jest.fn().mockResolvedValue(undefined),
  };

  const mockHandlerExecutor = {};

  const mockConfig = {
    redis: { host: 'localhost', port: 6379 },
    keyPrefix: 'test',
    entities: {
      table: { defaultEntityId: 'tableId' },
      account: { defaultEntityId: 'accountId' },
    },
  };

  let bus: QueueBus;

  beforeEach(() => {
    jest.clearAllMocks();
    bus = new QueueBus(
      mockRedis as any,
      mockConfig as any,
      mockLogService as any,
      mockExecutorPool as any,
      mockHandlerExecutor as any,
    );
  });

  describe('enqueue (direct with @EntityType)', () => {
    it('should enqueue a command with @QueueEntity decorator', async () => {
      const cmd = new MakeBetCommand('t-123', 50);
      const ref = await bus.enqueue(cmd);

      expect(ref.entityKey).toBe('table:t-123');
      expect(ref.id).toBeDefined();
      expect(mockLogService.append).toHaveBeenCalledTimes(1);
      expect(mockExecutorPool.tickle).toHaveBeenCalledTimes(1);

      const appendCall = mockLogService.append.mock.calls[0];
      expect(appendCall[0]).toBe('table:t-123');
      expect(appendCall[1].name).toBe('MakeBetCommand');
      expect(appendCall[1].data).toEqual({ tableId: 't-123', amount: 50 });
    });

    it('should enqueue a command with @EntityType + @QueueEntityId', async () => {
      const cmd = new WithdrawCommand('a-99', 200);
      const ref = await bus.enqueue(cmd);

      expect(ref.entityKey).toBe('account:a-99');
      expect(mockLogService.append).toHaveBeenCalledTimes(1);
    });

    it('should throw for undecorated commands', async () => {
      const cmd = new UndecoratedCommand('id-1');
      await expect(bus.enqueue(cmd)).rejects.toThrow(/Cannot enqueue/);
    });

    it('should allow entityId override', async () => {
      const cmd = new MakeBetCommand('t-123', 50);
      const ref = await bus.enqueue(cmd, { entityId: 'override-id' });

      expect(ref.entityKey).toBe('table:override-id');
    });
  });

  describe('forEntity', () => {
    it('should enqueue via forEntity', async () => {
      const cmd = new MakeBetCommand('t-456', 100);
      const target = bus.forEntity('table');
      const ref = await target.enqueue(cmd);

      expect(ref.entityKey).toBe('table:t-456');
      expect(mockLogService.append).toHaveBeenCalledTimes(1);
    });

    it('should enqueue bulk', async () => {
      const cmds = [
        new MakeBetCommand('t-1', 10),
        new MakeBetCommand('t-1', 20),
      ];
      const target = bus.forEntity('table');
      const refs = await target.enqueueBulk(cmds);

      expect(refs).toHaveLength(2);
      // Bulk appends individually then tickles once at end
      expect(mockLogService.append).toHaveBeenCalledTimes(2);
      // tickle is called once per _enqueue (2) + once at end of enqueueBulk (1)
      expect(mockExecutorPool.tickle).toHaveBeenCalled();
    });

    it('should return empty array for empty bulk', async () => {
      const target = bus.forEntity('table');
      const refs = await target.enqueueBulk([]);
      expect(refs).toEqual([]);
    });
  });
});
