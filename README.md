# AtomicQueues

A plug-and-play NestJS library for atomic process handling per entity with BullMQ, Redis distributed locking, and dynamic worker management.

## Overview

AtomicQueues is a library that abstracts and unifies queue architectures for atomic per-entity processing:

1. **User-based processing** - Atomic message queue processing with dynamic worker spawning
2. **Session-based processing** - Atomic action processing with dedicated workers

### Key Architectural Patterns

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ATOMIC QUEUES ARCHITECTURE                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │
│  │   Entity 1   │    │   Entity 2   │    │   Entity N   │          │
│  │   (User A)   │    │   (User B)   │    │  (Session X) │          │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘          │
│         │                    │                    │                  │
│         ▼                    ▼                    ▼                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │
│  │  Queue A     │    │  Queue B     │    │  Queue X     │          │
│  │ (Per-Entity) │    │ (Per-Entity) │    │ (Per-Entity) │          │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘          │
│         │                    │                    │                  │
│         ▼                    ▼                    ▼                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │
│  │  Worker A    │    │  Worker B    │    │  Worker X    │          │
│  │ concurrency=1│    │ concurrency=1│    │ concurrency=1│          │
│  └──────────────┘    └──────────────┘    └──────────────┘          │
│         │                    │                    │                  │
│         └────────────────────┼────────────────────┘                  │
│                              │                                       │
│                              ▼                                       │
│                    ┌──────────────────┐                              │
│                    │   Cron Manager   │                              │
│                    │ (Spawn/Terminate)│                              │
│                    └──────────────────┘                              │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Features

- **Dynamic Per-Entity Queues**: Automatically create and manage queues for each entity (user, session, etc.)
- **Worker Lifecycle Management**: Heartbeat-based worker tracking with TTL expiration
- **Distributed Resource Locking**: Atomic lock acquisition using Lua scripts
- **Graceful Shutdown**: Coordinated shutdown via Redis pub/sub
- **Cron-based Scaling**: Automatic worker spawning and termination based on demand
- **CQRS Integration**: Dynamic command/query execution by class name
- **Index Tracking**: Track jobs, workers, and queue states across entities

## Installation

```bash
npm install @atomicqueues/core bullmq ioredis
```

## Quick Start

### 1. Import the Module

```typescript
import { Module } from '@nestjs/common';
import { AtomicQueuesModule } from '@atomicqueues/core';

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
import { AtomicQueuesModule } from '@atomicqueues/core';

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

### 3. Use the Services

```typescript
import { Injectable } from '@nestjs/common';
import {
  QueueManagerService,
  WorkerManagerService,
  IndexManagerService,
  createAtomicJobData,
} from '@atomicqueues/core';

@Injectable()
export class MessageService {
  constructor(
    private readonly queueManager: QueueManagerService,
    private readonly workerManager: WorkerManagerService,
    private readonly indexManager: IndexManagerService,
  ) {}

  async queueMessage(userId: string, message: string) {
    // Get or create user's queue
    const queue = this.queueManager.getOrCreateEntityQueue('user', userId);

    // Create atomic job data
    const jobData = createAtomicJobData({
      entityType: 'user',
      entityId: userId,
      type: 'command',
      commandName: 'SendMessageCommand',
      payload: { message },
    });

    // Add job to queue
    const job = await this.queueManager.addJob(queue.name, 'send-message', jobData);

    // Index the job for tracking
    await this.indexManager.indexJob('user', userId, job.id!);

    return job.id;
  }

  async createUserWorker(userId: string) {
    const queueName = this.queueManager.getOrCreateEntityQueue('user', userId).name;

    await this.workerManager.createWorker({
      workerName: `user-${userId}-worker`,
      queueName,
      processor: async (job) => {
        // Process the job
        console.log(`Processing job for user ${userId}:`, job.data);
        
        // Clean up job index on completion
        await this.indexManager.removeJobIndex('user', userId, job.id!);
      },
      events: {
        onReady: async (worker, name) => {
          console.log(`Worker ${name} is ready`);
        },
        onCompleted: async (job, name) => {
          console.log(`Job ${job.id} completed by ${name}`);
        },
      },
    });
  }
}
```

## Core Services

### QueueManagerService

Manages dynamic queue creation and destruction per entity.

```typescript
// Get or create a queue
const queue = queueManager.getOrCreateEntityQueue('user', '123');

