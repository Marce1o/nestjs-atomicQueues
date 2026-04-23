import 'reflect-metadata';
import {
  EntityType,
  QueueEntityId,
  QueueEntity,
  JobCommand,
  JobQuery,
  getEntityType,
  getEntityIdProperty,
  getJobCommandMetadata,
  getJobQueryMetadata,
  ENTITY_TYPE_METADATA,
  ENTITY_ID_METADATA,
  JOB_COMMAND_METADATA,
  JOB_QUERY_METADATA,
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

