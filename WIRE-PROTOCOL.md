# atomic-queues Wire Protocol

This document specifies the Redis data structures, key layout, and command sequences used by atomic-queues V2. Any client that follows this protocol can enqueue messages, read results, and query the registry — regardless of language or framework.

## 1. Redis Key Layout

All keys are prefixed with a configurable `keyPrefix` (default: `aq`). Below, `{p}` is a shorthand for the prefix, `{et}` for entity type, and `{eid}` for entity ID.

| Pattern | Type | Description |
|---|---|---|
| `{p}:log:{et}:{eid}` | List | Per-entity message log (FIFO queue) |
| `{p}:ready` | Set | Entity keys that have pending messages |
| `{p}:gate:{et}:{eid}` | String | Dispatch gate (mutex). Value = owner token |
| `{p}:dead:{et}` | List | Dead-letter queue per entity type |
| `{p}:tickle` | Pub/Sub channel | Notification channel for executor pools |
| `{p}:results:{correlationId}` | Pub/Sub channel | Result delivery for request-reply |
| `{p}:registry:{et}` | String (JSON) | Entity contract (when registry enabled) |
| `{p}:registry:updates` | Pub/Sub channel | Registry change notifications |
| `{p}:actor-state:{et}:{eid}` | String (JSON) | Persisted actor instance state |

## 2. Message Format

Messages are serialized as JSON and stored in the log lists.

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "WithdrawCommand",
  "data": {
    "accountId": "a-1",
    "amount": 100
  },
  "entityType": "account",
  "entityId": "a-1",
  "isQuery": false,
  "correlationId": null,
  "enqueuedAt": 1700000000000,
  "attempts": 0,
  "maxAttempts": 3
}
```

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Unique message identifier |
| `name` | string | Message class name (used for handler routing) |
| `data` | object | Serialized message payload |
| `entityType` | string | Entity type for routing and gating |
| `entityId` | string | Entity instance ID |
| `isQuery` | boolean? | If true, a result is expected |
| `correlationId` | string? | UUID for request-reply pattern (required when `isQuery=true`) |
| `enqueuedAt` | number | Unix timestamp (ms) when enqueued |
| `attempts` | number | Number of execution attempts so far |
| `maxAttempts` | number | Maximum retry attempts before dead-letter |

## 3. Result Format

Results are published as JSON on `{p}:results:{correlationId}`.

**Success:**
```json
{ "result": <any> }
```

**Error:**
```json
{ "error": "Error message string" }
```

## 4. Enqueue (Fire-and-Forget)

Exact Redis command sequence:

```
LPUSH  {p}:log:{et}:{eid}  <message-json>
SADD   {p}:ready  {et}:{eid}
PUBLISH {p}:tickle  "1"
```

These three commands are pipelined in a single round-trip.

## 5. Enqueue and Wait (Request-Reply)

```
# 1. Subscribe to results pattern (done ONCE at startup by ResultCollector)
PSUBSCRIBE {p}:results:*

# 2. Register correlationId in local pending map (in-process, not Redis)

# 3. Enqueue the message (same as fire-and-forget, with isQuery=true and correlationId set)
LPUSH  {p}:log:{et}:{eid}  <message-json>
SADD   {p}:ready  {et}:{eid}
PUBLISH {p}:tickle  "1"

# 4. Wait for result on the pattern subscription
# When PMESSAGE arrives on channel {p}:results:{correlationId}, resolve the promise

# 5. On timeout, reject the promise locally (no Redis cleanup needed)
```

The ResultCollector uses a single `PSUBSCRIBE` connection for all pending waits. This avoids creating N TCP connections for N concurrent waits.

## 6. Dispatch (Executor Pool — Internal)

The executor pool uses a Lua script for atomic pick-dispatch:

```lua
-- KEYS[1] = ready set key
-- ARGV[1] = gate key prefix
-- ARGV[2] = gate TTL (seconds)
-- ARGV[3] = owner token (UUID)
-- ARGV[4] = log key prefix

local entityKey = redis.call('SRANDMEMBER', KEYS[1])
if not entityKey then return nil end

local gateKey = ARGV[1] .. entityKey
local acquired = redis.call('SET', gateKey, ARGV[3], 'EX', tonumber(ARGV[2]), 'NX')
if not acquired then return nil end

local logKey = ARGV[4] .. entityKey
local msg = redis.call('RPOP', logKey)
if not msg then
  redis.call('DEL', gateKey)
  redis.call('SREM', KEYS[1], entityKey)
  return nil
end

local remaining = redis.call('LLEN', logKey)
if remaining == 0 then
  redis.call('SREM', KEYS[1], entityKey)
end

