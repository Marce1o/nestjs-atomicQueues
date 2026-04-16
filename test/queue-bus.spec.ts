import 'reflect-metadata';
import { QueueBus } from '../src/services/queue-bus/queue-bus.service';
import {
  EntityType,
  QueueEntityId,
  QueueEntity,
  WorkerProcessor,
} from '../src/decorators';
import { IAtomicQueuesModuleConfig } from '../src/domain';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'job-1', name: 'TestCommand' }),
  addBulk: jest.fn().mockResolvedValue([{ id: 'j1' }, { id: 'j2' }]),
};

const mockQueueEvents = {
  waitUntilFinished: jest.fn(),
};

const mockQueueManager = {
  getOrCreateQueue: jest.fn().mockReturnValue(mockQueue),
  getQueueEvents: jest.fn().mockResolvedValue(mockQueueEvents),
};

const mockConfig: IAtomicQueuesModuleConfig = {
  redis: { host: 'localhost', port: 6379 },
  keyPrefix: 'test',
  entities: {
    table: {
      defaultEntityId: 'tableId',
      queueName: (id: string) => `table-${id}-queue`,
    },
    account: {
      defaultEntityId: 'accountId',
    },
  },
};

// ─── Test classes ───────────────────────────────────────────────────────────

@WorkerProcessor({
  entityType: 'table',
  queueName: (id: string) => `table-${id}-queue`,
  workerConfig: { concurrency: 1 },
})
class TableWorkerProcessor {}

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
  beforeEach(() => {
    // Clear the global registry between tests via a fresh registration
    // The registry is static, so we test additive behavior
  });

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

// ─── QueueBus.forProcessor() ────────────────────────────────────────────────

describe('QueueBus.forProcessor()', () => {
  let bus: QueueBus;

  beforeEach(() => {
    jest.clearAllMocks();
    bus = new QueueBus(mockQueueManager as any, mockConfig);
  });

  it('should return a QueueTarget for a valid @WorkerProcessor class', () => {
    const target = bus.forProcessor(TableWorkerProcessor);
    expect(target).toBeDefined();
  });

  it('should throw for non-decorated classes', () => {
    class NotAProcessor {}
    expect(() => bus.forProcessor(NotAProcessor as any)).toThrow(
      /not decorated with @WorkerProcessor/,
    );
  });

  it('should enqueue a command to the correct queue', async () => {
    const cmd = new MakeBetCommand('t-123', 50);
    const target = bus.forProcessor(TableWorkerProcessor);
    const job = await target.enqueue(cmd);

    expect(mockQueueManager.getOrCreateQueue).toHaveBeenCalledWith('table-t-123-queue');
    expect(mockQueue.add).toHaveBeenCalledWith(
      'MakeBetCommand',
      { tableId: 't-123', amount: 50 },
      undefined,
    );
  });

  it('should allow entityId override', async () => {
    const cmd = new MakeBetCommand('t-123', 50);
    const target = bus.forProcessor(TableWorkerProcessor);
    await target.enqueue(cmd, { entityId: 'override-id' });

    expect(mockQueueManager.getOrCreateQueue).toHaveBeenCalledWith('table-override-id-queue');
  });

  it('should pass jobOptions through', async () => {
    const cmd = new MakeBetCommand('t-1', 10);
    const target = bus.forProcessor(TableWorkerProcessor);
    await target.enqueue(cmd, { jobOptions: { priority: 0 } });

    expect(mockQueue.add).toHaveBeenCalledWith(
      'MakeBetCommand',
      expect.any(Object),
      { priority: 0 },
    );
  });

  it('should cache processor metadata', () => {
    // Call forProcessor twice - should not throw
    const target1 = bus.forProcessor(TableWorkerProcessor);
    const target2 = bus.forProcessor(TableWorkerProcessor);
    expect(target1).toBeDefined();
    expect(target2).toBeDefined();
  });
});

// ─── QueueBus.forEntity() ───────────────────────────────────────────────────

describe('QueueBus.forEntity()', () => {
  let bus: QueueBus;

  beforeEach(() => {
    jest.clearAllMocks();
    bus = new QueueBus(mockQueueManager as any, mockConfig);
  });

  it('should use entity config queueName function when available', async () => {
    const cmd = new MakeBetCommand('t-456', 100);
    const target = bus.forEntity('table');
    await target.enqueue(cmd);

    // table entity config has queueName: (id) => `table-${id}-queue`
    expect(mockQueueManager.getOrCreateQueue).toHaveBeenCalledWith('table-t-456-queue');
  });

  it('should use default queue name when no entity config queueName', async () => {
    const cmd = { accountId: 'a-1', amount: 50 };
    const target = bus.forEntity('account');
    await target.enqueue(cmd as any);

    // account config has no queueName, so uses default: {keyPrefix}-{entityType}-{entityId}-queue
    expect(mockQueueManager.getOrCreateQueue).toHaveBeenCalledWith('test-account-a-1-queue');
  });

  it('should return empty array for empty bulk', async () => {
    const target = bus.forEntity('table');
    const result = await target.enqueueBulk([]);
    expect(result).toEqual([]);
  });
});

// ─── QueueBus.enqueue() (direct with @EntityType) ──────────────────────────

describe('QueueBus.enqueue() (direct)', () => {
  let bus: QueueBus;

  beforeEach(() => {
    jest.clearAllMocks();
    bus = new QueueBus(mockQueueManager as any, mockConfig);
  });

  it('should route to the correct entity type queue', async () => {
    const cmd = new WithdrawCommand('a-99', 200);
    await bus.enqueue(cmd);

    // @EntityType('account') -> forEntity('account') -> default queue name
    expect(mockQueueManager.getOrCreateQueue).toHaveBeenCalledWith('test-account-a-99-queue');
  });

  it('should throw for undecorated commands', async () => {
    const cmd = new UndecoratedCommand('id-1');
    await expect(bus.enqueue(cmd)).rejects.toThrow(/Cannot enqueue.*directly/);
  });
});

// ─── QueueBus.execute() (legacy) ────────────────────────────────────────────

describe('QueueBus.execute() (legacy)', () => {
  let bus: QueueBus;

  beforeEach(() => {
    jest.clearAllMocks();
    bus = new QueueBus(mockQueueManager as any, mockConfig);
  });

  it('should resolve queue pattern with entityId', async () => {
    const cmd = { entityId: 'e-1', value: 42 };
    await bus.execute('{entityId}-queue', cmd as any);

    expect(mockQueueManager.getOrCreateQueue).toHaveBeenCalledWith('e-1-queue');
    expect(mockQueue.add).toHaveBeenCalledWith(
      'Object',
      expect.objectContaining({ entityId: 'e-1', value: 42 }),
      undefined,
    );
  });

  it('should use explicit entityId option over extracted one', async () => {
    const cmd = { entityId: 'auto', data: 1 };
    await bus.execute('{entityId}-q', cmd as any, { entityId: 'manual' });

    expect(mockQueueManager.getOrCreateQueue).toHaveBeenCalledWith('manual-q');
  });

  it('executeBulk should return empty for empty input', async () => {
    const result = await bus.executeBulk('pattern', []);
    expect(result).toEqual([]);
  });
});
