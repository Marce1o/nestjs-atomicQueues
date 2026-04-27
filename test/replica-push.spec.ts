import 'reflect-metadata';
import { MasterCoordinator } from '../src/cluster/master-coordinator';

function createMockLeaderElection(isLeader = true, epoch = 1) {
  const callbacks: Array<(isLeader: boolean) => void> = [];
  return {
    getIsLeader: jest.fn(() => isLeader),
    get epoch() {
      return epoch;
    },
    onLeaderChange: jest.fn((cb: (isLeader: boolean) => void) => {
      callbacks.push(cb);
    }),
    getMasterAddress: jest.fn(async () => '127.0.0.1:50051'),
    _callbacks: callbacks,
  };
}

function createMockDiscovery() {
  return {
    getNodes: jest.fn(async () => []),
    onRingChange: jest.fn(),
  };
}

function createMockServerRing() {
  return {
    get size() {
      return 0;
    },
    getOwner: jest.fn(() => null),
  };
}

function createMockGrpcClientPool() {
  return {
    getClient: jest.fn(async () => ({
      reportWorkers: jest.fn((_req: unknown, _opts: unknown, cb: Function) => {
        cb(null, { accepted: true });
      }),
    })),
    removeClient: jest.fn(),
  };
}

function createCoordinator(
  isLeader = true,
  epoch = 1,
): { coordinator: MasterCoordinator; election: ReturnType<typeof createMockLeaderElection> } {
  const election = createMockLeaderElection(isLeader, epoch);
  const discovery = createMockDiscovery();
  const ring = createMockServerRing();
  const grpcPool = createMockGrpcClientPool();

  const coordinator = new MasterCoordinator(
    {
      redis: { host: 'localhost' },
      grpc: {
        enabled: true,
        serverId: 'master-1',
        serviceGroup: 'default',
      },
    } as any,
    election as any,
    discovery as any,
    ring as any,
    grpcPool as any,
  );

  return { coordinator, election };
}

describe('MasterCoordinator — replica push protocol', () => {
  describe('acceptWorkerReport', () => {
    it('should accept report and merge assignments', () => {
      const { coordinator } = createCoordinator();

      const accepted = coordinator.acceptWorkerReport('replica-1', ['test:e1', 'test:e2'], 0);

      expect(accepted).toBe(true);
      expect(coordinator.totalAssignedWorkers()).toBe(2);
      const assignments = coordinator.getAssignments();
      expect(assignments.get('test:e1')?.replicaId).toBe('replica-1');
      expect(assignments.get('test:e2')?.replicaId).toBe('replica-1');
    });

    it('should skip already-assigned entities (pull wins over push)', () => {
      const { coordinator } = createCoordinator();

      // Pre-assign test:e1 to a different replica
      coordinator.resolve('test:e1');
      const assignmentBefore = coordinator.getAssignments().get('test:e1');
      expect(assignmentBefore?.replicaId).toBe('master-1'); // local

      // Push from replica-1 includes test:e1
      coordinator.acceptWorkerReport('replica-1', ['test:e1', 'test:e2'], 0);

      // test:e1 should still be assigned to master-1 (existing wins)
      const assignmentAfter = coordinator.getAssignments().get('test:e1');
      expect(assignmentAfter?.replicaId).toBe('master-1');

      // test:e2 should be assigned to replica-1 (new)
      expect(coordinator.getAssignments().get('test:e2')?.replicaId).toBe('replica-1');
    });

    it('should reject when not master', () => {
      const { coordinator } = createCoordinator(false);

      const accepted = coordinator.acceptWorkerReport('replica-1', ['test:e1'], 0);
      expect(accepted).toBe(false);
    });

    it('should reject on epoch mismatch', () => {
      const { coordinator } = createCoordinator(true, 5);

      const accepted = coordinator.acceptWorkerReport('replica-1', ['test:e1'], 3);
      expect(accepted).toBe(false);
    });

    it('should accept epoch 0 (unconditional)', () => {
      const { coordinator } = createCoordinator(true, 5);

      const accepted = coordinator.acceptWorkerReport('replica-1', ['test:e1'], 0);
      expect(accepted).toBe(true);
    });

    it('should accept matching epoch', () => {
      const { coordinator } = createCoordinator(true, 5);

      const accepted = coordinator.acceptWorkerReport('replica-1', ['test:e1'], 5);
      expect(accepted).toBe(true);
    });

    it('should update replica load correctly', () => {
      const { coordinator } = createCoordinator();

      coordinator.acceptWorkerReport('replica-1', ['test:e1', 'test:e2', 'test:e3'], 0);

      const load = coordinator.getReplicaLoad();
      expect(load.get('replica-1')).toBe(3);
    });
  });

  describe('setWorkerListProvider', () => {
    it('should store provider for use during push', () => {
      const { coordinator } = createCoordinator();
      const provider = jest.fn(async () => ['test:e1', 'test:e2']);
      coordinator.setWorkerListProvider(provider);
      // Provider is stored; actual push happens on leader loss
    });
  });
});
