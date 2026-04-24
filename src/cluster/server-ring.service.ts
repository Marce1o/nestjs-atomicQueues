import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { IAtomicQueuesModuleConfig } from '../domain';
import { ConsistentHashRing, HashRingNode } from '../workers/consistent-hash';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';
import { ClusterDiscoveryService, ClusterNode } from './cluster-discovery.service';

export interface ServerRingNode {
  serverId: string;
  grpcAddress: string;
  serviceGroup: string;
  entityTypes: string[];
}

/**
 * Server Ring — consistent hash ring of cluster servers.
 *
 * Determines which server owns a given entity key.
 * Updates automatically when cluster membership changes.
 */
@Injectable()
export class ServerRingService implements OnModuleInit {
  private readonly logger = new Logger(ServerRingService.name);
  private readonly ring = new ConsistentHashRing<ServerRingNode>(150);
  private readonly enabled: boolean;
  private readonly localServerId: string;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
    private readonly discovery: ClusterDiscoveryService,
  ) {
    this.enabled = config.grpc?.enabled ?? false;
    this.localServerId = config.grpc?.serverId ?? 'unknown';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;

    // Load initial ring state
    const nodes = await this.discovery.getNodes();
    this.rebuildRing(nodes);

    // Listen for ring changes
    this.discovery.onRingChange((updatedNodes) => {
      this.rebuildRing(updatedNodes);
    });

    this.logger.log(`Server ring initialized with ${this.ring.size} nodes`);
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  /**
   * Determine which server owns the given entity key.
   * If gRPC is disabled or the entity is local, returns null (process locally).
   */
  getOwner(entityType: string, entityId: string): ServerRingNode | null {
    if (!this.enabled) return null;
    if (this.ring.size === 0) return null;

    const entityKey = `${entityType}:${entityId}`;

    // Use filtered lookup: only consider servers that handle this entity type
    const owner = this.ring.getNodeFiltered(entityKey, (node) => {
      // If the node has no entity types declared, it accepts all
      if (node.data.entityTypes.length === 0) return true;
      return node.data.entityTypes.includes(entityType);
    });

    return owner?.data ?? null;
  }

  /**
   * Check if the current server owns the given entity.
   */
  isLocal(entityType: string, entityId: string): boolean {
    if (!this.enabled) return true; // Single-server mode: everything is local

    const owner = this.getOwner(entityType, entityId);
    if (!owner) return true; // No owner found, process locally

    return owner.serverId === this.localServerId;
  }

  /**
   * Get the local server ID.
   */
  getLocalServerId(): string {
    return this.localServerId;
  }

  /**
   * Get all server IDs in the ring.
   */
  getServerIds(): string[] {
    return this.ring.getNodeIds();
  }

  /**
   * Get the number of servers in the ring.
   */
  get size(): number {
    return this.ring.size;
  }

  // =========================================================================
  // INTERNAL
  // =========================================================================

  private rebuildRing(nodes: ClusterNode[]): void {
    const currentIds = new Set(this.ring.getNodeIds());
    const newIds = new Set(nodes.map((n) => n.serverId));

    // Remove nodes that left
    for (const id of currentIds) {
      if (!newIds.has(id)) {
        this.ring.removeNode(id);
        this.logger.log(`Removed server ${id} from ring`);
      }
    }

    // Add/update nodes
    for (const node of nodes) {
      const ringNode: HashRingNode<ServerRingNode> = {
        id: node.serverId,
        data: {
          serverId: node.serverId,
          grpcAddress: node.grpcAddress,
          serviceGroup: node.serviceGroup,
          entityTypes: node.entityTypes,
        },
      };

      if (!currentIds.has(node.serverId)) {
        this.ring.addNode(ringNode);
        this.logger.log(`Added server ${node.serverId} to ring`);
      }
    }
  }
}
