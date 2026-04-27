import 'reflect-metadata';
import { GrpcServerService } from '../src/grpc/grpc-server.service';

function createMockRouter() {
  return {
    dispatchAsMaster: jest.fn(async () => {}),
    dispatchAsMasterAndWait: jest.fn(async () => ({ result: 'ok' })),
    enqueue: jest.fn(async () => ({ id: 'test', entityKey: 'test:1' })),
    enqueueAndWait: jest.fn(async () => ({ result: 'ok' })),
  };
}

function createMockWorkerManager() {
  return {
    enqueue: jest.fn(async () => {}),
    enqueueAndWait: jest.fn(async () => ({ result: 'ok' })),
    spawn: jest.fn(() => true),
    teardown: jest.fn(async () => {}),
    listWorkers: jest.fn(() => []),
    workerCount: jest.fn(() => 0),
    totalQueueDepth: jest.fn(() => 0),
  };
}

function createMockMasterCoordinator(isMaster = true, isRebuilding = false) {
  return {
    isMaster: jest.fn(() => isMaster),
    isRebuildingTable: jest.fn(() => isRebuilding),
    resolve: jest.fn(() => ({
      replicaId: 'server-1',
      isLocal: true,
      needsSpawn: false,
      epoch: 1,
    })),
    release: jest.fn(),
    setWorkerListProvider: jest.fn(),
    acceptWorkerReport: jest.fn(() => true),
  };
}

function createMockLeaderElection(epoch = 5) {
  return {
    get epoch() { return epoch; },
    getIsLeader: jest.fn(() => true),
    updateSeenEpoch: jest.fn(),
  };
}

function createServer(opts: {
  isMaster?: boolean;
  epoch?: number;
  isRebuilding?: boolean;
} = {}) {
  const router = createMockRouter();
  const workerManager = createMockWorkerManager();
  const masterCoordinator = createMockMasterCoordinator(
    opts.isMaster ?? true,
    opts.isRebuilding ?? false,
  );
  const leaderElection = createMockLeaderElection(opts.epoch ?? 5);

  const server = new GrpcServerService(
    {
      redis: { host: 'localhost' },
      grpc: { enabled: false, serverId: 'server-1', maxConcurrentPetitions: 50 },
      entities: { test: {} },
    } as any,
    router as any,
    workerManager as any,
    masterCoordinator as any,
    leaderElection as any,
  );

  return { server, router, workerManager, masterCoordinator, leaderElection };
}

function makeEnvelope() {
  return {
    id: 'msg-1',
    name: 'test-cmd',
    payload: Buffer.from(JSON.stringify({ foo: 'bar' })),
    entityType: 'test',
    entityId: 'e1',
    correlationId: '',
    isQuery: false,
    enqueuedAt: Date.now(),
    attempts: 0,
    maxAttempts: 1,
    originServer: 'client-1',
    hops: 0,
    senderEpoch: 0,
  };
}

