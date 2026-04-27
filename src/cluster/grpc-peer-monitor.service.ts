import { Injectable, Logger, Inject, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { IAtomicQueuesModuleConfig } from '../domain';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';

export type PeerLivenessState = 'alive' | 'suspected-dead' | 'unknown';

interface PeerEntry {
  serverId: string;
  address: string;
  state: PeerLivenessState;
  client: unknown;
  suspectTimer: NodeJS.Timeout | null;
  watchActive: boolean;
}

interface GrpcModule {
  Client: new (address: string, credentials: unknown, options?: Record<string, unknown>) => GrpcMonitorClient;
  credentials: { createInsecure(): unknown };
  connectivityState: Record<string, number>;
}

interface GrpcMonitorClient {
  getChannel(): GrpcChannel;
  close(): void;
}

interface GrpcChannel {
  getConnectivityState(tryToConnect: boolean): number;
  watchConnectivityState(currentState: number, deadline: Date, callback: (err?: Error) => void): void;
}

@Injectable()
export class GrpcPeerMonitor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(GrpcPeerMonitor.name);
  private readonly enabled: boolean;
  private readonly debounceMs: number;
  private readonly keepaliveTimeMs: number;
  private readonly keepaliveTimeoutMs: number;
  private readonly connectivityWatchMs: number;

  private grpcModule: GrpcModule | null = null;
  private readonly peers = new Map<string, PeerEntry>();
  private readonly stateChangeListeners: Array<(serverId: string, state: PeerLivenessState) => void> = [];

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
  ) {
    this.enabled = (config.grpc?.enabled ?? false) && (config.grpc?.peerMonitorEnabled ?? true);
    this.debounceMs = config.grpc?.peerSuspectDebounceMs ?? 500;
    this.keepaliveTimeMs = config.grpc?.keepaliveTimeMs ?? 10000;
    this.keepaliveTimeoutMs = config.grpc?.keepaliveTimeoutMs ?? 5000;
    this.connectivityWatchMs = config.grpc?.deadlines?.connectivityWatchMs ?? 30000;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.grpcModule = require('@grpc/grpc-js') as GrpcModule;
      this.logger.log('gRPC peer monitor initialized');
    } catch {
      this.logger.warn('gRPC peer monitor disabled: @grpc/grpc-js not installed');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    for (const [, peer] of this.peers) {
      this.cleanupPeer(peer);
    }
    this.peers.clear();
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  getPeerState(serverId: string): PeerLivenessState {
    return this.peers.get(serverId)?.state ?? 'unknown';
  }

  onPeerStateChange(listener: (serverId: string, state: PeerLivenessState) => void): () => void {
    this.stateChangeListeners.push(listener);
    return () => {
      const idx = this.stateChangeListeners.indexOf(listener);
      if (idx >= 0) this.stateChangeListeners.splice(idx, 1);
    };
  }

  watchPeer(serverId: string, address: string): void {
    if (!this.grpcModule) return;

    const existing = this.peers.get(serverId);
    if (existing && existing.address === address) return;
    if (existing) this.cleanupPeer(existing);

    const channelOptions = {
      'grpc.keepalive_time_ms': this.keepaliveTimeMs,
      'grpc.keepalive_timeout_ms': this.keepaliveTimeoutMs,
      'grpc.keepalive_permit_without_calls': 1,
    };

    const client = new this.grpcModule.Client(
      address,
      this.grpcModule.credentials.createInsecure(),
      channelOptions,
    );

    const entry: PeerEntry = {
      serverId,
      address,
      state: 'unknown',
      client,
      suspectTimer: null,
      watchActive: true,
    };

    this.peers.set(serverId, entry);
    this.startWatchLoop(entry);
  }

  unwatchPeer(serverId: string): void {
    const peer = this.peers.get(serverId);
    if (!peer) return;
    this.cleanupPeer(peer);
    this.peers.delete(serverId);
  }

  syncPeers(peers: Array<{ serverId: string; address: string }>): void {
    const incoming = new Set(peers.map((p) => p.serverId));

    for (const [id] of this.peers) {
      if (!incoming.has(id)) this.unwatchPeer(id);
    }

    for (const p of peers) {
      this.watchPeer(p.serverId, p.address);
    }
  }

  // =========================================================================
  // INTERNAL — connectivity state watch loop
  // =========================================================================

  private startWatchLoop(entry: PeerEntry): void {
    if (!this.grpcModule || !entry.watchActive) return;

    const channel = (entry.client as GrpcMonitorClient).getChannel();
    const currentState = channel.getConnectivityState(true);

    this.handleStateTransition(entry, currentState);

    const deadline = new Date(Date.now() + this.connectivityWatchMs);
    channel.watchConnectivityState(currentState, deadline, (err) => {
      if (!entry.watchActive) return;

      if (err) {
        // Deadline expired without state change — re-arm
        this.startWatchLoop(entry);
        return;
      }

      // State changed — process and re-arm
      this.startWatchLoop(entry);
    });
  }

  private handleStateTransition(entry: PeerEntry, grpcState: number): void {
    if (!this.grpcModule) return;

    const { connectivityState } = this.grpcModule;
    const READY = connectivityState.READY;
    const TRANSIENT_FAILURE = connectivityState.TRANSIENT_FAILURE;
    const SHUTDOWN = connectivityState.SHUTDOWN;

    if (grpcState === READY) {
      if (entry.suspectTimer) {
        clearTimeout(entry.suspectTimer);
        entry.suspectTimer = null;
      }
      if (entry.state !== 'alive') {
        entry.state = 'alive';
        this.notifyListeners(entry.serverId, 'alive');
      }
    } else if (grpcState === TRANSIENT_FAILURE || grpcState === SHUTDOWN) {
      if (entry.state === 'alive' && !entry.suspectTimer) {
        entry.suspectTimer = setTimeout(() => {
          entry.suspectTimer = null;
          if (entry.state !== 'suspected-dead') {
            entry.state = 'suspected-dead';
            this.logger.warn(`Peer ${entry.serverId} suspected dead (gRPC ${grpcState === SHUTDOWN ? 'SHUTDOWN' : 'TRANSIENT_FAILURE'})`);
            this.notifyListeners(entry.serverId, 'suspected-dead');
          }
        }, this.debounceMs);
      }
    }
    // IDLE and CONNECTING: no action, wait for READY or TRANSIENT_FAILURE
  }

  // =========================================================================
  // INTERNAL — helpers
  // =========================================================================

  private cleanupPeer(peer: PeerEntry): void {
    peer.watchActive = false;
    if (peer.suspectTimer) {
      clearTimeout(peer.suspectTimer);
      peer.suspectTimer = null;
    }
    try {
      (peer.client as GrpcMonitorClient).close();
    } catch {
      // ignore
    }
  }

  private notifyListeners(serverId: string, state: PeerLivenessState): void {
    for (const listener of this.stateChangeListeners) {
      try {
        listener(serverId, state);
      } catch (err) {
        this.logger.error(`Peer state change listener error: ${(err as Error).message}`);
      }
    }
  }
}
