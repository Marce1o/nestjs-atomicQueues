import 'reflect-metadata';
import { HandlerExecutor } from '../src/services/handler-executor/handler-executor.service';
import { ISerializedMessage } from '../src/domain';

function createMessage(overrides?: Partial<ISerializedMessage>): ISerializedMessage {
  return {
    id: 'msg-1',
    name: 'TestCommand',
    data: { foo: 'bar' },
    entityType: 'account',
    entityId: 'a-1',
    enqueuedAt: Date.now(),
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

function createHandlerExecutor(): HandlerExecutor {
  const mockDiscoveryService = { getProviders: () => [] } as any;
  const mockModuleRef = { get: () => null } as any;
  const mockCommandDiscovery = {
    setCommandBus: jest.fn(),
    setQueryBus: jest.fn(),
    executeJob: jest.fn(),
    hasHandler: jest.fn().mockReturnValue(false),
  } as any;
  return new HandlerExecutor(mockCommandDiscovery, mockDiscoveryService, mockModuleRef);
}

describe('HandlerExecutor', () => {
  let executor: HandlerExecutor;

  beforeEach(() => {
    executor = createHandlerExecutor();
  });

  it('should dispatch via command discovery', async () => {
    const mockDiscovery = {
      executeJob: jest.fn().mockResolvedValue('discovered-result'),
      hasHandler: jest.fn().mockReturnValue(true),
    };
    executor.setCommandDiscovery(mockDiscovery as any);

    const msg = createMessage({ name: 'UnhandledCommand' });
    const result = await executor.execute(msg, 'account:a-1');

    expect(mockDiscovery.executeJob).toHaveBeenCalled();
    expect(result).toBe('discovered-result');
  });

  it('should fall through to command registry when no discovery handler', async () => {
    class TestCommand {}
    const mockBus = { execute: jest.fn().mockResolvedValue('bus-result') };
    executor.setCommandBus(mockBus);
    executor.registerCommand('TestCommand', TestCommand as any, false);

    const msg = createMessage({ name: 'TestCommand', data: { value: 42 } });
    const result = await executor.execute(msg, 'account:a-1');

    expect(mockBus.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('bus-result');
  });

  it('should use queryBus for registered queries', async () => {
    class TestQuery {}
    const mockQueryBus = { execute: jest.fn().mockResolvedValue('query-result') };
    executor.setQueryBus(mockQueryBus);
    executor.registerCommand('TestQuery', TestQuery as any, true);

    const msg = createMessage({ name: 'TestQuery' });
    const result = await executor.execute(msg, 'account:a-1');

    expect(mockQueryBus.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('query-result');
  });

  it('should return null when no handler found', async () => {
    const msg = createMessage({ name: 'UnknownCommand' });
    const result = await executor.execute(msg, 'account:a-1');
    expect(result).toBeNull();
  });

  it('should return null when command bus not set', async () => {
    class TestCommand {}
    executor.registerCommand('TestCommand', TestCommand as any, false);

    const msg = createMessage({ name: 'TestCommand' });
    const result = await executor.execute(msg, 'account:a-1');
    expect(result).toBeNull();
  });
});
