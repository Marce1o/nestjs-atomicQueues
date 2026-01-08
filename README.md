# atomic-queues

A NestJS library for atomic, sequential job processing per entity using BullMQ and Redis.

---

## Table of Contents

- [Overview](#overview)
- [The Concurrency Problem](#the-concurrency-problem)
- [The Per-Entity Queue Architecture](#the-per-entity-queue-architecture)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands and Decorators](#commands-and-decorators)
- [Configuration](#configuration)
- [Complete Example](#complete-example)
- [Advanced: Custom Worker Processors](#advanced-custom-worker-processors)
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

With atomic-queues, operations are queued and processed sequentially:

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

## The Per-Entity Queue Architecture

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

**Key features:**
- Each entity has exactly one active worker (enforced via Redis heartbeat)
- Workers spawn automatically when jobs arrive
- Workers terminate after configurable idle period
- Node failure → heartbeat expires → worker respawns on healthy node

---

## Installation

```bash
npm install atomic-queues bullmq ioredis
```

---

## Quick Start

### 1. Configure the Module

The `entities` configuration is **optional**. Choose the approach that fits your needs:

#### Option A: Minimal Setup (uses default naming)

```typescript
import { Module } from '@nestjs/common';
import { AtomicQueuesModule } from 'atomic-queues';

@Module({
  imports: [
    AtomicQueuesModule.forRoot({
      redis: { host: 'localhost', port: 6379 },
      keyPrefix: 'myapp',
      enableCronManager: true,
      // No entities config needed! Uses default naming:
      // Queue: {keyPrefix}:{entityType}:{entityId}:queue
      // Worker: {keyPrefix}:{entityType}:{entityId}:worker
    }),
  ],
})
export class AppModule {}
```

#### Option B: Custom Queue/Worker Naming (via entities config)

```typescript
@Module({
  imports: [
    AtomicQueuesModule.forRoot({
      redis: { host: 'localhost', port: 6379 },
      keyPrefix: 'myapp',
      enableCronManager: true,
      
      // Optional: Define custom naming and settings per entity type
      entities: {
        account: {
          queueName: (id) => `${id}-queue`,        // Custom queue naming
          workerName: (id) => `${id}-worker`,      // Custom worker naming
          maxWorkersPerEntity: 1,
          idleTimeoutSeconds: 15,
        },
      },
    }),
  ],
})
export class AppModule {}
```

#### Option C: Custom Naming via @WorkerProcessor

For advanced use cases, define a processor class instead of entities config:

```typescript
@WorkerProcessor({
  entityType: 'account',
  queueName: (id) => `${id}-queue`,
  workerName: (id) => `${id}-worker`,
  maxWorkersPerEntity: 1,
  idleTimeoutSeconds: 15,
})
@Injectable()
export class AccountProcessor {}
```

> **When to use each:**
> - **Option A**: Default naming works for you
> - **Option B**: Need custom naming but no custom job handling logic
> - **Option C**: Need custom naming AND custom `@JobHandler` methods

### 2. Create Commands with Decorators

```typescript
import { QueueEntity, QueueEntityId } from 'atomic-queues';

@QueueEntity('account')
export class WithdrawCommand {
  constructor(
    @QueueEntityId() public readonly accountId: string,
    public readonly amount: number,
    public readonly transactionId: string,
  ) {}
}

@QueueEntity('account')
export class DepositCommand {
  constructor(
    @QueueEntityId() public readonly accountId: string,
    public readonly amount: number,
    public readonly source: string,
  ) {}
}
```

### 3. Create Command Handlers (standard @nestjs/cqrs)

```typescript
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { WithdrawCommand } from './commands';

@CommandHandler(WithdrawCommand)
export class WithdrawHandler implements ICommandHandler<WithdrawCommand> {
  constructor(private readonly accountRepo: AccountRepository) {}

  async execute(command: WithdrawCommand) {
    const { accountId, amount, transactionId } = command;
    
    // SAFE: No race conditions! Processed sequentially per account.
    const account = await this.accountRepo.findById(accountId);
    
    if (account.balance < amount) {
      throw new InsufficientFundsError(accountId, account.balance, amount);
    }
    
    account.balance -= amount;
    await this.accountRepo.save(account);
    
    return { success: true, newBalance: account.balance };
  }
}
```

### 4. Enqueue Jobs

```typescript
import { Injectable } from '@nestjs/common';
import { QueueBus } from 'atomic-queues';
import { WithdrawCommand, DepositCommand } from './commands';

@Injectable()
export class AccountService {
  constructor(private readonly queueBus: QueueBus) {}

  async withdraw(accountId: string, amount: number, transactionId: string) {
    // Command is automatically routed to the account's queue
    await this.queueBus.enqueue(new WithdrawCommand(accountId, amount, transactionId));
  }

  async deposit(accountId: string, amount: number, source: string) {
    await this.queueBus.enqueue(new DepositCommand(accountId, amount, source));
  }
}
```

**That's it!** The library automatically:
- Creates a queue for each `accountId` when jobs arrive
- Spawns a worker to process jobs sequentially
- Routes jobs to the correct `@CommandHandler`
- Terminates idle workers after the configured timeout

---

## Commands and Decorators

### @QueueEntity(entityType)

Marks a command class for queue routing. The `entityType` must match a key in your `entities` config.

```typescript
@QueueEntity('account')
export class TransferCommand { ... }
```

### @QueueEntityId()

Marks which property contains the entity ID for queue routing. Only one per class.

```typescript
@QueueEntity('account')
export class TransferCommand {
  constructor(
    @QueueEntityId() public readonly sourceAccountId: string,  // Routes to source account's queue
    public readonly targetAccountId: string,
    public readonly amount: number,
  ) {}
}
```

### Alternative: Use defaultEntityId

If all commands for an entity use the same property name, configure it once:

```typescript
// In module config
entities: {
  account: {
    defaultEntityId: 'accountId',  // Commands without @QueueEntityId use this
    // ...
  },
}

// Then commands don't need @QueueEntityId
@QueueEntity('account')
export class WithdrawCommand {
  constructor(
    public readonly accountId: string,  // Automatically used
    public readonly amount: number,
  ) {}
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
  enableCronManager: true,       // Enable worker lifecycle management
  cronInterval: 5000,            // Scaling check interval (ms)
  
  workerDefaults: {
    concurrency: 1,              // Jobs processed simultaneously
    stalledInterval: 1000,       // Stalled job check interval (ms)
    lockDuration: 30000,         // Job lock duration (ms)
    heartbeatTTL: 3,             // Worker heartbeat TTL (seconds)
  },
  
  // OPTIONAL: Per-entity configuration
  // If omitted, uses default naming: {keyPrefix}:{entityType}:{entityId}:queue/worker
  entities: {
    account: {
      defaultEntityId: 'accountId',
      queueName: (id) => `${id}-queue`,
      workerName: (id) => `${id}-worker`,
      maxWorkersPerEntity: 1,
      idleTimeoutSeconds: 15,
      autoSpawn: true,           // Default: true
      workerConfig: {            // Override defaults per entity
        concurrency: 1,
        lockDuration: 60000,
      },
    },
    order: {
      defaultEntityId: 'orderId',
      queueName: (id) => `order-${id}-queue`,
      idleTimeoutSeconds: 30,
    },
  },
});
```

---

## Complete Example

A banking service handling financial transactions:

```typescript
// ─────────────────────────────────────────────────────────────────
// app.module.ts
// ─────────────────────────────────────────────────────────────────
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AtomicQueuesModule } from 'atomic-queues';

@Module({
  imports: [
    CqrsModule,
    AtomicQueuesModule.forRoot({
      redis: { host: 'localhost', port: 6379 },
      keyPrefix: 'banking',
      enableCronManager: true,
      entities: {
        account: {
          queueName: (id) => `${id}-queue`,
          workerName: (id) => `${id}-worker`,
          maxWorkersPerEntity: 1,
          idleTimeoutSeconds: 15,
          workerConfig: {
            concurrency: 1,
            lockDuration: 60000,
          },
        },
      },
    }),
  ],
  providers: [
    AccountService,
    WithdrawHandler,
    DepositHandler,
    TransferHandler,
  ],
  controllers: [AccountController],
})
export class AppModule {}

// ─────────────────────────────────────────────────────────────────
// commands/withdraw.command.ts
// ─────────────────────────────────────────────────────────────────
import { QueueEntity, QueueEntityId } from 'atomic-queues';

@QueueEntity('account')
export class WithdrawCommand {
  constructor(
    @QueueEntityId() public readonly accountId: string,
    public readonly amount: number,
    public readonly transactionId: string,
  ) {}
}

// ─────────────────────────────────────────────────────────────────
// commands/deposit.command.ts
// ─────────────────────────────────────────────────────────────────
import { QueueEntity, QueueEntityId } from 'atomic-queues';

@QueueEntity('account')
export class DepositCommand {
  constructor(
    @QueueEntityId() public readonly accountId: string,
    public readonly amount: number,
    public readonly source: string,
  ) {}
}

// ─────────────────────────────────────────────────────────────────
// commands/transfer.command.ts
// ─────────────────────────────────────────────────────────────────
import { QueueEntity, QueueEntityId } from 'atomic-queues';

@QueueEntity('account')
export class TransferCommand {
  constructor(
    @QueueEntityId() public readonly accountId: string,  // Source account
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
  constructor(private readonly accountRepo: AccountRepository) {}

  async execute(command: WithdrawCommand) {
    const { accountId, amount } = command;
    
    // SAFE: Sequential execution per account
    const account = await this.accountRepo.findById(accountId);
    
    if (account.balance < amount) {
      throw new InsufficientFundsError(accountId, account.balance, amount);
    }
    
    account.balance -= amount;
    await this.accountRepo.save(account);
    
    return { success: true, newBalance: account.balance };
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
    const { accountId, toAccountId, amount } = command;
    
    // Debit source (we're in source account's queue)
    const source = await this.accountRepo.findById(accountId);
    if (source.balance < amount) {
      throw new InsufficientFundsError(accountId, source.balance, amount);
    }
    
    source.balance -= amount;
    await this.accountRepo.save(source);
    
    // Credit destination (enqueued to destination's queue)
    await this.queueBus.enqueue(new DepositCommand(
      toAccountId,
      amount,
      `transfer:${accountId}`,
    ));
    
    return { success: true };
  }
}

// ─────────────────────────────────────────────────────────────────
// account.controller.ts
// ─────────────────────────────────────────────────────────────────
import { Controller, Post, Body, Param } from '@nestjs/common';
import { QueueBus } from 'atomic-queues';
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
    
    await this.queueBus.enqueue(
      new WithdrawCommand(accountId, body.amount, transactionId)
    );

    return { queued: true, transactionId };
  }

  @Post(':accountId/transfer')
  async transfer(
    @Param('accountId') accountId: string,
    @Body() body: { toAccountId: string; amount: number },
  ) {
    const transactionId = uuid();
    
    await this.queueBus.enqueue(
      new TransferCommand(accountId, body.toAccountId, body.amount, transactionId)
    );

    return { queued: true, transactionId };
  }
}
```

---

## Advanced: Custom Worker Processors

For special cases where you need custom job handling logic, you can still define a `@WorkerProcessor`:

```typescript
import { Injectable } from '@nestjs/common';
import { WorkerProcessor, JobHandler } from 'atomic-queues';
import { Job } from 'bullmq';

@WorkerProcessor({
  entityType: 'account',
  queueName: (id) => `${id}-queue`,
  workerName: (id) => `${id}-worker`,
  maxWorkersPerEntity: 1,
  idleTimeoutSeconds: 15,
})
@Injectable()
export class AccountProcessor {
  // Custom handler for specific job types
  @JobHandler('special-operation')
  async handleSpecialOperation(job: Job, entityId: string) {
    // Custom logic here
  }

  // Wildcard handler for everything else
  @JobHandler('*')
  async handleAll(job: Job, entityId: string) {
    // Falls back to CQRS routing automatically
  }
}
```

**Note:** When you define a `@WorkerProcessor` for an entity type, it takes precedence over config-based default registration.

---

## License

MIT
