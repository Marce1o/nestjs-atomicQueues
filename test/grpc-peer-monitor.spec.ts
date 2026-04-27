import 'reflect-metadata';
import { GrpcPeerMonitor } from '../src/cluster/grpc-peer-monitor.service';

// gRPC connectivity states (mirrors @grpc/grpc-js values)
const ConnectivityState = {
  IDLE: 0,
  CONNECTING: 1,
  READY: 2,
  TRANSIENT_FAILURE: 3,
  SHUTDOWN: 4,
};

interface MockChannel {
  getConnectivityState: jest.Mock;
  watchConnectivityState: jest.Mock;
  _pendingCallbacks: Array<(err?: Error) => void>;
  _simulateStateChange(newState: number): void;
  _simulateDeadlineExpired(): void;
}

function createMockChannel(initialState = ConnectivityState.IDLE): MockChannel {
  const pendingCallbacks: Array<(err?: Error) => void> = [];
  let currentState = initialState;

  const channel: MockChannel = {
    getConnectivityState: jest.fn((_tryToConnect: boolean) => currentState),
    watchConnectivityState: jest.fn(
      (_state: number, _deadline: Date, cb: (err?: Error) => void) => {
        pendingCallbacks.push(cb);
      },
    ),
    _pendingCallbacks: pendingCallbacks,
    _simulateStateChange(newState: number) {
      currentState = newState;
      channel.getConnectivityState.mockReturnValue(newState);
      const cbs = pendingCallbacks.splice(0);
      for (const cb of cbs) cb();
    },
    _simulateDeadlineExpired() {
      const cbs = pendingCallbacks.splice(0);
      for (const cb of cbs) cb(new Error('Deadline'));
    },
  };

  return channel;
}

interface MockClient {
  getChannel: jest.Mock;
  close: jest.Mock;
}

function createMockClient(channel: MockChannel): MockClient {
  return {
    getChannel: jest.fn(() => channel),
    close: jest.fn(),
  };
}

function mockGrpcModule(clientFactory: (address: string) => MockClient) {
  return {
    Client: jest.fn((address: string) => clientFactory(address)),
    credentials: { createInsecure: jest.fn(() => 'insecure') },
    connectivityState: ConnectivityState,
  };
}

function createMonitor(debounceMs = 50): GrpcPeerMonitor {
  return new GrpcPeerMonitor({
    redis: { host: 'localhost' },
    grpc: {
      enabled: true,
      peerMonitorEnabled: true,
      peerSuspectDebounceMs: debounceMs,
    },
  });
}

