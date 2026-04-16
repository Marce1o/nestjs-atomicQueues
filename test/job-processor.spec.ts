import 'reflect-metadata';
import { Job } from 'bullmq';
import {
  JobProcessorRegistry,
  DynamicExecutorService,
  AtomicJobProcessor,
} from '../src/services/job-processor/job-processor.service';
import { IAtomicJobData, IAtomicQueuesModuleConfig } from '../src/domain';

// ─── Mocks ──────────────────────────────────────────────────────────────────

function createMockJob<T>(overrides: Partial<Job<IAtomicJobData<T>>> & { data: IAtomicJobData<T> }): Job<IAtomicJobData<T>> {
  return {
    id: 'job-1',
    name: 'test-job',
    ...overrides,
  } as unknown as Job<IAtomicJobData<T>>;
}

const mockCommandBus = {
  execute: jest.fn(),
};

const mockQueryBus = {
  execute: jest.fn(),
};

const mockConfig: IAtomicQueuesModuleConfig = {
  redis: { host: 'localhost', port: 6379 },
};

// ─── JobProcessorRegistry ───────────────────────────────────────────────────

describe('JobProcessorRegistry', () => {
  let registry: JobProcessorRegistry;

  beforeEach(() => {
    registry = new JobProcessorRegistry();
  });

  it('should register and retrieve processors', () => {
    const processor = jest.fn();
    registry.registerProcessor('send-email', processor);

    expect(registry.hasProcessor('send-email')).toBe(true);
    expect(registry.getProcessor('send-email')).toBe(processor);
  });

  it('should return undefined for unregistered types', () => {
    expect(registry.getProcessor('unknown')).toBeUndefined();
    expect(registry.hasProcessor('unknown')).toBe(false);
  });

  it('should list all registered types', () => {
    registry.registerProcessor('type-a', jest.fn());
    registry.registerProcessor('type-b', jest.fn());

    const types = registry.getRegisteredTypes();
    expect(types).toContain('type-a');
    expect(types).toContain('type-b');
    expect(types).toHaveLength(2);
  });

  it('should unregister processors', () => {
    registry.registerProcessor('temp', jest.fn());
    expect(registry.hasProcessor('temp')).toBe(true);

    registry.unregisterProcessor('temp');
    expect(registry.hasProcessor('temp')).toBe(false);
  });

  it('should clear all processors', () => {
    registry.registerProcessor('a', jest.fn());
    registry.registerProcessor('b', jest.fn());

    registry.clearAll();
    expect(registry.getRegisteredTypes()).toHaveLength(0);
  });

  it('should overwrite existing processor on re-register', () => {
    const first = jest.fn();
    const second = jest.fn();

    registry.registerProcessor('job', first);
    registry.registerProcessor('job', second);

    expect(registry.getProcessor('job')).toBe(second);
  });
});

// ─── DynamicExecutorService ─────────────────────────────────────────────────

