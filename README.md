# atomic-queues

A plug-and-play NestJS library for atomic process handling per entity with BullMQ, Redis distributed locking, and dynamic worker management.

## Overview

`atomic-queues` provides a unified architecture for handling atomic, sequential processing of jobs on a per-entity basis. It abstracts the complexity of managing dynamic queues, workers, and distributed locking into a simple, **declarative decorator-based API**.

### Problem It Solves

In distributed systems, you often need to:
- Process jobs **sequentially** for a specific entity (user, order, session)
- **Dynamically spawn workers** based on load
- **Prevent race conditions** when multiple services handle the same entity
- **Scale horizontally** while maintaining per-entity ordering guarantees

This library solves all of these with a single, cohesive module.

---

## Features

- **Decorator-based API**: Use `@WorkerProcessor` and `@JobHandler` for declarative job routing
- **Auto-discovery**: Processors and scalers are automatically discovered and registered
- **Dynamic Per-Entity Queues**: Automatically create and manage queues for each entity
- **Worker Lifecycle Management**: Heartbeat-based worker tracking with TTL expiration
- **Distributed Resource Locking**: Atomic lock acquisition
- **Graceful Shutdown**: Coordinated shutdown via Redis pub/sub across cluster nodes
- **Cron-based Scaling**: Automatic worker spawning and termination based on demand

---

## Installation

```bash
npm install atomic-queues bullmq ioredis
```

---

## Quick Start (Decorator-based API) ✨

The recommended way to use `atomic-queues` is with the decorator-based API for clean, declarative code.

### 1. Import the Module

```typescript
import { Module } from '@nestjs/common';
import { AtomicQueuesModule } from 'atomic-queues';

@Module({
  imports: [
    AtomicQueuesModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        redis: {
          url: configService.get('REDIS_URL'),
        },
        keyPrefix: 'myapp',
        enableCronManager: true,
        workerDefaults: {
          concurrency: 1,
          heartbeatTTL: 3,
        },
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}
```

### 2. Create a Worker Processor

Use `@WorkerProcessor` to define a processor class and `@JobHandler` to route jobs to methods:

```typescript
import { Injectable } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Job } from 'bullmq';
import { WorkerProcessor, JobHandler } from 'atomic-queues';

@WorkerProcessor({
  entityType: 'order',
  queueName: (orderId) => `order-${orderId}-queue`,
  workerName: (orderId) => `order-${orderId}-worker`,
  workerConfig: {
    concurrency: 1,
    heartbeatTTL: 3,
  },
})
@Injectable()
export class OrderWorkerProcessor {
  constructor(private readonly commandBus: CommandBus) {}

  @JobHandler('validate')
  async handleValidate(job: Job, orderId: string) {
    const { items } = job.data;
    return this.commandBus.execute(new ValidateOrderCommand(orderId, items));
  }

  @JobHandler('process-payment')
  async handlePayment(job: Job, orderId: string) {
    const { amount } = job.data;
    return this.commandBus.execute(new ProcessPaymentCommand(orderId, amount));
  }

  @JobHandler('ship')
  async handleShip(job: Job, orderId: string) {
    return this.commandBus.execute(new ShipOrderCommand(orderId));
  }

  // Wildcard handler for any unmatched job names
  @JobHandler('*')
  async handleOther(job: Job, orderId: string) {
    console.log(`Unknown job type: ${job.name} for order ${orderId}`);
  }
}
```

### 3. Create an Entity Scaler

Use `@EntityScaler` to define scaling logic with decorated methods:

```typescript
import { Injectable } from '@nestjs/common';
import { EntityScaler, GetActiveEntities, GetDesiredWorkerCount } from 'atomic-queues';

@EntityScaler({
  entityType: 'order',
  maxWorkersPerEntity: 1,
})
@Injectable()
export class OrderEntityScaler {
  constructor(private readonly orderRepository: OrderRepository) {}

  @GetActiveEntities()
  async getActiveOrders(): Promise<string[]> {
    // Return order IDs that have pending work
    return this.orderRepository.findPendingOrderIds();
  }

  @GetDesiredWorkerCount()
  async getWorkerCount(orderId: string): Promise<number> {
    // Each order gets exactly 1 worker
    return 1;
  }
}
```

