/**
 * Event types for pub/sub communication
 */
export type AtomicQueueEventType =
  | 'worker:shutdown'
  | 'worker:ready'
  | 'worker:closed'
  | 'job:completed'
  | 'job:failed'
  | 'job:progress'
  | 'queue:closed'
  | 'custom';

/**
 * Event payload structure
 */
export interface IAtomicQueueEvent<T = unknown> {
  type: AtomicQueueEventType;
  nodeId: string;
  workerId?: string;
  entityId?: string;
  entityType?: string;
  timestamp: Date;
  data?: T;
}

/**
 * Event bus interface for internal pub/sub
 */
export interface IEventBus {
  /**
   * Publish an event
   */
  publish<T>(channel: string, event: IAtomicQueueEvent<T>): Promise<void>;

  /**
   * Subscribe to a channel
   */
  subscribe(
    channel: string,
    handler: (event: IAtomicQueueEvent) => void | Promise<void>,
  ): Promise<void>;

  /**
   * Unsubscribe from a channel
   */
  unsubscribe(channel: string): Promise<void>;

  /**
   * Subscribe to worker shutdown events for a specific worker
   */
  subscribeToWorkerShutdown(
    workerName: string,
    handler: () => void | Promise<void>,
  ): Promise<void>;
}

/**
 * Socket connection tracking interface
 */
export interface IConnectionTracker {
  /**
   * Track a socket connection for an entity
   */
  trackConnection(
    entityType: string,
    entityId: string,
    socketId: string,
    nodeId: string,
  ): Promise<void>;

  /**
   * Untrack a socket connection
   */
  untrackConnection(entityType: string, entityId: string, socketId: string): Promise<void>;

  /**
   * Get all socket connections for an entity
   */
  getEntityConnections(entityType: string, entityId: string): Promise<string[]>;

  /**
   * Get entity connections for a specific node
   */
  getEntityNodeConnections(
    entityType: string,
    entityId: string,
    nodeId: string,
  ): Promise<string[]>;

  /**
   * Untrack all connections for current node
   */
  untrackNodeConnections(): Promise<void>;

  /**
   * Check if entity has active connections
   */
  hasActiveConnections(entityType: string, entityId: string): Promise<boolean>;

  /**
   * Get node ID for a socket connection
   */
  getNodeForSocket(entityType: string, entityId: string, socketId: string): Promise<string | null>;
}