// Add a job
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
  processor: async (job) => {
    // Process job
  },
  config: {
    concurrency: 1,
    heartbeatTTL: 3,
  },
});

// Check if worker exists
const exists = await workerManager.workerExists('my-worker');

// Signal worker to close
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
  // Do work with the locked resource
  await lockService.releaseLock('context', 'context-123');
}

// Get first available resource from pool
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

// Get all entities with jobs
const entitiesWithJobs = await indexManager.getEntitiesWithJobs('user');
// Returns: { '123': 5, '456': 2 } (entityId: jobCount)

// Track queue existence
await indexManager.indexEntityQueue('user', '123');

// Clean up all indices for an entity
await indexManager.cleanupEntityIndices('user', '123');
```

## Usage Patterns

### Pattern 1: User Message Queue with Resource Locking

```typescript
@Injectable()
export class UserMessageService {
  constructor(
    private readonly queueManager: QueueManagerService,
    private readonly workerManager: WorkerManagerService,
    private readonly lockService: ResourceLockService,
    private readonly indexManager: IndexManagerService,
  ) {}

  async sendMessage(userId: string, recipient: string, message: string) {
    // Queue the message
    const queueName = `user-${userId}-msgq`;
    const queue = this.queueManager.getOrCreateQueue(queueName);
    
    const job = await queue.add('send-message', {
      type: 'send-message',
      userId,
      recipient,
      message,
    });

    // Index for tracking
    await this.indexManager.indexJob('user', userId, job.id!);
    await this.indexManager.indexEntityQueue('user', userId);
  }

  async processMessage(job: Job) {
    const { userId, recipient, message } = job.data;

    // Acquire a resource lock (e.g., for rate limiting or connection pooling)
    const lock = await this.lockService.getAvailableResource(
      'connection',
      await this.getAvailableConnectionIds(userId),
      userId,
      'user',
    );

    if (!lock.acquired) {
      throw new Error('No available connection');
    }

    try {
      // Send the message using the locked resource
      await this.sendMessageViaConnection(lock.lock!.resourceId, recipient, message);
    } finally {
      // Release the lock
      await this.lockService.releaseLock('connection', lock.lock!.resourceId);
    }
  }
}
```

### Pattern 2: Dynamic CQRS Execution

```typescript
@Injectable()
export class AtomicCommandService {
  constructor(
    private readonly queueManager: QueueManagerService,
    private readonly jobProcessor: AtomicJobProcessor,
  ) {
    // Register command classes for dynamic execution
    jobProcessor.registerCommands({
      SendMessageCommand,
      ProcessOrderCommand,
      UpdateStatusCommand,
    });
  }

  async queueAtomicCommand<T>(
    entityType: string,
    entityId: string,
    commandName: string,
    payload: T,
  ) {
    const queue = this.queueManager.getOrCreateEntityQueue(entityType, entityId);
    
    const jobData = createAtomicJobData({
      entityType,
      entityId,
      type: 'command',
      commandName,
      payload,
    });

    return this.queueManager.addJob(queue.name, commandName, jobData);
  }
}
```

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

## Graceful Shutdown

The library handles graceful shutdown automatically:

1. On `SIGTERM`/`SIGINT`, all workers on the node are signaled to close
2. Workers finish their current job (with timeout)
3. Heartbeat TTLs expire, marking workers as dead
4. Resources are cleaned up

```typescript
// Manual shutdown
await workerManager.signalNodeWorkersClose();
await workerManager.waitForWorkersToClose(30000);
```

## License

MIT
