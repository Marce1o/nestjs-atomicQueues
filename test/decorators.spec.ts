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
    @QueueEntity('order', 'orderId')
    class ShipOrderCommand {
      constructor(
        public readonly orderId: string,
        public readonly carrier: string,
      ) {}
    }

    expect(getEntityType(ShipOrderCommand)).toBe('order');
    expect(getEntityIdProperty(ShipOrderCommand)).toBe('orderId');
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
    class PlaceOrderCommand {
      constructor(
        public readonly orderId: string,
        public readonly quantity: number,
      ) {}
    }

    const meta = getJobCommandMetadata(PlaceOrderCommand);
    expect(meta).toBeDefined();
    expect(meta!.jobName).toBe('place-order');
    expect(meta!.entityIdParam).toBe(0);
    expect(meta!.targetClass).toBe(PlaceOrderCommand);
  });

  it('should accept explicit job name as string', () => {
    @JobCommand('submit-request')
    class SubmitRequestCommand {
      constructor(public readonly id: string) {}
    }

    const meta = getJobCommandMetadata(SubmitRequestCommand);
    expect(meta!.jobName).toBe('submit-request');
  });

  it('should accept options object', () => {
    @JobCommand({ name: 'reserve-stock', entityType: 'warehouse', entityIdParam: 'warehouseId' })
    class CustomCommand {
      constructor(
        public readonly warehouseId: string,
        public readonly quantity: number,
      ) {}
    }

    const meta = getJobCommandMetadata(CustomCommand);
    expect(meta!.jobName).toBe('reserve-stock');
    expect(meta!.entityType).toBe('warehouse');
    expect(meta!.entityIdParam).toBe('warehouseId');
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

  it('should use explicit params when provided', () => {
    @JobCommand({ params: ['orderId', 'quantity', 'notes'] })
    class MinifiedCommand {
      constructor(
        public readonly a: string,
        public readonly b: number,
        public readonly c: string,
      ) {}
    }

    const meta = getJobCommandMetadata(MinifiedCommand);
    expect(meta!.paramNames).toEqual(['orderId', 'quantity', 'notes']);
  });
});

// ─── @JobQuery ──────────────────────────────────────────────────────────────

describe('@JobQuery', () => {
  it('should auto-derive job name from class name', () => {
    @JobQuery()
    class GetOrderStatusQuery {
      constructor(public readonly orderId: string) {}
    }

    const meta = getJobQueryMetadata(GetOrderStatusQuery);
    expect(meta).toBeDefined();
    expect(meta!.jobName).toBe('get-order-status');
  });

  it('should accept explicit name', () => {
    @JobQuery('fetch-inventory')
    class FetchInventoryQuery {
      constructor(public readonly warehouseId: string) {}
    }

    const meta = getJobQueryMetadata(FetchInventoryQuery);
    expect(meta!.jobName).toBe('fetch-inventory');
  });

  it('should use explicit params when provided', () => {
    @JobQuery({ params: ['warehouseId', 'sku'] })
    class MinifiedQuery {
      constructor(
        public readonly a: string,
        public readonly b: string,
      ) {}
    }

    const meta = getJobQueryMetadata(MinifiedQuery);
    expect(meta!.paramNames).toEqual(['warehouseId', 'sku']);
  });
});

// ─── Minification detection ────────────────────────────────────────────────

describe('Minification detection', () => {
  it('should throw when all param names are <= 2 chars and count > 1', () => {
    expect(() => {
      @JobCommand()
      class MinifiedCmd {
        constructor(
          public readonly a: string,
          public readonly b: number,
        ) {}
      }
      return MinifiedCmd;
    }).toThrow(/appear minified/);
  });

  it('should not throw for a single short param', () => {
    expect(() => {
      @JobCommand()
      class SingleParamCmd {
        constructor(public readonly x: string) {}
      }
      return SingleParamCmd;
    }).not.toThrow();
  });

  it('should not throw when at least one param name is > 2 chars', () => {
    expect(() => {
      @JobCommand()
      class MixedCmd {
        constructor(
          public readonly id: string,
          public readonly name: string,
        ) {}
      }
      return MixedCmd;
    }).not.toThrow();
  });
});
