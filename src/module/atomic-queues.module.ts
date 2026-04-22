import {
  DynamicModule,
  Global,
  Module,
  Provider,
  Type,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig } from '../domain';
import {
  ATOMIC_QUEUES_REDIS,
  ATOMIC_QUEUES_CONFIG,
  LogService,
  GateService,
  SchedulerService,
  ExecutorPoolService,
  HandlerExecutor,
  ActorRegistry,
  ActorSystem,
  QueueBus,
  CommandDiscoveryService,
  ShutdownService,
} from '../services';

const CORE_SERVICES: Provider[] = [
  LogService,
  GateService,
  SchedulerService,
  ExecutorPoolService,
  HandlerExecutor,
  ActorRegistry,
  ActorSystem,
  QueueBus,
  CommandDiscoveryService,
  ShutdownService,
];

export interface AtomicQueuesModuleAsyncOptions {
  imports?: Type<unknown>[];
  useFactory: (...args: unknown[]) => Promise<IAtomicQueuesModuleConfig> | IAtomicQueuesModuleConfig;
  inject?: unknown[];
  isGlobal?: boolean;
}

@Global()
@Module({})
export class AtomicQueuesModule {
  static forRoot(config: IAtomicQueuesModuleConfig): DynamicModule {
    const redisProvider = this.createRedisProvider(config);

    return {
      module: AtomicQueuesModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: ATOMIC_QUEUES_CONFIG, useValue: config },
        redisProvider,
        DiscoveryService,
        MetadataScanner,
        ...CORE_SERVICES,
      ],
      exports: [
        ATOMIC_QUEUES_CONFIG,
        ATOMIC_QUEUES_REDIS,
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
          inject: (options.inject || []) as any[],
        },
        {
          provide: ATOMIC_QUEUES_REDIS,
          useFactory: (config: IAtomicQueuesModuleConfig) => {
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
          },
          inject: [ATOMIC_QUEUES_CONFIG],
        },
        DiscoveryService,
        MetadataScanner,
        ...CORE_SERVICES,
      ],
      exports: [
        ATOMIC_QUEUES_CONFIG,
        ATOMIC_QUEUES_REDIS,
        ...CORE_SERVICES,
      ],
      global: options.isGlobal ?? true,
    };
  }

  private static createRedisProvider(config: IAtomicQueuesModuleConfig): Provider {
    return {
      provide: ATOMIC_QUEUES_REDIS,
      useFactory: () => {
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
      },
    };
  }
}
