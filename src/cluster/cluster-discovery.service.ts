import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../domain';
import { resolveKeyPrefix } from '../utils';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../services/constants';

export interface ClusterNode {
  serverId: string;
  grpcAddress: string;
  serviceGroup: string;
  entityTypes: string[];
  ringVersion: number;
  startedAt: number;
  heartbeatAt: number;
}

const HEARTBEAT_SCRIPT = `
redis.call("HSET", KEYS[1], "heartbeat_at", ARGV[1])
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return redis.call("HGET", KEYS[1], "ring_version")
`;

/**
 * Cluster Discovery Service.
 *
 * Manages server heartbeats, ring membership, and ring change events
 * using Redis as the source of truth.
 *
 * Only active when `config.grpc.enabled` is true.
 */
@Injectable()
export class ClusterDiscoveryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ClusterDiscoveryService.name);
  private readonly keyPrefix: string;
  private readonly enabled: boolean;
  private readonly serverId: string;
  private readonly serviceGroup: string;
  private readonly grpcAddress: string;
  private readonly heartbeatIntervalMs: number;
  private readonly nodeTTL: number;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private subscriber: Redis | null = null;

  private readonly changeListeners: Array<(nodes: ClusterNode[]) => void> = [];

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
    this.enabled = config.grpc?.enabled ?? false;
    this.serverId = config.grpc?.serverId ?? 'unknown';
    this.serviceGroup = config.grpc?.serviceGroup ?? 'default';
    this.grpcAddress = config.grpc?.advertisedAddress ?? '0.0.0.0:50051';
    this.heartbeatIntervalMs = config.grpc?.heartbeatMs ?? 400;
    this.nodeTTL = config.grpc?.nodeTTLMs ?? 1500;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;

    // Register this node
    await this.registerNode();

    // Increment ring version
    await this.incrementRingVersion();

    // Publish join event
    await this.publishEvent('join');

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((err) => {
        this.logger.error(`Heartbeat failed: ${(err as Error).message}`);
      });
    }, this.heartbeatIntervalMs);

    // Start ring reconciliation
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((err) => {
        this.logger.error(`Reconciliation failed: ${(err as Error).message}`);
      });
    }, this.heartbeatIntervalMs);

    // Subscribe to ring events
    this.subscriber = this.redis.duplicate();
    const channel = this.getEventsChannel();
    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (_ch: string, payload: string) => {
      this.handleEvent(payload);
    });

    this.logger.log(
      `Cluster discovery started: serverId=${this.serverId}, group=${this.serviceGroup}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.enabled) return;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);

    // Remove this node from the ring
    await this.redis.del(this.getNodeKey(this.serverId));
    await this.incrementRingVersion();
    await this.publishEvent('leave');

    if (this.subscriber) {
      await this.subscriber.unsubscribe();
      await this.subscriber.quit();
    }

    this.logger.log('Cluster discovery stopped');
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  /**
   * Get all live nodes in the cluster.
   */
  async getNodes(): Promise<ClusterNode[]> {
    const pattern = `${this.keyPrefix}:cluster:nodes:*`;
    const keys = await this.scanKeys(pattern);

    const nodes: ClusterNode[] = [];
    for (const key of keys) {
      const data = await this.redis.hgetall(key);
      if (data && data.server_id) {
        nodes.push(this.parseNodeData(data));
      }
    }

    return nodes;
  }

  /**
   * Get the current ring version.
   */
  async getRingVersion(): Promise<number> {
    const versionKey = `${this.keyPrefix}:cluster:ring:version`;
    const version = await this.redis.get(versionKey);
    return version ? parseInt(version, 10) : 0;
  }

  /**
   * Register a listener for ring change events.
   */
  onRingChange(listener: (nodes: ClusterNode[]) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      const idx = this.changeListeners.indexOf(listener);
      if (idx >= 0) this.changeListeners.splice(idx, 1);
    };
  }

  /**
   * Get this server's ID.
   */
  getServerId(): string {
    return this.serverId;
  }

  /**
   * Resolve which service group owns an entity type (via Redis registry).
   */
  async resolveServiceGroup(entityType: string): Promise<string | null> {
    const registryKey = `${this.keyPrefix}:cluster:entity-registry:${entityType}`;
    return this.redis.get(registryKey);
  }

  // =========================================================================
  // INTERNAL — Registration
  // =========================================================================

  private async registerNode(): Promise<void> {
    const key = this.getNodeKey(this.serverId);
    const entityTypes = Object.keys(this.config.entities ?? {});
    const data: Record<string, string> = {
      server_id: this.serverId,
      grpc_address: this.grpcAddress,
      service_group: this.serviceGroup,
      entity_types: entityTypes.join(','),
      ring_version: '0',
      started_at: Date.now().toString(),
      heartbeat_at: Date.now().toString(),
    };

    await this.redis.hset(key, data);
    await this.redis.pexpire(key, this.nodeTTL);

    // Register entity type → service group mapping for cross-service routing
    for (const et of entityTypes) {
      const registryKey = `${this.keyPrefix}:cluster:entity-registry:${et}`;
      await this.redis.set(registryKey, this.serviceGroup, 'PX', this.nodeTTL * 2);
    }
  }

  private async heartbeat(): Promise<void> {
    const key = this.getNodeKey(this.serverId);
    await this.redis.eval(HEARTBEAT_SCRIPT, 1, key, Date.now().toString(), this.nodeTTL.toString());

    // Refresh entity type registry TTLs
    const entityTypes = Object.keys(this.config.entities ?? {});
    for (const et of entityTypes) {
      const registryKey = `${this.keyPrefix}:cluster:entity-registry:${et}`;
      await this.redis.pexpire(registryKey, this.nodeTTL * 2);
    }
  }

  private async reconcile(): Promise<void> {
    // Check if any nodes have disappeared since last check
    const nodes = await this.getNodes();
    this.notifyListeners(nodes);
  }

  // =========================================================================
  // INTERNAL — Events
  // =========================================================================

  private async publishEvent(action: 'join' | 'leave'): Promise<void> {
    const channel = this.getEventsChannel();
    await this.redis.publish(
      channel,
      JSON.stringify({
        action,
        serverId: this.serverId,
        serviceGroup: this.serviceGroup,
        timestamp: Date.now(),
      }),
    );
  }

  private handleEvent(payload: string): void {
    try {
      const event = JSON.parse(payload);
      if (event.serverId === this.serverId) return; // Ignore own events

      this.logger.log(`Ring event: ${event.action} from ${event.serverId}`);

      // Re-fetch nodes and notify listeners
      this.getNodes()
        .then((nodes) => this.notifyListeners(nodes))
        .catch((err) => this.logger.error(`Failed to refresh nodes: ${(err as Error).message}`));
    } catch {
      // Ignore malformed events
    }
  }

  private notifyListeners(nodes: ClusterNode[]): void {
    for (const listener of this.changeListeners) {
      try {
        listener(nodes);
      } catch (err) {
        this.logger.error(`Ring change listener error: ${(err as Error).message}`);
      }
    }
  }

  // =========================================================================
  // INTERNAL — Helpers
  // =========================================================================

  private getNodeKey(serverId: string): string {
    return `${this.keyPrefix}:cluster:nodes:${serverId}`;
  }

  private getEventsChannel(): string {
    return `${this.keyPrefix}:cluster:events`;
  }

  private async incrementRingVersion(): Promise<number> {
    const versionKey = `${this.keyPrefix}:cluster:ring:version`;
    return this.redis.incr(versionKey);
  }

  private parseNodeData(data: Record<string, string>): ClusterNode {
    return {
      serverId: data.server_id,
      grpcAddress: data.grpc_address,
      serviceGroup: data.service_group,
      entityTypes: data.entity_types ? data.entity_types.split(',').filter(Boolean) : [],
      ringVersion: parseInt(data.ring_version || '0', 10),
      startedAt: parseInt(data.started_at || '0', 10),
      heartbeatAt: parseInt(data.heartbeat_at || '0', 10),
    };
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    let cursor = '0';
    const keys: string[] = [];
    do {
      const [nextCursor, foundKeys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...foundKeys);
    } while (cursor !== '0');
    return keys;
  }
}