### 4. Register in Your Module

```typescript
@Module({
  imports: [AtomicQueuesModule.forRootAsync({ ... })],
  providers: [
    OrderWorkerProcessor,  // Auto-discovered by @WorkerProcessor
    OrderEntityScaler,     // Auto-discovered by @EntityScaler
  ],
})
export class OrderModule {}
```

### 5. Queue Jobs

```typescript
import { Injectable } from '@nestjs/common';
import { QueueManagerService } from 'atomic-queues';

@Injectable()
export class OrderService {
  constructor(private readonly queueManager: QueueManagerService) {}

  async createOrder(orderId: string, items: any[], amount: number) {
    const queue = this.queueManager.getOrCreateQueue(`order-${orderId}-queue`);
    
    // Jobs are processed in order (FIFO) by the worker
    await queue.add('validate', { items });
    await queue.add('process-payment', { amount });
    await queue.add('ship', {});
    
    return orderId;
  }
}
```

That's it! The library will:
1. **Auto-discover** your `OrderWorkerProcessor` and `OrderEntityScaler`
2. **Create workers** for active jobs via `CronManagerService`
3. **Route jobs** to the correct `@JobHandler` method
4. **Clean up** workers when jobs are complete

---

## Decorators Reference

### @WorkerProcessor(options)

Class decorator that marks a service as a worker processor for an entity type.

```typescript
@WorkerProcessor({
  entityType: string;                              // Required: Entity type (e.g., 'order', 'user')
  queueName?: string | ((entityId: string) => string);   // Queue name or function
  workerName?: string | ((entityId: string) => string);  // Worker name or function
  workerConfig?: {
    concurrency?: number;       // Default: 1
    stalledInterval?: number;   // Default: 1000ms
    lockDuration?: number;      // Default: 30000ms
    heartbeatTTL?: number;      // Default: 3 seconds
    heartbeatInterval?: number; // Default: 1000ms
  };
})
```

### @JobHandler(jobName)

Method decorator that routes jobs with a specific name to this handler.

```typescript
@JobHandler('validate')           // Handles jobs named 'validate'
async handleValidate(job: Job, entityId: string) { ... }

@JobHandler('*')                  // Wildcard: handles any unmatched job
async handleOther(job: Job, entityId: string) { ... }
```

### @EntityScaler(options)

Class decorator for entity scaling configuration.

```typescript
@EntityScaler({
  entityType: string;           // Required: Entity type to scale
  maxWorkersPerEntity?: number; // Default: 1
})
```

### @GetActiveEntities()

Method decorator marking the method that returns active entity IDs.

```typescript
@GetActiveEntities()
async getActiveOrders(): Promise<string[]> {
  return ['order-1', 'order-2'];
}
```

### @GetDesiredWorkerCount()

Method decorator for desired worker count calculation.

```typescript
@GetDesiredWorkerCount()
async getWorkerCount(entityId: string): Promise<number> {
  return 1;
}
```

### @OnSpawnWorker() / @OnTerminateWorker()

Optional method decorators for custom spawn/terminate logic.

```typescript
@OnSpawnWorker()
async customSpawn(entityId: string): Promise<void> {
  console.log(`Spawning worker for ${entityId}`);
}

@OnTerminateWorker()
async customTerminate(entityId: string, workerId: string): Promise<void> {
  console.log(`Terminating worker ${workerId} for ${entityId}`);
}
```

---

## Migration Guide

### Migrating from Manual Registration to Decorators

**Before (Manual Registration):**

```typescript
// order-job.processor.ts (one file per job type)
@Injectable()
@JobProcessor('validate-order')
export class ValidateOrderProcessor {
  async process(job: Job) {
    // validation logic
  }
}

// order-worker.service.ts (manual worker creation)
@Injectable()
export class OrderWorkerService {
  constructor(
    private workerManager: WorkerManagerService,
    private jobRegistry: JobProcessorRegistry,
  ) {}

  async createOrderWorker(orderId: string) {
    await this.workerManager.createWorker({
      workerName: `order-${orderId}-worker`,
      queueName: `order-${orderId}-queue`,
      processor: async (job) => {
        const processor = this.jobRegistry.getProcessor(job.name);
        await processor.process(job);
      },
    });
  }
}

// app.module.ts (manual entity type registration)
cronManager.registerEntityType({
  entityType: 'order',
  getActiveEntityIds: async () => [...],
  getDesiredWorkerCount: async (id) => 1,
  onSpawnWorker: async (id) => orderWorkerService.createOrderWorker(id),
});
```

