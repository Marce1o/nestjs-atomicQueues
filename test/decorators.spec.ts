import 'reflect-metadata';
import {
  EntityType,
  QueueEntityId,
  QueueEntity,
  JobCommand,
  JobQuery,
  Actor,
  On,
  getEntityType,
  getEntityIdProperty,
  getJobCommandMetadata,
  getJobQueryMetadata,
  getActorMetadata,
  getActorHandlers,
  ENTITY_TYPE_METADATA,
  ENTITY_ID_METADATA,
  JOB_COMMAND_METADATA,
  JOB_QUERY_METADATA,
  ACTOR_METADATA,
  ACTOR_HANDLERS_METADATA,
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
});

// ─── @Actor ─────────────────────────────────────────────────────────────────

describe('@Actor', () => {
  it('should set actor metadata with entity type', () => {
    @Actor('account')
    class AccountActor {}

    const meta = getActorMetadata(AccountActor);
    expect(meta).toBeDefined();
    expect(meta!.entityType).toBe('account');
    expect(meta!.defaultEntityId).toBeUndefined();
  });

  it('should accept optional defaultEntityId', () => {
    @Actor('table', { defaultEntityId: 'tableId' })
    class TableActor {}

    const meta = getActorMetadata(TableActor);
    expect(meta!.entityType).toBe('table');
    expect(meta!.defaultEntityId).toBe('tableId');
  });

  it('should mark class as injectable', () => {
    @Actor('game')
    class GameActor {}

    expect(Reflect.hasMetadata('injectable', GameActor)).toBe(true);
  });

  it('should return undefined for non-actor classes', () => {
    class NotAnActor {}
    expect(getActorMetadata(NotAnActor)).toBeUndefined();
  });
});

// ─── @On ────────────────────────────────────────────────────────────────────

describe('@On', () => {
  class DepositCommand {
    constructor(public readonly amount: number) {}
  }
  class WithdrawCommand {
    constructor(public readonly amount: number) {}
  }

  it('should register a handler for a message class', () => {
    @Actor('account')
    class AccountActor {
      @On(DepositCommand)
      async deposit(msg: DepositCommand) {
        return msg.amount;
      }
    }

    const handlers = getActorHandlers(AccountActor);
    expect(handlers).toHaveLength(1);
    expect(handlers[0].messageClass).toBe(DepositCommand);
    expect(handlers[0].methodName).toBe('deposit');
  });

  it('should register multiple handlers', () => {
    @Actor('account')
    class MultiActor {
      @On(DepositCommand)
      async deposit(msg: DepositCommand) {}

      @On(WithdrawCommand)
      async withdraw(msg: WithdrawCommand) {}
    }

    const handlers = getActorHandlers(MultiActor);
    expect(handlers).toHaveLength(2);
    const names = handlers.map((h) => h.methodName).sort();
    expect(names).toEqual(['deposit', 'withdraw']);
  });

  it('should store per-method metadata', () => {
    class TestActor {
      @On(DepositCommand)
      async handle(msg: DepositCommand) {}
    }

    const meta = Reflect.getMetadata('atomic:actor-handler', TestActor.prototype, 'handle');
    expect(meta).toBeDefined();
    expect(meta.messageClass).toBe(DepositCommand);
    expect(meta.methodName).toBe('handle');
  });
});
