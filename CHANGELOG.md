# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-04-22

### ⚠ BREAKING CHANGES

- **BullMQ removed entirely.** The library no longer depends on `bullmq` or `@nestjs/bullmq`. All queue operations are now pure Redis (lists + Lua scripts + pub/sub).
- **Workers removed.** There are no per-entity workers, no heartbeats, no idle timeouts, no scaling cycles. A shared executor pool dispatches messages via atomic Redis gates.
- **`@WorkerProcessor` removed.** Use `@Actor` for stateful entity processing or configure entity defaults in the module config for stateless handlers.
- **`@EntityScaler` and all scaling decorators removed.** `@GetActiveEntities`, `@GetDesiredWorkerCount`, `@OnSpawnWorker`, `@OnTerminateWorker` — all gone. No workers means nothing to scale.
- **`@JobHandler` removed.** Use `@On(MessageClass)` on actor methods, or `@CommandHandler`/`@QueryHandler` from `@nestjs/cqrs`.
- **`.forProcessor(ProcessorClass)` removed from QueueBus.** Use `.forEntity('type')` instead.
- **`@nestjs/cqrs` is now an optional peer dependency.** Only required if using the CQRS surface (`@JobCommand`, `@JobQuery`, `@CommandHandler`, `@QueryHandler`).
- **Return type of `enqueue()` changed.** Returns `IMessageRef` (`{ id, entityKey }`) instead of a BullMQ `Job` object.
- **16 services reduced to 12.** Deleted: `WorkerManagerService`, `CronManagerService`, `SpawnQueueService`, `ServiceQueueManager`, `IndexManagerService`, `QueueEventsManagerService`, `ScalingRegistrationService`, `WorkerFactoryService`, `QueueManagerService`, `ResourceLockService`.

### Added

- **Dispatch-gate execution model.** Per-entity Redis gates (`SET NX EX`) ensure single-writer semantics cluster-wide. No contention, no retry storms, no split-brain.
- **Shared executor pool (`ExecutorPoolService`).** A configurable pool of concurrent executors per node, dispatching messages from any ready entity. No per-entity workers to spawn or manage.
- **Atomic Lua scheduler (`SchedulerService`).** A single Lua script atomically picks an entity from the ready set, acquires its gate, and pops the next message. Zero race conditions.
- **Virtual actor surface (`@Actor`, `@On`).** Stateful entity classes with per-message-type handlers. Actor instances are virtual — activated on demand, evicted on idle, state persisted to Redis by default.
- **`ActorSystem` service.** Public API for the actor surface: `send()`, `sendAndWait()`.
- **`ActorRegistry` service.** Discovers `@Actor` classes at boot, manages per-entity instances, handles state persistence and idle eviction.
- **`ResultCollector` service.** Single multiplexed Redis subscriber for all `enqueueAndWait`/`sendAndWait` calls. Replaces the previous per-call `redis.duplicate()` pattern. One connection handles unlimited concurrent result waits.
- **Distributed contract registry (`RegistryService`).** Optional. On enable, each node publishes its entity types and accepted messages to Redis. Other nodes discover and validate messages at the call site before enqueue. Supports co-ownership (multiple services handling the same entity type).
- **`@Schema(zodSchema)` decorator.** Attaches a Zod schema to message classes. The registry serializes it to JSON Schema and validates payloads on send when `schemaValidation: true`.
- **Codegen CLI (`npx atomic-queues generate`).** Reads the live registry from Redis and generates TypeScript interfaces (`--ts`) or JSON Schema (`--json-schema`) for all registered entities and messages. Also supports `--snapshot` for full registry export.
- **Wire protocol documentation (`WIRE-PROTOCOL.md`).** Complete specification of the Redis key layout and command sequences. Any language with a Redis client can be a first-class citizen — three Redis commands to enqueue a message.
- **Per-entity-type configuration.** `gateTTL`, `retry`, `actorIdleTimeout`, `statePersistence` — configurable per entity type in the module config.
- **`HandlerExecutor` service.** Unified handler routing: tries `@Actor` → `@JobCommand`/`@JobQuery` → `QueueBus` registry → CQRS `CommandBus`/`QueryBus`. Single dispatch pipeline for all three surfaces.

### Changed

