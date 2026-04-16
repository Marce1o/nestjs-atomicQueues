import 'reflect-metadata';
import {
  EntityType,
  QueueEntityId,
  QueueEntity,
  JobHandler,
  WorkerProcessor,
  EntityScaler,
  GetActiveEntities,
  GetDesiredWorkerCount,
  OnSpawnWorker,
  OnTerminateWorker,
  JobCommand,
  JobQuery,
  AtomicProcessor,
  JobType,
  InjectAtomicQueue,
  getEntityType,
  getEntityIdProperty,
  getWorkerProcessorMetadata,
  getJobHandlerMetadata,
  getEntityScalerMetadata,
  getJobCommandMetadata,
  getJobQueryMetadata,
  isWorkerProcessor,
  isEntityScaler,
  isJobCommand,
  isJobQuery,
  ENTITY_TYPE_METADATA,
  ENTITY_ID_METADATA,
  WORKER_PROCESSOR_METADATA,
  ENTITY_SCALER_METADATA,
  JOB_HANDLER_METADATA,
  JOB_COMMAND_METADATA,
  JOB_QUERY_METADATA,
  ATOMIC_PROCESSOR_METADATA,
  JOB_TYPE_METADATA,
} from '../src/decorators';

// ─── @EntityType ────────────────────────────────────────────────────────────

describe('@EntityType', () => {
  it('should set entity type metadata', () => {
    @EntityType('account')
    class TestCommand {}

    expect(getEntityType(TestCommand)).toBe('account');
  });

  it('should return undefined for undecorated classes', () => {
    class Plain {}
    expect(getEntityType(Plain)).toBeUndefined();
  });
});

// ─── @QueueEntityId ─────────────────────────────────────────────────────────

describe('@QueueEntityId', () => {
  it('should mark a property as the entity ID', () => {
    class TestCmd {
      @QueueEntityId()
      public readonly accountId!: string;
      public readonly amount!: number;
    }

    expect(getEntityIdProperty(TestCmd)).toBe('accountId');
  });

  it('should work as a parameter decorator', () => {
    class ParamCmd {
      constructor(
        @QueueEntityId() public readonly userId: string,
        public readonly data: string,
      ) {}
    }

    expect(getEntityIdProperty(ParamCmd)).toBe('userId');
  });
});

// ─── @QueueEntity ───────────────────────────────────────────────────────────

describe('@QueueEntity', () => {
  it('should set both entity type and entity ID property', () => {
    @QueueEntity('table', 'tableId')
    class DealCommand {
      constructor(
        public readonly tableId: string,
        public readonly card: string,
      ) {}
    }

    expect(getEntityType(DealCommand)).toBe('table');
    expect(getEntityIdProperty(DealCommand)).toBe('tableId');
  });

  it('should set entity type only when entityIdProperty is omitted', () => {
    @QueueEntity('account')
    class DepositCommand {
      constructor(public readonly amount: number) {}
    }

    expect(getEntityType(DepositCommand)).toBe('account');
    expect(getEntityIdProperty(DepositCommand)).toBeUndefined();
  });
});

// ─── @WorkerProcessor ───────────────────────────────────────────────────────

describe('@WorkerProcessor', () => {
  it('should store processor metadata', () => {
    @WorkerProcessor({
      entityType: 'table',
      queueName: (id) => `${id}-queue`,
      workerConfig: { concurrency: 2 },
    })
    class TableProcessor {}

    const meta = getWorkerProcessorMetadata(TableProcessor);
    expect(meta).toBeDefined();
    expect(meta!.entityType).toBe('table');
    expect(typeof meta!.queueName).toBe('function');
    expect(meta!.workerConfig?.concurrency).toBe(2);
    expect(meta!.overrideDefaults).toBe(false);
  });

  it('should detect WorkerProcessor classes', () => {
    @WorkerProcessor({ entityType: 'user' })
    class UserProcessor {}

    class NotAProcessor {}

    expect(isWorkerProcessor(UserProcessor)).toBe(true);
    expect(isWorkerProcessor(NotAProcessor)).toBe(false);
  });

  it('should respect overrideDefaults option', () => {
    @WorkerProcessor({ entityType: 'test', overrideDefaults: true })
    class OverrideProcessor {}

    const meta = getWorkerProcessorMetadata(OverrideProcessor);
    expect(meta!.overrideDefaults).toBe(true);
  });

  it('should mark class as injectable', () => {
    @WorkerProcessor({ entityType: 'test' })
    class InjectableProcessor {}

    expect(Reflect.hasMetadata('injectable', InjectableProcessor)).toBe(true);
  });
});

