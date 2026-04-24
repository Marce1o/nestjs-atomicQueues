import 'reflect-metadata';
import { CommandDiscoveryService } from '../src/services/command-discovery/command-discovery.service';
import { JobCommand, JobQuery, JOB_COMMAND_METADATA, JOB_QUERY_METADATA } from '../src/decorators';

// ─── Test classes ───────────────────────────────────────────────────────────

@JobCommand('place-order')
class PlaceOrderCommand {
  constructor(
    public readonly orderId: string,
    public readonly quantity: number,
  ) {}
}

@JobCommand({ name: 'ship-order', entityType: 'order' })
class ShipOrderCommand {
  constructor(
    public readonly orderId: string,
    public readonly carrier: string,
  ) {}
}

@JobQuery('get-status')
class GetStatusQuery {
  constructor(
    public readonly orderId: string,
    public readonly includeHistory: number,
  ) {}
}

@JobQuery({ name: 'get-summary', entityType: 'order' })
class GetSummaryQuery {
  constructor(public readonly orderId: string) {}
}

// ─── Mock DiscoveryService ──────────────────────────────────────────────────

function createMockDiscoveryService(classes: Function[]) {
  return {
    getProviders: () =>
      classes.map((cls) => ({
        metatype: cls,
      })),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CommandDiscoveryService', () => {
  let service: CommandDiscoveryService;

  beforeEach(async () => {
    const mockDiscovery = createMockDiscoveryService([
      PlaceOrderCommand,
      ShipOrderCommand,
      GetStatusQuery,
      GetSummaryQuery,
    ]);

    service = new CommandDiscoveryService(
      mockDiscovery as any,
      {} as any, // reflector
    );

    // Trigger discovery
    await service.onModuleInit();
  });

  it('should discover @JobCommand classes', () => {
    expect(service.hasHandler('place-order')).toBe(true);
    expect(service.hasHandler('ship-order')).toBe(true);
  });

  it('should discover @JobQuery classes', () => {
    expect(service.hasHandler('get-status')).toBe(true);
    expect(service.hasHandler('get-summary')).toBe(true);
  });

  it('should return false for unknown job names', () => {
    expect(service.hasHandler('nonexistent')).toBe(false);
  });

  it('should get command class by job name', () => {
    expect(service.getCommandClass('place-order')).toBe(PlaceOrderCommand);
    expect(service.getCommandClass('ship-order')).toBe(ShipOrderCommand);
  });

  it('should get query class by job name', () => {
    expect(service.getQueryClass('get-status')).toBe(GetStatusQuery);
    expect(service.getQueryClass('get-summary')).toBe(GetSummaryQuery);
  });

  it('should return undefined for unknown command', () => {
    expect(service.getCommandClass('nope')).toBeUndefined();
  });

  it('should return undefined for unknown query', () => {
    expect(service.getQueryClass('nope')).toBeUndefined();
  });

  it('should support scoped routing by entityType', () => {
    // ShipOrderCommand has entityType: 'order'
    expect(service.hasHandler('ship-order', 'order')).toBe(true);
    expect(service.getCommandClass('ship-order', 'order')).toBe(ShipOrderCommand);

    // GetSummaryQuery has entityType: 'order'
    expect(service.hasHandler('get-summary', 'order')).toBe(true);
    expect(service.getQueryClass('get-summary', 'order')).toBe(GetSummaryQuery);
  });

  it('should fall back to global when scoped not found', () => {
    // place-order has no entityType
    expect(service.hasHandler('place-order', 'order')).toBe(true);
    expect(service.getCommandClass('place-order', 'order')).toBe(PlaceOrderCommand);
  });

  it('getRegisteredJobNames should list all discovered names', () => {
    const names = service.getRegisteredJobNames();
    expect(names.commands).toContain('place-order');
    expect(names.commands).toContain('ship-order');
    expect(names.queries).toContain('get-status');
    expect(names.queries).toContain('get-summary');
  });
});

describe('CommandDiscoveryService.executeJob', () => {
  let service: CommandDiscoveryService;
  const mockCommandBus = { execute: jest.fn() };
  const mockQueryBus = { execute: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const mockDiscovery = createMockDiscoveryService([PlaceOrderCommand, GetStatusQuery]);

    service = new CommandDiscoveryService(mockDiscovery as any, {} as any);
    service.setCommandBus(mockCommandBus);
    service.setQueryBus(mockQueryBus);

    await service.onModuleInit();
  });

  it('should execute a command via CommandBus', async () => {
    mockCommandBus.execute.mockResolvedValue('order-placed');

    const job = {
      name: 'place-order',
      data: { orderId: 'o-1', quantity: 100 },
    } as any;

    const result = await service.executeJob(job, 'entity-1');
    expect(mockCommandBus.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('order-placed');

    // Verify the command was instantiated correctly
    const cmdArg = mockCommandBus.execute.mock.calls[0][0];
    expect(cmdArg).toBeInstanceOf(PlaceOrderCommand);
    expect(cmdArg.orderId).toBe('entity-1'); // entityId injected
  });

  it('should execute a query via QueryBus', async () => {
    mockQueryBus.execute.mockResolvedValue({ status: 'shipped' });

    const job = {
      name: 'get-status',
      data: { orderId: 'o-1', includeHistory: 1 },
    } as any;

    const result = await service.executeJob(job, 'entity-2');
    expect(mockQueryBus.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'shipped' });
  });

  it('should return undefined for unknown job names', async () => {
    const job = { name: 'unknown-job', data: {} } as any;
    const result = await service.executeJob(job, 'e-1');
    expect(result).toBeUndefined();
  });

  it('should throw when CommandBus is not available', async () => {
    const freshService = new CommandDiscoveryService(
      createMockDiscoveryService([PlaceOrderCommand]) as any,
      {} as any,
    );
    await freshService.onModuleInit();

    const job = { name: 'place-order', data: {} } as any;
    await expect(freshService.executeJob(job, 'e-1')).rejects.toThrow(/CommandBus not available/);
  });

  it('should throw when QueryBus is not available', async () => {
    const freshService = new CommandDiscoveryService(
      createMockDiscoveryService([GetStatusQuery]) as any,
      {} as any,
    );
    await freshService.onModuleInit();

    const job = { name: 'get-status', data: {} } as any;
    await expect(freshService.executeJob(job, 'e-1')).rejects.toThrow(/QueryBus not available/);
  });
});

describe('CommandDiscoveryService without DiscoveryService', () => {
  it('should handle missing DiscoveryService gracefully', async () => {
    const service = new CommandDiscoveryService(undefined as any, undefined as any);

    // Should not throw
    await service.onModuleInit();

    expect(service.hasHandler('anything')).toBe(false);
    expect(service.getRegisteredJobNames()).toEqual({
      commands: [],
      queries: [],
    });
  });
});
