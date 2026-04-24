import 'reflect-metadata';
import { EntityTypeRegistry } from '../src/services/entity-type-registry/entity-type-registry.service';
import { EntityType, JobCommand } from '../src/decorators';

class DepositCommand {}
Reflect.defineMetadata('atomic:entity-type', 'account', DepositCommand);

class WithdrawCommand {}
Reflect.defineMetadata('atomic:entity-type', 'account', WithdrawCommand);

class ReserveStockCommand {}
Reflect.defineMetadata('atomic:entity-type', 'warehouse', ReserveStockCommand);

class DepositHandler {}
Reflect.defineMetadata('__commandHandler__', DepositCommand, DepositHandler);

class WithdrawHandler {}
Reflect.defineMetadata('__commandHandler__', WithdrawCommand, WithdrawHandler);

class ReserveHandler {}
Reflect.defineMetadata('__commandHandler__', ReserveStockCommand, ReserveHandler);

class GetBalanceQuery {}
Reflect.defineMetadata('atomic:entity-type', 'account', GetBalanceQuery);

class GetBalanceHandler {}
Reflect.defineMetadata('__queryHandler__', GetBalanceQuery, GetBalanceHandler);

@JobCommand({ name: 'place-order', entityType: 'order' })
class PlaceOrderCommand {
  constructor(public readonly orderId: string) {}
}

describe('EntityTypeRegistry', () => {
  function createRegistry(providers: { metatype: Function }[]): EntityTypeRegistry {
    const mockDiscovery = {
      getProviders: () => providers.map((p) => ({ metatype: p.metatype, instance: {} })),
    };
    return new EntityTypeRegistry(mockDiscovery as any);
  }

  it('should discover entity types from @CommandHandler providers', async () => {
    const registry = createRegistry([{ metatype: DepositHandler }, { metatype: WithdrawHandler }]);
    await registry.onModuleInit();

    expect(registry.getRegisteredEntityTypes()).toEqual(['account']);
    expect(registry.hasEntityType('account')).toBe(true);
    expect(registry.hasEntityType('unknown')).toBe(false);
  });

  it('should discover entity types from @QueryHandler providers', async () => {
    const registry = createRegistry([{ metatype: GetBalanceHandler }]);
    await registry.onModuleInit();

    expect(registry.hasEntityType('account')).toBe(true);
  });

  it('should discover entity types from @JobCommand providers', async () => {
    const registry = createRegistry([{ metatype: PlaceOrderCommand }]);
    await registry.onModuleInit();

    expect(registry.hasEntityType('order')).toBe(true);
  });

  it('should deduplicate entity types across sources', async () => {
    const registry = createRegistry([
      { metatype: DepositHandler },
      { metatype: WithdrawHandler },
      { metatype: GetBalanceHandler },
    ]);
    await registry.onModuleInit();

    const types = registry.getRegisteredEntityTypes();
    expect(types.filter((t) => t === 'account')).toHaveLength(1);
  });

  it('should discover multiple entity types', async () => {
    const registry = createRegistry([{ metatype: DepositHandler }, { metatype: ReserveHandler }]);
    await registry.onModuleInit();

    const types = registry.getRegisteredEntityTypes().sort();
    expect(types).toEqual(['account', 'warehouse']);
  });

  it('should return empty when no providers have entity types', async () => {
    const registry = createRegistry([]);
    await registry.onModuleInit();

    expect(registry.getRegisteredEntityTypes()).toEqual([]);
  });

  it('should handle missing discoveryService gracefully', async () => {
    const registry = new EntityTypeRegistry(null as any);
    await registry.onModuleInit();

    expect(registry.getRegisteredEntityTypes()).toEqual([]);
  });
});
