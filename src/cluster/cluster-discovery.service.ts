import { Injectable, Logger, Inject, Optional, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig } from '../domain';
import { resolveKeyPrefix } from '../utils';
import { ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG } from '../services/constants';
import { GrpcPeerMonitor } from './grpc-peer-monitor.service';
import { RedisHealthMonitor } from './redis-health-monitor.service';

export interface ClusterNode {
  serverId: string;
  instanceId?: string;
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
  private readonly reconcileIntervalMs: number;
  private readonly nodeTTL: number;

  private readonly instanceId: string = uuidv4();
  private lastSeenRingVersion = 0;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private eventReconcileTimer: NodeJS.Timeout | null = null;
  private subscriber: Redis | null = null;
  private redisAvailable = true;
  private unsubscribePeerMonitor: (() => void) | null = null;
  private unsubscribeRedisHealth: (() => void) | null = null;

  private readonly changeListeners: Array<(nodes: ClusterNode[]) => void> = [];

  constructor(
    @Inject(ATOMIC_QUEUES_REDIS) private readonly redis: Redis,
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    @Optional() private readonly peerMonitor?: GrpcPeerMonitor,
    @Optional() private readonly redisHealthMonitor?: RedisHealthMonitor,
  ) {
    this.keyPrefix = resolveKeyPrefix(config);
    this.enabled = config.grpc?.enabled ?? false;
    this.serverId = config.grpc?.serverId ?? 'unknown';
    this.serviceGroup = config.grpc?.serviceGroup ?? 'default';
    this.grpcAddress = config.grpc?.advertisedAddress ?? '0.0.0.0:50051';
    this.heartbeatIntervalMs = config.grpc?.heartbeatMs ?? 400;
    this.reconcileIntervalMs = config.grpc?.reconcileIntervalMs ?? 2000;
    this.nodeTTL = config.grpc?.nodeTTLMs ?? 1500;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;

    // Clean up stale keys from a previous instance of this serverId
    const oldPattern = `${this.keyPrefix}:cluster:nodes:${this.serverId}:*`;
    const oldKeys = await this.scanKeys(oldPattern);
    if (oldKeys.length > 0) {
      await this.redis.del(...oldKeys);
      const indexKey = this.getNodeIndexKey();
      const pipeline = this.redis.pipeline();
      for (const key of oldKeys) {
        const member = key.replace(`${this.keyPrefix}:cluster:nodes:`, '');
        pipeline.srem(indexKey, member);
      }
      await pipeline.exec();
      this.logger.log(`Cleaned ${oldKeys.length} stale node key(s) from previous instance`);
    }

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

    // Start ring reconciliation (slower than heartbeat — consistency fallback)
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((err) => {
        this.logger.error(`Reconciliation failed: ${(err as Error).message}`);
      });
    }, this.reconcileIntervalMs);

    // Subscribe to ring events
    this.subscriber = this.redis.duplicate();
    const channel = this.getEventsChannel();
    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (_ch: string, payload: string) => {
      this.handleEvent(payload);
    });

    // Subscribe to gRPC peer state changes for fast failure detection
    if (this.peerMonitor) {
      this.unsubscribePeerMonitor = this.peerMonitor.onPeerStateChange((peerId, state) => {
        if (state === 'suspected-dead') {
          this.logger.warn(`Peer ${peerId} suspected dead via gRPC — triggering reconcile`);
          this.reconcile().catch((err) => {
            this.logger.error(`Triggered reconcile failed: ${(err as Error).message}`);
          });
        }
      });
    }

    // Subscribe to Redis health changes for voluntary step-down
    if (this.redisHealthMonitor) {
      this.unsubscribeRedisHealth = this.redisHealthMonitor.onHealthChange((healthy) => {
        if (!healthy) {
          this.handleRedisLost();
        } else {
          this.handleRedisRecovered();
        }
      });
    }

    this.logger.log(
      `Cluster discovery started: serverId=${this.serverId}, group=${this.serviceGroup}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.enabled) return;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.eventReconcileTimer) clearTimeout(this.eventReconcileTimer);
    if (this.unsubscribePeerMonitor) this.unsubscribePeerMonitor();
    if (this.unsubscribeRedisHealth) this.unsubscribeRedisHealth();

    // Remove this node from the ring
    await this.redis.del(this.getNodeKey());
    await this.redis.srem(this.getNodeIndexKey(), `${this.serverId}:${this.instanceId}`);
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
    const indexKey = this.getNodeIndexKey();
    const members = await this.redis.smembers(indexKey);

    const nodes: ClusterNode[] = [];
    const staleMembers: string[] = [];

    for (const member of members) {
      const nodeKey = `${this.keyPrefix}:cluster:nodes:${member}`;
      const data = await this.redis.hgetall(nodeKey);
      if (data && data.server_id) {
        nodes.push(this.parseNodeData(data));
      } else {
        staleMembers.push(member);
      }
    }

    if (staleMembers.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const member of staleMembers) {
        pipeline.srem(indexKey, member);
      }
      pipeline.exec().catch(() => {});
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
   * Whether the cluster is healthy (Redis reachable).
   * When false, this node has stepped down and should not accept new work.
   */
  isClusterHealthy(): boolean {
    return this.redisAvailable;
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
    const key = this.getNodeKey();
    const indexKey = this.getNodeIndexKey();
    const entityTypes = Object.keys(this.config.entities ?? {});
    const data: Record<string, string> = {
      server_id: this.serverId,
      instance_id: this.instanceId,
      grpc_address: this.grpcAddress,
      service_group: this.serviceGroup,
      entity_types: entityTypes.join(','),
      ring_version: '0',
      started_at: Date.now().toString(),
      heartbeat_at: Date.now().toString(),
    };

    await this.redis.hset(key, data);
    await this.redis.pexpire(key, this.nodeTTL);
    await this.redis.sadd(indexKey, `${this.serverId}:${this.instanceId}`);

    // Register entity type → service group mapping for cross-service routing
    for (const et of entityTypes) {
      const registryKey = `${this.keyPrefix}:cluster:entity-registry:${et}`;
      await this.redis.set(registryKey, this.serviceGroup, 'PX', this.nodeTTL * 2);
    }
  }

  private async heartbeat(): Promise<void> {
    const key = this.getNodeKey();
    const entityTypes = Object.keys(this.config.entities ?? {});
    const pipeline = this.redis.pipeline();

    pipeline.eval(HEARTBEAT_SCRIPT, 1, key, Date.now().toString(), this.nodeTTL.toString());
    for (const et of entityTypes) {
      pipeline.pexpire(`${this.keyPrefix}:cluster:entity-registry:${et}`, this.nodeTTL * 2);
    }

    await pipeline.exec();
  }

  private async reconcile(): Promise<void> {
    if (!this.redisAvailable) return;

    const currentVersion = await this.getRingVersion();
    if (currentVersion > this.lastSeenRingVersion) {
      this.lastSeenRingVersion = currentVersion;
    }

    const nodes = await this.getNodes();

    // Sync gRPC peer monitor with current Redis-known nodes
    if (this.peerMonitor) {
      this.peerMonitor.syncPeers(
        nodes
          .filter((n) => n.serverId !== this.serverId)
          .map((n) => ({ serverId: n.serverId, address: n.grpcAddress })),
      );
    }

    this.notifyListeners(nodes);
  }

  // =========================================================================
  // INTERNAL — Events
  // =========================================================================

  private async publishEvent(action: 'join' | 'leave'): Promise<void> {
    const channel = this.getEventsChannel();
    const ringVersion = await this.getRingVersion();
    await this.redis.publish(
      channel,
      JSON.stringify({
        action,
        serverId: this.serverId,
        serviceGroup: this.serviceGroup,
        timestamp: Date.now(),
        ringVersion,
      }),
    );
  }

  private handleEvent(payload: string): void {
    try {
      const event = JSON.parse(payload);
      if (event.serverId === this.serverId) return;

      this.logger.log(`Ring event: ${event.action} from ${event.serverId}`);

      const receivedVersion = event.ringVersion as number | undefined;
      const gapDetected =
        receivedVersion !== undefined &&
        this.lastSeenRingVersion > 0 &&
        receivedVersion > this.lastSeenRingVersion + 1;

      if (receivedVersion !== undefined && receivedVersion > this.lastSeenRingVersion) {
        this.lastSeenRingVersion = receivedVersion;
      }

      if (gapDetected) {
        this.logger.warn(
          `Ring version gap detected (expected <= ${this.lastSeenRingVersion}, got ${receivedVersion}) — immediate reconcile`,
        );
        if (this.eventReconcileTimer) clearTimeout(this.eventReconcileTimer);
        this.eventReconcileTimer = null;
        this.reconcile().catch((err) =>
          this.logger.error(`Gap-triggered reconcile failed: ${(err as Error).message}`),
        );
        return;
      }

      if (this.eventReconcileTimer) clearTimeout(this.eventReconcileTimer);
      this.eventReconcileTimer = setTimeout(() => {
        this.eventReconcileTimer = null;
        this.reconcile().catch((err) =>
          this.logger.error(`Event-triggered reconcile failed: ${(err as Error).message}`),
        );
      }, 200);
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
  // INTERNAL — Redis health step-down / recovery
  // =========================================================================

  private handleRedisLost(): void {
    this.redisAvailable = false;
    this.logger.error('Redis connectivity lost — stepping down from cluster');

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    // Notify with empty node list — triggers leader resignation and worker cleanup
    this.notifyListeners([]);
  }

  private handleRedisRecovered(): void {
    this.redisAvailable = true;
    this.logger.log('Redis connectivity restored — rejoining cluster');

    this.registerNode()
      .then(() => this.incrementRingVersion())
      .then(() => this.publishEvent('join'))
      .catch((err) => {
        this.logger.error(`Failed to rejoin cluster: ${(err as Error).message}`);
      });

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this.heartbeat().catch((err) => {
          this.logger.error(`Heartbeat failed: ${(err as Error).message}`);
        });
      }, this.heartbeatIntervalMs);
    }

    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => {
        this.reconcile().catch((err) => {
          this.logger.error(`Reconciliation failed: ${(err as Error).message}`);
        });
      }, this.reconcileIntervalMs);
    }
  }

  // =========================================================================
  // INTERNAL — Helpers
  // =========================================================================

  private getNodeKey(): string {
    return `${this.keyPrefix}:cluster:nodes:${this.serverId}:${this.instanceId}`;
  }

  private getNodeIndexKey(): string {
    return `${this.keyPrefix}:cluster:node-index`;
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
      instanceId: data.instance_id || undefined,
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