return {entityKey, msg, ARGV[3]}
```

After execution, the executor either completes or fails:

**Complete:**
```
DEL    {p}:gate:{et}:{eid}           -- release gate
LLEN   {p}:log:{et}:{eid}            -- check remaining
SADD   {p}:ready  {et}:{eid}         -- if remaining > 0, re-mark ready
PUBLISH {p}:results:{correlationId}   -- if correlationId present
```

**Fail (retry):**
```
DEL    {p}:gate:{et}:{eid}           -- release gate
LPUSH  {p}:log:{et}:{eid}  <msg>    -- re-enqueue with attempts++
SADD   {p}:ready  {et}:{eid}         -- mark ready again
```

**Fail (dead-letter, attempts >= maxAttempts):**
```
DEL    {p}:gate:{et}:{eid}           -- release gate
LPUSH  {p}:dead:{et}  <msg>          -- dead-letter
```

## 7. Registry Read

When the distributed registry is enabled, entity contracts are stored as JSON strings with a TTL. Services refresh the TTL via heartbeat.

**Read a contract:**
```
GET {p}:registry:{et}
```

Returns a JSON object:
```json
{
  "entityType": "account",
  "serviceName": "bank-service",
  "version": "1.0.0",
  "messages": {
    "WithdrawCommand": {
      "kind": "command",
      "schema": { "type": "object", "required": ["accountId", "amount"], ... }
    },
    "GetBalanceQuery": {
      "kind": "query",
      "schema": { ... },
      "replySchema": { ... }
    }
  },
  "registeredAt": 1700000000000,
  "lastHeartbeat": 1700000060000
}
```

**List all entity types:**
```
SCAN 0 MATCH {p}:registry:* COUNT 100
```

**Watch for changes:**
```
SUBSCRIBE {p}:registry:updates
```

Change events are JSON:
```json
{ "entityType": "account", "action": "registered", "serviceName": "bank-service" }
```

## 8. Versioning Commitment

The following constitute breaking changes to this wire protocol:

- Changing the key layout (renaming, restructuring key patterns)
- Changing the message JSON format (adding required fields, removing fields, changing types)
- Changing the result JSON format
- Changing the Lua script semantics (gate acquisition, message pop order)
- Changing the pub/sub channel naming

The following are NOT breaking changes:

- Adding optional fields to the message or result JSON
- Adding new key patterns that don't conflict with existing ones
- Adding new pub/sub channels
- Changing internal service behavior that doesn't affect the Redis protocol

Breaking changes will be accompanied by a major version bump.

## 9. Example Client (Python)

A minimal Python client that enqueues a message and waits for the result:

```python
import redis
import uuid
import json
import time

r = redis.Redis(host='localhost', port=6379)
prefix = 'aq'

def enqueue(entity_type: str, entity_id: str, name: str, data: dict) -> str:
    """Fire-and-forget enqueue."""
    msg_id = str(uuid.uuid4())
    entity_key = f"{entity_type}:{entity_id}"
    message = json.dumps({
        "id": msg_id,
        "name": name,
        "data": data,
        "entityType": entity_type,
        "entityId": entity_id,
        "enqueuedAt": int(time.time() * 1000),
        "attempts": 0,
        "maxAttempts": 3,
    })
    pipe = r.pipeline()
    pipe.lpush(f"{prefix}:log:{entity_key}", message)
    pipe.sadd(f"{prefix}:ready", entity_key)
    pipe.publish(f"{prefix}:tickle", "1")
    pipe.execute()
    return msg_id

def enqueue_and_wait(entity_type: str, entity_id: str, name: str, data: dict,
                     timeout: float = 30.0):
    """Enqueue and block until result arrives."""
    correlation_id = str(uuid.uuid4())
    entity_key = f"{entity_type}:{entity_id}"
    channel = f"{prefix}:results:{correlation_id}"

    # Subscribe BEFORE enqueuing
    pubsub = r.pubsub()
    pubsub.subscribe(channel)

    message = json.dumps({
        "id": str(uuid.uuid4()),
        "name": name,
        "data": data,
        "entityType": entity_type,
        "entityId": entity_id,
        "isQuery": True,
        "correlationId": correlation_id,
        "enqueuedAt": int(time.time() * 1000),
        "attempts": 0,
        "maxAttempts": 3,
    })

    pipe = r.pipeline()
    pipe.lpush(f"{prefix}:log:{entity_key}", message)
    pipe.sadd(f"{prefix}:ready", entity_key)
    pipe.publish(f"{prefix}:tickle", "1")
    pipe.execute()

    # Wait for result
    deadline = time.time() + timeout
    for msg in pubsub.listen():
        if time.time() > deadline:
            pubsub.unsubscribe(channel)
            raise TimeoutError(f"No result after {timeout}s")
        if msg["type"] == "message":
            payload = json.loads(msg["data"])
            pubsub.unsubscribe(channel)
            if "error" in payload:
                raise RuntimeError(payload["error"])
            return payload["result"]

# Usage:
# enqueue("account", "a-1", "DepositCommand", {"amount": 100})
# balance = enqueue_and_wait("account", "a-1", "GetBalanceQuery", {"accountId": "a-1"})
```
