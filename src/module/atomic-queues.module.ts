import {
  DynamicModule,
  Global,
  Module,
  Provider,
  Type,
} from '@nestjs/common';
import Redis from 'ioredis';
import { IAtomicQueuesModuleConfig, DeepPartial } from '../domain';
import {
  ATOMIC_QUEUES_REDIS,
  ATOMIC_QUEUES_CONFIG,
  ATOMIC_QUEUES_MODULE_OPTIONS,
  QueueManagerService,
  WorkerManagerService,
  ResourceLockService,
  JobProcessorRegistry,
  DynamicExecutorService,
  AtomicJobProcessor,
  CronManagerService,
  IndexManagerService,
  ServiceQueueManager,
  ShutdownStateService,
} from '../services';

/**
 * Async module options for AtomicQueuesModule.forRootAsync()
 */
export interface AtomicQueuesModuleAsyncOptions {
  /**
   * Imports to include in the module
   */
  imports?: Type<unknown>[];

  /**
   * Factory function to create the module configuration
   */
  useFactory: (
    ...args: unknown[]
  ) => Promise<IAtomicQueuesModuleConfig> | IAtomicQueuesModuleConfig;

  /**
   * Dependencies to inject into the factory
   */
  inject?: unknown[];

  /**
   * Whether to make the module global
   */
  isGlobal?: boolean;
}

/**
 * Core services provided by the module
 */
const CORE_SERVICES: Provider[] = [
  QueueManagerService,
  WorkerManagerService,
  ResourceLockService,
  IndexManagerService,
  JobProcessorRegistry,
  DynamicExecutorService,
  AtomicJobProcessor,
  CronManagerService,
  ServiceQueueManager,
  ShutdownStateService,
];

/**
 * AtomicQueuesModule
 *
 * Main module for the AtomicQueues library.
 * Provides all services for atomic process handling per entity.
 *
 * @example
 * ```typescript
 * // Synchronous configuration
 * @Module({
 *   imports: [
 *     AtomicQueuesModule.forRoot({
 *       redis: {
 *         host: 'localhost',
 *         port: 6379,
 *       },
 *       enableCronManager: true,
 *       cronInterval: 5000,
 *     }),
 *   ],
 * })
 * export class AppModule {}
 *
 * // Async configuration
 * @Module({
 *   imports: [
 *     AtomicQueuesModule.forRootAsync({
 *       imports: [ConfigModule],
 *       useFactory: (configService: ConfigService) => ({
 *         redis: {
 *           url: configService.get('REDIS_URL'),
 *         },
 *         enableCronManager: true,
 *       }),
 *       inject: [ConfigService],
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Global()
@Module({})
export class AtomicQueuesModule {
  /**
   * Configure the module with synchronous options.
   */
  static forRoot(config: IAtomicQueuesModuleConfig): DynamicModule {
    const redisProvider = this.createRedisProvider(config);

    return {
      module: AtomicQueuesModule,
      // Note: CqrsModule should be imported by the consuming app, not here
      // to avoid duplicate CommandBus/QueryBus instances
      providers: [
        {
          provide: ATOMIC_QUEUES_CONFIG,
          useValue: config,
        },
        redisProvider,
        ...CORE_SERVICES,
      ],
      exports: [
        ATOMIC_QUEUES_CONFIG,
        ATOMIC_QUEUES_REDIS,
        ...CORE_SERVICES,
      ],
    };
  }

  /**
   * Configure the module with asynchronous options.
   */
  static forRootAsync(options: AtomicQueuesModuleAsyncOptions): DynamicModule {
    const configProvider = this.createAsyncConfigProvider(options);
    const redisProvider = this.createAsyncRedisProvider();

    return {
      module: AtomicQueuesModule,
      // Note: CqrsModule should be imported by the consuming app, not here
      // to avoid duplicate CommandBus/QueryBus instances
      imports: [...(options.imports || [])],
      providers: [configProvider, redisProvider, ...CORE_SERVICES],
      exports: [
        ATOMIC_QUEUES_CONFIG,
        ATOMIC_QUEUES_REDIS,
        ...CORE_SERVICES,
      ],
      global: options.isGlobal ?? true,
    };
  }

  /**
   * Create a feature module for entity-specific configuration.
   * Use this for registering entity scaling configurations.
   */
  static forFeature(options: {
    entityType: string;
    getDesiredWorkerCount: (entityId: string) => Promise<number>;
    getActiveEntityIds: () => Promise<string[]>;
    maxWorkersPerEntity?: number;
  }): DynamicModule {
    return {
      module: AtomicQueuesModule,
      providers: [
        {
          provide: `ENTITY_CONFIG_${options.entityType}`,
          useValue: options,
        },
      ],
    };
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * Create synchronous Redis provider.
   */
  private static createRedisProvider(
    config: IAtomicQueuesModuleConfig,
  ): Provider {
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

  /**
   * Create async configuration provider.
   */
  private static createAsyncConfigProvider(
    options: AtomicQueuesModuleAsyncOptions,
  ): Provider {
    return {
      provide: ATOMIC_QUEUES_CONFIG,
      useFactory: options.useFactory,
      inject: (options.inject || []) as any[],
    };
  }

  /**
   * Create async Redis provider.
   */
  private static createAsyncRedisProvider(): Provider {
    return {
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
    };
  }
}
