import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

const KEY_PREFIX = `aq-test-${process.pid}`;

function gateKey(entityKey: string): string {
  return `${KEY_PREFIX}:gate:${entityKey}`;
}

function logKey(entityKey: string): string {
  return `${KEY_PREFIX}:log:${entityKey}`;
}

function readySetKey(): string {
  return `${KEY_PREFIX}:ready`;
}

function createMessage(
  entityType: string,
  entityId: string,
  name: string,
  data: Record<string, unknown> = {},
) {
  return JSON.stringify({
    id: uuidv4(),
    name,
    data,
    entityType,
    entityId,
    enqueuedAt: Date.now(),
    attempts: 0,
    maxAttempts: 3,
  });
}

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const EXTEND_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

const PICK_DISPATCHABLE_SCRIPT = `
local readySetKey = KEYS[1]
local gatePrefix = ARGV[1]
local logPrefix = ARGV[2]
local ownerToken = ARGV[3]
local defaultTTL = tonumber(ARGV[4])
local batchSize = tonumber(ARGV[5]) or 32
local numFilters = #ARGV - 5

local members = redis.call("SRANDMEMBER", readySetKey, batchSize)
if not members or #members == 0 then
  return nil
end

for _, entityKey in ipairs(members) do
  local skipped = false
  if numFilters > 0 then
    local owned = false
    for i = 6, #ARGV do
      if string.sub(entityKey, 1, #ARGV[i]) == ARGV[i] then
        owned = true
        break
      end
    end
    if not owned then
      skipped = true
    end
  end

  if not skipped then
    local gateKey = gatePrefix .. entityKey
    local acquired = redis.call("SET", gateKey, ownerToken, "EX", defaultTTL, "NX")
    if acquired then
      local logKey = logPrefix .. entityKey
      local msg = redis.call("RPOP", logKey)
      if msg then
        local remaining = redis.call("LLEN", logKey)
        if remaining == 0 then
          redis.call("SREM", readySetKey, entityKey)
        end
        return {entityKey, msg, ownerToken}
      else
        redis.call("DEL", gateKey)
        redis.call("SREM", readySetKey, entityKey)
      end
    end
  end
end

return nil
`;