**After (Decorator-based):**

```typescript
// table-worker.processor.ts (single file with all handlers)
@WorkerProcessor({
  entityType: 'order',
  queueName: (id) => `order-${id}-queue`,
  workerName: (id) => `order-${id}-worker`,
})
@Injectable()
export class OrderWorkerProcessor {
  @JobHandler('validate-order')
  async handleValidate(job: Job, orderId: string) {
    // validation logic
  }
  
  @JobHandler('process-payment')
  async handlePayment(job: Job, orderId: string) {
    // payment logic
  }
}

// table-entity.scaler.ts (scaling config in one place)
@EntityScaler({ entityType: 'order', maxWorkersPerEntity: 1 })
@Injectable()
export class OrderEntityScaler {
  @GetActiveEntities()
  async getActiveOrders(): Promise<string[]> { return [...]; }
  
  @GetDesiredWorkerCount()
  async getWorkerCount(id: string): Promise<number> { return 1; }
}

// app.module.ts (just provide the classes, auto-discovery handles the rest)
@Module({
  providers: [OrderWorkerProcessor, OrderEntityScaler],
})
export class OrderModule {}
```

### Key Benefits of Migration

| Aspect | Manual API | Decorator API |
|--------|-----------|---------------|
| **Job routing** | Manual switch/case or registry lookup | Automatic via `@JobHandler` |
| **Worker creation** | Explicit service method | Auto-generated by library |
| **Scaling config** | Imperative `registerEntityType()` call | Declarative `@EntityScaler` class |
| **Entity ID access** | Manual parsing from job data | Injected as method parameter |
| **Code organization** | Multiple files and services | Single processor class per entity type |
| **Registration** | Manual in `onModuleInit` | Auto-discovered at startup |

---

## Architecture

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   atomic-queues ARCHITECTURE                                │
└─────────────────────────────────────────────────────────────────────────────────────────────┘

                                    ┌─────────────────────┐
                                    │   External Triggers │
                                    │  (WebSocket, HTTP,  │
                                    │   Cron, Pub/Sub)    │
                                    └──────────┬──────────┘
                                               │
                                               ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                      APPLICATION LAYER                                        │
│  ┌────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                              QueueManagerService                                        │  │
│  │                                                                                         │  │
│  │   queueManager.addJob(entityQueue, jobName, { entityId, action, payload })             │  │
│  │                                                                                         │  │
│  └────────────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                                               │
                                               ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                         REDIS (BullMQ)                                        │
│                                                                                               │
│   ┌───────────────┐    ┌───────────────┐    ┌───────────────┐    ┌───────────────┐          │
│   │  entity-A-q   │    │  entity-B-q   │    │  entity-C-q   │    │  entity-N-q   │          │
│   │               │    │               │    │               │    │               │          │
│   │  ┌─────────┐  │    │  ┌─────────┐  │    │  ┌─────────┐  │    │  ┌─────────┐  │          │
│   │  │  Job 1  │  │    │  │  Job 1  │  │    │  │  Job 1  │  │    │  │  Job 1  │  │          │
│   │  │  Job 2  │  │    │  │  Job 2  │  │    │  └─────────┘  │    │  │  Job 2  │  │          │
│   │  │  Job 3  │  │    │  └─────────┘  │    │               │    │  │  Job 3  │  │          │
│   │  │   ...   │  │    │               │    │               │    │  │   ...   │  │          │
│   │  └─────────┘  │    │               │    │               │    │  └─────────┘  │          │
│   └───────┬───────┘    └───────┬───────┘    └───────┬───────┘    └───────┬───────┘          │
│           │                    │                    │                    │                   │
└───────────┼────────────────────┼────────────────────┼────────────────────┼───────────────────┘
            │                    │                    │                    │
            ▼                    ▼                    ▼                    ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    WORKER LAYER (Per-Entity)                                  │
