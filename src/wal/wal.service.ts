import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { ISerializedMessage } from '../domain';
import { resolveKeyPrefix } from '../utils';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../services/constants';
import { IWalEntry, IWalConfig, IWalRecoveryResult, WalState } from './wal.types';
import {
  DISPATCH_SCRIPT,
  COMPLETE_SCRIPT,
  FAIL_SCRIPT,
  INTERRUPT_SCRIPT,
} from './wal.scripts';

@Injectable()
export class WalService {
  private readonly logger = new Logger(WalService.name);
  private readonly keyPrefix: string;
  private readonly serverId: string;
  private readonly entryTTL: number;
  private readonly cleanupInterval: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: { keyPrefix?: string; wal?: IWalConfig },
    serverId: string,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
    this.serverId = serverId;
    this.entryTTL = config.wal?.entryTTL ?? 86400;
    this.cleanupInterval = config.wal?.cleanupInterval ?? 5000;
  }

  // =========================================================================
  // KEY HELPERS
  // =========================================================================

  walEntryKey(entityKey: string, messageId: string): string {
    return `${this.keyPrefix}:wal:${this.serverId}:${entityKey}:${messageId}`;
  }

  walIndexKey(): string {
    return `${this.keyPrefix}:wal:${this.serverId}:index`;
  }

  deadLetterKey(entityType: string): string {
    return `${this.keyPrefix}:dead:${entityType}`;
  }

  // =========================================================================
  // WRITE — enqueue a message to the WAL
  // =========================================================================

  async write(entityKey: string, message: ISerializedMessage): Promise<void> {
    const entryKey = this.walEntryKey(entityKey, message.id);
    const indexKey = this.walIndexKey();
    const indexMember = `${entityKey}:${message.id}`;

    const entry: Record<string, string> = {
      state: 'enqueued',
      message: JSON.stringify(message),
      entity_key: entityKey,
      enqueued_at: message.enqueuedAt.toString(),
      correlation_id: message.correlationId ?? '',
      server_id: this.serverId,
    };

    const pipeline = this.redis.pipeline();
    pipeline.hset(entryKey, entry);
    pipeline.expire(entryKey, this.entryTTL);
    pipeline.zadd(indexKey, message.enqueuedAt, indexMember);
    await pipeline.exec();
  }

  // =========================================================================
  // STATE TRANSITIONS — atomic via Lua scripts
  // =========================================================================

  async markDispatched(entityKey: string, messageId: string, workerId: number): Promise<boolean> {
    const entryKey = this.walEntryKey(entityKey, messageId);
    const result = (await this.redis.eval(
      DISPATCH_SCRIPT,
      1,
      entryKey,
      Date.now().toString(),
      workerId.toString(),
    )) as number;
    return result === 1;
  }

  async markCompleted(entityKey: string, messageId: string): Promise<boolean> {
    const entryKey = this.walEntryKey(entityKey, messageId);
    const indexKey = this.walIndexKey();
    const indexMember = `${entityKey}:${messageId}`;
    const result = (await this.redis.eval(
      COMPLETE_SCRIPT,
      2,
      entryKey,
      indexKey,
      Date.now().toString(),
      indexMember,
    )) as number;
    return result === 1;
  }

  async markFailed(
    entityKey: string,
    messageId: string,
    error: string,
    stack?: string,
  ): Promise<boolean> {
    const entryKey = this.walEntryKey(entityKey, messageId);
    const result = (await this.redis.eval(
      FAIL_SCRIPT,
      1,
      entryKey,
      Date.now().toString(),
      error,
      stack ?? '',
    )) as number;
    return result === 1;
  }

  async markInterrupted(entityKey: string, messageId: string, reason: string): Promise<boolean> {
    const entryKey = this.walEntryKey(entityKey, messageId);
    const result = (await this.redis.eval(
      INTERRUPT_SCRIPT,
      1,
      entryKey,
      Date.now().toString(),
      reason,
    )) as number;
    return result === 1;
  }

  // =========================================================================
  // READ — get a WAL entry
  // =========================================================================

  async getEntry(entityKey: string, messageId: string): Promise<IWalEntry | null> {
    const entryKey = this.walEntryKey(entityKey, messageId);
    const raw = await this.redis.hgetall(entryKey);
    if (!raw || !raw.state) return null;

    return {
      messageId,
      state: raw.state as WalState,
      message: JSON.parse(raw.message),
      entityKey: raw.entity_key,
      serverId: raw.server_id,
      enqueuedAt: parseInt(raw.enqueued_at, 10),
      dispatchedAt: raw.dispatched_at ? parseInt(raw.dispatched_at, 10) : undefined,
      completedAt: raw.completed_at ? parseInt(raw.completed_at, 10) : undefined,
      error: raw.error || undefined,
      errorStack: raw.error_stack || undefined,
      correlationId: raw.correlation_id || undefined,
      workerId: raw.worker_id ? parseInt(raw.worker_id, 10) : undefined,
    };
  }

  // =========================================================================
  // RECOVERY — run on startup to resolve orphaned entries
  // =========================================================================

  async recover(
    onInterruptPolicy: Record<string, 'dead-letter' | 'retry'> = {},
    defaultPolicy: 'dead-letter' | 'retry' = 'dead-letter',
  ): Promise<IWalRecoveryResult> {
    const indexKey = this.walIndexKey();
    const members = await this.redis.zrange(indexKey, 0, -1);

    let reEnqueued = 0;
    let interrupted = 0;
    let cleaned = 0;

    const pendingMessages: ISerializedMessage[] = [];

    for (const member of members) {
      // member format: "entityKey:messageId"
      const lastColon = member.lastIndexOf(':');
      // entityKey can itself contain colons (e.g. "account:a-123")
      // member is "account:a-123:msg-uuid"
      // We need to parse the messageId (UUID) from the end
      const parts = member.split(':');
      const messageId = parts[parts.length - 1];
      const entityKey = parts.slice(0, -1).join(':');

      const entry = await this.getEntry(entityKey, messageId);
      if (!entry) {
        // Stale index entry — remove it
        await this.redis.zrem(indexKey, member);
        cleaned++;
        continue;
      }

      switch (entry.state) {
        case 'enqueued':
          // Handler never ran — safe to re-dispatch
          pendingMessages.push(entry.message);
          reEnqueued++;
          break;

        case 'dispatched': {
          // INTERRUPTED — process crashed during handler execution
          const entityType = entry.message.entityType;
          const policy = onInterruptPolicy[entityType] ?? defaultPolicy;

          if (policy === 'retry') {
            entry.message.attempts++;
            if (entry.message.attempts < entry.message.maxAttempts) {
              pendingMessages.push(entry.message);
              reEnqueued++;
            } else {
              await this.deadLetter(entityType, entry.message, 'interrupted: max retries exceeded');
              interrupted++;
            }
          } else {
            await this.deadLetter(
              entityType,
              entry.message,
              'interrupted: process crashed during execution',
            );
            interrupted++;
          }

          // Clean the WAL entry
          const entryKey = this.walEntryKey(entityKey, messageId);
          await this.redis.del(entryKey);
          await this.redis.zrem(indexKey, member);
          break;
        }

        case 'completed':
        case 'failed':
        case 'interrupted': {
          // Stale — should have been cleaned up
          const entryKey = this.walEntryKey(entityKey, messageId);
          await this.redis.del(entryKey);
          await this.redis.zrem(indexKey, member);
          cleaned++;
          break;
        }
      }
    }

    this.logger.log(
      `WAL recovery: ${reEnqueued} re-enqueued, ${interrupted} interrupted, ${cleaned} cleaned`,
    );

    return { reEnqueued, interrupted, cleaned };
  }

  /**
   * Returns the messages that should be re-enqueued after recovery.
   * Called by the recovery procedure to get pending messages.
   */
  async getPendingMessages(): Promise<ISerializedMessage[]> {
    const indexKey = this.walIndexKey();
    const members = await this.redis.zrange(indexKey, 0, -1);
    const pending: ISerializedMessage[] = [];

    for (const member of members) {
      const parts = member.split(':');
      const messageId = parts[parts.length - 1];
      const entityKey = parts.slice(0, -1).join(':');

      const entry = await this.getEntry(entityKey, messageId);
      if (entry && entry.state === 'enqueued') {
        pending.push(entry.message);
      }
    }

    return pending;
  }

  // =========================================================================
  // DEAD LETTER
  // =========================================================================

  async deadLetter(entityType: string, message: ISerializedMessage, reason: string): Promise<void> {
    const deadKey = this.deadLetterKey(entityType);
    await this.redis.lpush(
      deadKey,
      JSON.stringify({
        ...message,
        deadLetteredAt: Date.now(),
        deadLetterReason: reason,
      }),
    );
    this.logger.warn(
      `Dead-lettered ${message.name} for ${entityType}:${message.entityId}: ${reason}`,
    );
  }

  async getDeadLetters(entityType: string, limit = 100): Promise<ISerializedMessage[]> {
    const deadKey = this.deadLetterKey(entityType);
    const raw = await this.redis.lrange(deadKey, 0, limit - 1);
    return raw.map((r) => JSON.parse(r));
  }

  // =========================================================================
  // CLEANUP
  // =========================================================================

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch((err) => {
        this.logger.error(`WAL cleanup error: ${(err as Error).message}`);
      });
    }, this.cleanupInterval);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private async cleanup(): Promise<void> {
    const indexKey = this.walIndexKey();
    const members = await this.redis.zrange(indexKey, 0, -1);

    let cleaned = 0;
    for (const member of members) {
      const parts = member.split(':');
      const messageId = parts[parts.length - 1];
      const entityKey = parts.slice(0, -1).join(':');

      const entryKey = this.walEntryKey(entityKey, messageId);
      const state = await this.redis.hget(entryKey, 'state');

      if (!state || state === 'completed' || state === 'failed' || state === 'interrupted') {
        await this.redis.del(entryKey);
        await this.redis.zrem(indexKey, member);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`WAL cleanup: removed ${cleaned} entries`);
    }
  }
}