- **`QueueBus.enqueue()` internals.** Now writes to a Redis list (message log) instead of a BullMQ queue. Public API unchanged.
- **`QueueBus.enqueueAndWait()` internals.** Now uses `ResultCollector` (shared subscriber) instead of spawning a per-call Redis connection.
- **`IAtomicQueuesModuleConfig` simplified.** Removed `enableCronManager`, `cronInterval`, `workerDefaults`, `serviceQueue`. Added `executor`, `registry`, `retry`.
- **`IEntityConfig` simplified.** Removed `queueName`, `workerName`, `workerConfig`, `maxWorkersPerEntity`, `idleTimeoutSeconds`, `autoSpawn`. Added `gateTTL`, `retry`, `actorIdleTimeout`, `statePersistence`.
- **Handler discovery.** `HandlerExecutor` now auto-discovers `@CommandHandler`/`@QueryHandler` from `@nestjs/cqrs` and wires `CommandBus`/`QueryBus` automatically if the CQRS module is present.

### Removed

- `bullmq` dependency
- `@nestjs/bullmq` dependency
- `WorkerManagerService` — no workers
- `CronManagerService` — no scaling cycles
- `SpawnQueueService` — no worker spawning
- `ServiceQueueManager` — no service queue
- `IndexManagerService` — no indices to track
- `QueueEventsManagerService` — no BullMQ events
- `ScalingRegistrationService` — no scaling
- `WorkerFactoryService` — no workers to create
- `QueueManagerService` — replaced by `LogService`
- `ResourceLockService` — removed (was standalone utility)
- `@WorkerProcessor` decorator
- `@JobHandler` decorator
- `@EntityScaler` decorator
- `@GetActiveEntities` decorator
- `@GetDesiredWorkerCount` decorator
- `@OnSpawnWorker` decorator
- `@OnTerminateWorker` decorator
- `@AtomicProcessor` legacy decorator
- `@JobType` legacy decorator
- `@InjectAtomicQueue` legacy decorator
- All worker, scaling, lock, queue, event, process, and index-tracking interfaces from `domain/interfaces/`

---

## [1.6.0] - 2026-04-16

### Added

- **Comprehensive test suite** — 237 tests across 10 suites covering all utilities, decorators, and services
- **Shared `scanKeys()` utility** (`utils/redis.utils.ts`) — replaces 5 identical private copies across services
- **Shared `resolveKeyPrefix()`** (`utils/naming.utils.ts`) — centralizes `config.keyPrefix || 'aq'` resolution
- **Shared `ICommandBus` / `IQueryBus`** (`domain/interfaces/cqrs.interfaces.ts`) — eliminates duplicate definitions

### Changed

- **Modular project structure** — split 3 god-files into focused, single-responsibility modules
- **Decomposed `ProcessorDiscoveryService`** (968-line god class) into 5 focused services
- **Split `queue-bus.service.ts`** (855 lines) into focused modules
- **Bundled BullMQ/ioredis/@nestjs/bullmq** as regular dependencies

### Fixed

- **QueueBus `keyPrefix` defaulting to `'atomic'`** instead of `'aq'`

### Upgraded

- `@nestjs/bullmq` 10 → 11, `@nestjs/common` 10 → 11, `@nestjs/core` 10 → 11, `@nestjs/cqrs` 10 → 11
- `bullmq` 5.1 → 5.74, `ioredis` 5.3 → 5.10, `typescript` 5.3 → 5.9

## [1.3.0] - 2026-01-06

### Added

- **QueueBus** — CQRS-style bus for adding commands/queries to queues
- **QueueTarget** — fluent builder for processor-targeted enqueueing
- **EntityTarget** — zero-boilerplate entity-targeted enqueueing
- **`@QueueEntity('type', 'prop')`** — combined decorator for entity type + ID
- **`@QueueEntityId()`** — constructor parameter decorator support
- **`@JobCommand` / `@JobQuery`** — auto-routing decorators
- **`CommandDiscoveryService`** — auto-discovers `@JobCommand`/`@JobQuery` classes
- **`QueueBus.discoverFromCqrs()`** — auto-registers `@CommandHandler`/`@QueryHandler`

## [1.0.0] - 2025-11-28

### Added

- Initial release
- Per-entity BullMQ queue creation
- Worker lifecycle management with heartbeat TTL
- Distributed resource locking via Redis Lua scripts
- Graceful shutdown coordination via pub/sub
- Cron-based worker spawning and cleanup
- `@WorkerProcessor` and `@EntityScaler` decorators
- Index tracking for jobs, workers, and queues
