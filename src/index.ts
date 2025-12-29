/**
 * =============================================================================
 * ATOMIC QUEUES
 * =============================================================================
 *
 * A plug-and-play NestJS library for atomic process handling per entity
 * with BullMQ, Redis distributed locking, and dynamic worker management.
 *
 * Features:
 * - Dynamic per-entity queue creation
 * - Worker lifecycle management with heartbeat TTL
 * - Distributed resource locking (Redis/Lua scripts)
 * - Graceful shutdown coordination via pub/sub
 * - Cron-based worker spawning/cleanup
 * - CQRS command/query dynamic execution
 * - Index tracking for jobs, workers, and queues
 *
 * @example
 * ```typescript
 * import { AtomicQueuesModule, QueueManagerService, WorkerManagerService } from '@atomicqueues/core';
 *
 * @Module({
 *   imports: [
 *     AtomicQueuesModule.forRoot({
 *       redis: { host: 'localhost', port: 6379 },
 *       enableCronManager: true,
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * @packageDocumentation
 */

// Domain - Interfaces and Types
export * from './domain';

// Module
export * from './module';

// Services
export * from './services';

// Decorators
export * from './decorators';

// Utilities
export * from './utils';
