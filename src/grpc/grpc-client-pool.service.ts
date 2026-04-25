import { Injectable, Logger, Inject, OnApplicationShutdown } from '@nestjs/common';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig, ISerializedMessage, IMessageRef } from '../domain';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';

/** Minimal shape of a gRPC client instance (from @grpc/grpc-js). */
interface GrpcCallOptions {
  deadline?: Date;
}
interface GrpcClientInstance {
  forward(
    envelope: Record<string, unknown>,
    options: GrpcCallOptions,
    callback: (err: Error | null, response: Record<string, unknown>) => void,
  ): void;
  forwardAndWait(envelope: Record<string, unknown>): GrpcClientStream;
  ping(
    request: Record<string, unknown>,
    options: GrpcCallOptions,
    callback: (err: Error | null, response: Record<string, unknown>) => void,
  ): void;
  close(): void;
}

/** Minimal shape of a gRPC readable stream (from @grpc/grpc-js). */
interface GrpcClientStream {
  on(event: 'data', listener: (response: Record<string, unknown>) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'end', listener: () => void): void;
}

/** Minimal shape of the @grpc/grpc-js module used at runtime. */
interface GrpcModule {
  credentials: { createInsecure(): unknown };
  loadPackageDefinition(
    packageDef: unknown,
  ): Record<string, Record<string, Record<string, unknown>>>;
}

/** Minimal shape of the @grpc/proto-loader module used at runtime. */
interface ProtoLoaderModule {
  loadSync(filename: string, options: Record<string, unknown>): unknown;
}

/** Minimal shape of a proto-loaded service constructor. */
type GrpcServiceConstructor = new (address: string, credentials: unknown) => GrpcClientInstance;

/** Minimal shape of the loaded proto descriptor used in this pool. */
interface ProtoDescriptor {
  atomicqueues: {
    v1: {
      AtomicQueuesNode: GrpcServiceConstructor;
    };
  };
}

interface GrpcClient {
  address: string;
  client: GrpcClientInstance;
}

/**
 * gRPC Client Pool — maintains connections to peer servers.
 *
 * Provides `forward()` and `forwardAndWait()` methods that the
 * MessageRouter calls when an entity is owned by a remote server.
 */
@Injectable()
export class GrpcClientPool implements OnApplicationShutdown {
  private readonly logger = new Logger(GrpcClientPool.name);
  private readonly clients = new Map<string, GrpcClient>();
  private grpcModule: GrpcModule | null = null;
  private protoDescriptor: ProtoDescriptor | null = null;

  constructor(@Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig) {}

