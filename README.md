# @nestjs/atomic-queues

A plug-and-play NestJS library for atomic process handling per entity with BullMQ, Redis distributed locking, and dynamic worker management.

## Overview

`@nestjs/atomic-queues` provides a unified architecture for handling atomic, sequential processing of jobs on a per-entity basis. It abstracts the complexity of managing dynamic queues, workers, and distributed locking into a simple, declarative API.

### Problem It Solves

In distributed systems, you often need to:
- Process jobs **sequentially** for a specific entity (user, table, session)
- **Dynamically spawn workers** based on load
- **Prevent race conditions** when multiple services handle the same entity
- **Scale horizontally** while maintaining per-entity ordering guarantees

This library solves all of these with a single, cohesive module.

---

## Architecture

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                @nestjs/atomic-queues ARCHITECTURE                           │
└─────────────────────────────────────────────────────────────────────────────────────────────┘

                                    ┌─────────────────────┐
                                    │   External Events   │
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
│  │   queueManager.addJob(entityQueue, jobName, { entityId, command, payload })            │  │
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
│   │  │   ...   │  │    │               │    │               │    │  │  Job 4  │  │          │
│   │  └─────────┘  │    │               │    │               │    │  │   ...   │  │          │
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
│   │   @JobProcessor('make-bet')      @JobProcessor('deal')      @JobProcessor('end-game') │  │
│   │   class MakeBetProcessor {}      class DealProcessor {}     class EndGameProcessor {} │  │
│   │                                                                                        │  │
│   └───────────────────────────────────────────────────────────────────────────────────────┘  │
│                                           │                                                   │
│                                           ▼                                                   │
│   ┌───────────────────────────────────────────────────────────────────────────────────────┐  │
│   │                              CQRS CommandBus / QueryBus                                │  │
│   │                                                                                        │  │
│   │   commandBus.execute(new MakeBetCommand(...))                                         │  │
│   │   queryBus.execute(new GetTableStatusQuery(...))                                      │  │
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
  │   Gateway   │                    │  CronManager    │                  │     Worker      │
  │  (WS/HTTP)  │                    │    Service      │                  │   (BullMQ)      │
  └──────┬──────┘                    └────────┬────────┘                  └────────┬────────┘
         │                                    │                                    │
         │  1. Receive event                  │  1. Every N seconds                │  1. Poll queue
         │     (bet, decision, etc)           │     check entities                 │     for jobs
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
                                    │   (WebSocket    │
                                    │   sticky sess)  │
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
    │  │ (User 1)  │  │            │  │ (User 3)  │  │            │  │ (User 5)  │  │
    │  └───────────┘  │            │  └───────────┘  │            │  └───────────┘  │
    │                 │            │                 │            │                 │
    │  ┌───────────┐  │            │  ┌───────────┐  │            │  ┌───────────┐  │
    │  │ Worker B  │  │            │  │ Worker D  │  │            │  │ Worker F  │  │
    │  │ (User 2)  │  │            │  │ (User 4)  │  │            │  │ (User 6)  │  │
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
    │   │   user-1-queue │ user-2-queue │ user-3-queue │ ... │ user-N-queue       │   │
    │   └─────────────────────────────────────────────────────────────────────────┘   │
    │                                                                                  │
    │   ┌─────────────────────────────────────────────────────────────────────────┐   │
    │   │                        Worker Heartbeats (TTL)                           │   │
    │   │   aq:workers:user-1-worker │ aq:workers:user-2-worker │ ...             │   │
    │   └─────────────────────────────────────────────────────────────────────────┘   │
    │                                                                                  │
    │   ┌─────────────────────────────────────────────────────────────────────────┐   │
    │   │                         Job/Entity Indices                               │   │
    │   │   aq:idx:user:jobs │ aq:idx:user:queues │ aq:idx:user:workers           │   │
    │   └─────────────────────────────────────────────────────────────────────────┘   │
    │                                                                                  │
    │   ┌─────────────────────────────────────────────────────────────────────────┐   │
    │   │                       Pub/Sub Shutdown Channels                          │   │
    │   │   aq:worker:user-1-worker:shutdown │ aq:worker:user-2-worker:shutdown   │   │
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

- **Dynamic Per-Entity Queues**: Automatically create and manage queues for each entity (user, table, session, etc.)
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
@JobProcessor('make-bet')
export class MakeBetProcessor {
  constructor(private readonly commandBus: CommandBus) {}

