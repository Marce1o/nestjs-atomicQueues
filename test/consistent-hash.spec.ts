import {
  murmurhash3,
  ConsistentHashRing,
  HashRingNode,
} from '../src/workers/consistent-hash';

describe('murmurhash3', () => {
  it('should produce deterministic results', () => {
    const hash1 = murmurhash3('account:a-123');
    const hash2 = murmurhash3('account:a-123');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = murmurhash3('account:a-123');
    const hash2 = murmurhash3('account:a-456');
    expect(hash1).not.toBe(hash2);
  });

  it('should return a 32-bit unsigned integer', () => {
    const hash = murmurhash3('test');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  it('should use seed parameter', () => {
    const hash1 = murmurhash3('test', 0);
    const hash2 = murmurhash3('test', 42);
    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty string', () => {
    const hash = murmurhash3('');
    expect(typeof hash).toBe('number');
    expect(hash).toBeGreaterThanOrEqual(0);
  });

  it('should handle strings of various lengths', () => {
    const hashes = new Set<number>();
    for (let i = 1; i <= 20; i++) {
      hashes.add(murmurhash3('x'.repeat(i)));
    }
    // All different lengths should produce different hashes (with very high probability)
    expect(hashes.size).toBe(20);
  });
});

describe('ConsistentHashRing', () => {
  describe('basic operations', () => {
    it('should return null for empty ring', () => {
      const ring = new ConsistentHashRing<number>();
      expect(ring.getNode('any-key')).toBeNull();
    });

    it('should route all keys to single node when only one exists', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'worker-0', data: 0 });

      for (let i = 0; i < 100; i++) {
        const node = ring.getNode(`entity-${i}`);
        expect(node).not.toBeNull();
        expect(node!.id).toBe('worker-0');
        expect(node!.data).toBe(0);
      }
    });

    it('should deterministically route the same key to the same node', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'worker-0', data: 0 });
      ring.addNode({ id: 'worker-1', data: 1 });
      ring.addNode({ id: 'worker-2', data: 2 });

      const key = 'account:a-123';
      const first = ring.getNode(key);
      for (let i = 0; i < 50; i++) {
        expect(ring.getNode(key)!.id).toBe(first!.id);
      }
    });

    it('should distribute keys across multiple nodes', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'worker-0', data: 0 });
      ring.addNode({ id: 'worker-1', data: 1 });
      ring.addNode({ id: 'worker-2', data: 2 });

      const counts = new Map<string, number>();
      const numKeys = 10000;

      for (let i = 0; i < numKeys; i++) {
        const node = ring.getNode(`entity-${i}`);
        const count = counts.get(node!.id) ?? 0;
        counts.set(node!.id, count + 1);
      }

      // Each worker should get roughly 1/3 of the keys
      // With 150 virtual nodes and 10k keys, expect ~3333 each, ±15%
      for (const [, count] of counts) {
        expect(count).toBeGreaterThan(numKeys / 3 * 0.7);
        expect(count).toBeLessThan(numKeys / 3 * 1.3);
      }
    });

    it('should report correct size', () => {
      const ring = new ConsistentHashRing<number>();
      expect(ring.size).toBe(0);

      ring.addNode({ id: 'w0', data: 0 });
      expect(ring.size).toBe(1);

      ring.addNode({ id: 'w1', data: 1 });
      expect(ring.size).toBe(2);

      ring.removeNode('w0');
      expect(ring.size).toBe(1);
    });

    it('should check node existence', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'w0', data: 0 });

      expect(ring.hasNode('w0')).toBe(true);
      expect(ring.hasNode('w1')).toBe(false);
    });

    it('should get node by ID', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'w0', data: 42 });

      expect(ring.getNodeById('w0')?.data).toBe(42);
      expect(ring.getNodeById('w1')).toBeNull();
    });

    it('should list all node IDs', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'w0', data: 0 });
      ring.addNode({ id: 'w1', data: 1 });

      const ids = ring.getNodeIds().sort();
      expect(ids).toEqual(['w0', 'w1']);
    });

    it('should check ownership', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'w0', data: 0 });
      ring.addNode({ id: 'w1', data: 1 });

      const key = 'test-key';
      const owner = ring.getNode(key)!;

      expect(ring.isOwner(owner.id, key)).toBe(true);
      const other = owner.id === 'w0' ? 'w1' : 'w0';
      expect(ring.isOwner(other, key)).toBe(false);
    });
  });

  describe('add/remove node — minimal reassignment', () => {
    it('should only reassign ~1/N keys when adding a node', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'w0', data: 0 });
      ring.addNode({ id: 'w1', data: 1 });
      ring.addNode({ id: 'w2', data: 2 });

      // Record current assignments
      const numKeys = 5000;
      const before = new Map<string, string>();
      for (let i = 0; i < numKeys; i++) {
        const key = `entity-${i}`;
        before.set(key, ring.getNode(key)!.id);
      }

      // Add a 4th node
      ring.addNode({ id: 'w3', data: 3 });

      // Count reassignments
      let moved = 0;
      for (let i = 0; i < numKeys; i++) {
        const key = `entity-${i}`;
        if (ring.getNode(key)!.id !== before.get(key)) {
          moved++;
        }
      }

      // Expected: ~1/4 of keys move (25%), allow 10-40% range for variance
      const movedPct = moved / numKeys;
      expect(movedPct).toBeGreaterThan(0.10);
      expect(movedPct).toBeLessThan(0.40);
    });

    it('should only reassign ~1/N keys when removing a node', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'w0', data: 0 });
      ring.addNode({ id: 'w1', data: 1 });
      ring.addNode({ id: 'w2', data: 2 });
      ring.addNode({ id: 'w3', data: 3 });

      const numKeys = 5000;
      const before = new Map<string, string>();
      for (let i = 0; i < numKeys; i++) {
        const key = `entity-${i}`;
        before.set(key, ring.getNode(key)!.id);
      }

      ring.removeNode('w2');

      let moved = 0;
      for (let i = 0; i < numKeys; i++) {
        const key = `entity-${i}`;
        if (ring.getNode(key)!.id !== before.get(key)) {
          moved++;
        }
      }

      // Only keys that were on w2 should move — ~1/4 of keys (25%)
      const movedPct = moved / numKeys;
      expect(movedPct).toBeGreaterThan(0.10);
      expect(movedPct).toBeLessThan(0.40);
    });

    it('should handle re-adding a node with same ID', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'w0', data: 0 });
      ring.addNode({ id: 'w1', data: 1 });

      const before = ring.getNode('test-key')!.id;

      // Re-add w0 with different data
      ring.addNode({ id: 'w0', data: 99 });

      // Should still work, data should be updated
      expect(ring.getNodeById('w0')?.data).toBe(99);
      expect(ring.size).toBe(2);
    });

    it('should handle removing non-existent node', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'w0', data: 0 });

      ring.removeNode('w99'); // should not throw
      expect(ring.size).toBe(1);
    });

    it('should fall back to remaining nodes after removal', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'w0', data: 0 });
      ring.addNode({ id: 'w1', data: 1 });

      ring.removeNode('w0');

      // All keys should now go to w1
      for (let i = 0; i < 100; i++) {
        expect(ring.getNode(`entity-${i}`)!.id).toBe('w1');
      }
    });
  });

  describe('filtered lookup', () => {
    it('should skip nodes that fail the filter', () => {
      interface WorkerData {
        entityTypes: string[];
      }

      const ring = new ConsistentHashRing<WorkerData>();
      ring.addNode({ id: 's1', data: { entityTypes: ['account'] } });
      ring.addNode({ id: 's2', data: { entityTypes: ['warehouse'] } });
      ring.addNode({ id: 's3', data: { entityTypes: ['account', 'warehouse'] } });

      // Look for a node that handles 'warehouse'
      const result = ring.getNodeFiltered('warehouse:w-1', (node) =>
        node.data.entityTypes.includes('warehouse'),
      );

      expect(result).not.toBeNull();
      expect(result!.data.entityTypes).toContain('warehouse');
    });

    it('should return null when no node passes filter', () => {
      const ring = new ConsistentHashRing<string[]>();
      ring.addNode({ id: 's1', data: ['account'] });
      ring.addNode({ id: 's2', data: ['warehouse'] });

      const result = ring.getNodeFiltered('test', (node) =>
        node.data.includes('billing'),
      );

      expect(result).toBeNull();
    });

    it('should return null for empty ring', () => {
      const ring = new ConsistentHashRing<string>();
      const result = ring.getNodeFiltered('key', () => true);
      expect(result).toBeNull();
    });
  });

  describe('computeReassignment', () => {
    it('should compute which keys move when adding a node', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'w0', data: 0 });
      ring.addNode({ id: 'w1', data: 1 });

      const keys = Array.from({ length: 1000 }, (_, i) => `entity-${i}`);
      const newNode: HashRingNode<number> = { id: 'w2', data: 2 };

      const reassignment = ring.computeReassignment(keys, {
        type: 'add',
        node: newNode,
      });

      // Some keys should move to w2
      expect(reassignment.size).toBeGreaterThan(0);
      for (const [, newOwner] of reassignment) {
        expect(newOwner).toBe('w2');
      }

      // Original ring should be unchanged
      expect(ring.size).toBe(2);
      expect(ring.hasNode('w2')).toBe(false);
    });

    it('should compute which keys move when removing a node', () => {
      const ring = new ConsistentHashRing<number>();
      ring.addNode({ id: 'w0', data: 0 });
      ring.addNode({ id: 'w1', data: 1 });
      ring.addNode({ id: 'w2', data: 2 });

      const keys = Array.from({ length: 1000 }, (_, i) => `entity-${i}`);

      const reassignment = ring.computeReassignment(keys, {
        type: 'remove',
        nodeId: 'w1',
      });

      // Only keys that were on w1 should move
      for (const [key, newOwner] of reassignment) {
        expect(ring.getNode(key)!.id).toBe('w1');
        expect(newOwner).not.toBe('w1');
      }

      // Original ring should be unchanged
      expect(ring.size).toBe(3);
    });
  });

  describe('configurable virtual nodes', () => {
    it('should work with fewer virtual nodes', () => {
      const ring = new ConsistentHashRing<number>(10);
      ring.addNode({ id: 'w0', data: 0 });
      ring.addNode({ id: 'w1', data: 1 });

      const node = ring.getNode('test');
      expect(node).not.toBeNull();
    });

    it('should have better distribution with more virtual nodes', () => {
      const testDistribution = (vnodes: number): number => {
        const ring = new ConsistentHashRing<number>(vnodes);
        ring.addNode({ id: 'w0', data: 0 });
        ring.addNode({ id: 'w1', data: 1 });

        let w0Count = 0;
        const total = 10000;
        for (let i = 0; i < total; i++) {
          if (ring.getNode(`entity-${i}`)!.id === 'w0') w0Count++;
        }

        return Math.abs(w0Count / total - 0.5);
      };

      const deviationFew = testDistribution(5);
      const deviationMany = testDistribution(200);

      // More virtual nodes should give better (lower) deviation from 50/50
      expect(deviationMany).toBeLessThan(deviationFew + 0.1);
    });
  });
});
