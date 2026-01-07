# atomic-queues

A NestJS library for atomic, sequential job processing per entity with BullMQ and Redis.

## What It Does

```
┌─────────────────────────────────────────────────────────────────┐
│                     THE PROBLEM                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Multiple requests for the same entity arrive simultaneously:    │
│                                                                  │
│    Request A ───┐                                                │
│    Request B ───┼──► Entity 123 ──► 💥 RACE CONDITION!          │
│    Request C ───┘                                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     THE SOLUTION                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  atomic-queues ensures sequential processing per entity:         │
│                                                                  │
│    Request A ───┐     ┌─────────┐                                │
│    Request B ───┼──►  │ Queue   │  ──► Worker ──► Entity 123    │
│    Request C ───┘     │ A, B, C │      (1 at a time)            │
│                       └─────────┘                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
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

### 4. Register Commands at Startup

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { QueueBus } from 'atomic-queues';
import { ProcessOrderCommand, ShipOrderCommand } from './commands';

@Injectable()
export class OrderModule implements OnModuleInit {
  onModuleInit() {
    QueueBus.registerCommands(
      ProcessOrderCommand,
      ShipOrderCommand,
    );
  }
}
```

### 5. Queue Jobs with the Fluent API

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
- Creates a queue for each `orderId`
- Spawns a worker to process jobs sequentially
- Routes jobs to the correct command handlers

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        FLOW DIAGRAM                              │
└─────────────────────────────────────────────────────────────────┘

  YOUR CODE                    ATOMIC-QUEUES                 WORKER
  ─────────                    ─────────────                 ──────

  queueBus
    .forProcessor(OrderProcessor)
    .enqueue(new ProcessOrderCommand(...))
           │
           │ 1. Extract queue config from @WorkerProcessor
           │ 2. Extract orderId from command.orderId
           │ 3. Build queue name: order-{orderId}-queue
           ▼
    ┌─────────────┐
    │   Redis     │
    │   Queue     │  ◄─── Job: { name: "ProcessOrderCommand", data: {...} }
    └──────┬──────┘
           │
           │ 4. Worker pulls job from queue
           ▼
    ┌─────────────┐
    │   Worker    │
    │ (1 per ID)  │
    └──────┬──────┘
           │
           │ 5. Lookup ProcessOrderCommand in registry
           │ 6. Instantiate command from job.data
           │ 7. Execute via CommandBus
           ▼
    ┌─────────────┐
    │ CommandBus  │  ──►  ProcessOrderCommandHandler.execute()
    └─────────────┘
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

### QueueBus.registerCommands()

Register command classes for worker-side instantiation:

```typescript
// At startup
QueueBus.registerCommands(
  ProcessOrderCommand,
  ShipOrderCommand,
  CancelOrderCommand,
);

// For queries
QueueBus.registerQueries(
  GetOrderStatusQuery,
);
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

```typescript
// ─────────────────────────────────────────────────────────────────
// commands/place-bet.command.ts
// ─────────────────────────────────────────────────────────────────
export class PlaceBetCommand {
  constructor(
    public readonly tableId: string,
    public readonly playerId: string,
    public readonly amount: number,
  ) {}
}

// ─────────────────────────────────────────────────────────────────
// commands/deal-cards.command.ts
// ─────────────────────────────────────────────────────────────────
export class DealCardsCommand {
  constructor(
    public readonly tableId: string,
  ) {}
}

// ─────────────────────────────────────────────────────────────────
// table.processor.ts
// ─────────────────────────────────────────────────────────────────
import { Injectable } from '@nestjs/common';
import { WorkerProcessor } from 'atomic-queues';

@WorkerProcessor({
  entityType: 'table',
  queueName: (tableId) => `table-${tableId}-queue`,
  workerName: (tableId) => `table-${tableId}-worker`,
})
@Injectable()
export class TableProcessor {}

// ─────────────────────────────────────────────────────────────────
// table.module.ts
// ─────────────────────────────────────────────────────────────────
import { Module, OnModuleInit } from '@nestjs/common';
import { QueueBus } from 'atomic-queues';
import { PlaceBetCommand, DealCardsCommand } from './commands';
import { TableProcessor } from './table.processor';
import { TableGateway } from './table.gateway';

@Module({
  providers: [TableProcessor, TableGateway],
})
export class TableModule implements OnModuleInit {
  onModuleInit() {
    QueueBus.registerCommands(PlaceBetCommand, DealCardsCommand);
  }
}

// ─────────────────────────────────────────────────────────────────
// table.gateway.ts (WebSocket example)
// ─────────────────────────────────────────────────────────────────
import { Injectable } from '@nestjs/common';
import { QueueBus } from 'atomic-queues';
import { TableProcessor } from './table.processor';
import { PlaceBetCommand, DealCardsCommand } from './commands';

@Injectable()
export class TableGateway {
  constructor(private readonly queueBus: QueueBus) {}

  async onPlaceBet(tableId: string, playerId: string, amount: number) {
    await this.queueBus
      .forProcessor(TableProcessor)
      .enqueue(new PlaceBetCommand(tableId, playerId, amount));
  }

  async onDealCards(tableId: string) {
    await this.queueBus
      .forProcessor(TableProcessor)
      .enqueue(new DealCardsCommand(tableId));
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
  
  workerDefaults: {
    concurrency: 1,              // Jobs processed simultaneously
    stalledInterval: 1000,       // Stalled job check interval
    lockDuration: 30000,         // Job lock duration
    heartbeatTTL: 3,             // Worker heartbeat TTL (seconds)
  },
});
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