describe('Integration: Redis dispatch cycle', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis({ host: 'localhost', port: 6379, maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    const keys = await redis.keys(`${KEY_PREFIX}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await redis.quit();
  });

  afterEach(async () => {
    const keys = await redis.keys(`${KEY_PREFIX}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe('gate fencing (Phase 1 fix)', () => {
    it('should NOT release a gate held by a different owner', async () => {
      const key = gateKey('account:a-1');
      await redis.set(key, 'token-A', 'EX', 30, 'NX');

      const result = (await redis.eval(RELEASE_IF_OWNER_SCRIPT, 1, key, 'token-B')) as number;
      expect(result).toBe(0);

      const holder = await redis.get(key);
      expect(holder).toBe('token-A');
    });

    it('should release when owner token matches', async () => {
      const key = gateKey('account:a-2');
      await redis.set(key, 'token-A', 'EX', 30, 'NX');

      const result = (await redis.eval(RELEASE_IF_OWNER_SCRIPT, 1, key, 'token-A')) as number;
      expect(result).toBe(1);

      const holder = await redis.get(key);
      expect(holder).toBeNull();
    });

    it('should NOT extend a gate held by a different owner', async () => {
      const key = gateKey('account:a-3');
      await redis.set(key, 'token-A', 'EX', 10, 'NX');

      const result = (await redis.eval(EXTEND_IF_OWNER_SCRIPT, 1, key, 'token-B', '60')) as number;
      expect(result).toBe(0);

      const ttl = await redis.ttl(key);
      expect(ttl).toBeLessThanOrEqual(10);
    });

    it('should extend when owner token matches', async () => {
      const key = gateKey('account:a-4');
      await redis.set(key, 'token-A', 'EX', 5, 'NX');

      const result = (await redis.eval(EXTEND_IF_OWNER_SCRIPT, 1, key, 'token-A', '60')) as number;
      expect(result).toBe(1);

      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(5);
    });
  });

  describe('Lua scheduler script', () => {
    it('should pick a message and acquire gate atomically', async () => {
      const entityKey = 'account:a-1';
      await redis.lpush(logKey(entityKey), createMessage('account', 'a-1', 'Deposit'));
      await redis.sadd(readySetKey(), entityKey);

      const token = uuidv4();
      const result = (await redis.eval(
        PICK_DISPATCHABLE_SCRIPT,
        1,
        readySetKey(),
        `${KEY_PREFIX}:gate:`,
        `${KEY_PREFIX}:log:`,
        token,
        '30',
        '32',
      )) as [string, string, string] | null;

      expect(result).not.toBeNull();
      expect(result![0]).toBe(entityKey);
      const msg = JSON.parse(result![1]);
      expect(msg.name).toBe('Deposit');
      expect(result![2]).toBe(token);

      const held = await redis.get(gateKey(entityKey));
      expect(held).toBe(token);
    });

    it('should not dispatch if gate is already held', async () => {
      const entityKey = 'account:a-2';
      await redis.lpush(logKey(entityKey), createMessage('account', 'a-2', 'Withdraw'));
      await redis.sadd(readySetKey(), entityKey);
      await redis.set(gateKey(entityKey), 'existing-token', 'EX', 30, 'NX');

      const result = (await redis.eval(
        PICK_DISPATCHABLE_SCRIPT,
        1,
        readySetKey(),
        `${KEY_PREFIX}:gate:`,
        `${KEY_PREFIX}:log:`,
        uuidv4(),
        '30',
        '32',
      )) as null;

      expect(result).toBeNull();
    });

    it('should remove entity from ready set when log is empty after pop', async () => {
      const entityKey = 'account:a-3';
      await redis.lpush(logKey(entityKey), createMessage('account', 'a-3', 'Check'));
      await redis.sadd(readySetKey(), entityKey);

      await redis.eval(
        PICK_DISPATCHABLE_SCRIPT,
        1,
        readySetKey(),
        `${KEY_PREFIX}:gate:`,
        `${KEY_PREFIX}:log:`,
        uuidv4(),
        '30',
        '32',
      );

      const isMember = await redis.sismember(readySetKey(), entityKey);
      expect(isMember).toBe(0);
    });

    it('should keep entity in ready set when more messages remain', async () => {
      const entityKey = 'account:a-4';
      await redis.lpush(logKey(entityKey), createMessage('account', 'a-4', 'Msg1'));
      await redis.lpush(logKey(entityKey), createMessage('account', 'a-4', 'Msg2'));
      await redis.sadd(readySetKey(), entityKey);

      await redis.eval(
        PICK_DISPATCHABLE_SCRIPT,
        1,
        readySetKey(),
        `${KEY_PREFIX}:gate:`,
        `${KEY_PREFIX}:log:`,
        uuidv4(),
        '30',
        '32',
      );

      const isMember = await redis.sismember(readySetKey(), entityKey);
      expect(isMember).toBe(1);
    });

    it('should filter by entity type prefix', async () => {
      const wareKey = 'warehouse:w-1';
      const acctKey = 'account:a-5';
      await redis.lpush(logKey(wareKey), createMessage('warehouse', 'w-1', 'Reserve'));
      await redis.lpush(logKey(acctKey), createMessage('account', 'a-5', 'Deposit'));
      await redis.sadd(readySetKey(), wareKey, acctKey);

      const result = (await redis.eval(
        PICK_DISPATCHABLE_SCRIPT,
        1,
        readySetKey(),
        `${KEY_PREFIX}:gate:`,
        `${KEY_PREFIX}:log:`,
        uuidv4(),
        '30',
        '32',
        'warehouse:',
      )) as [string, string, string] | null;

      expect(result).not.toBeNull();
      expect(result![0]).toBe(wareKey);
    });

    it('should handle concurrent pick attempts — only one wins the gate', async () => {
      const entityKey = 'account:a-6';
      await redis.lpush(logKey(entityKey), createMessage('account', 'a-6', 'ConcurrentOp'));
      await redis.sadd(readySetKey(), entityKey);

      const results = await Promise.all([
        redis.eval(
          PICK_DISPATCHABLE_SCRIPT,
          1,
          readySetKey(),
          `${KEY_PREFIX}:gate:`,
          `${KEY_PREFIX}:log:`,
          uuidv4(),
          '30',
          '32',
        ),
        redis.eval(
          PICK_DISPATCHABLE_SCRIPT,
          1,
          readySetKey(),
          `${KEY_PREFIX}:gate:`,
          `${KEY_PREFIX}:log:`,
          uuidv4(),
          '30',
          '32',
        ),
        redis.eval(
          PICK_DISPATCHABLE_SCRIPT,
          1,
          readySetKey(),
          `${KEY_PREFIX}:gate:`,
          `${KEY_PREFIX}:log:`,
          uuidv4(),
          '30',
          '32',
        ),
      ]);

      const winners = results.filter((r) => r !== null);
      expect(winners.length).toBe(1);
    });
  });

  describe('sequential entity processing', () => {
    it('should process messages for same entity one at a time', async () => {
      const entityKey = 'account:seq-1';
      // LPUSH pushes to head; RPOP pops from tail → FIFO: first LPUSH'd = first consumed
      await redis.lpush(logKey(entityKey), createMessage('account', 'seq-1', 'Msg1'));
      await redis.lpush(logKey(entityKey), createMessage('account', 'seq-1', 'Msg2'));
      await redis.lpush(logKey(entityKey), createMessage('account', 'seq-1', 'Msg3'));
      await redis.sadd(readySetKey(), entityKey);

      const token = uuidv4();
      const first = (await redis.eval(
        PICK_DISPATCHABLE_SCRIPT,
        1,
        readySetKey(),
        `${KEY_PREFIX}:gate:`,
        `${KEY_PREFIX}:log:`,
        token,
        '30',
        '32',
      )) as [string, string, string];

      expect(JSON.parse(first[1]).name).toBe('Msg1');

      // Same entity can't be picked while gate is held
      const second = await redis.eval(
        PICK_DISPATCHABLE_SCRIPT,
        1,
        readySetKey(),
        `${KEY_PREFIX}:gate:`,
        `${KEY_PREFIX}:log:`,
        uuidv4(),
        '30',
        '32',
      );
      expect(second).toBeNull();

      // Release gate and re-mark ready
      await redis.eval(RELEASE_IF_OWNER_SCRIPT, 1, gateKey(entityKey), token);
      await redis.sadd(readySetKey(), entityKey);

      const token2 = uuidv4();
      const third = (await redis.eval(
        PICK_DISPATCHABLE_SCRIPT,
        1,
        readySetKey(),
        `${KEY_PREFIX}:gate:`,
        `${KEY_PREFIX}:log:`,
        token2,
        '30',
        '32',
      )) as [string, string, string];

      expect(JSON.parse(third[1]).name).toBe('Msg2');
    });
  });

  describe('concurrent entity processing', () => {
    it('should dispatch different entities in parallel', async () => {
      for (let i = 1; i <= 3; i++) {
        const entityKey = `account:par-${i}`;
        await redis.lpush(logKey(entityKey), createMessage('account', `par-${i}`, `Op${i}`));
        await redis.sadd(readySetKey(), entityKey);
      }

      const results: ([string, string, string] | null)[] = [];
      for (let i = 0; i < 3; i++) {
        const r = (await redis.eval(
          PICK_DISPATCHABLE_SCRIPT,
          1,
          readySetKey(),
          `${KEY_PREFIX}:gate:`,
          `${KEY_PREFIX}:log:`,
          uuidv4(),
          '30',
          '32',
        )) as [string, string, string] | null;
        results.push(r);
      }

      const dispatched = results.filter((r) => r !== null);
      expect(dispatched.length).toBe(3);

      const keys = dispatched.map((r) => r![0]).sort();
      expect(keys).toEqual(['account:par-1', 'account:par-2', 'account:par-3']);
    });
  });
});
