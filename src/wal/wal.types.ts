import { ISerializedMessage } from '../domain';

export type WalState = 'enqueued' | 'dispatched' | 'completed' | 'failed' | 'interrupted';

export interface IWalEntry {
  messageId: string;
  state: WalState;
  message: ISerializedMessage;
  entityKey: string;
  serverId: string;
  enqueuedAt: number;
  dispatchedAt?: number;
  completedAt?: number;
  error?: string;
  errorStack?: string;
  correlationId?: string;
  workerId?: number;
}

export interface IWalConfig {
  /** Enable WAL persistence (default: true) */
  enabled?: boolean;
  /** Cleanup batch interval in ms (default: 5000) */
  cleanupInterval?: number;
  /** Safety TTL for WAL entries in seconds (default: 86400 = 24h) */
  entryTTL?: number;
}

export interface IWalRecoveryResult {
  reEnqueued: number;
  interrupted: number;
  cleaned: number;
}
