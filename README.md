# atomic-queues

A NestJS library for atomic, sequential job processing per entity using BullMQ and Redis.

---

## Table of Contents

- [Overview](#overview)
- [The Concurrency Problem](#the-concurrency-problem)
- [The Per-Entity Queue Architecture](#the-per-entity-queue-architecture)
- [Architecture](#architecture)
- [Use Cases](#use-cases)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Entity ID Extraction](#entity-id-extraction)
- [Scalerless Mode (Auto-Spawn Workers)](#scalerless-mode-auto-spawn-workers)
- [Scaling with Entity Scalers](#scaling-with-entity-scalers)
- [Complete Example](#complete-example)
- [Configuration](#configuration)
- [License](#license)

---

## Overview

**atomic-queues** solves the fundamental concurrency problem in distributed systems: ensuring that operations on the same logical entity execute sequentially, even when requests arrive simultaneously across multiple service instances.

Rather than relying on distributed locks—which introduce contention, latency degradation, and complex failure modes—this library implements a **per-entity queue architecture** where each entity (user account, order, document) has its own dedicated processing queue and worker.

---

## The Concurrency Problem

Consider a banking system where a user with a $100 balance submits two concurrent $80 withdrawal requests:

```
Time    Request A                    Request B                    Database State
─────────────────────────────────────────────────────────────────────────────────
T₀      SELECT balance → $100        SELECT balance → $100        balance = $100
T₁      CHECK: $100 >= $80 ✓         CHECK: $100 >= $80 ✓              
T₂      UPDATE: balance = $20        UPDATE: balance = $20        balance = $20
T₃                                   UPDATE: balance = -$60       balance = -$60
─────────────────────────────────────────────────────────────────────────────────
Result: Both withdrawals succeed. Balance becomes -$60. Integrity violated.
```

This occurs because both transactions read the balance before either writes—a classic **lost update anomaly**.

Traditional solutions (distributed locks, row locks, optimistic concurrency) attempt to serialize access at the *moment of execution*. Under high contention, this creates a thundering herd where N requests compete for the same resource simultaneously.

---

## The Per-Entity Queue Architecture

Instead of serializing at execution time, **serialize at ingestion time**:

```
                                    ┌─────────────────────────────────────────┐
   Request A ─┐                     │         Per-Entity Queue                │
              │                     │  ┌─────┐ ┌─────┐ ┌─────┐               │
   Request B ─┼──▶ [Entity Router] ─┼─▶│ Op₁ │→│ Op₂ │→│ Op₃ │→ [Worker] ─┐ │
              │                     │  └─────┘ └─────┘ └─────┘             │ │
   Request C ─┘                     │                                      │ │
                                    │      Sequential Processing ◄─────────┘ │
                                    └─────────────────────────────────────────┘
```

Operations targeting the same entity are immediately routed to that entity's queue. A dedicated worker processes operations one at a time, guaranteeing:

1. **Serialized Execution**: Operations execute in FIFO order
2. **Consistent State Visibility**: Each operation sees the result of all prior operations  
3. **Isolation**: No interleaving of concurrent modifications

### Correctness Under Load

```
Time    Queue State                 Worker Execution              Database State
───────────────────────────────────────────────────────────────────────────────────
T₀      [Withdraw $80, Withdraw $80]                              balance = $100
T₁      [Withdraw $80]              Process Op₁: $100 - $80       balance = $20
T₂      []                          Process Op₂: $20 < $80 → REJECT   balance = $20
───────────────────────────────────────────────────────────────────────────────────
Result: First withdrawal succeeds. Second is rejected. Integrity preserved.
```

---

## Architecture

### Multi-Pod Kubernetes Deployments

In containerized environments, services scale horizontally through pod replication. Workers are distributed across service instances via Redis-based coordination:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              REDIS CLUSTER                                       │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │  Entity Queues                                                             │ │
│  │  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐              │ │
│  │  │ account:ACC-001 │ │ account:ACC-002 │ │ account:ACC-003 │  ...         │ │
│  │  │ [op₁][op₂][op₃] │ │ [op₁]           │ │ [op₁][op₂]      │              │ │
│  │  └────────┬────────┘ └────────┬────────┘ └────────┬────────┘              │ │
│  │           │                   │                   │                        │ │
│  │  ┌────────┴───────────────────┴───────────────────┴────────┐              │ │
│  │  │              Worker Heartbeat Registry                   │              │ │
│  │  │  ACC-001 → node-1 | ACC-002 → node-2 | ACC-003 → node-1  │              │ │
│  │  └──────────────────────────────────────────────────────────┘              │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
           │                        │                        │
           ▼                        ▼                        ▼
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│   Service Node 1    │  │   Service Node 2    │  │   Service Node 3    │
│  ┌───────────────┐  │  │  ┌───────────────┐  │  │  ┌───────────────┐  │
│  │ Worker ACC-001│  │  │  │ Worker ACC-002│  │  │  │ Worker ACC-004│  │
│  │ Worker ACC-003│  │  │  │ Worker ACC-005│  │  │  │ Worker ACC-006│  │
│  └───────────────┘  │  │  └───────────────┘  │  │  └───────────────┘  │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

**Properties:**
- Each entity has exactly one active worker at any time (enforced via heartbeat TTL)
- Workers spawn on-demand when jobs arrive for an entity
- Workers terminate after configurable idle period
- Node failure → heartbeat expires → worker respawns on healthy node

### Dynamic Worker Lifecycle

```
                    Job Arrives for Entity X
                              │
                              ▼
                    ┌─────────────────────┐
                    │ Worker exists for X? │
                    └──────────┬──────────┘
                               │
              ┌────────────────┴────────────────┐
              │ NO                              │ YES
              ▼                                 ▼
    ┌─────────────────────┐           ┌─────────────────────┐
    │ Spawn worker for X  │           │ Job added to queue  │
    │ Register heartbeat  │           │ Worker will process │
    └─────────────────────┘           └─────────────────────┘
              │
              ▼
    ┌─────────────────────┐
    │ Process jobs until  │◄─────── Idle Timeout
    │ queue empty + idle  │         (configurable)
    └──────────┬──────────┘
               │
               ▼
    ┌─────────────────────┐
    │ Worker terminates   │
    │ Heartbeat expires   │
    └─────────────────────┘
```

**Resource Efficiency**: A system with 1 million registered accounts but 10,000 active accounts maintains only 10,000 workers.

---

## Use Cases

| Domain            | Entity Type     | Operations                                          |
|-------------------|-----------------|-----------------------------------------------------|
| **Finance**       | Account, Wallet | Deposits, withdrawals, transfers, balance queries   |
| **E-Commerce**    | Order, Cart     | Add/remove items, apply discounts, checkout         |
| **Collaboration** | Document        | Edits, comments, permission changes                 |
| **IoT**           | Device          | Command dispatch, state synchronization             |
| **Gaming**        | Match, Session  | Player actions, state transitions                   |

---

## Installation

```bash
npm install atomic-queues bullmq ioredis
```

---

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
      enableCronManager: true,
    }),
  ],
})
export class AppModule {}
```

### 2. Create Commands

Plain classes—no decorators required:

```typescript
// commands/withdraw.command.ts
export class WithdrawCommand {
  constructor(
    public readonly accountId: string,
    public readonly amount: number,
    public readonly transactionId: string,
  ) {}
}

// commands/deposit.command.ts
export class DepositCommand {
  constructor(
    public readonly accountId: string,
    public readonly amount: number,
    public readonly source: string,
  ) {}
}
```

### 3. Create a Worker Processor (Scalerless Mode)

The simplest approach—workers automatically spawn when jobs arrive and terminate when idle:

```typescript
import { Injectable } from '@nestjs/common';
import { WorkerProcessor, JobHandler } from 'atomic-queues';
import { CommandBus } from '@nestjs/cqrs';

@WorkerProcessor({
  entityType: 'account',
  queueName: (accountId) => `${accountId}-queue`,
  workerName: (accountId) => `${accountId}-worker`,
  maxWorkersPerEntity: 1,
  idleTimeoutSeconds: 15,
  autoSpawn: true,  // Workers spawn automatically when jobs arrive
})
@Injectable()
export class AccountProcessor {
  constructor(private readonly commandBus: CommandBus) {}

  @JobHandler('*')  // Handle all job types for this entity
  async handleJob(job: any): Promise<any> {
    const { commandName, data } = job.data;
    
    // Reconstruct and execute the command
    const CommandClass = QueueBus.getCommandClass(commandName);
    const command = Object.assign(new CommandClass(), data);
    return this.commandBus.execute(command);
  }
}
```

### 4. Queue Jobs with the Fluent API

```typescript
import { Injectable } from '@nestjs/common';
import { QueueBus } from 'atomic-queues';
import { AccountProcessor } from './account.processor';
import { WithdrawCommand, DepositCommand } from './commands';

@Injectable()
export class AccountService {
  constructor(private readonly queueBus: QueueBus) {}

  async withdraw(accountId: string, amount: number, transactionId: string) {
    // Jobs are queued and processed sequentially per accountId
    await this.queueBus
      .forProcessor(AccountProcessor)
      .enqueue(new WithdrawCommand(accountId, amount, transactionId));
  }

  async deposit(accountId: string, amount: number, source: string) {
    await this.queueBus
      .forProcessor(AccountProcessor)
      .enqueue(new DepositCommand(accountId, amount, source));
  }
}
```

That's it! The library automatically:
- Discovers commands from `@CommandHandler` decorators
- Creates a queue for each `accountId`
- Spawns a worker when jobs arrive (scalerless mode)
- Routes jobs to the correct command handlers
- Terminates idle workers after the configured timeout

---

## API Reference

### QueueBus

QueueBus provides three ways to enqueue commands:

#### Option 1: `forProcessor()` - Full Control

Use when you have a `@WorkerProcessor` class with custom configuration:

```typescript
@WorkerProcessor({
  entityType: 'order',
  defaultEntityId: 'orderId',
  queueName: (id) => `order-${id}-queue`,
})
export class OrderProcessor {}

// Usage
await queueBus
  .forProcessor(OrderProcessor)
  .enqueue(new ProcessOrderCommand(orderId, items));
```

#### Option 2: `forEntity()` - Zero Boilerplate

Use when you've configured entity defaults in the module:

```typescript
// Module config
AtomicQueuesModule.forRoot({
  redis: { host: 'localhost', port: 6379 },
  entities: {
    order: { defaultEntityId: 'orderId' },
    account: { defaultEntityId: 'accountId' },
  },
})

// Usage
await queueBus
  .forEntity('order')
  .enqueue(new ProcessOrderCommand(orderId, items));
```

#### Option 3: Direct `enqueue()` - Most Ergonomic

Use when commands have `@EntityType` and `@QueueEntityId` decorators:

```typescript
import { EntityType, QueueEntityId } from 'atomic-queues';

@EntityType('order')
export class ProcessOrderCommand {
  @QueueEntityId()
  orderId: string;
  
  constructor(orderId: string, public readonly items: string[]) {
    this.orderId = orderId;
  }
}

// Usage - command knows where it goes!
await queueBus.enqueue(new ProcessOrderCommand(orderId, items));
```

### @WorkerProcessor

Defines how workers are created for an entity type:

```typescript
@WorkerProcessor({
  entityType: 'account',                            // Required
  defaultEntityId: 'accountId',                     // Default property for entity ID
  queueName: (id) => `account-${id}-queue`,         // Queue naming pattern
  workerName: (id) => `account-${id}-worker`,       // Worker naming pattern
  maxWorkersPerEntity: 1,                           // Max workers per entity (scalerless)
  idleTimeoutSeconds: 15,                           // Idle timeout before termination
  autoSpawn: true,                                  // Enable scalerless mode
  workerConfig: {
    concurrency: 1,                                 // Jobs per worker (default: 1)
    stalledInterval: 1000,                          // Check stalled jobs (ms)
    lockDuration: 30000,                            // Job lock duration (ms)
  },
})
```

---

## Entity ID Extraction

Commands must explicitly declare which property contains the entity ID. This prevents silent misrouting bugs.

### Priority Chain

Entity ID is resolved in this order:

1. **`@QueueEntityId()` decorator** on command property (highest priority)
2. **`defaultEntityId`** in `@WorkerProcessor` options
3. **`defaultEntityId`** in module `entities` config
4. **Error** (no magic fallback)

### Using `@QueueEntityId()` Decorator (Recommended)

```typescript
import { QueueEntityId, EntityType } from 'atomic-queues';

@EntityType('account')
export class TransferCommand {
  @QueueEntityId()  // Explicit: this command routes to sourceAccountId's queue
  sourceAccountId: string;
  
  targetAccountId: string;
  amount: number;
  
  constructor(source: string, target: string, amount: number) {
    this.sourceAccountId = source;
    this.targetAccountId = target;
    this.amount = amount;
  }
}
```

> ⚠️ **Only one `@QueueEntityId()` per class** — a compile-time error is thrown if multiple properties are decorated.

### Using Module-Level Defaults

For commands without `@QueueEntityId()`, configure defaults per entity type:

```typescript
AtomicQueuesModule.forRoot({
  redis: { host: 'localhost', port: 6379 },
  entities: {
    account: { 
      defaultEntityId: 'accountId',
      workerConfig: { concurrency: 1 },
    },
    order: { 
      defaultEntityId: 'orderId',
      queueName: (id) => `orders-${id}`,
    },
  },
})
```

### Using Processor-Level Defaults

```typescript
@WorkerProcessor({
  entityType: 'order',
  defaultEntityId: 'orderId',  // All commands use this if no @QueueEntityId()
})
export class OrderProcessor {}
```

---

## Scalerless Mode (Auto-Spawn Workers)

The simplest way to use atomic-queues—no EntityScaler class required:

```typescript
@WorkerProcessor({
  entityType: 'account',
  queueName: (accountId) => `${accountId}-queue`,
  maxWorkersPerEntity: 1,     // Max 1 worker per entity
  idleTimeoutSeconds: 15,     // Terminate after 15s idle
  autoSpawn: true,            // Spawn workers when jobs arrive
})
@Injectable()
export class AccountProcessor {
  constructor(private readonly commandBus: CommandBus) {}

  @JobHandler('*')
  async handleJob(job: any): Promise<any> {
    const { commandName, data } = job.data;
    const CommandClass = QueueBus.getCommandClass(commandName);
    const command = Object.assign(new CommandClass(), data);
    return this.commandBus.execute(command);
  }
}
```

**How it works:**
1. When a job is enqueued, the library listens via BullMQ's `QueueEvents` (Redis pub/sub)
2. If no worker exists for that entity, one is automatically spawned
3. The worker processes jobs sequentially
4. When the queue is empty and the worker has been idle for `idleTimeoutSeconds`, it terminates
5. The CronManager handles idle detection via Redis heartbeat tracking

---

## Scaling with Entity Scalers

For more control over worker lifecycle (e.g., based on external state), use an EntityScaler:

```typescript
import { Injectable } from '@nestjs/common';
import { EntityScaler, GetActiveEntities, GetDesiredWorkerCount } from 'atomic-queues';

@EntityScaler({
  entityType: 'order',
  maxWorkersPerEntity: 1,
  idleTimeoutSeconds: 30,
})
@Injectable()
export class OrderScaler {
  constructor(private readonly orderRepo: OrderRepository) {}

  @GetActiveEntities()
  async getActiveOrders(): Promise<string[]> {
    // Return IDs of orders that need active workers
    return this.orderRepo.findPendingOrderIds();
  }

  @GetDesiredWorkerCount()
  async getWorkerCount(orderId: string): Promise<number> {
    return 1; // Always 1 worker per order
  }
}
```

---

## Complete Example

A banking service handling critical financial transactions where race conditions could cause overdrafts:

```typescript
// ─────────────────────────────────────────────────────────────────
// commands/withdraw.command.ts
// ─────────────────────────────────────────────────────────────────
export class WithdrawCommand {
  constructor(
    public readonly accountId: string,
    public readonly amount: number,
    public readonly transactionId: string,
  ) {}
}

// ─────────────────────────────────────────────────────────────────
// commands/deposit.command.ts
// ─────────────────────────────────────────────────────────────────
export class DepositCommand {
  constructor(
    public readonly accountId: string,
    public readonly amount: number,
    public readonly source: string,
  ) {}
}

// ─────────────────────────────────────────────────────────────────
// commands/transfer.command.ts
// ─────────────────────────────────────────────────────────────────
export class TransferCommand {
  constructor(
    public readonly accountId: string,   // Source account (for queue routing)
    public readonly toAccountId: string,
    public readonly amount: number,
    public readonly transactionId: string,
  ) {}
}

// ─────────────────────────────────────────────────────────────────
// handlers/withdraw.handler.ts
// ─────────────────────────────────────────────────────────────────
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { WithdrawCommand } from '../commands';

@CommandHandler(WithdrawCommand)
export class WithdrawHandler implements ICommandHandler<WithdrawCommand> {
  constructor(
    private readonly accountRepo: AccountRepository,
    private readonly ledger: LedgerService,
  ) {}

  async execute(command: WithdrawCommand) {
    const { accountId, amount, transactionId } = command;
    
    // SAFE: No race conditions! This handler runs sequentially per account
    // Even if 10 withdrawals arrive simultaneously, they execute one-by-one
    
    const account = await this.accountRepo.findById(accountId);
    
    if (account.balance < amount) {
      throw new InsufficientFundsError(accountId, account.balance, amount);
    }
    
    if (account.status !== 'active') {
      throw new AccountFrozenError(accountId);
    }
    
    // Debit the account
    account.balance -= amount;
    await this.accountRepo.save(account);
    
    // Record in ledger
    await this.ledger.record({
      transactionId,
      accountId,
      type: 'DEBIT',
      amount,
      balanceAfter: account.balance,
      timestamp: new Date(),
    });
    
    return { 
      success: true, 
      transactionId, 
      newBalance: account.balance,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// handlers/transfer.handler.ts
// ─────────────────────────────────────────────────────────────────
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { TransferCommand, DepositCommand } from '../commands';
import { QueueBus } from 'atomic-queues';

@CommandHandler(TransferCommand)
export class TransferHandler implements ICommandHandler<TransferCommand> {
  constructor(
    private readonly accountRepo: AccountRepository,
    private readonly queueBus: QueueBus,
  ) {}

  async execute(command: TransferCommand) {
    const { accountId, toAccountId, amount, transactionId } = command;
    
    // Step 1: Debit source account (already in source account's queue)
    const sourceAccount = await this.accountRepo.findById(accountId);
    
    if (sourceAccount.balance < amount) {
      throw new InsufficientFundsError(accountId, sourceAccount.balance, amount);
    }
    
    sourceAccount.balance -= amount;
    await this.accountRepo.save(sourceAccount);
    
    // Step 2: Queue credit to destination account (different queue!)
    // This ensures the destination account also processes atomically
    await this.queueBus
      .forProcessor(AccountProcessor)
      .enqueue(new DepositCommand(
        toAccountId,
        amount,
        `transfer:${accountId}`,
      ));
    
    return { success: true, transactionId };
  }
}

// ─────────────────────────────────────────────────────────────────
// account.processor.ts (Scalerless Mode)
// ─────────────────────────────────────────────────────────────────
import { Injectable } from '@nestjs/common';
import { WorkerProcessor, JobHandler, QueueBus } from 'atomic-queues';
import { CommandBus } from '@nestjs/cqrs';

@WorkerProcessor({
  entityType: 'account',
  queueName: (accountId) => `${accountId}-queue`,
  workerName: (accountId) => `${accountId}-worker`,
  maxWorkersPerEntity: 1,
  idleTimeoutSeconds: 15,
  autoSpawn: true,
  workerConfig: {
    concurrency: 1,         // CRITICAL: Must be 1 for financial transactions
    lockDuration: 60000,    // 60s lock for long transactions
  },
})
@Injectable()
export class AccountProcessor {
  constructor(private readonly commandBus: CommandBus) {}

  @JobHandler('*')
  async handleJob(job: any): Promise<any> {
    const { commandName, data } = job.data;
    const CommandClass = QueueBus.getCommandClass(commandName);
    const command = Object.assign(new CommandClass(), data);
    return this.commandBus.execute(command);
  }
}

// ─────────────────────────────────────────────────────────────────
// account.module.ts
// ─────────────────────────────────────────────────────────────────
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

@Module({
  imports: [CqrsModule],
  providers: [
    AccountProcessor,
    WithdrawHandler,
    DepositHandler,
    TransferHandler,
  ],
  controllers: [AccountController],
})
export class AccountModule {}

// ─────────────────────────────────────────────────────────────────
// account.controller.ts
// ─────────────────────────────────────────────────────────────────
import { Controller, Post, Body, Param } from '@nestjs/common';
import { QueueBus } from 'atomic-queues';
import { AccountProcessor } from './account.processor';
import { WithdrawCommand, TransferCommand } from './commands';
import { v4 as uuid } from 'uuid';

@Controller('accounts')
export class AccountController {
  constructor(private readonly queueBus: QueueBus) {}

  @Post(':accountId/withdraw')
  async withdraw(
    @Param('accountId') accountId: string,
    @Body() body: { amount: number },
  ) {
    const transactionId = uuid();
    
    // Even if user spam-clicks "Withdraw", each request is queued
    // and processed sequentially - no double-withdrawals possible
    await this.queueBus
      .forProcessor(AccountProcessor)
      .enqueue(new WithdrawCommand(accountId, body.amount, transactionId));

    return { 
      queued: true, 
      transactionId,
      message: 'Withdrawal queued for processing',
    };
  }

  @Post(':accountId/transfer')
  async transfer(
    @Param('accountId') accountId: string,
    @Body() body: { toAccountId: string; amount: number },
  ) {
    const transactionId = uuid();
    
    await this.queueBus
      .forProcessor(AccountProcessor)
      .enqueue(new TransferCommand(
        accountId,
        body.toAccountId,
        body.amount,
        transactionId,
      ));

    return { 
      queued: true, 
      transactionId,
      message: 'Transfer queued for processing',
    };
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
  
  keyPrefix: 'myapp',            // Redis key prefix (default: 'aq')
  
  enableCronManager: true,       // Enable worker scaling/cleanup (default: false)
  cronInterval: 5000,            // Scaling check interval (default: 5000ms)
  
  verbose: false,                // Enable verbose logging (default: false)
  
  workerDefaults: {
    concurrency: 1,              // Jobs processed simultaneously
    stalledInterval: 1000,       // Stalled job check interval (ms)
    lockDuration: 30000,         // Job lock duration (ms)
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
