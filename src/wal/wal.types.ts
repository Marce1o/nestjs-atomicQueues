import { ISerializedMessage, IWalConfig } from '../domain';

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

export { IWalConfig };

export interface IWalRecoveryResult {
  reEnqueued: number;
  interrupted: number;
  cleaned: number;
}
