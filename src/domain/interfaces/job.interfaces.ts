/**
 * Serialized message stored in the entity log
 */
export interface ISerializedMessage {
  /** Unique message ID */
  id: string;
  /** Message class name (e.g., 'WithdrawCommand') */
  name: string;
  /** Serialized message data */
  data: Record<string, any>;
  /** Entity type */
  entityType: string;
  /** Entity ID */
  entityId: string;
  /** Whether this is a query (expects a reply) */
  isQuery?: boolean;
  /** Correlation ID for reply delivery */
  correlationId?: string;
  /** Timestamp when enqueued */
  enqueuedAt: number;
  /** Number of attempts so far */
  attempts: number;
  /** Max attempts allowed */
  maxAttempts: number;
}

/**
 * Reference returned from enqueue operations
 */
export interface IMessageRef {
  /** Unique message ID */
  id: string;
  /** Entity key (entityType:entityId) */
  entityKey: string;
}

/**
 * Result of a dispatched message
 */
export interface IDispatchResult {
  entityKey: string;
  message: ISerializedMessage;
  ownerToken: string;
}