│                                                                                               │
│   ┌───────────────┐    ┌───────────────┐    ┌───────────────┐    ┌───────────────┐          │
│   │   Worker A    │    │   Worker B    │    │   Worker C    │    │   Worker N    │          │
│   │ concurrency=1 │    │ concurrency=1 │    │ concurrency=1 │    │ concurrency=1 │          │
│   │               │    │               │    │               │    │               │          │
│   │  ┌─────────┐  │    │  ┌─────────┐  │    │  ┌─────────┐  │    │  ┌─────────┐  │          │
│   │  │Heartbeat│  │    │  │Heartbeat│  │    │  │Heartbeat│  │    │  │Heartbeat│  │          │
│   │  │  TTL=3s │  │    │  │  TTL=3s │  │    │  │  TTL=3s │  │    │  │  TTL=3s │  │          │
│   │  └─────────┘  │    │  └─────────┘  │    │  └─────────┘  │    │  └─────────┘  │          │
│   └───────┬───────┘    └───────┬───────┘    └───────┬───────┘    └───────┬───────┘          │
│           │                    │                    │                    │                   │
│           │         WorkerManagerService (Lifecycle, Heartbeats, Shutdown Signals)          │
│           └────────────────────┴────────────────────┴────────────────────┘                   │
│                                          │                                                   │
└──────────────────────────────────────────┼───────────────────────────────────────────────────┘
                                           │
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   JOB PROCESSOR SERVICE                                       │
│                                                                                               │
│   ┌───────────────────────────────────────────────────────────────────────────────────────┐  │
│   │                           JobProcessorRegistry                                         │  │
│   │                                                                                        │  │
│   │   @JobProcessor('validate')    @JobProcessor('pay')       @JobProcessor('ship')       │  │
│   │   class ValidateProcessor {}   class PayProcessor {}      class ShipProcessor {}      │  │
│   │                                                                                        │  │
│   └───────────────────────────────────────────────────────────────────────────────────────┘  │
│                                           │                                                   │
│                                           ▼                                                   │
│   ┌───────────────────────────────────────────────────────────────────────────────────────┐  │
│   │                              CQRS CommandBus / QueryBus                                │  │
│   │                                                                                        │  │
│   │   commandBus.execute(new ValidateOrderCommand(...))                                   │  │
│   │   commandBus.execute(new ProcessPaymentCommand(...))                                  │  │
│   │                                                                                        │  │
│   └───────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                               │
└──────────────────────────────────────────────────────────────────────────────────────────────┘


┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  SUPPORTING SERVICES                                          │
│                                                                                               │
│   ┌─────────────────────────┐    ┌─────────────────────────┐    ┌─────────────────────────┐  │
│   │    CronManagerService   │    │   IndexManagerService   │    │  ResourceLockService    │  │
│   │                         │    │                         │    │                         │  │
│   │  • Poll for entities    │    │  • Track jobs per       │    │  • Lua-based atomic     │  │
│   │    needing workers      │    │    entity               │    │    locks                │  │
│   │  • Spawn workers on     │    │  • Track worker states  │    │  • Lock pooling         │  │
│   │    demand               │    │  • Track queue states   │    │  • TTL-based expiry     │  │
│   │  • Terminate idle       │    │  • Cleanup on entity    │    │  • Owner tracking       │  │
│   │    workers              │    │    completion           │    │                         │  │
│   │                         │    │                         │    │                         │  │
│   └─────────────────────────┘    └─────────────────────────┘    └─────────────────────────┘  │
│                                                                                               │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Component Interaction

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              COMPLETE JOB LIFECYCLE                                              │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

  1. JOB CREATION                    2. WORKER SPAWNING                   3. JOB PROCESSING
  ─────────────────                  ──────────────────                   ─────────────────

  ┌─────────────┐                    ┌─────────────────┐                  ┌─────────────────┐
  │   Service   │                    │  CronManager    │                  │     Worker      │
  │  (HTTP/WS)  │                    │    Service      │                  │   (BullMQ)      │
  └──────┬──────┘                    └────────┬────────┘                  └────────┬────────┘
         │                                    │                                    │
         │  1. Receive request                │  1. Every N seconds                │  1. Poll queue
         │     (create order, etc)            │     check entities                 │     for jobs
         ▼                                    │     with pending jobs              │
  ┌─────────────┐                             ▼                                    ▼
  │   Queue     │                    ┌─────────────────┐                  ┌─────────────────┐
  │  Manager    │                    │     Index       │                  │      Job        │
  │  Service    │                    │    Manager      │                  │   Processor     │
  └──────┬──────┘                    └────────┬────────┘                  │   Registry      │
         │                                    │                           └────────┬────────┘
         │  2. Get/create queue               │  2. Return entities                │
         │     for entity                     │     with job counts                │  2. Lookup processor
         ▼                                    │                                    │     by job name
  ┌─────────────┐                             ▼                                    ▼
  │   Redis     │                    ┌─────────────────┐                  ┌─────────────────┐
  │   Queue     │◄────────────────── │    Worker       │                  │   @JobProcessor │
  │ (entity-X)  │                    │    Manager      │                  │   Handler Class │
  └──────┬──────┘                    └────────┬────────┘                  └────────┬────────┘
         │                                    │                                    │
         │  3. Add job to queue               │  3. Spawn worker                   │  3. Execute
         │     (FIFO ordered)                 │     for entity                     │     command/query
         ▼                                    │                                    ▼
  ┌─────────────┐                             ▼                           ┌─────────────────┐
  │   Index     │                    ┌─────────────────┐                  │   CommandBus    │
  │  Manager    │                    │   New Worker    │                  │   / QueryBus    │
  └─────────────┘                    │  (concurrency=1)│                  └────────┬────────┘
         │                           └─────────────────┘                           │
         │  4. Track job in index                                                  │  4. Domain
         │     for entity                                                          │     logic
         ▼                                                                         ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │                                       REDIS                                          │
  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │
  │   │   Queues    │  │   Workers   │  │   Indices   │  │    Locks    │                │
  │   │  (BullMQ)   │  │ (Heartbeat) │  │  (Jobs/Qs)  │  │  (Lua Atom) │                │
  │   └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘                │
  └─────────────────────────────────────────────────────────────────────────────────────┘


  4. JOB COMPLETION                  5. WORKER TERMINATION               6. GRACEFUL SHUTDOWN
  ─────────────────                  ─────────────────────               ────────────────────

  ┌─────────────────┐                ┌─────────────────┐                 ┌─────────────────┐
  │     Worker      │                │   CronManager   │                 │   SIGTERM/INT   │
  │   completes     │                │    Service      │                 │     Signal      │
  └────────┬────────┘                └────────┬────────┘                 └────────┬────────┘
           │                                  │                                   │
           │  1. Job finished                 │  1. Check worker                  │  1. Caught by
           │                                  │     idle time                     │     process handler
           ▼                                  │                                   ▼
  ┌─────────────────┐                         ▼                          ┌─────────────────┐
  │     Index       │                ┌─────────────────┐                 │   Worker        │
  │    Manager      │                │  No pending     │                 │   Manager       │
  └────────┬────────┘                │  jobs for       │                 └────────┬────────┘
           │                         │  entity?        │                          │
           │  2. Remove job from     └────────┬────────┘                          │  2. Signal all
           │     entity index                 │                                   │     workers to close
           ▼                                  │  YES                              ▼
  ┌─────────────────┐                         ▼                          ┌─────────────────┐
  │  Check pending  │                ┌─────────────────┐                 │   Redis         │
  │  jobs for       │                │    Worker       │                 │   Pub/Sub       │
  │  entity         │                │    Manager      │                 │   (shutdown     │
  └────────┬────────┘                └────────┬────────┘                 │    channel)     │
           │                                  │                          └────────┬────────┘
           │  3. If no pending               │  2. Signal worker                  │
           │     jobs, cleanup               │     to close                       │  3. Workers receive
           ▼                                  ▼                                   │     shutdown signal
  ┌─────────────────┐                ┌─────────────────┐                          ▼
  │  Entity indices │                │   Worker        │                 ┌─────────────────┐
  │  cleaned up     │                │   gracefully    │                 │   Workers       │
  │                 │                │   closes        │                 │   finish        │
  └─────────────────┘                └─────────────────┘                 │   current job   │
                                                                         │   then exit     │
                                                                         └─────────────────┘