  async process(job: Job) {
    const { tableId, playerId, bets } = job.data;
    await this.commandBus.execute(new MakeBetCommand(tableId, playerId, bets));
  }
}

@Injectable()
@JobProcessor('deal')
export class DealProcessor {
  constructor(private readonly commandBus: CommandBus) {}

  async process(job: Job) {
    const { tableId } = job.data;
    await this.commandBus.execute(new DealCommand(tableId));
  }
}
```

### 4. Queue Jobs

```typescript
import { Injectable } from '@nestjs/common';
import { QueueManagerService, IndexManagerService } from '@nestjs/atomic-queues';

@Injectable()
export class TableService {
  constructor(
    private readonly queueManager: QueueManagerService,
    private readonly indexManager: IndexManagerService,
  ) {}

  async queueBet(tableId: string, playerId: string, bets: any[]) {
    const queue = this.queueManager.getOrCreateEntityQueue('table', tableId);
    
    const job = await this.queueManager.addJob(queue.name, 'make-bet', {
      tableId,
      playerId,
      bets,
    });

    await this.indexManager.indexJob('table', tableId, job.id!);
    return job.id;
  }
}
```

### 5. Create Workers

```typescript
import { Injectable } from '@nestjs/common';
import { WorkerManagerService, JobProcessorRegistry } from '@nestjs/atomic-queues';

@Injectable()
export class TableWorkerService {
  constructor(
    private readonly workerManager: WorkerManagerService,
    private readonly jobRegistry: JobProcessorRegistry,
  ) {}

  async createTableWorker(tableId: string) {
    const queueName = `table-${tableId}-queue`;

    await this.workerManager.createWorker({
      workerName: `${tableId}-worker`,
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
const queue = queueManager.getOrCreateEntityQueue('user', '123');

// Add a job to a queue
await queueManager.addJob(queue.name, 'process-message', { data: 'hello' });

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
const workers = await workerManager.getEntityWorkers('user', '123');
```

### ResourceLockService

Provides distributed resource locking using Redis Lua scripts.

```typescript
// Acquire a lock
const result = await lockService.acquireLock(
  'context',           // resourceType
  'context-123',       // resourceId
  'user-456',          // ownerId
  'user',              // ownerType
  60,                  // TTL in seconds
);

if (result.acquired) {
  try {
    // Do work with the locked resource
  } finally {
    await lockService.releaseLock('context', 'context-123');
  }
}

// Get first available resource from a pool
const available = await lockService.getAvailableResource(
  'context',
  ['ctx-1', 'ctx-2', 'ctx-3'],
  'user-456',
  'user',
);
```

### CronManagerService

Automatic worker scaling based on demand.

```typescript
// Register entity type for automatic scaling
cronManager.registerEntityType({
  entityType: 'user',
  getDesiredWorkerCount: async (userId) => {
    const plan = await getUserPlan(userId);
    return planConcurrencyMap[plan];
  },
  getActiveEntityIds: async () => {
    return Object.keys(await indexManager.getEntitiesWithJobs('user'));
  },
  maxWorkersPerEntity: 5,
  onSpawnWorker: async (userId) => {
    await messageService.createUserWorker(userId);
  },
});

// Start the cron manager
cronManager.start(5000);
```

### IndexManagerService

Track jobs, workers, and queue states.

```typescript
// Index a job
await indexManager.indexJob('user', '123', 'job-456');

// Get all entities with pending jobs
const entitiesWithJobs = await indexManager.getEntitiesWithJobs('user');
// Returns: { '123': 5, '456': 2 } (entityId: jobCount)

// Track queue existence
await indexManager.indexEntityQueue('user', '123');

// Clean up all indices for an entity
await indexManager.cleanupEntityIndices('user', '123');
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

### 1. Per-User Message Queues (Chat/WhatsApp Style)
Each user has their own queue ensuring messages are processed in order.

### 2. Per-Table Game Processing (Casino/Gaming)
Each game table has a dedicated worker ensuring game actions are atomic.

### 3. Per-Tenant Job Processing (SaaS)
Each tenant's jobs are isolated and processed sequentially.

### 4. Per-Session State Machines
Each session maintains ordered state transitions.

---

## License

MIT