// ─── @JobHandler ────────────────────────────────────────────────────────────

describe('@JobHandler', () => {
  it('should register specific job handlers', () => {
    @WorkerProcessor({ entityType: 'game' })
    class GameProcessor {
      @JobHandler('make-bet')
      async handleBet() {}

      @JobHandler('deal-cards')
      async handleDeal() {}
    }

    const handlers = getJobHandlerMetadata(GameProcessor);
    expect(handlers).toHaveLength(2);
    expect(handlers[0].jobName).toBe('make-bet');
    expect(handlers[0].methodName).toBe('handleBet');
    expect(handlers[0].isWildcard).toBe(false);
    expect(handlers[1].jobName).toBe('deal-cards');
  });

  it('should support wildcard handler', () => {
    class WildProcessor {
      @JobHandler('*')
      async handleAll() {}
    }

    const handlers = getJobHandlerMetadata(WildProcessor);
    expect(handlers).toHaveLength(1);
    expect(handlers[0].isWildcard).toBe(true);
    expect(handlers[0].jobName).toBe('*');
  });
});

// ─── @EntityScaler ──────────────────────────────────────────────────────────

describe('@EntityScaler', () => {
  it('should store scaler metadata', () => {
    @EntityScaler({ entityType: 'table', maxWorkersPerEntity: 2 })
    class TableScaler {}

    const meta = getEntityScalerMetadata(TableScaler);
    expect(meta).toBeDefined();
    expect(meta!.entityType).toBe('table');
    expect(meta!.maxWorkersPerEntity).toBe(2);
  });

  it('should detect EntityScaler classes', () => {
    @EntityScaler({ entityType: 'user' })
    class UserScaler {}

    class NotAScaler {}

    expect(isEntityScaler(UserScaler)).toBe(true);
    expect(isEntityScaler(NotAScaler)).toBe(false);
  });
});

// ─── Scaler method decorators ───────────────────────────────────────────────

describe('Scaler method decorators', () => {
  @EntityScaler({ entityType: 'table' })
  class TestScaler {
    @GetActiveEntities()
    async getEntities(): Promise<string[]> {
      return [];
    }

    @GetDesiredWorkerCount()
    async getCount(_entityId: string): Promise<number> {
      return 1;
    }

    @OnSpawnWorker()
    async spawn(_entityId: string): Promise<void> {}

    @OnTerminateWorker()
    async terminate(_entityId: string): Promise<void> {}
  }

  it('@GetActiveEntities should set method metadata', () => {
    const method = Reflect.getMetadata(
      'atomic:get-active-entities:method',
      TestScaler,
    );
    expect(method).toBe('getEntities');
  });

  it('@GetDesiredWorkerCount should set method metadata', () => {
    const method = Reflect.getMetadata(
      'atomic:get-desired-worker-count:method',
      TestScaler,
    );
    expect(method).toBe('getCount');
  });

  it('@OnSpawnWorker should set method metadata', () => {
    const method = Reflect.getMetadata(
      'atomic:on-spawn-worker:method',
      TestScaler,
    );
    expect(method).toBe('spawn');
  });

  it('@OnTerminateWorker should set method metadata', () => {
    const method = Reflect.getMetadata(
      'atomic:on-terminate-worker:method',
      TestScaler,
    );
    expect(method).toBe('terminate');
  });
});

// ─── @JobCommand ────────────────────────────────────────────────────────────

