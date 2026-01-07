# atomic-queues

A NestJS library for atomic, sequential job processing per entity with BullMQ and Redis.

## What It Does

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              THE PROBLEM                                       ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                                ║
║   Multiple requests for the same entity arrive simultaneously:                 ║
║                                                                                ║
║        ┌──────────┐                                                            ║
║        │ Request A │──┐                                                        ║
║        └──────────┘  │                                                         ║
║        ┌──────────┐  │    ┌─────────────┐                                      ║
║        │ Request B │──┼───▶│  Entity 123 │───▶  💥 RACE CONDITION!             ║
║        └──────────┘  │    └─────────────┘                                      ║
║        ┌──────────┐  │                                                         ║
║        │ Request C │──┘                                                        ║
║        └──────────┘                                                            ║
║                                                                                ║
╚═══════════════════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════════════════════════════════════════════════╗
║                              THE SOLUTION                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                                ║
║   atomic-queues ensures sequential processing per entity:                      ║
║                                                                                ║
║        ┌──────────┐      ┌─────────────────┐      ┌──────────┐                 ║
║        │ Request A │──┐   │                 │      │          │                 ║
║        └──────────┘  │   │   Redis Queue   │      │  Worker  │  ┌───────────┐  ║
║        ┌──────────┐  │   │   ┌───┬───┬───┐ │      │          │  │           │  ║
║        │ Request B │──┼──▶│   │ A │ B │ C │ │─────▶│  (1 job  │─▶│Entity 123 │  ║
║        └──────────┘  │   │   └───┴───┴───┘ │      │ at a time│  │           │  ║
║        ┌──────────┐  │   │                 │      │          │  └───────────┘  ║
║        │ Request C │──┘   └─────────────────┘      └──────────┘                 ║
║        └──────────┘                                                            ║
║                                                                                ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

## Installation

```bash
npm install atomic-queues bullmq ioredis
```

## Quick Start

### 1. Configure the Module

```typescript
import { Module } from '@nestjs/common';
import { AtomicQueuesModule } from 'atomic-queues';

@Module({
  imports: [
    AtomicQueuesModule.forRoot({
      redis: { host: 'localhost', port: 6379 },
      keyPrefix: 'myapp',
    }),
  ],
})
export class AppModule {}
```

### 2. Create Your Commands

Plain classes - no decorators needed:

```typescript
// commands/process-order.command.ts
export class ProcessOrderCommand {
  constructor(
    public readonly orderId: string,
    public readonly items: string[],
    public readonly amount: number,
  ) {}
}

// commands/ship-order.command.ts
export class ShipOrderCommand {
  constructor(
    public readonly orderId: string,
    public readonly address: string,
  ) {}
}
```

### 3. Create a Worker Processor

```typescript
import { Injectable } from '@nestjs/common';
import { WorkerProcessor } from 'atomic-queues';

@WorkerProcessor({
  entityType: 'order',
  queueName: (orderId) => `order-${orderId}-queue`,
  workerName: (orderId) => `order-${orderId}-worker`,
})
@Injectable()
export class OrderProcessor {}
```

### 4. Queue Jobs with the Fluent API

Commands are **automatically registered** from your `@CommandHandler` classes - no manual registration needed!

```typescript
import { Injectable } from '@nestjs/common';
import { QueueBus } from 'atomic-queues';
import { OrderProcessor } from './order.processor';
import { ProcessOrderCommand, ShipOrderCommand } from './commands';

@Injectable()
export class OrderService {
  constructor(private readonly queueBus: QueueBus) {}

  async createOrder(orderId: string, items: string[], amount: number) {
    // Jobs are queued and processed sequentially per orderId
    await this.queueBus
      .forProcessor(OrderProcessor)
      .enqueue(new ProcessOrderCommand(orderId, items, amount));

    await this.queueBus
      .forProcessor(OrderProcessor)
      .enqueue(new ShipOrderCommand(orderId, '123 Main St'));
  }
}
```

That's it! The library automatically:
- Discovers commands from `@CommandHandler` decorators
- Creates a queue for each `orderId`
- Spawns a worker to process jobs sequentially
- Routes jobs to the correct command handlers

---

## How It Works

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              ARCHITECTURE                                      ║
╚═══════════════════════════════════════════════════════════════════════════════╝

  YOUR CODE                         ATOMIC-QUEUES                        EXECUTION
  ─────────                         ─────────────                        ─────────

  ┌─────────────────────────┐
  │ queueBus                │
  │   .forProcessor(...)    │
  │   .enqueue(command)     │
  └───────────┬─────────────┘
              │
              │  ① Extract queue config from @WorkerProcessor
              │  ② Extract entityId from command properties
              │  ③ Build queue name: {prefix}-{entityId}-queue
              ▼
      ┌───────────────────┐
      │                   │
      │   Redis Queue     │◀─── Job { name: "MyCommand", data: {...} }
      │   (per entity)    │
      │                   │
      └─────────┬─────────┘
                │
                │  ④ Worker pulls job (one at a time)
                ▼
      ┌───────────────────┐
      │                   │
      │   BullMQ Worker   │
      │   (1 per entity)  │
      │                   │
      └─────────┬─────────┘
                │
                │  ⑤ Lookup command class in registry
                │  ⑥ Instantiate from job.data
                │  ⑦ Execute via CQRS CommandBus
                ▼
      ┌───────────────────┐      ┌─────────────────────────┐
      │                   │      │                         │
      │    CommandBus     │─────▶│  MyCommandHandler       │
      │                   │      │    .execute(command)    │
      └───────────────────┘      └─────────────────────────┘
```

---

## API Reference

### QueueBus

The main way to add jobs to queues:

```typescript
// Enqueue a single command
await queueBus
  .forProcessor(MyProcessor)
  .enqueue(new MyCommand(entityId, data));

// Enqueue and wait for result
const result = await queueBus
  .forProcessor(MyProcessor)
  .enqueueAndWait(new MyQuery(entityId));

// Enqueue multiple commands
await queueBus
  .forProcessor(MyProcessor)
  .enqueueBulk([
    new CommandA(entityId),
    new CommandB(entityId),
  ]);

// With job options (delay, priority, etc.)
await queueBus
  .forProcessor(MyProcessor)
  .enqueue(new MyCommand(entityId), {
    jobOptions: { delay: 5000, priority: 1 }
  });
```

### @WorkerProcessor

Defines how workers are created for an entity type:

```typescript
@WorkerProcessor({
  entityType: 'order',                              // Required
  queueName: (id) => `order-${id}-queue`,           // Optional
  workerName: (id) => `order-${id}-worker`,         // Optional
  workerConfig: {
    concurrency: 1,                                 // Jobs per worker (default: 1)
    stalledInterval: 1000,                          // Check stalled jobs (ms)
    lockDuration: 30000,                            // Job lock duration (ms)
  },
})
```

---

## Entity ID Extraction

The `entityId` is automatically extracted from your command's properties:

```typescript
// These property names are checked in order:
// entityId, tableId, userId, id, gameId, playerId

export class ProcessOrderCommand {
  constructor(
    public readonly orderId: string,  // ✓ 'orderId' contains 'Id' → entityId
    public readonly items: string[],
  ) {}
}

// Or use standard names
export class UpdateUserCommand {
  constructor(
    public readonly userId: string,   // ✓ Matches 'userId' → entityId
    public readonly name: string,
  ) {}
}
```

---

## Scaling with Entity Scalers

For dynamic worker management based on demand:

```typescript
import { Injectable } from '@nestjs/common';
import { EntityScaler, GetActiveEntities, GetDesiredWorkerCount } from 'atomic-queues';

@EntityScaler({
  entityType: 'order',
  maxWorkersPerEntity: 1,
})
@Injectable()
export class OrderScaler {
  constructor(private readonly orderRepo: OrderRepository) {}

  @GetActiveEntities()
  async getActiveOrders(): Promise<string[]> {
    // Return IDs that need workers
    return this.orderRepo.findPendingOrderIds();
  }

  @GetDesiredWorkerCount()
  async getWorkerCount(orderId: string): Promise<number> {
    return 1; // One worker per order
  }
}
```

---

## Complete Example

A document processing service where multiple users can edit the same document:

```typescript
// ─────────────────────────────────────────────────────────────────
// commands/update-document.command.ts
// ─────────────────────────────────────────────────────────────────
export class UpdateDocumentCommand {
  constructor(
    public readonly documentId: string,
    public readonly userId: string,
    public readonly content: string,
    public readonly version: number,
  ) {}
}

// ─────────────────────────────────────────────────────────────────
// commands/publish-document.command.ts
// ─────────────────────────────────────────────────────────────────
export class PublishDocumentCommand {
  constructor(
    public readonly documentId: string,
    public readonly publishedBy: string,
  ) {}
}

// ─────────────────────────────────────────────────────────────────
// handlers/update-document.handler.ts
// ─────────────────────────────────────────────────────────────────
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { UpdateDocumentCommand } from '../commands';

@CommandHandler(UpdateDocumentCommand)
export class UpdateDocumentHandler implements ICommandHandler<UpdateDocumentCommand> {
  constructor(private readonly documentRepo: DocumentRepository) {}

  async execute(command: UpdateDocumentCommand) {
    const { documentId, userId, content, version } = command;
    
    // Safe! No race conditions - one update at a time per document
    await this.documentRepo.update(documentId, { content, version, lastEditedBy: userId });
    
    return { success: true, documentId, version };
  }
}

// ─────────────────────────────────────────────────────────────────
// handlers/publish-document.handler.ts
// ─────────────────────────────────────────────────────────────────
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { PublishDocumentCommand } from '../commands';

@CommandHandler(PublishDocumentCommand)
export class PublishDocumentHandler implements ICommandHandler<PublishDocumentCommand> {
  constructor(private readonly documentRepo: DocumentRepository) {}

  async execute(command: PublishDocumentCommand) {
    const { documentId, publishedBy } = command;
    
    await this.documentRepo.publish(documentId, publishedBy);
    
    return { success: true, documentId, publishedAt: new Date() };
  }
}

// ─────────────────────────────────────────────────────────────────
// document.processor.ts
// ─────────────────────────────────────────────────────────────────
import { Injectable } from '@nestjs/common';
import { WorkerProcessor } from 'atomic-queues';

@WorkerProcessor({
  entityType: 'document',
  queueName: (documentId) => `doc-${documentId}-queue`,
  workerName: (documentId) => `doc-${documentId}-worker`,
})
@Injectable()
export class DocumentProcessor {}

// ─────────────────────────────────────────────────────────────────
// document.module.ts
// ─────────────────────────────────────────────────────────────────
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { DocumentProcessor } from './document.processor';
import { DocumentController } from './document.controller';
import { UpdateDocumentHandler, PublishDocumentHandler } from './handlers';

@Module({
  imports: [CqrsModule],
  providers: [
    DocumentProcessor,
    UpdateDocumentHandler,   // Commands auto-discovered!
    PublishDocumentHandler,
  ],
  controllers: [DocumentController],
})
export class DocumentModule {}

// ─────────────────────────────────────────────────────────────────
// document.controller.ts
// ─────────────────────────────────────────────────────────────────
import { Controller, Post, Body, Param } from '@nestjs/common';
import { QueueBus } from 'atomic-queues';
import { DocumentProcessor } from './document.processor';
import { UpdateDocumentCommand, PublishDocumentCommand } from './commands';

@Controller('documents')
export class DocumentController {
  constructor(private readonly queueBus: QueueBus) {}

  @Post(':id/update')
  async updateDocument(
    @Param('id') documentId: string,
    @Body() body: { userId: string; content: string; version: number },
  ) {
    // Multiple users editing same doc? No problem!
    // Updates are queued and processed one at a time
    await this.queueBus
      .forProcessor(DocumentProcessor)
      .enqueue(new UpdateDocumentCommand(
        documentId,
        body.userId,
        body.content,
        body.version,
      ));

    return { queued: true, documentId };
  }

  @Post(':id/publish')
  async publishDocument(
    @Param('id') documentId: string,
    @Body() body: { publishedBy: string },
  ) {
    await this.queueBus
      .forProcessor(DocumentProcessor)
      .enqueue(new PublishDocumentCommand(documentId, body.publishedBy));

    return { queued: true, documentId };
  }
}
```

---

## Configuration

```typescript
AtomicQueuesModule.forRoot({
  redis: {
    host: 'localhost',
    port: 6379,
    password: 'secret',
  },
  
  keyPrefix: 'myapp',           // Redis key prefix (default: 'aq')
  
  enableCronManager: true,       // Enable auto-scaling (default: false)
  cronInterval: 5000,            // Scaling check interval (default: 5000ms)
  
  verbose: false,                // Enable verbose logging (default: false)
                                 // When true, logs service job processing details
  
  workerDefaults: {
    concurrency: 1,              // Jobs processed simultaneously
    stalledInterval: 1000,       // Stalled job check interval
    lockDuration: 30000,         // Job lock duration
    heartbeatTTL: 3,             // Worker heartbeat TTL (seconds)
  },
});
```

---

## Command Registration

By default, atomic-queues **auto-discovers** all commands from your `@CommandHandler` and `@QueryHandler` decorators. No manual registration needed!

### Auto-Discovery (Default)

Commands are automatically discovered when you have CQRS handlers:

```typescript
// Your handler - that's all you need!
@CommandHandler(ProcessOrderCommand)
export class ProcessOrderHandler implements ICommandHandler<ProcessOrderCommand> {
  async execute(command: ProcessOrderCommand) {
    // ProcessOrderCommand is auto-registered with QueueBus
  }
}
```

### Manual Registration (Optional)

If you need to register commands without handlers, or disable auto-discovery:

```typescript
// Disable auto-discovery in config
AtomicQueuesModule.forRoot({
  redis: { host: 'localhost', port: 6379 },
  autoRegisterCommands: false, // Disable auto-discovery
});

// Then manually register
QueueBus.registerCommands(ProcessOrderCommand, ShipOrderCommand);
```

---

## Why Use atomic-queues?

| Feature | Without | With atomic-queues |
|---------|---------|-------------------|
| Sequential per-entity | Manual locking | Automatic via queues |
| Race conditions | Possible | Prevented |
| Worker management | Manual | Automatic |
| Horizontal scaling | Complex | Built-in |
| Code organization | Scattered | Clean decorators |

---

## License

MIT
