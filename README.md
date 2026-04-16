<div align="center">
<table><tr><td>
<pre>
 ╔═╗ ╔════╗ ╔═══╗ ╔══╗╔══╗ ╔╗ ╔═══╗
 ╠═╣   ╠╣   ║   ║ ║  ╚╝  ║ ║║ ║
 ║ ║   ╚╝   ╚═══╝ ║      ║ ║║ ╚═══╝
 ╔═══╗ ╔╗ ╔╗ ╔═══╗ ╔╗ ╔╗ ╔═══╗ ╔═══╗
 ║   ║ ║║ ║║ ╠═══╝ ║║ ║║ ╠═══╝ ╚══╗║
 ╚═══╝ ╚═══╝ ╚═══╝ ╚═══╝ ╚═══╝ ╚══╝╝
</pre>
</td></tr></table>

<strong>zero-contention · per-entity · lock-free</strong><br>
sequential processing for NestJS

</div>

<p align="center">
  <img src="https://img.shields.io/npm/v/atomic-queues?style=flat-square&color=cb3837" alt="npm version" />
  <img src="https://img.shields.io/badge/NestJS-11-ea2845?style=flat-square&logo=nestjs" alt="NestJS 11" />
  <img src="https://img.shields.io/badge/BullMQ-5-3c873a?style=flat-square" alt="BullMQ 5" />
  <img src="https://img.shields.io/badge/Redis-7-dc382d?style=flat-square&logo=redis&logoColor=white" alt="Redis 7" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License" />
</p>

---

## Why atomic-queues?

Distributed locks (Redlock, advisory locks, optimistic locking) all share the same fundamental flaw: **contention collapse**. When multiple pods fight for the same lock simultaneously, they spend more time retrying failed acquisitions than doing actual work. The harder you push, the slower they go.

**atomic-queues** eliminates contention entirely. Instead of locking, each entity gets its own dedicated BullMQ queue. Operations execute sequentially — back-to-back with zero wasted cycles. There's nothing to contend over.

### atomic-queues vs Redlock

| | Redlock | atomic-queues |
|---|---|---|
| **Architecture** | Distributed mutex (quorum-based) | Per-entity queue (sequential) |
| **Under contention** | Degrades — retry storms, backoff delays | **Constant** — jobs queue up, execute instantly |
| **Failure mode** | Silent double-execution (clock drift) | Job stuck in queue (visible, retryable) |
| **Split-brain risk** | Yes (timing assumptions) | **Impossible** (serial queue) |
| **Warm-path overhead** | Acquire + release per op | **0 Redis calls** (in-memory hot cache) |
| **Cold-start** | None | One-time per entity |
| **Multi-pod scaling** | Contention increases with pods | **Throughput increases with pods** |

---

## Table of Contents

