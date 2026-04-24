import { DynamicModule, Global, Module, Provider, Type } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { IAtomicQueuesModuleConfig } from '../domain';
import {
  ATOMIC_QUEUES_REDIS,
  ATOMIC_QUEUES_CONFIG,
  HandlerExecutor,
  EntityTypeRegistry,
  QueueBus,
  CommandDiscoveryService,
  ShutdownService,
  MessageRouter,
} from '../services';
import { WalService } from '../wal';
import { EntityWorkerManager } from '../workers';
import { GrpcServerService, GrpcClientPool } from '../grpc';
import {
  ClusterDiscoveryService,
  ServerRingService,
  LeaderElectionService,
  MasterCoordinator,
} from '../cluster';

export const ATOMIC_QUEUES_SERVER_ID = 'ATOMIC_QUEUES_SERVER_ID';

const CORE_SERVICES: Provider[] = [
  HandlerExecutor,
  EntityTypeRegistry,
  QueueBus,
  CommandDiscoveryService,
  ShutdownService,
  MessageRouter,
  EntityWorkerManager,
  GrpcServerService,
  GrpcClientPool,
  ClusterDiscoveryService,
  ServerRingService,
  LeaderElectionService,
  MasterCoordinator,
];

export interface AtomicQueuesModuleAsyncOptions {
  imports?: Type<unknown>[];
  useFactory: (
    ...args: unknown[]
  ) => Promise<IAtomicQueuesModuleConfig> | IAtomicQueuesModuleConfig;
  inject?: unknown[];
  isGlobal?: boolean;
}

@Global()
@Module({})
export class AtomicQueuesModule {
  static forRoot(config: IAtomicQueuesModuleConfig): DynamicModule {
    const serverId = config.grpc?.serverId ?? uuidv4();

    return {
      module: AtomicQueuesModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: ATOMIC_QUEUES_CONFIG, useValue: config },
        { provide: ATOMIC_QUEUES_SERVER_ID, useValue: serverId },
        {
          provide: ATOMIC_QUEUES_REDIS,
          useFactory: () => this.buildRedisConnection(config),
        },
        {
          provide: WalService,
          useFactory: (redis: Redis, cfg: IAtomicQueuesModuleConfig) => {
            return new WalService(redis, cfg, serverId);
          },
          inject: [ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG],
        },
        DiscoveryService,
        MetadataScanner,
        ...CORE_SERVICES,
      ],
      exports: [
        ATOMIC_QUEUES_CONFIG,
        ATOMIC_QUEUES_REDIS,
        ATOMIC_QUEUES_SERVER_ID,
        WalService,
        ...CORE_SERVICES,
      ],
    };
  }

  static forRootAsync(options: AtomicQueuesModuleAsyncOptions): DynamicModule {
    return {
      module: AtomicQueuesModule,
      imports: [DiscoveryModule, ...(options.imports || [])],
      providers: [
        {
          provide: ATOMIC_QUEUES_CONFIG,
          useFactory: options.useFactory,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inject: (options.inject || []) as any[],
        },
        {
          provide: ATOMIC_QUEUES_SERVER_ID,
          useFactory: (config: IAtomicQueuesModuleConfig) => config.grpc?.serverId ?? uuidv4(),
          inject: [ATOMIC_QUEUES_CONFIG],
        },
        {
          provide: ATOMIC_QUEUES_REDIS,
          useFactory: (config: IAtomicQueuesModuleConfig) => this.buildRedisConnection(config),
          inject: [ATOMIC_QUEUES_CONFIG],
        },
        {
          provide: WalService,
          useFactory: (redis: Redis, config: IAtomicQueuesModuleConfig, sid: string) => {
            return new WalService(redis, config, sid);
          },
          inject: [ATOMIC_QUEUES_REDIS, ATOMIC_QUEUES_CONFIG, ATOMIC_QUEUES_SERVER_ID],
        },
        DiscoveryService,
        MetadataScanner,
        ...CORE_SERVICES,
      ],
      exports: [
        ATOMIC_QUEUES_CONFIG,
        ATOMIC_QUEUES_REDIS,
        ATOMIC_QUEUES_SERVER_ID,
        WalService,
        ...CORE_SERVICES,
      ],
      global: options.isGlobal ?? true,
    };
  }

  private static buildRedisConnection(config: IAtomicQueuesModuleConfig): Redis {
    if (config.redis.url) {
      return new Redis(config.redis.url, {
        maxRetriesPerRequest: config.redis.maxRetriesPerRequest ?? null,
      });
    }
    return new Redis({
      host: config.redis.host || 'localhost',
      port: config.redis.port || 6379,
      password: config.redis.password,
      db: config.redis.db,
      maxRetriesPerRequest: config.redis.maxRetriesPerRequest ?? null,
    });
  }
}
