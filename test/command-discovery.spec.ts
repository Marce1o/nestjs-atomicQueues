import 'reflect-metadata';
import { CommandDiscoveryService } from '../src/services/command-discovery/command-discovery.service';
import { JobCommand, JobQuery, JOB_COMMAND_METADATA, JOB_QUERY_METADATA } from '../src/decorators';

// ─── Test classes ───────────────────────────────────────────────────────────

@JobCommand('make-bet')
class MakeBetCommand {
  constructor(
    public readonly tableId: string,
    public readonly amount: number,
  ) {}
}

@JobCommand({ name: 'deal-cards', entityType: 'table' })
class DealCardsCommand {
  constructor(
    public readonly tableId: string,
    public readonly deck: string,
  ) {}
}

@JobQuery('get-score')
class GetScoreQuery {
  constructor(
    public readonly tableId: string,
    public readonly seatIndex: number,
  ) {}
}

@JobQuery({ name: 'get-state', entityType: 'table' })
class GetStateQuery {
  constructor(public readonly tableId: string) {}
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
      MakeBetCommand,
      DealCardsCommand,
      GetScoreQuery,
      GetStateQuery,
    ]);

    service = new CommandDiscoveryService(
      mockDiscovery as any,
      {} as any, // reflector
    );

    // Trigger discovery
    await service.onModuleInit();
  });

  it('should discover @JobCommand classes', () => {
    expect(service.hasHandler('make-bet')).toBe(true);
    expect(service.hasHandler('deal-cards')).toBe(true);
  });

  it('should discover @JobQuery classes', () => {
    expect(service.hasHandler('get-score')).toBe(true);
    expect(service.hasHandler('get-state')).toBe(true);
  });

  it('should return false for unknown job names', () => {
    expect(service.hasHandler('nonexistent')).toBe(false);
  });

  it('should get command class by job name', () => {
    expect(service.getCommandClass('make-bet')).toBe(MakeBetCommand);
    expect(service.getCommandClass('deal-cards')).toBe(DealCardsCommand);
  });

  it('should get query class by job name', () => {
    expect(service.getQueryClass('get-score')).toBe(GetScoreQuery);
    expect(service.getQueryClass('get-state')).toBe(GetStateQuery);
  });

  it('should return undefined for unknown command', () => {
    expect(service.getCommandClass('nope')).toBeUndefined();
  });

  it('should return undefined for unknown query', () => {
    expect(service.getQueryClass('nope')).toBeUndefined();
  });

  it('should support scoped routing by entityType', () => {
    // DealCardsCommand has entityType: 'table'
    expect(service.hasHandler('deal-cards', 'table')).toBe(true);
    expect(service.getCommandClass('deal-cards', 'table')).toBe(DealCardsCommand);

    // GetStateQuery has entityType: 'table'
    expect(service.hasHandler('get-state', 'table')).toBe(true);
    expect(service.getQueryClass('get-state', 'table')).toBe(GetStateQuery);
  });

  it('should fall back to global when scoped not found', () => {
    // make-bet has no entityType
    expect(service.hasHandler('make-bet', 'table')).toBe(true);
    expect(service.getCommandClass('make-bet', 'table')).toBe(MakeBetCommand);
  });

  it('getRegisteredJobNames should list all discovered names', () => {
    const names = service.getRegisteredJobNames();
    expect(names.commands).toContain('make-bet');
    expect(names.commands).toContain('deal-cards');
    expect(names.queries).toContain('get-score');
    expect(names.queries).toContain('get-state');
  });
});

describe('CommandDiscoveryService.executeJob', () => {
  let service: CommandDiscoveryService;
  const mockCommandBus = { execute: jest.fn() };
  const mockQueryBus = { execute: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const mockDiscovery = createMockDiscoveryService([MakeBetCommand, GetScoreQuery]);

    service = new CommandDiscoveryService(mockDiscovery as any, {} as any);
    service.setCommandBus(mockCommandBus);
    service.setQueryBus(mockQueryBus);

    await service.onModuleInit();
  });

  it('should execute a command via CommandBus', async () => {
    mockCommandBus.execute.mockResolvedValue('bet-placed');

    const job = {
      name: 'make-bet',
      data: { tableId: 't-1', amount: 100 },
    } as any;

    const result = await service.executeJob(job, 'entity-1');
    expect(mockCommandBus.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('bet-placed');

    // Verify the command was instantiated correctly
    const cmdArg = mockCommandBus.execute.mock.calls[0][0];
    expect(cmdArg).toBeInstanceOf(MakeBetCommand);
    expect(cmdArg.tableId).toBe('entity-1'); // entityId injected
  });

  it('should execute a query via QueryBus', async () => {
    mockQueryBus.execute.mockResolvedValue({ score: 21 });

    const job = {
      name: 'get-score',
      data: { tableId: 't-1', seatIndex: 3 },
    } as any;

    const result = await service.executeJob(job, 'entity-2');
    expect(mockQueryBus.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ score: 21 });
  });

  it('should return undefined for unknown job names', async () => {
    const job = { name: 'unknown-job', data: {} } as any;
    const result = await service.executeJob(job, 'e-1');
    expect(result).toBeUndefined();
  });

  it('should throw when CommandBus is not available', async () => {
    // Create service without setting CommandBus
    const freshService = new CommandDiscoveryService(
      createMockDiscoveryService([MakeBetCommand]) as any,
      {} as any,
    );
    await freshService.onModuleInit();

    const job = { name: 'make-bet', data: {} } as any;
    await expect(freshService.executeJob(job, 'e-1')).rejects.toThrow(/CommandBus not available/);
  });

  it('should throw when QueryBus is not available', async () => {
    const freshService = new CommandDiscoveryService(
      createMockDiscoveryService([GetScoreQuery]) as any,
      {} as any,
    );
    await freshService.onModuleInit();

    const job = { name: 'get-score', data: {} } as any;
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
