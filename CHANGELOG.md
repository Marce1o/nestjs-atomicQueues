# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