- [Why atomic-queues?](#why-atomic-queues)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands & Decorators](#commands--decorators)
- [Configuration](#configuration)
- [Distributed Worker Lifecycle](#distributed-worker-lifecycle)
- [Complete Example](#complete-example)
- [Advanced: Custom Worker Processors](#advanced-custom-worker-processors)
- [Performance](#performance)
- [License](#license)

---

## How It Works

### The Problem

Every distributed system eventually hits this:

```
Time    Request A                    Request B                    Database
──────────────────────────────────────────────────────────────────────────
T₀      SELECT balance → $100        SELECT balance → $100        $100
T₁      CHECK: $100 ≥ $80 ✓          CHECK: $100 ≥ $80 ✓
T₂      UPDATE: $100 − $80 = $20                                  $20
T₃                                   UPDATE: $100 − $80 = $20     −$60
──────────────────────────────────────────────────────────────────────────
Result: Balance is −$60. Both withdrawals succeed. Integrity violated.
```

### The Solution

atomic-queues routes operations through per-entity queues. Same entity → same queue → sequential execution. Different entities → parallel queues → full throughput.

```
                        ┌─────────────────────────────────────────────────┐
  Request A ─┐          │           Entity: account-42                    │
             │          │  ┌──────┐  ┌──────┐  ┌──────┐                  │
  Request B ─┼─► Route ─┼─►│ Op 1 │─►│ Op 2 │─►│ Op 3 │─► [Worker] ──┐  │
             │          │  └──────┘  └──────┘  └──────┘               │  │
  Request C ─┘          │                    Sequential ◄─────────────┘  │
                        └─────────────────────────────────────────────────┘

                        ┌─────────────────────────────────────────────────┐
  Request D ─┐          │           Entity: account-99                    │
             │          │  ┌──────┐  ┌──────┐                            │
  Request E ─┼─► Route ─┼─►│ Op 1 │─►│ Op 2 │─────────► [Worker] ──┐    │
             │          │  └──────┘  └──────┘                       │    │
  Request F ─┘          │                    Sequential ◄───────────┘    │
                        └─────────────────────────────────────────────────┘

                        ▲ These two queues run in PARALLEL across pods ▲
```

**Key properties:**
- **One worker per entity** — enforced via Redis heartbeat TTL. No duplicates, ever.
- **Auto-spawn** — workers materialize when jobs arrive, on the pod that sees them first.
- **Auto-terminate** — idle workers shut down after a configurable timeout.
- **Self-healing** — node failure → heartbeat expires → worker respawns on a healthy pod.
- **Distributed** — workers spread across all pods via atomic `SET NX` claim. No leader election, no single point of failure.

---

## Installation

```bash
npm install atomic-queues
```

BullMQ, ioredis, and `@nestjs/bullmq` are bundled — no extra installs needed.

**Peer dependencies** (provided by your NestJS app): `@nestjs/common` 10+, `@nestjs/core` 10+, `reflect-metadata`, `rxjs` 7+. Optional: `@nestjs/cqrs` (for auto-routing commands/queries).

---

## Quick Start

### 1. Configure the Module

```typescript
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AtomicQueuesModule } from 'atomic-queues';

@Module({
  imports: [
    CqrsModule,
    AtomicQueuesModule.forRoot({
      redis: { host: 'localhost', port: 6379 },
      keyPrefix: 'myapp',
      entities: {
        account: {
          queueName: (id) => `account-${id}-queue`,
          workerName: (id) => `account-${id}-worker`,
          maxWorkersPerEntity: 1,
          idleTimeoutSeconds: 15,
        },
      },
    }),
  ],
})
export class AppModule {}
```

> **Tip:** The `entities` config is optional. Without it, default naming applies: `{keyPrefix}:{entityType}:{entityId}:queue`.

<details>
<summary><strong>Async configuration (ConfigService)</strong></summary>

```typescript
AtomicQueuesModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    redis: { url: config.get('REDIS_URL') },
    keyPrefix: 'myapp',
    entities: {
      account: {
        queueName: (id) => `account-${id}-queue`,
        workerName: (id) => `account-${id}-worker`,
      },
    },
  }),
  inject: [ConfigService],
}),
```

</details>

### 2. Define Commands

```typescript
import { QueueEntity, QueueEntityId } from 'atomic-queues';

@QueueEntity('account')
export class WithdrawCommand {
  constructor(
    @QueueEntityId() public readonly accountId: string,
    public readonly amount: number,
  ) {}
}

@QueueEntity('account')
export class DepositCommand {
  constructor(
    @QueueEntityId() public readonly accountId: string,
    public readonly amount: number,
  ) {}
}
```

### 3. Write Handlers (standard @nestjs/cqrs)

```typescript
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

@CommandHandler(WithdrawCommand)
export class WithdrawHandler implements ICommandHandler<WithdrawCommand> {
  constructor(private readonly repo: AccountRepository) {}

  async execute({ accountId, amount }: WithdrawCommand) {
    // SAFE: No race conditions. Sequential execution per account.
    const account = await this.repo.findById(accountId);

    if (account.balance < amount) {
      throw new InsufficientFundsError(accountId, account.balance, amount);
    }

    account.balance -= amount;
    await this.repo.save(account);
  }
}
```

### 4. Enqueue Jobs

```typescript
import { Injectable } from '@nestjs/common';
import { QueueBus } from 'atomic-queues';

@Injectable()
export class AccountService {
  constructor(private readonly queueBus: QueueBus) {}

  async withdraw(accountId: string, amount: number) {
    await this.queueBus.enqueue(new WithdrawCommand(accountId, amount));
  }
}
```

**That's it.** The library automatically:
1. Creates a queue for each `accountId` when jobs arrive
2. Spawns a worker (spread across pods) to process jobs sequentially
3. Routes jobs to the correct `@CommandHandler` via CQRS
4. Terminates idle workers after the configured timeout
5. Self-heals if a pod dies (heartbeat expires → respawn elsewhere)

---

## Commands & Decorators

### `@QueueEntity(entityType, entityIdProperty?)`

Marks a command/query class for queue routing. The optional second argument specifies which property holds the entity ID — this is the simplest approach when you don't want to decorate individual properties.

```typescript
// Option 1: Explicit property name (no @QueueEntityId needed)
@QueueEntity('account', 'accountId')
export class TransferCommand {
  constructor(
    public readonly accountId: string,
    public readonly toAccountId: string,
    public readonly amount: number,
  ) {}
}

// Option 2: Rely on module-level defaultEntityId from entities config
@QueueEntity('account')
export class DepositCommand {
  constructor(
    public readonly accountId: string,  // Matched by entities.account.defaultEntityId
    public readonly amount: number,
  ) {}
}
```

### `@QueueEntityId()`

Marks the property that contains the entity ID. One per class. Use this when you need per-command control over which property is the entity ID, or when you can't use the two-argument `@QueueEntity` shorthand.

```typescript
@QueueEntity('account')
export class TransferCommand {
  constructor(
    @QueueEntityId() public readonly accountId: string,  // Routes to this account's queue
    public readonly targetAccountId: string,
    public readonly amount: number,
  ) {}
}
```

> **Entity ID resolution order:** `@QueueEntityId()` decorator > `@QueueEntity('type', 'prop')` second argument > `@WorkerProcessor({ defaultEntityId })` > `entities[type].defaultEntityId` in module config.

### `@WorkerProcessor(options)`

Optional. Define a processor class for custom job handling on top of CQRS auto-routing.

```typescript
@WorkerProcessor({
  entityType: 'account',
  queueName: (id) => `account-${id}-queue`,
  workerName: (id) => `account-${id}-worker`,
  maxWorkersPerEntity: 1,
  idleTimeoutSeconds: 15,
})
@Injectable()
export class AccountProcessor {
  @JobHandler('special-audit')
  async handleAudit(job: Job, entityId: string) { ... }
}
```

### `@JobHandler(jobName)` / `@JobHandler('*')`

Custom job handlers on a `@WorkerProcessor`. The wildcard `'*'` catches anything not matched by a specific handler.

---

## Configuration

```typescript
AtomicQueuesModule.forRoot({
  // ── Redis connection ──────────────────────────────────────
  redis: {
    host: 'redis',
    port: 6379,
    password: 'secret',       // optional
  },

  // ── Global settings ───────────────────────────────────────
  keyPrefix: 'myapp',          // Redis key namespace (default: 'aq')
  enableCronManager: true,     // Legacy cron-based scaling (optional)
  cronInterval: 5000,          // Cron tick interval in ms

  // ── Worker defaults ───────────────────────────────────────
  workerDefaults: {
    concurrency: 1,            // Jobs processed concurrently per worker
    stalledInterval: 1000,     // ms between stalled-job checks
    lockDuration: 30000,       // ms a job is locked during processing
    heartbeatTTL: 3,           // Heartbeat key TTL in seconds
  },

  // ── Per-entity configuration (optional) ───────────────────
  entities: {
    account: {
      queueName: (id) => `account-${id}-queue`,
      workerName: (id) => `account-${id}-worker`,
      maxWorkersPerEntity: 1,
      idleTimeoutSeconds: 15,

      // Fallback property name for entity ID extraction.
      // Used when a command has no @QueueEntityId() decorator
      // and no second argument to @QueueEntity().
      defaultEntityId: 'accountId',

      workerConfig: {          // Override workerDefaults per entity
        concurrency: 1,
        lockDuration: 60000,
      },
    },
  },
});
```

---

## Distributed Worker Lifecycle

Workers in atomic-queues have a fully automated lifecycle, distributed across all pods with no leader election:

```
  Job arrives                   SET NX claim
  on any pod  ──────►  ┌──────────────────────┐
                        │  Pod claims worker?   │
                        └──────┬───────┬───────┘
                           YES │       │ NO (another pod won)
                               ▼       ▼
                        ┌────────┐  ┌──────────────┐
                        │ Spawn  │  │ Wait — other │
                        │ worker │  │ pod handles  │
                        │ locally│  └──────────────┘
                        └───┬────┘
                            ▼
                     ┌──────────────┐
                     │  Processing  │◄──── Heartbeat refresh (pipeline)
                     │  jobs back-  │      every 1s (1 Redis round-trip)
                     │  to-back     │
                     └──────┬───────┘
                            │ No jobs for idleTimeoutSeconds
                            ▼
                     ┌──────────────┐
                     │  Idle sweep  │──── Hot cache eviction
                     │  closes      │     Heartbeat keys cleaned up
                     │  worker      │
                     └──────────────┘
```

### Hot Cache

After a worker is confirmed alive, subsequent job arrivals for that entity hit an **in-memory cache** — zero Redis calls on the warm path. This eliminates the per-job Redis overhead that plagues lock-based approaches.

| Path | Redis calls | When |
|---|---|---|
| **Hot** (cache hit) | 0 | Worker known alive |
| **Warm** (cache miss) | 1 (`EXISTS`) | First time seeing entity |
| **Cold** (no worker) | 1 (`SET NX`) | Worker needs creation |

### SpawnQueueService

For multi-pod deployments, the `SpawnQueueService` distributes worker creation across all pods via a shared BullMQ spawn queue. The **direct local spawn** path bypasses this queue entirely — the pod that first sees a job for a new entity claims it with an atomic `SET NX` and spawns the worker locally.

---

## Complete Example

A banking service with withdrawals, deposits, and cross-account transfers:

```typescript
// ── Module ──────────────────────────────────────────────
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AtomicQueuesModule } from 'atomic-queues';

@Module({
  imports: [
    CqrsModule,
    AtomicQueuesModule.forRoot({
      redis: { host: 'redis', port: 6379 },
      keyPrefix: 'banking',
      entities: {
        account: {
          queueName: (id) => `account-${id}-queue`,
          workerName: (id) => `account-${id}-worker`,
          maxWorkersPerEntity: 1,
          idleTimeoutSeconds: 15,
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
})
export class BankingModule {}

// ── Commands ────────────────────────────────────────────
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

@QueueEntity('account')
export class TransferCommand {
  constructor(
    @QueueEntityId() public readonly accountId: string,
    public readonly toAccountId: string,
    public readonly amount: number,
  ) {}
}

// ── Handlers ────────────────────────────────────────────
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

@CommandHandler(WithdrawCommand)
export class WithdrawHandler implements ICommandHandler<WithdrawCommand> {
  constructor(private readonly repo: AccountRepository) {}

  async execute({ accountId, amount }: WithdrawCommand) {
    const account = await this.repo.findById(accountId);
    if (account.balance < amount) throw new InsufficientFundsError();
    account.balance -= amount;
    await this.repo.save(account);
  }
}

@CommandHandler(TransferCommand)
export class TransferHandler implements ICommandHandler<TransferCommand> {
  constructor(
    private readonly repo: AccountRepository,
    private readonly queueBus: QueueBus,
  ) {}

  async execute({ accountId, toAccountId, amount }: TransferCommand) {
    // Debit source (we're in source account's queue — safe)
    const source = await this.repo.findById(accountId);
    if (source.balance < amount) throw new InsufficientFundsError();
    source.balance -= amount;
    await this.repo.save(source);

    // Credit destination (enqueued to destination's queue — also safe)
    await this.queueBus.enqueue(
      new DepositCommand(toAccountId, amount, `transfer:${accountId}`),
    );
  }
}

// ── Controller ──────────────────────────────────────────
import { Controller, Post, Body, Param } from '@nestjs/common';
import { QueueBus } from 'atomic-queues';

@Controller('accounts')
export class AccountController {
  constructor(private readonly queueBus: QueueBus) {}

  @Post(':id/withdraw')
  async withdraw(@Param('id') id: string, @Body() body: { amount: number }) {
    await this.queueBus.enqueue(new WithdrawCommand(id, body.amount, uuid()));
    return { queued: true };
  }

  @Post(':id/transfer')
  async transfer(
    @Param('id') id: string,
    @Body() body: { to: string; amount: number },
  ) {
    await this.queueBus.enqueue(new TransferCommand(id, body.to, body.amount));
    return { queued: true };
  }
}
```

---

## Advanced: Custom Worker Processors

For cases where CQRS auto-routing isn't enough, define a `@WorkerProcessor` with explicit `@JobHandler` methods:

```typescript
import { Injectable } from '@nestjs/common';
import { WorkerProcessor, JobHandler } from 'atomic-queues';
import { Job } from 'bullmq';

@WorkerProcessor({
  entityType: 'account',
  queueName: (id) => `account-${id}-queue`,
  workerName: (id) => `account-${id}-worker`,
  maxWorkersPerEntity: 1,
  idleTimeoutSeconds: 15,
})
@Injectable()
export class AccountProcessor {
  @JobHandler('high-priority-audit')
  async handleAudit(job: Job, entityId: string) {
    // Specific handler for this job type
  }

  @JobHandler('*')
  async handleAll(job: Job, entityId: string) {
    // Wildcard — catches everything not explicitly handled
    // Falls back to CQRS routing automatically when not defined
  }
}
```

> **Priority order:** Explicit `@JobHandler` → CQRS auto-routing (`@JobCommand`/`@JobQuery`) → Wildcard handler

---

## Performance

### Why it's fast

1. **Zero contention** — no locks, no retries, no backoff. Jobs queue and execute.
2. **Hot cache** — after first check, subsequent job arrivals for an entity incur 0 Redis calls.
3. **Direct local spawn** — atomic `SET NX` claim, local worker creation. No queue round-trip.
4. **Pipelined heartbeats** — heartbeat refresh uses a single Redis pipeline (1 round-trip for 2 keys).
5. **O(1) worker existence check** — global alive key replaces `KEYS` pattern scan.

### When to use what

| Use case | Recommendation |
|---|---|
| Per-entity operations that must be serialized (payments, inventory, game state) | **atomic-queues** |
| Rare, low-frequency mutual exclusion (config updates, migrations) | Redlock / advisory locks |
| Exactly-once semantics with audit trail | **atomic-queues** (BullMQ job IDs) |
| Sub-millisecond synchronous response required | Redlock (synchronous acquire) |
| Multi-pod, many entities, sustained load | **atomic-queues** (contention-free scaling) |

---

## License

MIT