```

### Multi-Node Cluster Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              MULTI-NODE CLUSTER DEPLOYMENT                                       │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

                                    ┌─────────────────┐
                                    │   Load Balancer │
                                    └────────┬────────┘
                                             │
              ┌──────────────────────────────┼──────────────────────────────┐
              │                              │                              │
              ▼                              ▼                              ▼
    ┌─────────────────┐            ┌─────────────────┐            ┌─────────────────┐
    │     Node 1      │            │     Node 2      │            │     Node 3      │
    │   (PM2 Cluster) │            │   (PM2 Cluster) │            │   (K8s Pod)     │
    ├─────────────────┤            ├─────────────────┤            ├─────────────────┤
    │                 │            │                 │            │                 │
    │  ┌───────────┐  │            │  ┌───────────┐  │            │  ┌───────────┐  │
    │  │ Worker A  │  │            │  │ Worker C  │  │            │  │ Worker E  │  │
    │  │(Entity 1) │  │            │  │(Entity 3) │  │            │  │(Entity 5) │  │
    │  └───────────┘  │            │  └───────────┘  │            │  └───────────┘  │
    │                 │            │                 │            │                 │
    │  ┌───────────┐  │            │  ┌───────────┐  │            │  ┌───────────┐  │
    │  │ Worker B  │  │            │  │ Worker D  │  │            │  │ Worker F  │  │
    │  │(Entity 2) │  │            │  │(Entity 4) │  │            │  │(Entity 6) │  │
    │  └───────────┘  │            │  └───────────┘  │            │  └───────────┘  │
    │                 │            │                 │            │                 │
    └────────┬────────┘            └────────┬────────┘            └────────┬────────┘
             │                              │                              │
             └──────────────────────────────┼──────────────────────────────┘
                                            │
                                            ▼
    ┌─────────────────────────────────────────────────────────────────────────────────┐
    │                                  REDIS CLUSTER                                   │
    │                                                                                  │
    │   ┌─────────────────────────────────────────────────────────────────────────┐   │
    │   │                           BullMQ Queues                                  │   │
    │   │   entity-1-queue │ entity-2-queue │ entity-3-queue │ ... │ entity-N-q   │   │
    │   └─────────────────────────────────────────────────────────────────────────┘   │
    │                                                                                  │
    │   ┌─────────────────────────────────────────────────────────────────────────┐   │
    │   │                        Worker Heartbeats (TTL)                           │   │
    │   │   aq:workers:entity-1-worker │ aq:workers:entity-2-worker │ ...         │   │
    │   └─────────────────────────────────────────────────────────────────────────┘   │
    │                                                                                  │
    │   ┌─────────────────────────────────────────────────────────────────────────┐   │
    │   │                         Job/Entity Indices                               │   │
    │   │   aq:idx:entity:jobs │ aq:idx:entity:queues │ aq:idx:entity:workers     │   │
    │   └─────────────────────────────────────────────────────────────────────────┘   │
    │                                                                                  │
    │   ┌─────────────────────────────────────────────────────────────────────────┐   │
    │   │                       Pub/Sub Shutdown Channels                          │   │
    │   │   aq:worker:entity-1-worker:shutdown │ aq:worker:entity-2-worker:shut   │   │
    │   └─────────────────────────────────────────────────────────────────────────┘   │
    │                                                                                  │
    └─────────────────────────────────────────────────────────────────────────────────┘


    KEY GUARANTEES:
    ───────────────
    ✓ Only ONE worker processes jobs for each entity (concurrency=1)
    ✓ Jobs for same entity are processed in FIFO order
    ✓ Worker heartbeats detected across all nodes
    ✓ Graceful shutdown via Redis pub/sub (not local signals)
    ✓ Any node can spawn workers for any entity
    ✓ Dead workers detected via TTL expiration
```

---

## Manual API (Legacy)

The manual API is still available for advanced use cases or gradual migration. **For most use cases, prefer the decorator-based API above.**

### 1. Module Configuration

```typescript
import { Module } from '@nestjs/common';
import { AtomicQueuesModule } from 'atomic-queues';

@Module({
  imports: [
    AtomicQueuesModule.forRoot({
      redis: {
        host: 'localhost',
        port: 6379,
      },
      enableCronManager: true,
      cronInterval: 5000,
      keyPrefix: 'myapp',
    }),
  ],
})
export class AppModule {}
```

