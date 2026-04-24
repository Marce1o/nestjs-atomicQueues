import { Injectable, Logger, Inject, OnApplicationShutdown } from '@nestjs/common';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig, ISerializedMessage, IMessageRef } from '../domain';
import { ATOMIC_QUEUES_CONFIG } from '../services/constants';

interface GrpcClient {
  address: string;
  client: any;
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
  private grpcModule: any = null;
  private protoDescriptor: any = null;

  constructor(
    @Inject(ATOMIC_QUEUES_CONFIG) private readonly config: IAtomicQueuesModuleConfig,
  ) {}

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
    const grpc = require('@grpc/grpc-js');
    const protoLoader = require('@grpc/proto-loader');
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
    this.protoDescriptor = grpc.loadPackageDefinition(packageDef);
  }

  /**
   * Get or create a client connection to a peer server.
   */
  async getClient(serverId: string, address: string): Promise<any> {
    const existing = this.clients.get(serverId);
    if (existing && existing.address === address) {
      return existing.client;
    }

    await this.ensureLoaded();

    const ServiceClass = this.protoDescriptor.atomicqueues.v1.AtomicQueuesNode;
    const client = new ServiceClass(
      address,
      this.grpcModule.credentials.createInsecure(),
    );

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

    return new Promise<IMessageRef>((resolve, reject) => {
      client.forward(envelope, (err: Error | null, response: any) => {
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

      stream.on('data', (response: any) => {
        clearTimeout(timer);

        if (response.error) {
          reject(new Error(response.error));
        } else if (response.result) {
          const resultJson = Buffer.from(response.result).toString('utf-8');
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

    return new Promise((resolve, reject) => {
      client.ping({ senderId: myServerId }, (err: Error | null, response: any) => {
        if (err) {
          resolve({ healthy: false, queueDepth: 0 });
          return;
        }
        resolve({
          healthy: true,
          queueDepth: response.queueDepth ?? 0,
        });
      });
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
