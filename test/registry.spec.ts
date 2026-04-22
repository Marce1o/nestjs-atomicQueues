import 'reflect-metadata';
import { RegistryService } from '../src/services/registry/registry.service';
import { EntityContract } from '../src/services/registry/registry.types';

function createMockRedis() {
  const store: Record<string, { value: string; ttl?: number }> = {};
  const subscribers: Record<string, Function[]> = {};

  return {
    get: jest.fn(async (key: string) => store[key]?.value ?? null),
    set: jest.fn(async (key: string, value: string, _ex?: string, _ttl?: number) => {
      store[key] = { value, ttl: _ttl };
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      delete store[key];
      return 1;
    }),
    scan: jest.fn(async (_cursor: string, _match: string, pattern: string) => {
      const prefix = pattern.replace('*', '');
      const keys = Object.keys(store).filter(k => k.startsWith(prefix));
      return ['0', keys];
    }),
    publish: jest.fn().mockResolvedValue(1),
    duplicate: jest.fn().mockReturnValue({
      subscribe: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
    }),
    _store: store,
  };
}

describe('RegistryService', () => {
  describe('disabled (default)', () => {
    it('should not write to Redis when disabled', async () => {
      const redis = createMockRedis();
      const registry = new RegistryService(
        redis as any,
        { redis: {}, keyPrefix: 'test' } as any,
        { getProviders: () => [] } as any,
      );

      await registry.onModuleInit();

      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.duplicate).not.toHaveBeenCalled();
    });

    it('should return null from getContract', async () => {
      const redis = createMockRedis();
      const registry = new RegistryService(
        redis as any,
        { redis: {}, keyPrefix: 'test' } as any,
        null as any,
      );

      const contract = await registry.getContract('account');
      expect(contract).toBeNull();
    });

    it('should return empty from listEntityTypes', async () => {
      const redis = createMockRedis();
      const registry = new RegistryService(
        redis as any,
        { redis: {}, keyPrefix: 'test' } as any,
        null as any,
      );

      const types = await registry.listEntityTypes();
      expect(types).toEqual([]);
    });

    it('should no-op on validate', async () => {
      const redis = createMockRedis();
      const registry = new RegistryService(
        redis as any,
        { redis: {}, keyPrefix: 'test' } as any,
        null as any,
      );

      await expect(registry.validate('account', 'WithdrawCommand')).resolves.toBeUndefined();
    });
  });

  describe('enabled', () => {
    let redis: ReturnType<typeof createMockRedis>;
    let registry: RegistryService;

    function seedContract(entityType: string, contract: EntityContract) {
      redis._store[`test:registry:${entityType}`] = { value: JSON.stringify(contract) };
    }

    beforeEach(() => {
      redis = createMockRedis();
      registry = new RegistryService(
        redis as any,
        {
          redis: {},
          keyPrefix: 'test',
          registry: {
            enabled: true,
            serviceName: 'test-svc',
            heartbeatInterval: 60000, // long interval so no auto-heartbeat during test
          },
        } as any,
        { getProviders: () => [] } as any,
      );
    });

    afterEach(async () => {
      await registry.onApplicationShutdown();
    });

    it('should subscribe to update channel on init', async () => {
      await registry.onModuleInit();
      const sub = redis.duplicate();
      expect(sub.subscribe).toHaveBeenCalledWith('test:registry:updates');
    });

    it('should getContract from Redis and cache it', async () => {
      await registry.onModuleInit();

      const contract: EntityContract = {
        entityType: 'account',
        serviceName: 'bank-svc',
        version: '1.0.0',
        messages: { WithdrawCommand: { kind: 'command' } },
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
      };
      seedContract('account', contract);

      const result = await registry.getContract('account');
      expect(result).toBeDefined();
      expect(result!.entityType).toBe('account');
      expect(result!.messages.WithdrawCommand.kind).toBe('command');

      // Second call should use cache (no additional redis.get)
      const getCallCount = redis.get.mock.calls.length;
      const cached = await registry.getContract('account');
      expect(cached).toBe(result);
      expect(redis.get.mock.calls.length).toBe(getCallCount);
    });

    it('should return null for unknown entity type', async () => {
      await registry.onModuleInit();
      const result = await registry.getContract('nonexistent');
      expect(result).toBeNull();
    });

    it('should validate — pass for known entity type and message', async () => {
      await registry.onModuleInit();

      seedContract('account', {
        entityType: 'account',
        serviceName: 'bank-svc',
        version: '1.0.0',
        messages: { WithdrawCommand: { kind: 'command' } },
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
      });

      await expect(registry.validate('account', 'WithdrawCommand')).resolves.toBeUndefined();
    });

    it('should validate — throw for unknown entity type', async () => {
      await registry.onModuleInit();

      await expect(registry.validate('unknown', 'SomeCommand'))
        .rejects.toThrow(/Unknown entity type 'unknown'/);
    });

    it('should validate — throw for unknown message on known entity type', async () => {
      await registry.onModuleInit();

      seedContract('account', {
        entityType: 'account',
        serviceName: 'bank-svc',
        version: '1.0.0',
        messages: { WithdrawCommand: { kind: 'command' } },
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
      });

      await expect(registry.validate('account', 'TransferCommand'))
        .rejects.toThrow(/does not accept message 'TransferCommand'/);
    });

    it('should validate — schema catches missing required field', async () => {
      const registryWithSchema = new RegistryService(
        redis as any,
        {
          redis: {},
          keyPrefix: 'test',
          registry: {
            enabled: true,
            serviceName: 'test-svc',
            schemaValidation: true,
            heartbeatInterval: 60000,
          },
        } as any,
        { getProviders: () => [] } as any,
      );
      await registryWithSchema.onModuleInit();

      seedContract('account', {
        entityType: 'account',
        serviceName: 'bank-svc',
        version: '1.0.0',
        messages: {
          WithdrawCommand: {
            kind: 'command',
            schema: {
              type: 'object',
              required: ['accountId', 'amount'],
              properties: {
                accountId: { type: 'string' },
                amount: { type: 'number' },
              },
            },
          },
        },
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
      });

      await expect(
        registryWithSchema.validate('account', 'WithdrawCommand', { accountId: 'a-1' }),
      ).rejects.toThrow(/missing required fields: \[amount\]/);

      await registryWithSchema.onApplicationShutdown();
    });

    it('should validate — schema catches wrong type', async () => {
      const registryWithSchema = new RegistryService(
        redis as any,
        {
          redis: {},
          keyPrefix: 'test',
          registry: {
            enabled: true,
            serviceName: 'test-svc',
            schemaValidation: true,
            heartbeatInterval: 60000,
          },
        } as any,
        { getProviders: () => [] } as any,
      );
      await registryWithSchema.onModuleInit();

      seedContract('account', {
        entityType: 'account',
        serviceName: 'bank-svc',
        version: '1.0.0',
        messages: {
          WithdrawCommand: {
            kind: 'command',
            schema: {
              type: 'object',
              properties: {
                amount: { type: 'number' },
              },
            },
          },
        },
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
      });

      await expect(
        registryWithSchema.validate('account', 'WithdrawCommand', { amount: 'not-a-number' }),
      ).rejects.toThrow(/field 'amount' expected number, got string/);

      await registryWithSchema.onApplicationShutdown();
    });

    it('should exportSnapshot with all contracts', async () => {
      await registry.onModuleInit();

      seedContract('account', {
        entityType: 'account',
        serviceName: 'bank-svc',
        version: '1.0.0',
        messages: { WithdrawCommand: { kind: 'command' } },
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
      });

      seedContract('order', {
        entityType: 'order',
        serviceName: 'shop-svc',
        version: '1.0.0',
        messages: { PlaceOrderCommand: { kind: 'command' } },
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
      });

      const snapshot = await registry.exportSnapshot();
      expect(snapshot.entities).toHaveLength(2);
      expect(snapshot.keyPrefix).toBe('test');
      expect(snapshot.generatedAt).toBeGreaterThan(0);
    });

    it('should notify change listeners on registry update', async () => {
      await registry.onModuleInit();

      const changes: any[] = [];
      registry.watchChanges((change) => changes.push(change));

      // Simulate incoming pub/sub message
      const subscriber = redis.duplicate();
      const onCall = subscriber.on.mock.calls.find((c: any[]) => c[0] === 'message');
      expect(onCall).toBeDefined();

      const handler = onCall![1];
      handler('test:registry:updates', JSON.stringify({
        entityType: 'account',
        action: 'registered',
        serviceName: 'bank-svc',
      }));

      expect(changes).toHaveLength(1);
      expect(changes[0].entityType).toBe('account');
      expect(changes[0].action).toBe('registered');
    });

    it('should invalidate cache on registry update', async () => {
      await registry.onModuleInit();

      seedContract('account', {
        entityType: 'account',
        serviceName: 'bank-svc',
        version: '1.0.0',
        messages: { WithdrawCommand: { kind: 'command' } },
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
      });

      // Load into cache
      await registry.getContract('account');

      // Simulate update
      const subscriber = redis.duplicate();
      const onCall = subscriber.on.mock.calls.find((c: any[]) => c[0] === 'message');
      const handler = onCall![1];
      handler('test:registry:updates', JSON.stringify({
        entityType: 'account',
        action: 'updated',
        serviceName: 'other-svc',
      }));

      // Next call should re-fetch from Redis
      const callsBefore = redis.get.mock.calls.length;
      await registry.getContract('account');
      expect(redis.get.mock.calls.length).toBe(callsBefore + 1);
    });

    it('should report isEnabled correctly', () => {
      expect(registry.isEnabled()).toBe(true);

      const disabledRegistry = new RegistryService(
        redis as any,
        { redis: {}, keyPrefix: 'test' } as any,
        null as any,
      );
      expect(disabledRegistry.isEnabled()).toBe(false);
    });
  });
});
