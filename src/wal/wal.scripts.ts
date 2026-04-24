/**
 * Lua scripts for atomic WAL state transitions.
 * Each script operates atomically within Redis.
 */

/**
 * Transition WAL entry from 'enqueued' to 'dispatched'.
 * Only succeeds if current state is 'enqueued'.
 *
 * KEYS[1] = WAL entry hash key
 * ARGV[1] = timestamp (dispatched_at)
 * ARGV[2] = worker_id
 *
 * Returns 1 on success, 0 if state is not 'enqueued'.
 */
export const DISPATCH_SCRIPT = `
local state = redis.call("HGET", KEYS[1], "state")
if state ~= "enqueued" then
  return 0
end
redis.call("HSET", KEYS[1], "state", "dispatched", "dispatched_at", ARGV[1], "worker_id", ARGV[2])
return 1
`;

/**
 * Transition WAL entry from 'dispatched' to 'completed'.
 * Only succeeds if current state is 'dispatched'.
 *
 * KEYS[1] = WAL entry hash key
 * KEYS[2] = WAL index sorted set key
 * ARGV[1] = timestamp (completed_at)
 * ARGV[2] = index member (entityKey:messageId)
 *
 * Returns 1 on success, 0 if state is not 'dispatched'.
 */
export const COMPLETE_SCRIPT = `
local state = redis.call("HGET", KEYS[1], "state")
if state ~= "dispatched" then
  return 0
end
redis.call("HSET", KEYS[1], "state", "completed", "completed_at", ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[2])
redis.call("DEL", KEYS[1])
return 1
`;

/**
 * Transition WAL entry from 'dispatched' to 'failed'.
 * Records error details.
 *
 * KEYS[1] = WAL entry hash key
 * ARGV[1] = timestamp (completed_at)
 * ARGV[2] = error message
 * ARGV[3] = error stack (may be empty)
 *
 * Returns 1 on success, 0 if state is not 'dispatched'.
 */
export const FAIL_SCRIPT = `
local state = redis.call("HGET", KEYS[1], "state")
if state ~= "dispatched" then
  return 0
end
redis.call("HSET", KEYS[1], "state", "failed", "completed_at", ARGV[1], "error", ARGV[2], "error_stack", ARGV[3])
return 1
`;

/**
 * Transition WAL entry from 'dispatched' to 'interrupted'.
 * Used during recovery when a process crashed mid-execution.
 *
 * KEYS[1] = WAL entry hash key
 * ARGV[1] = timestamp
 * ARGV[2] = reason string
 *
 * Returns 1 on success, 0 if state is not 'dispatched'.
 */
export const INTERRUPT_SCRIPT = `
local state = redis.call("HGET", KEYS[1], "state")
if state ~= "dispatched" then
  return 0
end
redis.call("HSET", KEYS[1], "state", "interrupted", "completed_at", ARGV[1], "error", ARGV[2])
return 1
`;
