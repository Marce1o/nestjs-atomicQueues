# atomic-queues

A NestJS library for atomic, sequential job processing per entity with BullMQ and Redis.

## What It Does

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              THE PROBLEM                                       ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                                ║
║   User has $100 balance. Two $80 withdrawals arrive at the same time:          ║
║                                                                                ║
║       Withdraw $80 ──┐                                                         ║
║          (API 1)     │    ┌────────────────────┐                               ║
║                      ├───▶│  Balance: $100     │                               ║
║       Withdraw $80 ──┘    │  Both read $100    │                               ║
║          (API 2)          │  Both approve      │                               ║
║                           │  Final: -$60 💥    │                               ║
║                           └────────────────────┘                               ║
║                                                                                ║
║   Race condition: Both transactions see $100, both succeed, balance goes -$60  ║
║                                                                                ║
╚═══════════════════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════════════════════════════════════════════════╗
║                              THE SOLUTION                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                                ║
║   atomic-queues processes one transaction at a time per account:               ║
║                                                                                ║
║       Withdraw $80 ──┐     ┌─────────────┐     ┌─────────────────────────────┐ ║
║          (API 1)     │     │             │     │ Worker processes queue:     │ ║
║                      ├────▶│ Redis Queue │────▶│                             │ ║
║       Withdraw $80 ──┘     │  [W1] [W2]  │     │  W1: $100 - $80 = $20 ✓     │ ║
║          (API 2)           │             │     │  W2: $20 < $80 = REJECTED ✓ │ ║
║                            └─────────────┘     └─────────────────────────────┘ ║
║                                                                                ║
║   Sequential processing: W1 completes first, W2 sees updated balance           ║
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

┌──────────────────┐
│   API Request    │   POST /accounts/ACC-123/withdraw { amount: 80 }
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  QueueBus.forProcessor(AccountProcessor).enqueue(new WithdrawCommand(...))   │
└────────┬─────────────────────────────────────────────────────────────────────┘
         │
         │  ① Reads @WorkerProcessor metadata from AccountProcessor
         │  ② Extracts accountId from command.accountId property
         │  ③ Generates queue name: "account-ACC-123-queue"
         │
         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              REDIS                                            │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Queue: account-ACC-123-queue                                          │  │
│  │  ┌─────────────────┬─────────────────┬─────────────────┐               │  │
│  │  │ Job 1           │ Job 2           │ Job 3           │  ...          │  │
│  │  │ WithdrawCommand │ DepositCommand  │ TransferCommand │               │  │
│  │  │ amount: 80      │ amount: 50      │ amount: 25      │               │  │
│  │  └─────────────────┴─────────────────┴─────────────────┘               │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Queue: account-ACC-456-queue  (different account = different queue)   │  │
│  │  ┌─────────────────┐                                                   │  │
│  │  │ Job 1           │  ← Processes in parallel with ACC-123             │  │
│  │  │ WithdrawCommand │                                                   │  │
│  │  └─────────────────┘                                                   │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
         │
         │  ④ BullMQ Worker pulls Job 1 (only one job at a time per queue)
         │
         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Worker: account-ACC-123-worker                                              │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  ⑤ Lookup "WithdrawCommand" in QueueBus.globalRegistry                  │ │
│  │  ⑥ Instantiate: Object.assign(new WithdrawCommand(), job.data)          │ │
│  │  ⑦ Execute: CommandBus.execute(withdrawCommand)                         │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└────────┬─────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  @CommandHandler(WithdrawCommand)                                            │
│  class WithdrawHandler {                                                     │
│    async execute(cmd: WithdrawCommand) {                                     │
│      // Safe! No race conditions - guaranteed sequential execution           │
│      const balance = await this.repo.getBalance(cmd.accountId);              │
│      if (balance < cmd.amount) throw new InsufficientFundsError();           │
│      await this.repo.debit(cmd.accountId, cmd.amount);                       │
│    }                                                                         │
│  }                                                                           │
└──────────────────────────────────────────────────────────────────────────────┘
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

A banking service handling critical financial transactions where race conditions could cause overdrafts or double-spending:

```typescript
// ─────────────────────────────────────────────────────────────────
// commands/withdraw.command.ts
// ─────────────────────────────────────────────────────────────────
export class WithdrawCommand {
  constructor(
    public readonly accountId: string,
    public readonly amount: number,
    public readonly transactionId: string,
    public readonly requestedBy: string,
  ) {}
}

// ─────────────────────────────────────────────────────────────────
// commands/deposit.command.ts
// ─────────────────────────────────────────────────────────────────
export class DepositCommand {
  constructor(
    public readonly accountId: string,
    public readonly amount: number,
    public readonly transactionId: string,
    public readonly source: string,
  ) {}
}

// ─────────────────────────────────────────────────────────────────
// commands/transfer.command.ts
// ─────────────────────────────────────────────────────────────────
export class TransferCommand {
  constructor(
    public readonly accountId: string,  // Source account (for queue routing)
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
      newBalance: account.balance 
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
        transactionId,
        `transfer:${accountId}`,
      ));
    
    return { success: true, transactionId };
  }
}

// ─────────────────────────────────────────────────────────────────
// account.processor.ts
// ─────────────────────────────────────────────────────────────────
import { Injectable } from '@nestjs/common';
import { WorkerProcessor } from 'atomic-queues';

@WorkerProcessor({
  entityType: 'account',
  queueName: (accountId) => `bank-account-${accountId}-queue`,
  workerName: (accountId) => `bank-account-${accountId}-worker`,
  workerConfig: {
    concurrency: 1,        // CRITICAL: Must be 1 for financial transactions
    lockDuration: 60000,   // 60s lock for long transactions
    stalledInterval: 5000,
  },
})
@Injectable()
export class AccountProcessor {}

// ─────────────────────────────────────────────────────────────────
// account.scaler.ts - Scale workers based on active accounts
// ─────────────────────────────────────────────────────────────────
import { Injectable } from '@nestjs/common';
import { EntityScaler, GetActiveEntities, GetDesiredWorkerCount } from 'atomic-queues';

@EntityScaler({
  entityType: 'account',
  maxWorkersPerEntity: 1,  // Never more than 1 worker per account
})
@Injectable()
export class AccountScaler {
  constructor(private readonly accountRepo: AccountRepository) {}

  @GetActiveEntities()
  async getActiveAccounts(): Promise<string[]> {
    // Return accounts with pending transactions
    return this.accountRepo.findAccountsWithPendingTransactions();
  }

  @GetDesiredWorkerCount()
  async getWorkerCount(accountId: string): Promise<number> {
    // Always 1 worker per account for atomicity
    return 1;
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
    AccountScaler,
    WithdrawHandler,    // Commands auto-discovered!
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
import { WithdrawCommand, DepositCommand, TransferCommand } from './commands';
import { v4 as uuid } from 'uuid';

@Controller('accounts')
export class AccountController {
  constructor(private readonly queueBus: QueueBus) {}

  @Post(':accountId/withdraw')
  async withdraw(
    @Param('accountId') accountId: string,
    @Body() body: { amount: number; requestedBy: string },
  ) {
    const transactionId = uuid();
    
    // Even if user spam-clicks "Withdraw", each request is queued
    // and processed sequentially - no double-withdrawals possible
    await this.queueBus
      .forProcessor(AccountProcessor)
      .enqueue(new WithdrawCommand(
        accountId,
        body.amount,
        transactionId,
        body.requestedBy,
      ));

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
