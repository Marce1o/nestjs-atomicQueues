import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig, ISerializedMessage, IDispatchResult } from '../../domain';
import { resolveKeyPrefix } from '../../utils';
import { LogService } from '../log';
import { GateService } from '../gate';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../constants';

const PICK_DISPATCHABLE_SCRIPT = `
local readySetKey = KEYS[1]
local gatePrefix = ARGV[1]
local logPrefix = ARGV[2]
local ownerToken = ARGV[3]
local defaultTTL = tonumber(ARGV[4])
local batchSize = tonumber(ARGV[5]) or 32

local members = redis.call("SRANDMEMBER", readySetKey, batchSize)
if not members or #members == 0 then
  return nil
end

for _, entityKey in ipairs(members) do
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

return nil
`;

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly logService: LogService,
    private readonly gateService: GateService,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
  }

  async pickNext(): Promise<IDispatchResult | null> {
    const readySetKey = this.logService.getReadySetKey();
    const gatePrefix = `${this.keyPrefix}:gate:`;
    const logPrefix = `${this.keyPrefix}:log:`;
    const ownerToken = uuidv4();
    const defaultTTL = this.config.executor?.gateTTL ?? 30;

    const result = await this.redis.eval(
      PICK_DISPATCHABLE_SCRIPT,
      1,
      readySetKey,
      gatePrefix,
      logPrefix,
      ownerToken,
      defaultTTL.toString(),
      '32',
    ) as [string, string, string] | null;

    if (!result) return null;

    const [entityKey, rawMessage, token] = result;
    const message = JSON.parse(rawMessage) as ISerializedMessage;

    this.logger.debug(`Dispatched ${message.name} for ${entityKey}`);

    return { entityKey, message, ownerToken: token };
  }

  async complete(entityKey: string): Promise<void> {
    await this.gateService.release(entityKey);

    const remaining = await this.logService.length(entityKey);
    if (remaining > 0) {
      await this.logService.markReady(entityKey);
    }
  }

  async fail(entityKey: string, message: ISerializedMessage, error: Error): Promise<void> {
    await this.gateService.release(entityKey);

    const entityType = message.entityType;
    const retryConfig = this.config.entities?.[entityType]?.retry ?? this.config.retry;
    const maxAttempts = retryConfig?.maxAttempts ?? 3;

    message.attempts++;

    if (message.attempts >= maxAttempts) {
      await this.logService.deadLetter(entityType, message);
    } else {
      const logKey = this.logService.getLogKey(entityKey);
      await this.redis.rpush(logKey, JSON.stringify(message));
      await this.logService.markReady(entityKey);
      this.logger.warn(
        `Retrying ${message.name} for ${entityKey} (attempt ${message.attempts + 1}/${maxAttempts}): ${error.message}`,
      );
    }
  }
}
