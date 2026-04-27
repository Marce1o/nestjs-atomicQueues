import 'reflect-metadata';
import { GrpcClientPool } from '../src/grpc/grpc-client-pool.service';

function createPool(opts: { threshold?: number; cooldownMs?: number } = {}): GrpcClientPool {
  return new GrpcClientPool({
    redis: { host: 'localhost' },
    grpc: {
      enabled: false,
      circuitBreakerFailureThreshold: opts.threshold ?? 3,
      circuitBreakerCooldownMs: opts.cooldownMs ?? 100,
    },
  } as any);
}

describe('GrpcClientPool — circuit breaker', () => {
  describe('state transitions', () => {
    it('starts in closed state (no throws)', () => {
      const pool = createPool();
      // No recorded failures — getClient would work if grpc were loaded
      // recordSuccess on unknown peer is a no-op
      pool.recordSuccess('peer-1');
    });

    it('opens after reaching failure threshold', () => {
      const pool = createPool({ threshold: 3 });
      pool.recordFailure('peer-1');
      pool.recordFailure('peer-1');
      pool.recordFailure('peer-1');

      expect(() => {
        (pool as any).checkCircuit('peer-1');
      }).toThrow('PEER_CIRCUIT_OPEN');
    });

    it('does not open before reaching threshold', () => {
      const pool = createPool({ threshold: 3 });
      pool.recordFailure('peer-1');
      pool.recordFailure('peer-1');

      expect(() => {
        (pool as any).checkCircuit('peer-1');
      }).not.toThrow();
    });

    it('transitions to half-open after cooldown', async () => {
      const pool = createPool({ threshold: 2, cooldownMs: 50 });
      pool.recordFailure('peer-1');
      pool.recordFailure('peer-1');

      expect(() => (pool as any).checkCircuit('peer-1')).toThrow('PEER_CIRCUIT_OPEN');

      await new Promise((r) => setTimeout(r, 60));

      // After cooldown, should not throw (half-open)
      expect(() => (pool as any).checkCircuit('peer-1')).not.toThrow();
    });

    it('closes on success after half-open', async () => {
      const pool = createPool({ threshold: 2, cooldownMs: 50 });
      pool.recordFailure('peer-1');
      pool.recordFailure('peer-1');

      await new Promise((r) => setTimeout(r, 60));

      // Half-open: doesn't throw
      (pool as any).checkCircuit('peer-1');

      // Record success → closed
      pool.recordSuccess('peer-1');

      // Should not throw even immediately
      expect(() => (pool as any).checkCircuit('peer-1')).not.toThrow();
    });

    it('re-opens on failure in half-open', async () => {
      const pool = createPool({ threshold: 2, cooldownMs: 50 });
      pool.recordFailure('peer-1');
      pool.recordFailure('peer-1');

      await new Promise((r) => setTimeout(r, 60));

      // Half-open
      (pool as any).checkCircuit('peer-1');

      // Fail again — re-opens
      pool.recordFailure('peer-1');
      expect(() => (pool as any).checkCircuit('peer-1')).toThrow('PEER_CIRCUIT_OPEN');
    });
  });

  describe('openCircuit / closeCircuit', () => {
    it('openCircuit immediately opens the circuit', () => {
      const pool = createPool();
      pool.openCircuit('peer-1');

      expect(() => (pool as any).checkCircuit('peer-1')).toThrow('PEER_CIRCUIT_OPEN');
    });

    it('closeCircuit resets the circuit', () => {
      const pool = createPool();
      pool.openCircuit('peer-1');
      pool.closeCircuit('peer-1');

      expect(() => (pool as any).checkCircuit('peer-1')).not.toThrow();
    });
  });

  describe('removeClient clears circuit state', () => {
    it('should remove circuit breaker state on removeClient', () => {
      const pool = createPool({ threshold: 2 });
      pool.recordFailure('peer-1');
      pool.recordFailure('peer-1');

      expect(() => (pool as any).checkCircuit('peer-1')).toThrow('PEER_CIRCUIT_OPEN');

      pool.removeClient('peer-1');

      // After removal, peer is unknown — no circuit state
      expect(() => (pool as any).checkCircuit('peer-1')).not.toThrow();
    });
  });

  describe('per-peer isolation', () => {
    it('failures on one peer do not affect another', () => {
      const pool = createPool({ threshold: 2 });
      pool.recordFailure('peer-1');
      pool.recordFailure('peer-1');

      expect(() => (pool as any).checkCircuit('peer-1')).toThrow('PEER_CIRCUIT_OPEN');
      expect(() => (pool as any).checkCircuit('peer-2')).not.toThrow();
    });
  });
});