### 2. Register Job Processors Manually

```typescript
import { Injectable } from '@nestjs/common';
import { JobProcessor, JobProcessorRegistry } from 'atomic-queues';
import { CommandBus } from '@nestjs/cqrs';

@Injectable()
@JobProcessor('validate-order')
export class ValidateOrderProcessor {
  constructor(private readonly commandBus: CommandBus) {}

  async process(job: Job) {
    const { orderId, items } = job.data;
    await this.commandBus.execute(new ValidateOrderCommand(orderId, items));
  }
}
```

### 3. Queue Jobs Manually

```typescript
import { Injectable } from '@nestjs/common';
import { QueueManagerService, IndexManagerService } from 'atomic-queues';

@Injectable()
export class OrderService {
  constructor(
    private readonly queueManager: QueueManagerService,
    private readonly indexManager: IndexManagerService,
  ) {}

  async createOrder(orderId: string, items: any[], amount: number) {
    const queue = this.queueManager.getOrCreateEntityQueue('order', orderId);
    
    // Queue validation job
    const job = await this.queueManager.addJob(queue.name, 'validate-order', { orderId, items });
    
    // Queue payment job (will run after validation completes due to FIFO)
    await this.queueManager.addJob(queue.name, 'process-payment', { orderId, amount });
    
    // Track job for scaling decisions
    await this.indexManager.indexJob('order', orderId, job.id!);
    
    return orderId;
  }
}
```

### 4. Create Workers Manually

```typescript
import { Injectable } from '@nestjs/common';
import { WorkerManagerService, JobProcessorRegistry } from 'atomic-queues';

@Injectable()
export class OrderWorkerService {
  constructor(
    private readonly workerManager: WorkerManagerService,
    private readonly jobRegistry: JobProcessorRegistry,
  ) {}

  async createOrderWorker(orderId: string) {
    const queueName = `order-${orderId}-queue`;

    await this.workerManager.createWorker({
      workerName: `${orderId}-worker`,
      queueName,
      processor: async (job) => {
        const processor = this.jobRegistry.getProcessor(job.name);
        if (!processor) {
          throw new Error(`No processor for job: ${job.name}`);
        }
        await processor.process(job);
      },
      events: {
        onReady: async (worker, name) => {
          console.log(`Worker ${name} is ready`);
        },
        onCompleted: async (job, name) => {
          console.log(`Job ${job.id} completed by ${name}`);
        },
        onFailed: async (job, error, name) => {
          console.error(`Job ${job?.id} failed in ${name}:`, error.message);
        },
      },
    });
  }
}
```

---

## Core Services

### QueueManagerService

Manages dynamic queue creation and destruction per entity.

```typescript
// Get or create a queue for an entity
const queue = queueManager.getOrCreateEntityQueue('order', '123');

// Add a job to a queue
await queueManager.addJob(queue.name, 'process', { data: 'hello' });

// Get job counts
const counts = await queueManager.getJobCounts(queue.name);

// Close a queue
await queueManager.closeQueue(queue.name);
```

### WorkerManagerService

Manages worker lifecycle with heartbeat-based liveness tracking.

```typescript
// Create a worker
await workerManager.createWorker({
  workerName: 'my-worker',
  queueName: 'my-queue',
  processor: async (job) => { /* process job */ },
  config: {
    concurrency: 1,
    heartbeatTTL: 3,
  },
});

// Check if worker exists
const exists = await workerManager.workerExists('my-worker');

// Signal worker to close via Redis pub/sub
await workerManager.signalWorkerClose('my-worker');

// Get all workers for an entity
const workers = await workerManager.getEntityWorkers('order', '123');
```

### ResourceLockService

Provides distributed resource locking using Redis Lua scripts.

```typescript
// Acquire a lock
const result = await lockService.acquireLock(
  'resource',          // resourceType
  'resource-123',      // resourceId
  'owner-456',         // ownerId
  'service',           // ownerType
  60,                  // TTL in seconds
);

if (result.acquired) {
  try {
    // Do work with the locked resource
  } finally {
    await lockService.releaseLock('resource', 'resource-123');
  }
}

// Get first available resource from a pool
const available = await lockService.getAvailableResource(
  'resource',
  ['res-1', 'res-2', 'res-3'],
  'owner-456',
  'service',
);
```

