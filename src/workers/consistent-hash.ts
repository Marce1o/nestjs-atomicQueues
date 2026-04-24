/**
 * MurmurHash3 (32-bit) — deterministic, fast, excellent distribution.
 * Pure JS implementation, no dependencies.
 */
export function murmurhash3(key: string, seed = 0): number {
  let h1 = seed >>> 0;
  const len = key.length;
  const nblocks = len >> 2;

  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  // Body
  for (let i = 0; i < nblocks; i++) {
    let k1 =
      (key.charCodeAt(i * 4) & 0xff) |
      ((key.charCodeAt(i * 4 + 1) & 0xff) << 8) |
      ((key.charCodeAt(i * 4 + 2) & 0xff) << 16) |
      ((key.charCodeAt(i * 4 + 3) & 0xff) << 24);

    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = Math.imul(h1, 5) + 0xe6546b64;
  }

  // Tail
  const tail = nblocks * 4;
  let k1 = 0;
  const remainder = len & 3;

  if (remainder >= 3) k1 ^= (key.charCodeAt(tail + 2) & 0xff) << 16;
  if (remainder >= 2) k1 ^= (key.charCodeAt(tail + 1) & 0xff) << 8;
  if (remainder >= 1) {
    k1 ^= key.charCodeAt(tail) & 0xff;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }

  // Finalization
  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;

  return h1 >>> 0;
}

/**
 * A node on the consistent hash ring.
 */
export interface HashRingNode<T = unknown> {
  /** Unique identifier for this node (e.g. workerId, serverId) */
  id: string;
  /** Arbitrary metadata attached to the node */
  data: T;
}

interface VirtualNode<T> {
  hash: number;
  nodeId: string;
  data: T;
}

/**
 * Consistent hash ring with virtual nodes.
 *
 * Provides O(log n) lookups and minimizes entity reassignment
 * when nodes are added or removed (~1/N entities move).
 *
 * @example
 * ```typescript
 * const ring = new ConsistentHashRing<number>(150);
 * ring.addNode({ id: 'worker-0', data: 0 });
 * ring.addNode({ id: 'worker-1', data: 1 });
 *
 * const owner = ring.getNode('account:a-123');
 * // owner.data === 0 or 1 (deterministic for same key)
 * ```
 */
export class ConsistentHashRing<T = unknown> {
  private ring: VirtualNode<T>[] = [];
  private readonly nodes = new Map<string, HashRingNode<T>>();
  private readonly virtualNodesPerNode: number;

  constructor(virtualNodesPerNode = 150) {
    this.virtualNodesPerNode = virtualNodesPerNode;
  }

  /**
   * Add a node to the ring with its virtual nodes.
   * If a node with this ID already exists, it is replaced.
   */
  addNode(node: HashRingNode<T>): void {
    if (this.nodes.has(node.id)) {
      this.removeNode(node.id);
    }

    this.nodes.set(node.id, node);

    for (let i = 0; i < this.virtualNodesPerNode; i++) {
      const key = `${node.id}:vnode:${i}`;
      this.ring.push({
        hash: murmurhash3(key),
        nodeId: node.id,
        data: node.data,
      });
    }

    this.ring.sort((a, b) => a.hash - b.hash);
  }

  /**
   * Remove a node and all its virtual nodes from the ring.
   */
  removeNode(nodeId: string): void {
    this.nodes.delete(nodeId);
    this.ring = this.ring.filter((vn) => vn.nodeId !== nodeId);
  }

  /**
   * Get the node that owns the given key.
   * Returns null if the ring is empty.
   *
   * Uses binary search to find the first virtual node
   * whose hash is >= the key's hash (clockwise walk).
   */
  getNode(key: string): HashRingNode<T> | null {
    if (this.ring.length === 0) return null;

    const hash = murmurhash3(key);

    // Binary search for first virtual node with hash >= key hash
    let lo = 0;
    let hi = this.ring.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].hash < hash) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // Wrap around to the first node if we're past the end
    const idx = lo < this.ring.length ? lo : 0;
    const vnode = this.ring[idx];

    return this.nodes.get(vnode.nodeId) ?? null;
  }

  /**
   * Get the node that owns the given key, but only consider nodes
   * that pass the filter. Walks clockwise until a matching node is found.
   *
   * Useful for entity-type affinity: skip nodes that don't handle
   * the entity type.
   *
   * Returns null if no matching node exists.
   */
  getNodeFiltered(key: string, filter: (node: HashRingNode<T>) => boolean): HashRingNode<T> | null {
    if (this.ring.length === 0) return null;

    const hash = murmurhash3(key);

    // Find starting position
    let lo = 0;
    let hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].hash < hash) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // Walk clockwise, checking filter
    const visited = new Set<string>();
    for (let i = 0; i < this.ring.length; i++) {
      const idx = (lo + i) % this.ring.length;
      const vnode = this.ring[idx];

      if (visited.has(vnode.nodeId)) continue;
      visited.add(vnode.nodeId);

      const node = this.nodes.get(vnode.nodeId);
      if (node && filter(node)) return node;

      // If we've checked all distinct nodes, stop
      if (visited.size >= this.nodes.size) break;
    }

    return null;
  }

  /**
   * Check if a specific node owns the given key.
   */
  isOwner(nodeId: string, key: string): boolean {
    const owner = this.getNode(key);
    return owner?.id === nodeId;
  }

  /**
   * Get all node IDs currently in the ring.
   */
  getNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Get the number of physical nodes in the ring.
   */
  get size(): number {
    return this.nodes.size;
  }

  /**
   * Check if a node exists in the ring.
   */
  hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  /**
   * Get a node by its ID.
   */
  getNodeById(nodeId: string): HashRingNode<T> | null {
    return this.nodes.get(nodeId) ?? null;
  }

  /**
   * Compute which keys from the given set would be reassigned
   * if a node were added or removed.
   *
   * Returns a map of key → new owner node ID.
   */
  computeReassignment(
    keys: Iterable<string>,
    operation: { type: 'add'; node: HashRingNode<T> } | { type: 'remove'; nodeId: string },
  ): Map<string, string> {
    // Create a hypothetical ring with the change applied
    const hypothetical = new ConsistentHashRing<T>(this.virtualNodesPerNode);

    for (const [id, node] of this.nodes) {
      if (operation.type === 'remove' && id === operation.nodeId) continue;
      hypothetical.addNode(node);
    }

    if (operation.type === 'add') {
      hypothetical.addNode(operation.node);
    }

    // Find keys that changed ownership
    const reassignment = new Map<string, string>();
    for (const key of keys) {
      const currentOwner = this.getNode(key);
      const newOwner = hypothetical.getNode(key);

      if (currentOwner?.id !== newOwner?.id && newOwner) {
        reassignment.set(key, newOwner.id);
      }
    }

    return reassignment;
  }
}