  async onApplicationShutdown(): Promise<void> {
    for (const [, { client }] of this.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  /**
   * Ensure the gRPC module is loaded (lazy, for optional dependency).
   */
  private async ensureLoaded(): Promise<void> {
    if (this.grpcModule) return;

    /* eslint-disable @typescript-eslint/no-var-requires */
    const grpc = require('@grpc/grpc-js') as GrpcModule;
    const protoLoader = require('@grpc/proto-loader') as ProtoLoaderModule;
    /* eslint-enable @typescript-eslint/no-var-requires */

    const protoPath = path.join(__dirname, 'atomicqueues.proto');
    const packageDef = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    this.grpcModule = grpc;
    this.protoDescriptor = grpc.loadPackageDefinition(packageDef) as unknown as ProtoDescriptor;
  }

  /**
   * Get or create a client connection to a peer server.
   */
  async getClient(serverId: string, address: string): Promise<GrpcClientInstance> {
    const existing = this.clients.get(serverId);
    if (existing && existing.address === address) {
      return existing.client;
    }

    await this.ensureLoaded();

    const ServiceClass = this.protoDescriptor!.atomicqueues.v1.AtomicQueuesNode;
    const client = new ServiceClass(address, this.grpcModule!.credentials.createInsecure());

    this.clients.set(serverId, { address, client });
    this.logger.log(`Connected to peer ${serverId} at ${address}`);

    return client;
  }

  /**
   * Forward a message to a remote server (fire-and-forget).
   */
  async forward(
    serverId: string,
    address: string,
    message: ISerializedMessage,
    originServerId: string,
    hops: number,
  ): Promise<IMessageRef> {
    const client = await this.getClient(serverId, address);

    const envelope = {
      id: message.id,
      name: message.name,
      payload: Buffer.from(JSON.stringify(message.data), 'utf-8'),
      entityType: message.entityType,
      entityId: message.entityId,
      correlationId: message.correlationId ?? '',
      isQuery: message.isQuery ?? false,
      enqueuedAt: message.enqueuedAt,
      attempts: message.attempts,
      maxAttempts: message.maxAttempts,
      originServer: originServerId,
      hops: hops + 1,
    };

    const deadline = new Date(Date.now() + 1500);
    return new Promise<IMessageRef>((resolve, reject) => {
      client.forward(envelope, { deadline }, (err: Error | null, response: Record<string, unknown>) => {
        if (err) {
          reject(new Error(`gRPC forward to ${serverId} failed: ${err.message}`));
          return;
        }
        if (!response.accepted) {
          reject(new Error(`Forward rejected by ${serverId}: ${response.rejectReason}`));
          return;
        }
        resolve({
          id: message.id,
          entityKey: `${message.entityType}:${message.entityId}`,
        });
      });
    });
  }

  /**
   * Forward a message to a remote server and wait for the result.
   */
  async forwardAndWait<R = unknown>(
    serverId: string,
    address: string,
    message: ISerializedMessage,
    originServerId: string,
    hops: number,
    timeout: number,
  ): Promise<R> {
    const client = await this.getClient(serverId, address);

    const envelope = {
      id: message.id,
      name: message.name,
      payload: Buffer.from(JSON.stringify(message.data), 'utf-8'),
      entityType: message.entityType,
      entityId: message.entityId,
      correlationId: message.correlationId ?? uuidv4(),
      isQuery: true,
      enqueuedAt: message.enqueuedAt,
      attempts: message.attempts,
      maxAttempts: message.maxAttempts,
      originServer: originServerId,
      hops: hops + 1,
    };

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`gRPC forwardAndWait to ${serverId} timed out after ${timeout}ms`));
      }, timeout);

      const stream = client.forwardAndWait(envelope);

      stream.on('data', (response: Record<string, unknown>) => {
        clearTimeout(timer);

        if (response.error) {
          reject(new Error(response.error as string));
        } else if (response.result) {
          const resultJson = Buffer.from(response.result as Buffer).toString('utf-8');
          resolve(JSON.parse(resultJson) as R);
        } else {
          reject(new Error('Empty result from remote server'));
        }
      });

      stream.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`gRPC stream error from ${serverId}: ${err.message}`));
      });

      stream.on('end', () => {
        clearTimeout(timer);
        // If we haven't resolved yet, the stream ended without data
      });
    });
  }

  /**
   * Ping a peer server.
   */
  async ping(serverId: string, address: string): Promise<{ healthy: boolean; queueDepth: number }> {
    const client = await this.getClient(serverId, address);
    const myServerId = this.config.grpc?.serverId ?? 'unknown';

    const deadline = new Date(Date.now() + 1000);
    return new Promise((resolve, _reject) => {
      client.ping(
        { senderId: myServerId },
        { deadline },
        (err: Error | null, response: Record<string, unknown>) => {
          if (err) {
            resolve({ healthy: false, queueDepth: 0 });
            return;
          }
          resolve({
            healthy: true,
            queueDepth: (response.queueDepth as number) ?? 0,
          });
        },
      );
    });
  }

  /**
   * Remove a client connection.
   */
  removeClient(serverId: string): void {
    const existing = this.clients.get(serverId);
    if (existing) {
      try {
        existing.client.close();
      } catch {
        // ignore
      }
      this.clients.delete(serverId);
    }
  }
}
