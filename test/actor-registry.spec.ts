import 'reflect-metadata';
import { Actor, On, EntityType, getActorMetadata, getActorHandlers } from '../src/decorators';
import { ActorRegistry } from '../src/services/actor-registry/actor-registry.service';
import { HandlerExecutor } from '../src/services/handler-executor/handler-executor.service';

class DepositCommand {
  constructor(public readonly amount: number) {}
}

class WithdrawCommand {
  constructor(public readonly amount: number) {}
}

@Actor('account')
class AccountActor {
  public balance = 0;

  @On(DepositCommand)
  async deposit(msg: DepositCommand) {
    this.balance += msg.amount;
    return this.balance;
  }

  @On(WithdrawCommand)
  async withdraw(msg: WithdrawCommand) {
    this.balance -= msg.amount;
    return this.balance;
  }
}

// --- Auto-discovered actor (no @Actor, entity type inferred from message classes) ---

@EntityType('warehouse')
class ReserveStockCommand {
  constructor(public readonly sku: string, public readonly quantity: number) {}
}

@EntityType('warehouse')
class GetStockQuery {
  constructor(public readonly sku: string) {}
}

class WarehouseHandler {
  public stock = 1000;

  @On(ReserveStockCommand)
  reserve(msg: ReserveStockCommand) {
    this.stock -= msg.quantity;
  }

  @On(GetStockQuery)
  getStock(msg: GetStockQuery) {
    return { sku: msg.sku, available: this.stock };
  }
}

function createMockRedis() {
  const store: Record<string, string> = {};
  return {
    get: async (key: string) => store[key] ?? null,
    set: async (key: string, value: string, ...args: any[]) => {
      store[key] = value;
      return 'OK';
    },
    del: async (key: string) => {
      delete store[key];
      return 1;
    },
    _store: store,
  };
}

describe('ActorRegistry', () => {
  it('should discover @Actor metadata correctly', () => {
    const meta = getActorMetadata(AccountActor);
    expect(meta).toBeDefined();
    expect(meta!.entityType).toBe('account');
  });

  it('should discover @On handlers', () => {
    const handlers = getActorHandlers(AccountActor);
    expect(handlers).toHaveLength(2);
    const names = handlers.map(h => h.messageClass.name).sort();
    expect(names).toEqual(['DepositCommand', 'WithdrawCommand']);
  });

  describe('instance management', () => {
    let registry: ActorRegistry;
    let mockRedis: ReturnType<typeof createMockRedis>;
    let handlerExecutor: HandlerExecutor;

    beforeEach(async () => {
      mockRedis = createMockRedis();
      const mockDiscoveryService = { getProviders: () => [] } as any;
      const mockModuleRef = { get: () => null } as any;
      const mockCommandDiscovery = {
        setCommandBus: jest.fn(),
        setQueryBus: jest.fn(),
      } as any;
      handlerExecutor = new HandlerExecutor(mockCommandDiscovery, mockDiscoveryService, mockModuleRef);

      const mockDiscovery = {
        getProviders: () => [
          {
            metatype: AccountActor,
            instance: new AccountActor(),
          },
        ],
      };

      registry = new ActorRegistry(
        mockRedis as any,
        { redis: {}, keyPrefix: 'test' } as any,
        mockDiscovery as any,
        handlerExecutor,
      );

      await registry.onModuleInit();
    });

    afterEach(async () => {
      await registry.onApplicationShutdown();
    });

    it('should register actor definitions', () => {
      expect(registry.hasActor('account')).toBe(true);
      expect(registry.hasActor('nonexistent')).toBe(false);
    });

    it('should return registered entity types', () => {
      expect(registry.getRegisteredEntityTypes()).toEqual(['account']);
    });

    it('should resolve handler methods', () => {
      expect(registry.getHandlerMethod('account', 'DepositCommand')).toBe('deposit');
      expect(registry.getHandlerMethod('account', 'WithdrawCommand')).toBe('withdraw');
      expect(registry.getHandlerMethod('account', 'Unknown')).toBeUndefined();
    });

    it('should create instances for entities', async () => {
      const instance = await registry.getOrCreateInstance('account', 'a-1');
      expect(instance).not.toBeNull();
    });

    it('should return same instance for same entity', async () => {
      const instance1 = await registry.getOrCreateInstance('account', 'a-1');
      const instance2 = await registry.getOrCreateInstance('account', 'a-1');
      expect(instance1).toBe(instance2);
    });

    it('should return different instances for different entities', async () => {
      const instance1 = await registry.getOrCreateInstance('account', 'a-1');
      const instance2 = await registry.getOrCreateInstance('account', 'a-2');
      expect(instance1).not.toBe(instance2);
    });

    it('should return null for unknown entity types', async () => {
      const instance = await registry.getOrCreateInstance('unknown', 'x-1');
      expect(instance).toBeNull();
    });

    it('should restore state from Redis on instance creation', async () => {
      mockRedis._store['test:actor-state:account:a-5'] = JSON.stringify({ balance: 500 });
      const instance = await registry.getOrCreateInstance('account', 'a-5') as any;
      expect(instance.balance).toBe(500);
    });
  });

  describe('auto-discovery without @Actor', () => {
    let registry: ActorRegistry;
    let mockRedis: ReturnType<typeof createMockRedis>;
    let handlerExecutor: HandlerExecutor;

    beforeEach(async () => {
      mockRedis = createMockRedis();
      const mockDiscoveryService = { getProviders: () => [] } as any;
      const mockModuleRef = { get: () => null } as any;
      const mockCommandDiscovery = {
        setCommandBus: jest.fn(),
        setQueryBus: jest.fn(),
      } as any;
      handlerExecutor = new HandlerExecutor(mockCommandDiscovery, mockDiscoveryService, mockModuleRef);

      const mockDiscovery = {
        getProviders: () => [
          {
            metatype: WarehouseHandler,
            instance: new WarehouseHandler(),
          },
        ],
      };

      registry = new ActorRegistry(
        mockRedis as any,
        { redis: {}, keyPrefix: 'test' } as any,
        mockDiscovery as any,
        handlerExecutor,
      );

      await registry.onModuleInit();
    });

    afterEach(async () => {
      await registry.onApplicationShutdown();
    });

    it('should discover handlers without @Actor by inferring entity type from message class', () => {
      expect(registry.hasActor('warehouse')).toBe(true);
      expect(registry.getRegisteredEntityTypes()).toContain('warehouse');
    });

    it('should resolve handler methods for auto-discovered actor', () => {
      expect(registry.getHandlerMethod('warehouse', 'ReserveStockCommand')).toBe('reserve');
      expect(registry.getHandlerMethod('warehouse', 'GetStockQuery')).toBe('getStock');
    });

    it('should create per-entity instances for auto-discovered actor', async () => {
      const instance = await registry.getOrCreateInstance('warehouse', 'SKU-001') as any;
      expect(instance).not.toBeNull();
      expect(instance.stock).toBe(1000);
    });

    it('should execute handlers on auto-discovered actor', async () => {
      const instance = await registry.getOrCreateInstance('warehouse', 'SKU-001') as any;
      instance.reserve({ sku: 'SKU-001', quantity: 200 });
      expect(instance.stock).toBe(800);

      const result = instance.getStock({ sku: 'SKU-001' });
      expect(result).toEqual({ sku: 'SKU-001', available: 800 });
    });
  });
});