describe('GrpcServerService — epoch fencing', () => {
  describe('handlePetition', () => {
    it('should reject when not master', (done) => {
      const { server } = createServer({ isMaster: false });
      const call = { request: { entityKey: 'test:e1', message: makeEnvelope(), masterEpoch: 5 } };

      (server as any).handlePetition(call, (err: Error | null, response: any) => {
        expect(err).toBeNull();
        expect(response.accepted).toBe(false);
        expect(response.rejectReason).toBe('NOT_MASTER');
        done();
      });
    });

    it('should reject STALE_MASTER when request epoch > current', (done) => {
      const { server } = createServer({ isMaster: true, epoch: 5 });
      const call = { request: { entityKey: 'test:e1', message: makeEnvelope(), masterEpoch: 10 } };

      (server as any).handlePetition(call, (err: Error | null, response: any) => {
        expect(err).toBeNull();
        expect(response.accepted).toBe(false);
        expect(response.rejectReason).toBe('STALE_MASTER');
        done();
      });
    });

    it('should reject when rebuilding table', (done) => {
      const { server } = createServer({ isMaster: true, isRebuilding: true });
      const call = { request: { entityKey: 'test:e1', message: makeEnvelope(), masterEpoch: 0 } };

      (server as any).handlePetition(call, (err: Error | null, response: any) => {
        expect(err).toBeNull();
        expect(response.accepted).toBe(false);
        expect(response.rejectReason).toBe('MASTER_REBUILDING');
        done();
      });
    });

    it('should accept valid petition with matching epoch', (done) => {
      const { server } = createServer({ isMaster: true, epoch: 5 });
      const call = { request: { entityKey: 'test:e1', message: makeEnvelope(), masterEpoch: 5 } };

      (server as any).handlePetition(call, (err: Error | null, response: any) => {
        expect(err).toBeNull();
        expect(response.accepted).toBe(true);
        expect(response.assignedReplicaId).toBe('server-1');
        done();
      });
    });

    it('should accept petition with epoch 0 (no fencing)', (done) => {
      const { server } = createServer({ isMaster: true, epoch: 5 });
      const call = { request: { entityKey: 'test:e1', message: makeEnvelope(), masterEpoch: 0 } };

      (server as any).handlePetition(call, (err: Error | null, response: any) => {
        expect(err).toBeNull();
        expect(response.accepted).toBe(true);
        done();
      });
    });
  });

  describe('handleEnqueueToWorker', () => {
    it('should reject stale epoch', (done) => {
      const { server } = createServer({ epoch: 5 });
      const call = {
        request: {
          entityKey: 'test:e1',
          message: makeEnvelope(),
          masterEpoch: 3,
        },
      };

      (server as any).handleEnqueueToWorker(call, (err: Error | null, response: any) => {
        expect(err).toBeNull();
        expect(response.accepted).toBe(false);
        expect(response.rejectReason).toContain('Stale epoch');
        done();
      });
    });

    it('should accept matching epoch', (done) => {
      const { server } = createServer({ epoch: 5 });
      const call = {
        request: {
          entityKey: 'test:e1',
          message: makeEnvelope(),
          masterEpoch: 5,
        },
      };

      (server as any).handleEnqueueToWorker(call, (err: Error | null, response: any) => {
        expect(err).toBeNull();
        expect(response.accepted).toBe(true);
        done();
      });
    });

    it('should update seen epoch on valid request', (done) => {
      const { server, leaderElection } = createServer({ epoch: 5 });
      const call = {
        request: {
          entityKey: 'test:e1',
          message: makeEnvelope(),
          masterEpoch: 5,
        },
      };

      (server as any).handleEnqueueToWorker(call, () => {
        expect(leaderElection.updateSeenEpoch).toHaveBeenCalledWith(5);
        done();
      });
    });

    it('should return RESOURCE_EXHAUSTED on worker limit', (done) => {
      const { server, workerManager } = createServer({ epoch: 5 });
      workerManager.enqueue.mockRejectedValue(new Error('WORKER_LIMIT_EXCEEDED'));

      const call = {
        request: {
          entityKey: 'test:e1',
          message: makeEnvelope(),
          masterEpoch: 5,
        },
      };

      (server as any).handleEnqueueToWorker(call, (err: Error | null, response: any) => {
        expect(err).toBeNull();
        expect(response.accepted).toBe(false);
        expect(response.rejectReason).toBe('RESOURCE_EXHAUSTED');
        done();
      });
    });

    it('should return RESOURCE_EXHAUSTED on queue depth exceeded', (done) => {
      const { server, workerManager } = createServer({ epoch: 5 });
      workerManager.enqueue.mockRejectedValue(new Error('QUEUE_DEPTH_EXCEEDED'));

      const call = {
        request: {
          entityKey: 'test:e1',
          message: makeEnvelope(),
          masterEpoch: 5,
        },
      };

      (server as any).handleEnqueueToWorker(call, (err: Error | null, response: any) => {
        expect(err).toBeNull();
        expect(response.accepted).toBe(false);
        expect(response.rejectReason).toBe('RESOURCE_EXHAUSTED');
        done();
      });
    });
  });

  describe('handleReportWorkers', () => {
    it('should accept worker report and delegate to coordinator', (done) => {
      const { server, masterCoordinator } = createServer({ isMaster: true });
      const call = {
        request: {
          replicaId: 'replica-1',
          entityKeys: ['test:e1', 'test:e2'],
          epoch: 0,
        },
      };

      (server as any).handleReportWorkers(call, (err: Error | null, response: any) => {
        expect(err).toBeNull();
        expect(response.accepted).toBe(true);
        expect(masterCoordinator.acceptWorkerReport).toHaveBeenCalledWith(
          'replica-1',
          ['test:e1', 'test:e2'],
          0,
        );
        done();
      });
    });

    it('should return rejected when coordinator rejects', (done) => {
      const { server, masterCoordinator } = createServer({ isMaster: true });
      masterCoordinator.acceptWorkerReport.mockReturnValue(false);

      const call = {
        request: {
          replicaId: 'replica-1',
          entityKeys: ['test:e1'],
          epoch: 99,
        },
      };

      (server as any).handleReportWorkers(call, (err: Error | null, response: any) => {
        expect(err).toBeNull();
        expect(response.accepted).toBe(false);
        expect(response.rejectReason).toBe('EPOCH_MISMATCH_OR_NOT_MASTER');
        done();
      });
    });
  });
});
