# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-04-26

### ⚠ BREAKING CHANGES

- **Execution model replaced.** Shared executor pool + Redis gates replaced by dedicated Worker Threads per entity instance. Each `entity:entityId` gets its own in-memory worker with sequential FIFO processing.
- **Actor surface removed.** `@Actor`, `@On`, `ActorSystem`, `ActorRegistry`, actor state persistence — all removed. Use `@CommandHandler`/`@QueryHandler` from `@nestjs/cqrs` or plain function handlers via `queueBus.handle()`.
- **Executor pool removed.** `ExecutorPoolService`, `SchedulerService`, `GateService`, `LogService`, `ResultCollector` — all removed. Workers now process directly; no polling, no gates, no shared dispatch loop.
- **Registry removed.** `RegistryService`, schema validation, `ClusterContracts`, `queueBus.introspect()` — removed. Entity types are now discovered from CQRS handler metadata and module config.
- **`IAtomicQueuesModuleConfig` restructured.** Removed `executor`, `registry`, `defaultReplyTimeout`, `gateTTL`, actor-related options. Added `grpc`, `wal`, `maxTotalWorkers`, `maxTotalQueueDepth`.
- **`IEntityConfig` restructured.** Removed `gateTTL`, `actorIdleTimeout`, `statePersistence`. Added `workerIdleTimeout`, `workerMaxQueueDepth`, `onInterrupt`.

### Added

- **Worker Thread execution.** One worker per `entity:entityId`, sequential message processing, concurrent + parallel across entities. Workers auto-spawn on first message and teardown after idle timeout (default 30s).
- **Write-ahead log (WAL).** Lua-based state machine tracks every message through `enqueued → dispatched → completed/failed`. Messages found in `dispatched` state on recovery are dead-lettered (or retried, configurable via `onInterrupt`).
- **gRPC cluster topology.** Multi-server support with consistent hash ring, lock-free leader election, epoch fencing, and master assignment table. Messages are forwarded to the correct server automatically.
- **Cluster health monitoring.** `GrpcPeerMonitor` (channel state watching), `RedisHealthMonitor` (PING-based), per-peer circuit breakers. Degraded Redis triggers automatic step-down.
- **`MessageRouter` service.** Unified routing layer — handles local dispatch, master petition, cached assignment forwarding, and request-reply semantics.
- **Consistent hash ring.** 150 virtual nodes per server, O(log N) lookup, incremental rebalancing on topology changes.
- **Plain function handlers.** `queueBus.handle('PlaceOrder', async (data, ctx) => { ... })` — no CQRS, no decorators, no classes. Also available via `forEntity().handle()`.
- **CLI dead-letter commands.** `npx atomic-queues dlq list`, `dlq purge`, `dlq replay` for inspecting and managing dead-lettered messages.
- **Global admission control.** `maxTotalWorkers` and `maxTotalQueueDepth` caps to prevent unbounded resource growth.

### Deprecated

- **`@JobCommand` / `@JobQuery` decorators.** Use `@EntityType` + `@QueueEntityId` with standard `@CommandHandler`/`@QueryHandler`, or plain function handlers.
- **Two-argument `@QueueEntity('type', 'idProp')`.** Use `@EntityType('type')` + `@QueueEntityId()` instead.

### Removed

- `ActorSystem`, `ActorRegistry`, `@Actor`, `@On` — actor surface
- `ExecutorPoolService` — shared executor pool
- `SchedulerService` — Lua dispatch scheduler
- `GateService` — Redis gate mutex
- `LogService` — message log manager
- `ResultCollector` — multiplexed result subscriber
- `RegistryService`, `SchemaConverter` — distributed contract registry
- `@Schema` decorator, schema validation, `ClusterContracts`, codegen `--classes`
- `WIRE-PROTOCOL.md` — documented v2 Redis key layout, now obsolete

---

## [2.1.1] - 2026-04-22

### Changed

- **`@Actor` is now optional.** Classes with `@On` handlers are auto-discovered at boot — the entity type is inferred from the message class's `@EntityType` decorator. `@Actor` remains available for explicit declaration but is no longer required.

---

## [2.1.0] - 2026-04-22

### Added

- **Runtime introspection API (`queueBus.introspect()`).** Returns a `ClusterContracts` object with methods like `entityTypes()`, `hasEntity()`, `messagesFor()`, `schemaFor()`, `replySchemaFor()`, `accepts()`, and a human-readable `toString()`. Lets any service discover the full cluster topology at runtime without importing code from other services.
- **Raw cross-service enqueue (string-based API).** `queueBus.enqueue('warehouse', 'ReserveStockCommand', entityId, { ... })` and the matching `enqueueAndWait()` overload send messages to entities owned by other services — no class import, no code dependency. Also available via `queueBus.forEntity('warehouse').enqueue(...)`.
- **`Reply<T>` phantom type.** Zero-runtime-cost brand that carries the reply type at compile time. Generated query classes implement `Reply<R>`, so `enqueueAndWait(new GetStockQuery(...))` returns the correct type without an explicit generic.
- **`InferReply<T>` utility type.** Conditional type that extracts `R` from `Reply<R>` — used internally by `enqueueAndWait` overloads.
- **Class codegen (`npx atomic-queues generate --classes`).** Reads the live registry and generates one decorated TypeScript file per entity type plus a barrel `index.ts`. Each file contains data interfaces, reply interfaces, `@EntityType`/`@QueueEntityId` decorated classes, and `Reply<T>` branding for queries. Import and use like regular CQRS — no string API, no timeout, full autocomplete.
- **Config-driven timeout resolution.** `enqueueAndWait` no longer requires an explicit timeout. Resolution chain: explicit arg → per-entity `replyTimeout` → global `defaultReplyTimeout` → `gateTTL * 2 * 1000` → 60s fallback.
- **`replyTimeout` per-entity config.** `entities.warehouse.replyTimeout: 5000` sets the default reply timeout for all `enqueueAndWait` calls targeting that entity type.
- **`defaultReplyTimeout` executor config.** `executor.defaultReplyTimeout: 10000` sets a global default when no per-entity timeout is configured.
- **Entity-type dispatch routing (Lua).** The Lua scheduler now accepts entity-type prefix filters so each node only dispatches messages for entity types it owns handlers for. Eliminates message stealing in multi-service deployments where services share the same Redis.
- **Pure-client node detection.** Services with `registry.enabled` but no handlers (e.g. API gateways) return `[]` for owned entity types, making the executor pool skip dispatch entirely instead of stealing messages from handler-owning services.
- **`ClusterContracts` class.** Structured API wrapping `RegistrySnapshot` with typed accessors for entity types, messages, schemas, and reply schemas.
- **`TypedEnqueue<TMap>` / `TypedEnqueueAndWait<TMap, TReplyMap>` utility types.** Enable full autocomplete on entity types, message names, and payloads when used with the generated `DispatchMap`.
- **Registry `entityIdField` metadata.** The registry now publishes which field is the entity ID for each message, so class codegen can apply `@QueueEntityId()` to the correct property.
- **Registry kind inference.** `buildMessageSpec` infers `kind: 'query'` when a reply schema is present, so `@Actor` handlers don't need to explicitly specify the message kind.
- **`--entities` filter for CLI generate.** `npx atomic-queues generate --classes --entities warehouse,billing` limits codegen to specific entity types.
- **`-o` shorthand for `--output`** in the CLI.

### Fixed

- **Lua 5.1 compatibility.** Replaced `goto`/`::continue::` (Lua 5.2+) with a boolean flag pattern for Lua 5.1, which is what Redis uses.

---

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
