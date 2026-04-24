import 'reflect-metadata';
import { QueueBus } from '../src/services/queue-bus/queue-bus.service';
import { EntityType, QueueEntityId, QueueEntity } from '../src/decorators';

// ─── Test classes ───────────────────────────────────────────────────────────

@QueueEntity('order', 'orderId')
class PlaceOrderCommand {
  constructor(
    public readonly orderId: string,
    public readonly quantity: number,
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
  const mockRouter = {
    enqueue: jest.fn().mockResolvedValue({ id: 'msg-1', entityKey: 'order:o-123' }),
    enqueueAndWait: jest.fn().mockResolvedValue({ result: 42 }),
  };

  const mockConfig = {
    redis: { host: 'localhost', port: 6379 },
    keyPrefix: 'test',
    entities: {
      order: { defaultEntityId: 'orderId' },
      account: { defaultEntityId: 'accountId' },
    },
  };

  let bus: QueueBus;

  beforeEach(() => {
    jest.clearAllMocks();
    bus = new QueueBus(mockConfig as any, mockRouter as any);
  });

  describe('enqueue (direct with @EntityType)', () => {
    it('should enqueue a command with @QueueEntity decorator', async () => {
      const cmd = new PlaceOrderCommand('o-123', 50);
      const ref = await bus.enqueue(cmd);

      expect(ref.entityKey).toBe('order:o-123');
      expect(mockRouter.enqueue).toHaveBeenCalledTimes(1);

      const [entityType, msgName, entityId, data] = mockRouter.enqueue.mock.calls[0];
      expect(entityType).toBe('order');
      expect(msgName).toBe('PlaceOrderCommand');
      expect(entityId).toBe('o-123');
      expect(data).toEqual({ orderId: 'o-123', quantity: 50 });
    });

    it('should enqueue a command with @EntityType + @QueueEntityId', async () => {
      const cmd = new WithdrawCommand('a-99', 200);
      await bus.enqueue(cmd);

      expect(mockRouter.enqueue).toHaveBeenCalledTimes(1);
      const [entityType, , entityId] = mockRouter.enqueue.mock.calls[0];
      expect(entityType).toBe('account');
      expect(entityId).toBe('a-99');
    });

    it('should throw for undecorated commands', async () => {
      const cmd = new UndecoratedCommand('id-1');
      await expect(bus.enqueue(cmd)).rejects.toThrow(/Cannot enqueue/);
    });

    it('should allow entityId override', async () => {
      const cmd = new PlaceOrderCommand('o-123', 50);
      await bus.enqueue(cmd, { entityId: 'override-id' });

      const [, , entityId] = mockRouter.enqueue.mock.calls[0];
      expect(entityId).toBe('override-id');
    });
  });

  describe('enqueue raw (string API)', () => {
    it('should forward raw enqueue to router', async () => {
      await bus.enqueue('order', 'PlaceOrderCommand', 'o-1', { quantity: 100 });

      expect(mockRouter.enqueue).toHaveBeenCalledWith('order', 'PlaceOrderCommand', 'o-1', {
        quantity: 100,
      });
    });
  });

  describe('forEntity', () => {
    it('should enqueue via forEntity', async () => {
      const cmd = new PlaceOrderCommand('o-456', 100);
      const target = bus.forEntity('order');
      await target.enqueue(cmd);

      expect(mockRouter.enqueue).toHaveBeenCalledTimes(1);
      const [entityType, , entityId] = mockRouter.enqueue.mock.calls[0];
      expect(entityType).toBe('order');
      expect(entityId).toBe('o-456');
    });

    it('should enqueue bulk', async () => {
      const cmds = [new PlaceOrderCommand('o-1', 10), new PlaceOrderCommand('o-1', 20)];
      const target = bus.forEntity('order');
      const refs = await target.enqueueBulk(cmds);

      expect(refs).toHaveLength(2);
      expect(mockRouter.enqueue).toHaveBeenCalledTimes(2);
    });

    it('should return empty array for empty bulk', async () => {
      const target = bus.forEntity('order');
      const refs = await target.enqueueBulk([]);
      expect(refs).toEqual([]);
    });

    it('should enqueue raw via forEntity', async () => {
      const target = bus.forEntity('order');
      await target.enqueueRaw('ShipOrderCommand', 'o-1', { carrier: 'express' });

      expect(mockRouter.enqueue).toHaveBeenCalledWith('order', 'ShipOrderCommand', 'o-1', {
        carrier: 'express',
      });
    });
  });
});