### CronManagerService

Automatic worker scaling based on demand.

**Recommended: Use `@EntityScaler` decorator (see Quick Start section above)**

The decorator-based approach is preferred as it's cleaner and auto-discovered:

```typescript
@EntityScaler({ entityType: 'order', maxWorkersPerEntity: 1 })
@Injectable()
export class OrderEntityScaler {
  @GetActiveEntities()
  async getActiveOrders(): Promise<string[]> { ... }
  
  @GetDesiredWorkerCount()
  async getWorkerCount(orderId: string): Promise<number> { return 1; }
}
```

**Legacy API (Manual Registration):**

```typescript
// Register entity type for automatic scaling
cronManager.registerEntityType({
  entityType: 'order',
  getDesiredWorkerCount: async (orderId) => {
    // Return how many workers this entity needs
    return 1;
  },
  getActiveEntityIds: async () => {
    return Object.keys(await indexManager.getEntitiesWithJobs('order'));
  },
  maxWorkersPerEntity: 5,
  onSpawnWorker: async (orderId) => {
    await orderWorkerService.createOrderWorker(orderId);
  },
});

// Start the cron manager
cronManager.start(5000);
```

### IndexManagerService

Track jobs, workers, and queue states.

```typescript
// Index a job
await indexManager.indexJob('order', '123', 'job-456');

// Get all entities with pending jobs
const entitiesWithJobs = await indexManager.getEntitiesWithJobs('order');
// Returns: { '123': 5, '456': 2 } (entityId: jobCount)

// Track queue existence
await indexManager.indexEntityQueue('order', '123');

// Clean up all indices for an entity
await indexManager.cleanupEntityIndices('order', '123');
```

---

## Configuration Options

```typescript
interface IAtomicQueuesModuleConfig {
  // Redis connection
  redis: {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    url?: string;
    maxRetriesPerRequest?: number | null;
  };

  // Worker defaults
  workerDefaults?: {
    concurrency?: number;        // Default: 1
    stalledInterval?: number;    // Default: 1000ms
    lockDuration?: number;       // Default: 30000ms
    maxStalledCount?: number;    // Default: MAX_SAFE_INTEGER
    heartbeatTTL?: number;       // Default: 3 seconds
    heartbeatInterval?: number;  // Default: 1000ms
  };

  // Queue defaults
  queueDefaults?: {
    defaultJobOptions?: {
      removeOnComplete?: boolean;
      removeOnFail?: boolean;
      attempts?: number;
      backoff?: { type: 'fixed' | 'exponential'; delay: number };
      priority?: number;
    };
  };

  // Cron manager
  enableCronManager?: boolean;  // Default: false
  cronInterval?: number;        // Default: 5000ms

  // Key prefix for Redis keys
  keyPrefix?: string;           // Default: 'aq'
}
```

---

## Graceful Shutdown

The library handles graceful shutdown automatically via Redis pub/sub:

1. On `SIGTERM`/`SIGINT`, the node publishes shutdown signals to Redis
2. All workers (even on other nodes) subscribed to shutdown channels receive the signal
3. Workers finish their current job (with configurable timeout)
4. Heartbeat TTLs expire, marking workers as dead
5. Resources are cleaned up

```typescript
// Manual shutdown
await workerManager.signalNodeWorkersClose();
await workerManager.waitForWorkersToClose(30000);
```

---

## Use Cases

### 1. Per-Order Processing (E-commerce)
Each order has its own queue ensuring stages (validate → pay → ship) happen sequentially.

### 2. Per-User Message Queues (Chat/Messaging)
Each user has their own queue for message delivery, ensuring order.

### 3. Per-Tenant Job Processing (SaaS)
Each tenant's jobs are isolated and processed sequentially.

### 4. Per-Document Processing (Document Management)
Each document goes through OCR → validation → storage in sequence.

### 5. Per-Device Commands (IoT)
Each device receives commands in order, preventing race conditions.

---

## License

MIT