describe('DynamicExecutorService', () => {
  let executor: DynamicExecutorService;

  beforeEach(() => {
    jest.clearAllMocks();
    executor = new DynamicExecutorService(
      mockCommandBus as any,
      mockQueryBus as any,
    );
  });

  it('should execute a pre-registered command', async () => {
    class TestCommand {
      name!: string;
    }
    mockCommandBus.execute.mockResolvedValue({ success: true });

    executor.registerCommandClass('TestCommand', TestCommand as any);
    const result = await executor.executeCommand('TestCommand', { name: 'foo' });

    expect(mockCommandBus.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  it('should execute a pre-registered query', async () => {
    class TestQuery {
      id!: string;
    }
    mockQueryBus.execute.mockResolvedValue({ data: 'result' });

    executor.registerQueryClass('TestQuery', TestQuery as any);
    const result = await executor.executeQuery('TestQuery', { id: '123' });

    expect(mockQueryBus.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: 'result' });
  });

  it('should throw when command class is not found', async () => {
    await expect(
      executor.executeCommand('NonExistent', {}),
    ).rejects.toThrow('Command class not found: NonExistent');
  });

  it('should throw when query class is not found', async () => {
    await expect(
      executor.executeQuery('NonExistent', {}),
    ).rejects.toThrow('Query class not found: NonExistent');
  });

  it('should bulk register command classes', () => {
    class CmdA {}
    class CmdB {}

    executor.registerCommandClasses({
      CmdA: CmdA as any,
      CmdB: CmdB as any,
    });

    // Verify they're accessible by executing
    mockCommandBus.execute.mockResolvedValue('ok');

    expect(
      executor.executeCommand('CmdA', {}),
    ).resolves.toBe('ok');
  });

  it('should bulk register query classes', () => {
    class QueryA {}
    class QueryB {}

    executor.registerQueryClasses({
      QueryA: QueryA as any,
      QueryB: QueryB as any,
    });

    mockQueryBus.execute.mockResolvedValue('ok');

    expect(
      executor.executeQuery('QueryA', {}),
    ).resolves.toBe('ok');
  });
});

// ─── AtomicJobProcessor ─────────────────────────────────────────────────────

describe('AtomicJobProcessor', () => {
  let registry: JobProcessorRegistry;
  let executor: DynamicExecutorService;
  let processor: AtomicJobProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new JobProcessorRegistry();
    executor = new DynamicExecutorService(
      mockCommandBus as any,
      mockQueryBus as any,
    );
    processor = new AtomicJobProcessor(registry, executor, mockConfig);
  });

  it('should use custom registered processor when available', async () => {
    const customProcessor = jest.fn().mockResolvedValue('custom-result');
    registry.registerProcessor('custom-job', customProcessor);

    const job = createMockJob({
      name: 'custom-job',
      data: {
        uuid: '1',
        entityId: 'e-1',
        entityType: 'test',
        type: 'custom',
        payload: { x: 1 },
      },
    });

    const result = await processor.process(job);
    expect(result.success).toBe(true);
    expect(result.result).toBe('custom-result');
    expect(result.processingTime).toBeGreaterThanOrEqual(0);
    expect(customProcessor).toHaveBeenCalledWith(job);
  });

  it('should execute commands via DynamicExecutor', async () => {
    class FakeCommand {}
    executor.registerCommandClass('FakeCommand', FakeCommand as any);
    mockCommandBus.execute.mockResolvedValue('cmd-result');

    const job = createMockJob({
      name: 'unregistered-name',
      data: {
        uuid: '2',
        entityId: 'e-2',
        entityType: 'test',
        type: 'command',
        commandName: 'FakeCommand',
        payload: { val: 42 },
      },
    });

    const result = await processor.process(job);
    expect(result.success).toBe(true);
    expect(result.result).toBe('cmd-result');
  });

  it('should execute queries via DynamicExecutor', async () => {
    class FakeQuery {}
    executor.registerQueryClass('FakeQuery', FakeQuery as any);
    mockQueryBus.execute.mockResolvedValue('query-result');

    const job = createMockJob({
      name: 'unregistered-name',
      data: {
        uuid: '3',
        entityId: 'e-3',
        entityType: 'test',
        type: 'query',
        commandName: 'FakeQuery',
        payload: {},
      },
    });

    const result = await processor.process(job);
    expect(result.success).toBe(true);
    expect(result.result).toBe('query-result');
  });

  it('should return error for unknown job type/processor', async () => {
    const job = createMockJob({
      name: 'no-handler',
      data: {
        uuid: '4',
        entityId: 'e-4',
        entityType: 'test',
        type: 'custom',
        payload: {},
      },
    });

    const result = await processor.process(job);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown job type or missing processor');
  });

  it('should catch processor errors and return failure', async () => {
    registry.registerProcessor('failing-job', jest.fn().mockRejectedValue(new Error('boom')));

    const job = createMockJob({
      name: 'failing-job',
      data: {
        uuid: '5',
        entityId: 'e-5',
        entityType: 'test',
        type: 'custom',
        payload: {},
      },
    });

    const result = await processor.process(job);
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('createProcessor should return a function that throws on failure', async () => {
    registry.registerProcessor('fail-job', jest.fn().mockRejectedValue(new Error('oops')));
    const processFn = processor.createProcessor();

    const job = createMockJob({
      name: 'fail-job',
      data: {
        uuid: '6',
        entityId: 'e-6',
        entityType: 'test',
        type: 'custom',
        payload: {},
      },
    });

    await expect(processFn(job)).rejects.toThrow('oops');
  });

  it('createProcessor should return result on success', async () => {
    registry.registerProcessor('ok-job', jest.fn().mockResolvedValue('yay'));
    const processFn = processor.createProcessor();

    const job = createMockJob({
      name: 'ok-job',
      data: {
        uuid: '7',
        entityId: 'e-7',
        entityType: 'test',
        type: 'custom',
        payload: {},
      },
    });

    const result = await processFn(job);
    expect(result).toBe('yay');
  });

  it('registerProcessor should delegate to registry', () => {
    const fn = jest.fn();
    processor.registerProcessor('delegated', fn);
    expect(registry.hasProcessor('delegated')).toBe(true);
  });

  it('registerCommands should delegate to executor', () => {
    class A {}
    processor.registerCommands({ A: A as any });
    // Verify by attempting to execute
    mockCommandBus.execute.mockResolvedValue('ok');
    expect(executor.executeCommand('A', {})).resolves.toBe('ok');
  });

  it('registerQueries should delegate to executor', () => {
    class B {}
    processor.registerQueries({ B: B as any });
    mockQueryBus.execute.mockResolvedValue('ok');
    expect(executor.executeQuery('B', {})).resolves.toBe('ok');
  });

  it('should prefer custom processor over dynamic executor', async () => {
    // Register both a custom processor and a command class with the same name
    const customFn = jest.fn().mockResolvedValue('custom');
    registry.registerProcessor('DualJob', customFn);

    class DualJob {}
    executor.registerCommandClass('DualJob', DualJob as any);

    const job = createMockJob({
      name: 'DualJob',
      data: {
        uuid: '8',
        entityId: 'e-8',
        entityType: 'test',
        type: 'command',
        commandName: 'DualJob',
        payload: {},
      },
    });

    const result = await processor.process(job);
    expect(result.result).toBe('custom');
    expect(mockCommandBus.execute).not.toHaveBeenCalled();
  });
});
