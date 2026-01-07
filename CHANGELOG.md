# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-01-06

### Added

- **QueueBus** - A CQRS-style bus for adding commands/queries to queues
  - `QueueBus.execute(pattern, command, options)` - Adds command instance to a queue
  - `QueueBus.registerCommands(...classes)` - Static registration of command classes
  - `QueueBus.registerQueries(...classes)` - Static registration of query classes
  - Queue patterns with `{entityId}` placeholder: `'bji:table:{entityId}:queue'`
  - Job name automatically derived from class name (e.g., `MakeBetCommand` → `'MakeBetCommand'`)
  - Full integration with `ProcessorDiscoveryService` for worker-side routing

- **QueueManagerService.getQueueEvents(name)** - Get `QueueEvents` instance for a queue

### Changed

- **ProcessorDiscoveryService** now supports QueueBus registry as additional routing option
  - Job processing priority: `@JobHandler` → `@JobCommand`/`@JobQuery` → QueueBus registry → wildcard
  - Commands in QueueBus registry are instantiated with entityId + job.data
  - `setCommandBus()` / `setQueryBus()` methods for CQRS integration

### Migration

With QueueBus, you no longer need `@JobCommand` decorators OR job name enums:

**Before (v1.2.0) - Decorators required:**
```typescript
@JobCommand('make-bet')
export class MakeBetCommand { ... }

// Enum still needed for adding jobs
enum JobNames { MakeBet = 'make-bet' }
queue.add(JobNames.MakeBet, { bets, player });
```

**After (v1.3.0) - Pure classes, no decorators:**
```typescript
// command.ts - Just a class, no decorator
export class MakeBetCommand {
  constructor(
    public readonly tableId: string,
    public readonly bets: any[],
    public readonly player: any,
  ) {}
}

// registration.ts - Register once at startup
QueueBus.registerCommands(MakeBetCommand, DealCommand, ...);

// usage - Pass command instance to QueueBus
queueBus.execute('table:{entityId}:queue', 
  new MakeBetCommand(tableId, bets, player),
  { entityId: tableId }
);
```

## [1.2.0] - 2026-01-06

### Added

- **Zero-boilerplate CQRS integration** with `@JobCommand` and `@JobQuery` decorators
  - `@JobCommand('job-name')` - Class decorator to route jobs directly to command classes
  - `@JobQuery('job-name')` - Class decorator to route jobs directly to query classes
  - Auto-derives job names from class names (e.g., `MakeBetCommand` → `'make-bet'`)
  - Supports explicit job names and entity type scoping
  - Constructor parameter extraction for automatic command instantiation

- **CommandDiscoveryService** - Discovers and routes `@JobCommand`/`@JobQuery` decorated classes
  - Automatic discovery of decorated command/query classes
  - Job-to-command routing with automatic instantiation
  - Entity ID injection as first constructor parameter
  - Job data mapping to remaining constructor parameters
  - Scoped routing support for entity-type-specific commands
  - `setCommandBus()` / `setQueryBus()` for CQRS integration
  - `getRegisteredJobNames()` for debugging/documentation

### Changed

- **ProcessorDiscoveryService** now integrates with `CommandDiscoveryService`
  - Job processing priority: explicit `@JobHandler` → `@JobCommand`/`@JobQuery` → wildcard handler
  - Seamless fallback to auto-routed commands when no explicit handler exists

### Migration

Commands decorated with `@JobCommand` no longer need explicit `@JobHandler` methods in processors:

**Before (v1.1.0):**
```typescript
// In processor file - BOILERPLATE
@JobHandler('make-bet')
async handleMakeBet(job: Job, tableId: string) {
  return this.commandBus.execute(
    new MakeBetCommand(tableId, job.data.bets, job.data.player)
  );
}
```

**After (v1.2.0):**
```typescript
// In command file - just add decorator
@JobCommand('make-bet')
export class MakeBetCommand {
  constructor(
    public readonly tableId: string,  // ← entityId (auto-injected)
    public readonly bets: any[],      // ← from job.data.bets
    public readonly player: any,      // ← from job.data.player
  ) {}
}

// Processor becomes nearly empty - just configuration
@WorkerProcessor({ entityType: 'table', ... })
export class TableProcessor {
  @JobHandler('*')
  handleUnmapped(job: Job) { /* fallback */ }
}
```

## [1.1.0] - 2026-01-06

### Added

- **Decorator-based API** for declarative worker and job handler configuration
  - `@WorkerProcessor(options)` - Class decorator to define a worker processor for an entity type
  - `@JobHandler(jobName)` - Method decorator to route jobs to specific handler methods
  - `@JobHandler('*')` - Wildcard handler support for fallback/catch-all processing
  - `@EntityScaler(options)` - Class decorator for entity scaling configuration
  - `@GetActiveEntities()` - Method decorator for active entity discovery
  - `@GetDesiredWorkerCount()` - Method decorator for worker count calculation
  - `@OnSpawnWorker()` - Method decorator for custom spawn logic
  - `@OnTerminateWorker()` - Method decorator for custom termination logic

- **ProcessorDiscoveryService** - Automatic discovery and registration of decorated classes
  - Auto-discovers `@WorkerProcessor` and `@EntityScaler` decorated providers
  - Registers job handlers with `WorkerManagerService`
  - Integrates scalers with `CronManagerService`
  - Supports manual registration via `registerProcessorClass()` and `registerScalerClass()`

- **Utility functions** for metadata retrieval
  - `getWorkerProcessorMetadata()`
  - `getJobHandlerMetadata()`
  - `getEntityScalerMetadata()`
  - `isWorkerProcessor()`
  - `isEntityScaler()`

### Changed

- Module now imports `DiscoveryModule` from `@nestjs/core` for provider scanning

### Deprecated

- `@AtomicProcessor` - Use `@WorkerProcessor` class decorator with `@JobHandler` method decorators
- `@EntityType` - Use `@WorkerProcessor` or `@EntityScaler` class decorators
- `@JobType` - Use `@JobHandler` method decorator

## [1.0.16] - Previous

- Initial stable release with manual registration API
