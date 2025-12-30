# @nestjs/atomic-queues

A plug-and-play NestJS library for atomic process handling per entity with BullMQ, Redis distributed locking, and dynamic worker management.

## Overview

`@nestjs/atomic-queues` provides a unified architecture for handling atomic, sequential processing of jobs on a per-entity basis. It abstracts the complexity of managing dynamic queues, workers, and distributed locking into a simple, declarative API.

### Problem It Solves

In distributed systems, you often need to:
- Process jobs **sequentially** for a specific entity (user, order, session)
- **Dynamically spawn workers** based on load
- **Prevent race conditions** when multiple services handle the same entity
- **Scale horizontally** while maintaining per-entity ordering guarantees

This library solves all of these with a single, cohesive module.

---

## Example Scenario: Order Processing System

Imagine an e-commerce platform where each customer can place multiple orders. Each order goes through several stages: validation, payment, inventory reservation, and shipping. These stages **must happen in sequence** for each order, but different orders can be processed in parallel.

```
Customer A places Order 1 → [validate] → [pay] → [reserve] → [ship]
Customer A places Order 2 → [validate] → [pay] → [reserve] → [ship]
Customer B places Order 3 → [validate] → [pay] → [reserve] → [ship]
```

**Without atomic queues**: Race conditions, duplicate payments, inventory overselling.
**With atomic queues**: Each order gets its own queue and worker, ensuring sequential processing.

---

## Architecture

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                @nestjs/atomic-queues ARCHITECTURE                           │
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

## Features

- **Dynamic Per-Entity Queues**: Automatically create and manage queues for each entity (user, order, session, etc.)
- **Worker Lifecycle Management**: Heartbeat-based worker tracking with TTL expiration
- **Distributed Resource Locking**: Atomic lock acquisition using Lua scripts
- **Graceful Shutdown**: Coordinated shutdown via Redis pub/sub across cluster nodes
- **Cron-based Scaling**: Automatic worker spawning and termination based on demand
- **Job Processor Registry**: Decorator-based job handler registration
- **Index Tracking**: Track jobs, workers, and queue states across entities

---

## Installation

```bash
npm install @nestjs/atomic-queues bullmq ioredis
```

---

## Quick Start

### 1. Import the Module

```typescript
import { Module } from '@nestjs/common';
import { AtomicQueuesModule } from '@nestjs/atomic-queues';

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

### 2. Async Configuration

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AtomicQueuesModule } from '@nestjs/atomic-queues';

@Module({
  imports: [
    AtomicQueuesModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        redis: {
          url: configService.get('REDIS_URL'),
        },
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

### 3. Register Job Processors

```typescript
import { Injectable } from '@nestjs/common';
import { JobProcessor, JobProcessorRegistry } from '@nestjs/atomic-queues';
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

@Injectable()
@JobProcessor('process-payment')
export class ProcessPaymentProcessor {
  constructor(private readonly commandBus: CommandBus) {}

  async process(job: Job) {
    const { orderId, amount } = job.data;
    await this.commandBus.execute(new ProcessPaymentCommand(orderId, amount));
  }
}
```

### 4. Queue Jobs

```typescript
import { Injectable } from '@nestjs/common';
import { QueueManagerService, IndexManagerService } from '@nestjs/atomic-queues';

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

### 5. Create Workers

```typescript
import { Injectable } from '@nestjs/common';
import { WorkerManagerService, JobProcessorRegistry } from '@nestjs/atomic-queues';

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
