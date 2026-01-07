# atomic-queues

A NestJS library for atomic, sequential job processing per entity using BullMQ and Redis.

---

## Table of Contents

- [Overview](#overview)
- [The Concurrency Problem](#the-concurrency-problem)
  - [Race Condition Scenario](#race-condition-scenario)
  - [Traditional Solutions and Their Limitations](#traditional-solutions-and-their-limitations)
- [The Per-Entity Queue Architecture](#the-per-entity-queue-architecture)
  - [Design Principle](#design-principle)
  - [Correctness Under Load](#correctness-under-load)
- [Comparative Analysis](#comparative-analysis)
  - [Behavioral Characteristics](#behavioral-characteristics)
  - [Scalability Profile](#scalability-profile)
- [Architecture](#architecture)
  - [Alignment with Node.js Event Loop Philosophy](#alignment-with-nodejs-event-loop-philosophy)
  - [Multi-Pod Kubernetes Deployments](#multi-pod-kubernetes-deployments)
  - [Distributed Systems Guarantees](#distributed-systems-guarantees)
  - [Request Flow in Multi-Pod Deployment](#request-flow-in-multi-pod-deployment)
  - [Horizontal Scaling Model](#horizontal-scaling-model)
  - [Dynamic Worker Lifecycle](#dynamic-worker-lifecycle)
- [Use Cases](#use-cases)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [QueueBus](#queuebus)
  - [@WorkerProcessor](#workerprocessor)
- [Entity ID Extraction](#entity-id-extraction)
- [Scaling with Entity Scalers](#scaling-with-entity-scalers)
- [Advanced Features](#advanced-features)
- [Configuration Reference](#configuration-reference)
- [License](#license)

---

## Overview

**atomic-queues** solves the fundamental concurrency problem in distributed systems: ensuring that operations on the same logical entity execute sequentially, even when requests arrive simultaneously across multiple service instances.

Rather than relying on distributed locks—which introduce contention, latency degradation, and complex failure modes—this library implements a **per-entity queue architecture** where each entity (user account, game table, order, document) has its own dedicated processing queue and worker.

---

## The Concurrency Problem

### Race Condition Scenario

Consider a financial system where a user with a $100 balance submits two concurrent $80 withdrawal requests:

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

This occurs because both transactions read the balance before either writes, a classic **lost update anomaly**.

### Traditional Solutions and Their Limitations

| Approach | Mechanism | Failure Mode |
|----------|-----------|--------------|
| **Distributed Locks (Redlock)** | Acquire lock before operation, release after | Lock contention storms under high throughput; exponential latency degradation; lock holder failure requires TTL expiration |
| **Database Row Locks** | `SELECT ... FOR UPDATE` | Connection pool exhaustion; deadlock risk in multi-entity transactions; database becomes bottleneck |
| **Optimistic Concurrency Control** | Version numbers with conditional updates | Retry storms under contention; unbounded retries on hot entities; wasted compute cycles |
| **Application Semaphores** | In-memory mutex/semaphore | Single-process only; ineffective in horizontally scaled deployments |

**Fundamental limitation**: These approaches attempt to serialize access at the *moment of execution*. Under high contention, this creates a thundering herd where N requests compete for the same resource simultaneously.

---

## The Per-Entity Queue Architecture

### Design Principle

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

## Comparative Analysis

### Behavioral Characteristics

| Characteristic            | Distributed Locks                     | Per-Entity Queues                               |
|-------------------------  |-------------------------------------- |-------------------                              |
| **Request Handling**      | Block until lock acquired             | Queue immediately, return                       |
| **Latency Distribution**  | Bimodal (fast if uncontested)         | Predictable (queue depth × avg processing time) |
| **Throughput Ceiling**    | Limited by lock contention            | Limited only by worker processing rate          |
| **Failure Recovery**      | Stuck locks until TTL expiration      | Failed jobs retry or move to dead-letter queue  |
| **Ordering Guarantees**   | Non-deterministic (race to acquire)   | Deterministic FIFO                              |
| **Observability**         | Lock wait times difficult to measure  | Queue depth, throughput directly observable     |

### Scalability Profile

```
Throughput
    ▲
    │                                    ╭──── Per-Entity Queues
    │                                ╭───╯     (linear scaling)
    │                            ╭───╯
    │                        ╭───╯
    │                    ╭───╯
    │                ╭───╯         ╭────── Distributed Locks
    │            ╭───╯         ╭───╯       (contention ceiling)
    │        ╭───╯         ╭───╯
    │    ╭───╯     ╭───────╯
    │╭───╯ ╭───────╯
    ├──────╯
    └──────────────────────────────────────────────▶ Concurrent Requests

    Lock-based systems hit a contention ceiling where adding more 
    requests increases wait time faster than throughput.
    
    Queue-based systems scale linearly: each entity's queue is 
    independent, so Entity A's load doesn't affect Entity B.
```

---

## Architecture

### Alignment with Node.js Event Loop Philosophy

Node.js achieves high concurrency not through multi-threading, but through an **event-driven, non-blocking I/O model**. The single-threaded event loop processes events sequentially, delegating I/O operations to the system kernel and handling callbacks as they complete.

**atomic-queues** extends this philosophy to distributed systems:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     NODE.JS EVENT LOOP MODEL                                     │
│                                                                                  │
│    ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐             │
│    │  Event   │────▶│  Event   │────▶│  Event   │────▶│  Event   │────▶ ...    │
│    │    1     │     │    2     │     │    3     │     │    4     │             │
│    └──────────┘     └──────────┘     └──────────┘     └──────────┘             │
│         │                                                                        │
│         ▼                                                                        │
│    Single-threaded sequential processing prevents race conditions               │
│    within a single process. But what about multiple processes?                  │
│                                                                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                     ATOMIC-QUEUES DISTRIBUTED MODEL                              │
│                                                                                  │
│    ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐             │
│    │   Job    │────▶│   Job    │────▶│   Job    │────▶│   Job    │────▶ ...    │
│    │    1     │     │    2     │     │    3     │     │    4     │             │
│    └──────────┘     └──────────┘     └──────────┘     └──────────┘             │
│         │                                                                        │
│         ▼                                                                        │
│    Per-entity queue + single worker = event loop semantics at cluster scale    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

| Concept | Node.js Event Loop | atomic-queues |
|---------|-------------------|---------------|
| **Unit of Work** | Event/Callback | Job |
| **Serialization Mechanism** | Single thread | Single worker per entity |
| **Concurrency Model** | Non-blocking I/O | Async job processing |
| **Scope** | Single process | Distributed cluster |

This alignment means developers familiar with Node.js concurrency patterns will find the mental model intuitive: just as the event loop prevents race conditions within a process, per-entity queues prevent race conditions across a distributed cluster.

### Multi-Pod Kubernetes Deployments

In containerized environments, services scale horizontally through pod replication. Each pod runs an independent instance of the application, creating the distributed concurrency challenge this library solves.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         KUBERNETES CLUSTER                                       │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         Service: account-service                         │    │
│  │                         Replicas: 6 pods                                 │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                      │                                           │
│                          Load Balancer / Ingress                                │
│                                      │                                           │
│         ┌────────────────────────────┼────────────────────────────┐             │
│         │                            │                            │             │
│         ▼                            ▼                            ▼             │
│  ┌─────────────┐              ┌─────────────┐              ┌─────────────┐      │
│  │   Node 1    │              │   Node 2    │              │   Node 3    │      │
│  │             │              │             │              │             │      │
│  │ ┌─────────┐ │              │ ┌─────────┐ │              │ ┌─────────┐ │      │
│  │ │ Pod 1   │ │              │ │ Pod 3   │ │              │ │ Pod 5   │ │      │
│  │ │ workers:│ │              │ │ workers:│ │              │ │ workers:│ │      │
│  │ │ ACC-001 │ │              │ │ ACC-003 │ │              │ │ ACC-007 │ │      │
│  │ │ ACC-002 │ │              │ │ ACC-005 │ │              │ │ ACC-009 │ │      │
│  │ └─────────┘ │              │ └─────────┘ │              │ └─────────┘ │      │
│  │ ┌─────────┐ │              │ ┌─────────┐ │              │ ┌─────────┐ │      │
│  │ │ Pod 2   │ │              │ │ Pod 4   │ │              │ │ Pod 6   │ │      │
│  │ │ workers:│ │              │ │ workers:│ │              │ │ workers:│ │      │
│  │ │ ACC-004 │ │              │ │ ACC-006 │ │              │ │ ACC-008 │ │      │
│  │ │ ACC-010 │ │              │ │ ACC-011 │ │              │ │ ACC-012 │ │      │
│  │ └─────────┘ │              │ └─────────┘ │              │ └─────────┘ │      │
│  └─────────────┘              └─────────────┘              └─────────────┘      │
│                                                                                  │
│  Total: 6 pods across 3 nodes, workers distributed via Redis coordination       │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              REDIS CLUSTER                                       │
│                                                                                  │
│  • Queues: Shared state accessible from all pods                                │
│  • Heartbeats: Track which pod owns which entity's worker                       │
│  • Coordination: Atomic operations prevent duplicate worker spawning            │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Operational Characteristics:**

| Scenario | Behavior |
|----------|----------|
| **Pod scales up** | New pod discovers entities needing workers, spawns workers for unassigned entities |
| **Pod scales down** | Workers on terminating pod close gracefully; heartbeats expire; surviving pods spawn replacement workers |
| **Pod crashes** | Heartbeat TTL expires (default: 3s); any healthy pod spawns replacement worker |
| **Rolling deployment** | Old pods drain (stop accepting new workers); new pods take over entity workers progressively |
| **Network partition** | Partitioned pods lose Redis connectivity; heartbeats expire; workers on connected pods take over |

### Distributed Systems Guarantees

The architecture provides the following guarantees in a distributed environment:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         CONSISTENCY MODEL                                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  INVARIANT 1: Single Writer per Entity                                          │
│  ─────────────────────────────────────                                          │
│  At any point in time, at most one worker processes jobs for a given entity.    │
│  Enforced via Redis heartbeat with TTL. If two workers attempt to claim the     │
│  same entity, the heartbeat check ensures only one succeeds.                    │
│                                                                                  │
│  INVARIANT 2: Total Ordering per Entity                                         │
│  ─────────────────────────────────────                                          │
│  All operations on an entity execute in a globally consistent order (FIFO).     │
│  Jobs added from Pod A before Pod B's job will process first, regardless of     │
│  which pod's worker processes them.                                             │
│                                                                                  │
│  INVARIANT 3: At-Least-Once Delivery                                            │
│  ─────────────────────────────────────                                          │
│  Jobs are persisted in Redis before acknowledgment. Worker failure mid-job      │
│  triggers retry on another worker. Handlers must be idempotent.                 │
│                                                                                  │
│  INVARIANT 4: Partition Tolerance                                               │
│  ─────────────────────────────────────                                          │
│  Network partitions cause heartbeat expiration on disconnected nodes.           │
│  Connected nodes take over orphaned workers. When partition heals,              │
│  duplicate workers are prevented by heartbeat check before spawning.            │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Request Flow in Multi-Pod Deployment

```
                              User Request: Withdraw $80 from ACC-001
                                             │
                                             ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                            LOAD BALANCER                                       │
│                   Routes to any available pod (round-robin)                    │
└───────────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  POD 3 (receives request)                                                      │
│                                                                                │
│  1. Deserialize request                                                        │
│  2. Create WithdrawCommand(ACC-001, $80)                                       │
│  3. QueueBus.forProcessor(AccountProcessor).enqueue(command)                   │
│     └──▶ Determines queue name: "account-ACC-001-queue"                        │
│     └──▶ Adds job to Redis queue (O(1) operation)                              │
│  4. Return 202 Accepted (job queued)                                           │
│                                                                                │
└───────────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  REDIS                                                                         │
│                                                                                │
│  Queue "account-ACC-001-queue": [..., WithdrawCommand($80)]                    │
│  Heartbeat "ACC-001-worker": Pod 1 (TTL: 3s)                                   │
│                                                                                │
└───────────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  POD 1 (owns ACC-001 worker)                                                   │
│                                                                                │
│  Worker polling queue "account-ACC-001-queue"                                  │
│  1. Dequeue job: WithdrawCommand($80)                                          │
│  2. Lookup handler in QueueBus registry                                        │
│  3. Execute: CommandBus.execute(withdrawCommand)                               │
│  4. Handler runs with exclusive access to ACC-001 state                        │
│  5. Mark job complete                                                          │
│                                                                                │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Key insight**: The pod receiving the HTTP request is not necessarily the pod processing the job. This decoupling enables true horizontal scaling—any pod can accept requests, while entity-specific processing is centralized on the worker owner.

### Horizontal Scaling Model

Workers are distributed across service instances via Redis-based coordination:

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
│                     │  │                     │  │                     │
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

### Recommended Applications

| Domain            | Entity Type     | Operations                                          |
|-------------------|-----------------|-----------------------------------------------------|
| **Finance**       | Account, Wallet | Deposits, withdrawals, transfers, balance queries   |
| **Gaming**        | Game, Match     | Player actions, state transitions, bet processing   |
| **E-Commerce**    | Order, Cart     | Add/remove items, apply discounts, checkout         |
| **Collaboration** | Document        | Edits, comments, permission changes                 |
| **IoT**           | Device          | Command dispatch, state synchronization             |

### When to Use Alternative Approaches

- **Read-heavy workloads**: Use caching layers (Redis, Memcached) or read replicas
- **Parallelizable operations**: Use standard job queues (BullMQ, SQS) without entity affinity
- **Fire-and-forget notifications**: Use pub/sub (Redis Pub/Sub, Kafka) without ordering guarantees
- **Short critical sections (<10ms)**: Distributed locks may suffice if contention is low

---

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