describe('GrpcPeerMonitor', () => {
  let monitor: GrpcPeerMonitor;

  afterEach(async () => {
    await monitor.onApplicationShutdown();
  });

  describe('when gRPC is not installed', () => {
    it('should return unknown for all peers', async () => {
      monitor = createMonitor();
      // Skip onModuleInit (no grpc module loaded)
      expect(monitor.getPeerState('peer-1')).toBe('unknown');
    });

    it('should not throw on watchPeer without grpc', async () => {
      monitor = createMonitor();
      expect(() => monitor.watchPeer('peer-1', '127.0.0.1:50051')).not.toThrow();
      expect(monitor.getPeerState('peer-1')).toBe('unknown');
    });
  });

  describe('with mocked gRPC', () => {
    let channels: Map<string, MockChannel>;

    function setupMonitor(debounceMs = 50): GrpcPeerMonitor {
      channels = new Map();
      const m = createMonitor(debounceMs);

      const grpc = mockGrpcModule((address) => {
        const channel = createMockChannel(ConnectivityState.IDLE);
        channels.set(address, channel);
        return createMockClient(channel);
      });

      // Inject the mock grpc module
      (m as any).grpcModule = grpc;

      return m;
    }

    it('should return unknown for unmonitored peers', () => {
      monitor = setupMonitor();
      expect(monitor.getPeerState('no-such-peer')).toBe('unknown');
    });

    it('should transition to alive when channel becomes READY', () => {
      monitor = setupMonitor();
      monitor.watchPeer('peer-1', '127.0.0.1:50051');

      const channel = channels.get('127.0.0.1:50051')!;
      channel._simulateStateChange(ConnectivityState.READY);

      expect(monitor.getPeerState('peer-1')).toBe('alive');
    });

    it('should emit alive via onPeerStateChange', () => {
      monitor = setupMonitor();
      const listener = jest.fn();
      monitor.onPeerStateChange(listener);

      monitor.watchPeer('peer-1', '127.0.0.1:50051');
      const channel = channels.get('127.0.0.1:50051')!;
      channel._simulateStateChange(ConnectivityState.READY);

      expect(listener).toHaveBeenCalledWith('peer-1', 'alive');
    });

    it('should transition to suspected-dead after debounce when TRANSIENT_FAILURE', async () => {
      monitor = setupMonitor(30);
      monitor.watchPeer('peer-1', '127.0.0.1:50051');

      const channel = channels.get('127.0.0.1:50051')!;
      // First become READY
      channel._simulateStateChange(ConnectivityState.READY);
      expect(monitor.getPeerState('peer-1')).toBe('alive');

      // Then fail
      channel._simulateStateChange(ConnectivityState.TRANSIENT_FAILURE);

      // Still alive (debounce hasn't fired)
      expect(monitor.getPeerState('peer-1')).toBe('alive');

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 50));

      expect(monitor.getPeerState('peer-1')).toBe('suspected-dead');
    });

    it('should cancel debounce if peer recovers quickly (flap suppression)', async () => {
      monitor = setupMonitor(60);
      const listener = jest.fn();
      monitor.onPeerStateChange(listener);

      monitor.watchPeer('peer-1', '127.0.0.1:50051');
      const channel = channels.get('127.0.0.1:50051')!;

      // READY -> TRANSIENT_FAILURE -> READY within debounce window
      channel._simulateStateChange(ConnectivityState.READY);
      channel._simulateStateChange(ConnectivityState.TRANSIENT_FAILURE);

      await new Promise((r) => setTimeout(r, 20));

      // Recover before debounce fires
      channel._simulateStateChange(ConnectivityState.READY);

      await new Promise((r) => setTimeout(r, 80));

      // Should still be alive, suspected-dead should never have been emitted
      expect(monitor.getPeerState('peer-1')).toBe('alive');
      const suspectedDeadCalls = listener.mock.calls.filter(
        ([, state]) => state === 'suspected-dead',
      );
      expect(suspectedDeadCalls).toHaveLength(0);
    });

    it('should handle watchPeer/unwatchPeer lifecycle', () => {
      monitor = setupMonitor();
      monitor.watchPeer('peer-1', '127.0.0.1:50051');

      const channel = channels.get('127.0.0.1:50051')!;
      channel._simulateStateChange(ConnectivityState.READY);
      expect(monitor.getPeerState('peer-1')).toBe('alive');

      monitor.unwatchPeer('peer-1');
      expect(monitor.getPeerState('peer-1')).toBe('unknown');
    });

    it('should not double-watch same peer with same address', () => {
      monitor = setupMonitor();
      monitor.watchPeer('peer-1', '127.0.0.1:50051');
      monitor.watchPeer('peer-1', '127.0.0.1:50051');

      // Only one channel should have been created
      expect(channels.size).toBe(1);
    });

    it('should re-create channel when address changes', () => {
      monitor = setupMonitor();
      monitor.watchPeer('peer-1', '127.0.0.1:50051');
      monitor.watchPeer('peer-1', '127.0.0.1:50052');

      expect(channels.size).toBe(2);
    });

    it('should syncPeers — add new and remove stale', () => {
      monitor = setupMonitor();
      monitor.watchPeer('peer-1', '127.0.0.1:50051');
      monitor.watchPeer('peer-2', '127.0.0.1:50052');

      monitor.syncPeers([
        { serverId: 'peer-2', address: '127.0.0.1:50052' },
        { serverId: 'peer-3', address: '127.0.0.1:50053' },
      ]);

      expect(monitor.getPeerState('peer-1')).toBe('unknown'); // removed
      expect(monitor.getPeerState('peer-3')).not.toBe(undefined); // added
    });

    it('should unsubscribe listeners', () => {
      monitor = setupMonitor();
      const listener = jest.fn();
      const unsub = monitor.onPeerStateChange(listener);
      unsub();

      monitor.watchPeer('peer-1', '127.0.0.1:50051');
      const channel = channels.get('127.0.0.1:50051')!;
      channel._simulateStateChange(ConnectivityState.READY);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should clean up all peers on shutdown', async () => {
      monitor = setupMonitor();
      monitor.watchPeer('peer-1', '127.0.0.1:50051');
      monitor.watchPeer('peer-2', '127.0.0.1:50052');

      await monitor.onApplicationShutdown();

      expect(monitor.getPeerState('peer-1')).toBe('unknown');
      expect(monitor.getPeerState('peer-2')).toBe('unknown');
    });
  });
});