describe('@JobCommand', () => {
  it('should auto-derive job name from class name', () => {
    @JobCommand()
    class MakeBetCommand {
      constructor(
        public readonly tableId: string,
        public readonly amount: number,
      ) {}
    }

    const meta = getJobCommandMetadata(MakeBetCommand);
    expect(meta).toBeDefined();
    expect(meta!.jobName).toBe('make-bet');
    expect(meta!.entityIdParam).toBe(0);
    expect(meta!.targetClass).toBe(MakeBetCommand);
  });

  it('should accept explicit job name as string', () => {
    @JobCommand('place-wager')
    class PlaceWagerCommand {
      constructor(public readonly id: string) {}
    }

    const meta = getJobCommandMetadata(PlaceWagerCommand);
    expect(meta!.jobName).toBe('place-wager');
  });

  it('should accept options object', () => {
    @JobCommand({ name: 'custom-bet', entityType: 'table', entityIdParam: 'tableId' })
    class CustomCommand {
      constructor(
        public readonly tableId: string,
        public readonly amount: number,
      ) {}
    }

    const meta = getJobCommandMetadata(CustomCommand);
    expect(meta!.jobName).toBe('custom-bet');
    expect(meta!.entityType).toBe('table');
    expect(meta!.entityIdParam).toBe('tableId');
  });

  it('should detect JobCommand classes', () => {
    @JobCommand()
    class TestCommand {
      constructor(public readonly id: string) {}
    }

    class NotACommand {}

    expect(isJobCommand(TestCommand)).toBe(true);
    expect(isJobCommand(NotACommand)).toBe(false);
  });

  it('should extract constructor parameter names', () => {
    @JobCommand()
    class ProcessPaymentCommand {
      constructor(
        public readonly accountId: string,
        public readonly amount: number,
        public readonly currency: string,
      ) {}
    }

    const meta = getJobCommandMetadata(ProcessPaymentCommand);
    expect(meta!.paramNames).toEqual(['accountId', 'amount', 'currency']);
  });
});

// ─── @JobQuery ──────────────────────────────────────────────────────────────

describe('@JobQuery', () => {
  it('should auto-derive job name from class name', () => {
    @JobQuery()
    class GetTableStateQuery {
      constructor(public readonly tableId: string) {}
    }

    const meta = getJobQueryMetadata(GetTableStateQuery);
    expect(meta).toBeDefined();
    expect(meta!.jobName).toBe('get-table-state');
  });

  it('should accept explicit name', () => {
    @JobQuery('fetch-score')
    class FetchScoreQuery {
      constructor(public readonly playerId: string) {}
    }

    const meta = getJobQueryMetadata(FetchScoreQuery);
    expect(meta!.jobName).toBe('fetch-score');
  });

  it('should detect JobQuery classes', () => {
    @JobQuery()
    class TestQuery {
      constructor(public readonly id: string) {}
    }

    class NotAQuery {}

    expect(isJobQuery(TestQuery)).toBe(true);
    expect(isJobQuery(NotAQuery)).toBe(false);
  });
});

// ─── Legacy decorators ──────────────────────────────────────────────────────

describe('Legacy decorators', () => {
  it('@AtomicProcessor should set metadata on methods', () => {
    class LegacyProcessor {
      @AtomicProcessor('send-message')
      async handle() {}
    }

    const meta = Reflect.getMetadata(
      ATOMIC_PROCESSOR_METADATA,
      LegacyProcessor.prototype.handle,
    );
    expect(meta).toBe('send-message');
  });

  it('@JobType should set metadata on methods', () => {
    class LegacyProcessor {
      @JobType('process-order')
      async handle() {}
    }

    const meta = Reflect.getMetadata(
      JOB_TYPE_METADATA,
      LegacyProcessor.prototype.handle,
    );
    expect(meta).toBe('process-order');
  });
});

// ─── @InjectAtomicQueue ─────────────────────────────────────────────────────

describe('@InjectAtomicQueue', () => {
  it('should store injection metadata', () => {
    class MyService {
      async process(
        @InjectAtomicQueue('user', 'u-1') queue: any,
      ) {}
    }

    const meta = Reflect.getMetadata(
      'atomic:inject-queue',
      MyService.prototype,
      'process',
    );
    expect(meta).toEqual([{ type: 'user', id: 'u-1', index: 0 }]);
  });

  it('should accumulate multiple injection params', () => {
    class MultiService {
      async process(
        @InjectAtomicQueue('user') userQueue: any,
        @InjectAtomicQueue('order') orderQueue: any,
      ) {}
    }

    const meta = Reflect.getMetadata(
      'atomic:inject-queue',
      MultiService.prototype,
      'process',
    );
    expect(meta).toHaveLength(2);
    // Parameter decorators execute in reverse index order
    const types = meta.map((m: any) => m.type).sort();
    expect(types).toEqual(['order', 'user']);
  });
});
