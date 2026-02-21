# Tier 2: Medium-Term Scaling (50K–200K TPS)

> CQRS, Message Queue, Event Store Partitioning, and Snapshot-based Hash Verification

**Status:** Planning
**Author:** Engineering
**Date:** 2026-02-21

## Overview

Tier 2 improvements target **50,000–200,000 TPS** by separating read/write paths, replacing polling with push-based messaging, partitioning the event store, and optimizing the hash verification pipeline.

**Prerequisites:** All Tier 1 features (connection pooling, read replicas, Redis, background workers) must be in place before starting Tier 2. See `docs/content/docs/scaling.mdx` for Tier 1 reference.

## PostgreSQL Scaling Reality

A common misconception is that relational databases cap at ~100–1,000 TPS due to lock contention (Amdahl's Law). This is **not universally true** — PostgreSQL's actual throughput depends heavily on the workload:

| Workload | Realistic Single-Instance TPS | Bottleneck |
|----------|:---:|-----------|
| Simple INSERTs (no contention) | 50K–100K | WAL I/O |
| Double-entry with row locks (different accounts) | 10K–30K | Lock acquisition overhead |
| Double-entry with row locks (same hot account) | 1K–5K | Serial lock contention on hot rows |
| Cross-shard 2PC transactions | 500–2K | Network round-trips + prepare/commit overhead |

**For Summa specifically**, the bottleneck is **hot account contention** — the `@World` system account participates in every credit/debit transaction and requires an advisory lock. This creates a serial execution point that limits per-account throughput regardless of hardware.

**What PostgreSQL scales well:**
- **Reads** — unlimited horizontal scaling via streaming replicas (Tier 1, done)
- **Storage** — billions of rows via table partitioning (Tier 2, this plan)
- **Connections** — thousands of concurrent clients via pooling (Tier 1, done)

**What PostgreSQL does NOT scale natively:**
- **Write throughput beyond single-instance limits** — requires application-level sharding (Tier 3) or distributed PostgreSQL (Citus, YugabyteDB)
- **Hot row contention** — fundamental serialization point that no amount of hardware fixes

**Summa's realistic scaling trajectory:**

```
Current (Tier 1):   5K–30K TPS   Single PG + pooling + read replicas + Redis
Tier 2 target:      30K–100K TPS  + CQRS + partitioning + message queue
Tier 3 target:      100K–500K+ TPS + application sharding + dedicated event store
```

---

| Feature | Estimated Effort | Impact | Risk |
|---------|:---:|:---:|:---:|
| CQRS Pattern | 3–4 weeks | High | Medium |
| Message Queue (Redis Streams / Kafka) | 2–3 weeks | High | Medium |
| Event Store Partitioning | 2 weeks | Medium | Low |
| Snapshot-based Hash Verification | 1–2 weeks | Medium | Low |

---

## 1. CQRS Pattern (Command Query Responsibility Segregation)

### Problem

Currently, the same `account_balance` and `entry_record` tables serve both writes (transactions) and reads (balance queries, statements, admin dashboards). At high write throughput, read queries compete for row locks and inflate connection pool pressure.

### Current Architecture

```
┌─────────────────────────────┐
│        SummaAdapter         │
│  (single read/write model)  │
├─────────────────────────────┤
│  account_balance (R+W)      │
│  entry_record (R+W)         │
│  transaction_record (R+W)   │
│  ledger_event (append-only) │
└─────────────────────────────┘
```

### Proposed Architecture

```
WRITE SIDE                           READ SIDE
┌─────────────────┐                  ┌─────────────────────────┐
│ SummaAdapter    │   events         │   Read Projections      │
│ (writes only)   │──────────▶       │   (materialized views)  │
├─────────────────┤   via MQ         ├─────────────────────────┤
│ account_balance │                  │ account_balance_view     │
│ entry_record    │                  │ entry_record_view        │
│ ledger_event    │                  │ transaction_summary_view │
└─────────────────┘                  │ holder_dashboard_view    │
                                     └─────────────────────────┘
```

### Implementation Plan

#### Phase 1: Introduce Projection Engine (Week 1–2)

**New package:** `packages/projections/`

```ts
// packages/projections/src/projection.ts

export interface Projection {
  /** Unique ID for this projection */
  id: string;

  /** Event types this projection subscribes to */
  eventTypes: string[];

  /** Materialize the event into the read model */
  apply(event: StoredEvent, ctx: ProjectionContext): Promise<void>;

  /** Rebuild from scratch (full replay) */
  rebuild?(ctx: ProjectionContext): Promise<void>;
}

export interface ProjectionContext {
  /** Dedicated read-model database adapter */
  readAdapter: SummaAdapter;

  /** Logger */
  logger: Logger;
}
```

Key files to create:
- `packages/projections/src/projection.ts` — Projection interface
- `packages/projections/src/projection-runner.ts` — Consumes events, dispatches to projections
- `packages/projections/src/checkpoint.ts` — Tracks last-processed event per projection

Key files to modify:
- `packages/summa/src/infrastructure/event-store.ts` — Emit events to message bus after append
- `packages/core/src/types/index.ts` — Add `StoredEvent` re-export if needed

#### Phase 2: Built-in Projections (Week 2–3)

Create default read-model projections that replace current read paths:

| Projection | Source Events | Target Table | Purpose |
|-----------|--------------|-------------|---------|
| `AccountBalanceProjection` | `CREDIT`, `DEBIT`, `HOLD_*` | `account_balance_view` | Real-time balance queries |
| `EntryRecordProjection` | `CREDIT`, `DEBIT` | `entry_record_view` | Statement generation, history |
| `TransactionSummaryProjection` | All transaction events | `transaction_summary_view` | Dashboard & reporting |
| `HolderDashboardProjection` | All events per holder | `holder_dashboard_view` | Aggregated per-user stats |

```ts
// Example: AccountBalanceProjection
export const accountBalanceProjection: Projection = {
  id: "account-balance-view",
  eventTypes: ["CREDIT_POSTED", "DEBIT_POSTED", "HOLD_PLACED", "HOLD_RELEASED", "HOLD_CAPTURED"],

  async apply(event, ctx) {
    const data = event.eventData;
    switch (event.eventType) {
      case "CREDIT_POSTED":
        await ctx.readAdapter.rawMutate(
          `UPDATE account_balance_view
           SET balance = balance + $1,
               available_balance = available_balance + $1,
               updated_at = NOW()
           WHERE id = $2`,
          [data.amount, data.accountId]
        );
        break;
      // ... other event handlers
    }
  },
};
```

#### Phase 3: Route Reads to Projections (Week 3–4)

Modify the read-replica adapter to route specific read queries to projection tables:

```ts
// packages/core/src/db/cqrs-adapter.ts

export interface CQRSAdapterOptions {
  /** Adapter for write operations */
  writeAdapter: SummaAdapter;
  /** Adapter for read-model queries */
  readAdapter: SummaAdapter;
  /** Models that should be read from the read-model */
  readModels: string[];
}

export function createCQRSAdapter(options: CQRSAdapterOptions): SummaAdapter {
  const { writeAdapter, readAdapter, readModels } = options;

  return {
    id: "cqrs",
    options: writeAdapter.options,

    findOne: async (data) => {
      const adapter = readModels.includes(data.model) ? readAdapter : writeAdapter;
      return adapter.findOne(data);
    },

    findMany: async (data) => {
      const adapter = readModels.includes(data.model) ? readAdapter : writeAdapter;
      return adapter.findMany(data);
    },

    // All writes go to writeAdapter
    create: (data) => writeAdapter.create(data),
    update: (data) => writeAdapter.update(data),
    delete: (data) => writeAdapter.delete(data),
    transaction: (fn) => writeAdapter.transaction(fn),
    // ...
  };
}
```

### Migration Strategy

1. **Dual-write phase:** Projection runner applies events AND existing write path updates tables. Compare results for correctness.
2. **Shadow-read phase:** Read from both paths, log discrepancies, serve from write-path.
3. **Cutover:** Switch reads to projection tables. Keep dual-write for 1 week.
4. **Cleanup:** Remove redundant read queries from write path.

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Eventual consistency confuses users | Show "last updated" timestamp on read models; allow `consistency: "strong"` flag to bypass and read from write-path |
| Projection falls behind | Monitor lag metric; auto-alert if > 5s behind; built-in catch-up mode |
| Schema drift between write and read models | Projection rebuild command in CLI; version projections |
| Data loss during projection rebuild | Projections are derived from immutable event store — always rebuildable |

---

## 2. Message Queue (Redis Streams / Kafka)

### Problem

The current outbox plugin uses **database polling** (`outbox-processor` worker, 5s interval) to publish events. This has several limitations:
- 5s latency floor on event delivery
- Database load from polling queries (even when idle)
- No backpressure or consumer groups
- Scaling consumers requires manual coordination

### Current Architecture

```
Transaction ──▶ outbox table ──▶ [5s poll] ──▶ publisher() callback
```

### Proposed Architecture (Two Options)

#### Option A: Redis Streams (Recommended for < 200K TPS)

```
Transaction ──▶ outbox table ──▶ XADD stream ──▶ Consumer Group ──▶ handlers
                                                   ├── Projection Runner
                                                   ├── Webhook Dispatcher
                                                   └── External Integrations
```

**Pros:** Already have Redis (Tier 1), low latency (< 10ms), built-in consumer groups, no new infrastructure.
**Cons:** Not durable across Redis restarts (unless using Redis persistence/Cluster), limited to ~200K msg/s.

#### Option B: Kafka (For > 200K TPS or strict durability)

```
Transaction ──▶ outbox table ──▶ Kafka Producer ──▶ Topic ──▶ Consumer Groups
                                                              ├── Projections
                                                              ├── Webhooks
                                                              └── Analytics
```

**Pros:** True durability, unlimited throughput, partition-based parallelism, replay from offset.
**Cons:** Additional infrastructure (Kafka cluster), operational complexity, higher latency (50–200ms).

### Implementation Plan

**New package:** `packages/message-queue/`

#### Phase 1: Abstract MessageBus Interface (Week 1)

```ts
// packages/message-queue/src/bus.ts

export interface MessageBus {
  /** Publish an event to a topic */
  publish(topic: string, event: BusEvent): Promise<void>;

  /** Subscribe to a topic with a consumer group */
  subscribe(options: SubscribeOptions): Promise<Subscription>;

  /** Graceful disconnect */
  disconnect(): Promise<void>;

  /** Health check */
  ping(): Promise<boolean>;
}

export interface BusEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
  correlationId?: string;
}

export interface SubscribeOptions {
  topic: string;
  group: string;
  handler: (event: BusEvent) => Promise<void>;
  /** Max concurrent handlers. Default: 10 */
  concurrency?: number;
  /** Retry failed messages. Default: 3 */
  maxRetries?: number;
}

export interface Subscription {
  unsubscribe(): Promise<void>;
}
```

#### Phase 2: Redis Streams Implementation (Week 1–2)

```ts
// packages/message-queue/src/redis-streams.ts

export function createRedisStreamsBus(options: {
  client: Redis;
  keyPrefix?: string;
  blockTimeMs?: number;
}): MessageBus {
  // XADD for publish
  // XREADGROUP for subscribe with consumer groups
  // XACK for message acknowledgment
  // XPENDING + XCLAIM for dead-letter recovery
}
```

Key implementation details:
- Each topic maps to a Redis Stream key: `{prefix}:stream:{topic}`
- Consumer groups created via `XGROUP CREATE`
- Blocking read with `XREADGROUP ... BLOCK {blockTimeMs}`
- Failed messages retried via `XPENDING` → `XCLAIM` flow
- Dead-letter after `maxRetries` → store in `{prefix}:dlq:{topic}`

#### Phase 3: Kafka Implementation (Week 2–3)

```ts
// packages/message-queue/src/kafka.ts

export function createKafkaBus(options: {
  brokers: string[];
  clientId: string;
  ssl?: boolean;
  sasl?: SaslConfig;
}): MessageBus {
  // kafkajs Producer for publish
  // kafkajs Consumer with consumer groups for subscribe
  // Automatic partition assignment
}
```

#### Phase 4: Integrate with Outbox Plugin (Week 3)

Modify the outbox plugin to use `MessageBus` instead of raw publisher callback:

```ts
// Modified outbox plugin options
export interface OutboxOptions {
  /** Message bus for event publishing */
  bus: MessageBus;
  // ... existing options remain
}
```

Key files to modify:
- `packages/summa/src/plugins/outbox.ts` — Replace `publisher` callback with `MessageBus.publish()`
- `packages/summa/src/infrastructure/event-store.ts` — Optionally publish directly after event append (skip outbox for low-latency path)
- `packages/summa/src/context/context.ts` — Add `messageBus` to `SummaContext`
- `packages/core/src/types/index.ts` — Add `SummaContext.messageBus?: MessageBus`

### Migration Strategy

1. **Dual-publish phase:** Outbox continues polling AND publishes to message bus. Consumers read from bus.
2. **Verify phase:** Compare message counts between outbox table and bus. Zero discrepancy for 1 week.
3. **Cutover:** Disable outbox polling worker. All delivery via bus.
4. **Optional:** Remove outbox table if no longer needed (keep for audit trail if desired).

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Redis Stream data loss on restart | Enable AOF persistence; or use Kafka for strict durability |
| Consumer falls behind | Monitor consumer lag; auto-scale consumer instances |
| Duplicate delivery | All consumers must be idempotent (use event ID for dedup) |
| Message ordering | Partition by aggregate_id ensures per-aggregate ordering |

---

## 3. Event Store Partitioning

### Problem

The `ledger_event` table is append-only and grows indefinitely. At 50K TPS, it adds ~4.3 billion rows/year. Query performance degrades as the table grows, especially for:
- Hash chain verification (sequential scan per aggregate)
- Reconciliation (full-table scans)
- Event replay for projection rebuilds

### Current Schema

```sql
-- Single monolithic table
CREATE TABLE ledger_event (
  id UUID PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL,
  sequence_number INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  correlation_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(aggregate_type, aggregate_id, sequence_number)
);
```

### Proposed: Time-Range Partitioning

```sql
-- Partitioned by month on created_at
CREATE TABLE ledger_event (
  -- same columns
) PARTITION BY RANGE (created_at);

-- Monthly partitions
CREATE TABLE ledger_event_2026_01 PARTITION OF ledger_event
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE ledger_event_2026_02 PARTITION OF ledger_event
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
-- ...auto-created by maintenance worker
```

### Implementation Plan

#### Phase 1: Partition Management Worker (Week 1)

Add a new worker to the maintenance plugin that auto-creates future partitions:

```ts
// Addition to packages/summa/src/plugins/maintenance.ts

{
  id: "partition-manager",
  description: "Creates future ledger_event partitions and detaches old ones",
  interval: "1d",
  leaseRequired: true,
  handler: async (ctx: SummaContext) => {
    // 1. Check existing partitions
    // 2. Create partitions for next 3 months if missing
    // 3. Optionally detach partitions older than retention period
  },
}
```

Key files to create:
- `packages/summa/src/infrastructure/partition-manager.ts` — Partition creation/detachment logic

Key files to modify:
- `packages/summa/src/plugins/maintenance.ts` — Add `partition-manager` worker
- `packages/summa/src/db/schema.ts` — Mark `ledgerEvent` table as partitioned
- `packages/cli/src/commands/migrate.ts` — Handle partition-aware migration

#### Phase 2: Migration Script (Week 1–2)

Create a CLI command for zero-downtime migration from unpartitioned to partitioned:

```bash
summa migrate:partition-event-store --strategy=online
```

Steps:
1. Create new partitioned table `ledger_event_new` with same schema
2. Create trigger on old table to dual-write to new table
3. Backfill old data in batches (50K rows/batch, throttled)
4. Swap tables atomically: `ALTER TABLE ledger_event RENAME TO ledger_event_old; ALTER TABLE ledger_event_new RENAME TO ledger_event;`
5. Verify row counts match
6. Drop old table after confirmation

#### Phase 3: Query Optimization (Week 2)

Ensure all existing queries include `created_at` in WHERE clauses for partition pruning:

| Query Location | Current | Partitioned |
|---------------|---------|-------------|
| `appendEvent()` | `WHERE aggregate_type = $1 AND aggregate_id = $2` | Same (INSERT goes to correct partition automatically) |
| `verifyHashChain()` | Sequential scan per aggregate | Add `created_at >= $N` bound from checkpoint |
| `reconciliation` Step 3 | Full scan of recent blocks | Natural partition pruning via `created_at` |
| `snapshots` | Scans entries since last snapshot | Natural partition pruning via `created_at` |

### Partitioning Strategy Decision

| Strategy | Pros | Cons | Best For |
|----------|------|------|----------|
| **RANGE by created_at (monthly)** | Natural time-series fit, easy archival, good query pruning | Cross-partition aggregate queries | General use |
| RANGE by created_at (weekly) | Finer granularity | More partitions to manage | Very high volume |
| LIST by aggregate_type | Perfect per-type isolation | Limited cardinality | Few aggregate types |
| HASH by aggregate_id | Even distribution | No archival benefit, no range pruning | Write-heavy |

**Recommendation:** RANGE by `created_at` (monthly) — aligns with archival needs and most queries already filter by time.

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Migration downtime | Online migration with dual-write trigger; zero-downtime swap |
| Cross-partition queries slow | Add `created_at` bounds to all aggregate queries |
| Partition management overhead | Automated worker creates partitions 3 months ahead |
| Hash chain spans partitions | Hash chain is per-aggregate — partition boundary doesn't break it |

---

## 4. Snapshot-based Hash Verification

### Problem

The current reconciliation plugin (Step 3) calls `verifyRecentBlocks()` which processes events sequentially. At scale, this becomes a bottleneck:
- 50K TPS = 4.3B events/year
- Full chain verification: O(n) per aggregate
- Block checkpoint verification: O(new events since last checkpoint)

### Current Implementation

```ts
// Current: hash-chain.ts
// verifyHashChain() — O(all events for aggregate)
// verifyRecentBlocks() — O(events since last checkpoint)
// createBlockCheckpoint() — Creates periodic checkpoint blocks
```

### Proposed: Snapshot-Accelerated Verification

```
BEFORE: verify 1M events sequentially
  event_1 → event_2 → ... → event_1000000 ✓

AFTER: verify from nearest snapshot
  snapshot_at_990000 ✓ → event_990001 → ... → event_1000000 ✓
  (only verify 10K events instead of 1M)
```

### Implementation Plan

#### Phase 1: Hash Snapshot Table (Week 1)

```sql
CREATE TABLE hash_snapshot (
  id UUID PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  snapshot_version INTEGER NOT NULL,
  snapshot_hash TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(aggregate_type, aggregate_id, snapshot_version)
);
```

Key files to create:
- `packages/summa/src/infrastructure/hash-snapshot.ts` — Snapshot creation and verification logic

```ts
// packages/summa/src/infrastructure/hash-snapshot.ts

export async function createHashSnapshot(
  ctx: SummaContext,
  aggregateType: string,
  aggregateId: string,
): Promise<HashSnapshot> {
  // 1. Get latest event for this aggregate
  // 2. Record its version + hash as a snapshot
  // 3. Return snapshot record
}

export async function verifyFromSnapshot(
  ctx: SummaContext,
  aggregateType: string,
  aggregateId: string,
): Promise<VerificationResult> {
  // 1. Find latest snapshot for this aggregate
  // 2. Verify snapshot hash matches stored event hash at that version
  // 3. Verify chain from snapshot_version+1 to HEAD
  // 4. If no snapshot exists, fall back to full verification
}
```

#### Phase 2: Snapshot Creation Worker (Week 1)

Add to reconciliation plugin — after successful verification, create a snapshot:

```ts
// After Step 3 passes:
{
  id: "hash-snapshot-creator",
  description: "Creates hash snapshots for verified aggregates",
  interval: "6h",
  leaseRequired: true,
  handler: async (ctx: SummaContext) => {
    // 1. Find aggregates that have > 10K events since last snapshot
    // 2. Verify their chain from last snapshot
    // 3. If valid, create new snapshot at HEAD
  },
}
```

Key files to modify:
- `packages/summa/src/infrastructure/hash-chain.ts` — Add `verifyFromSnapshot()` as default verify method
- `packages/summa/src/plugins/reconciliation.ts` — Use snapshot-accelerated verification in Step 3
- `packages/summa/src/db/schema.ts` — Add `hashSnapshot` table definition

#### Phase 3: CLI Verification Commands (Week 2)

```bash
# Verify a specific aggregate using snapshots
summa verify:aggregate --type=account --id=acc_123

# Force full verification (ignore snapshots)
summa verify:aggregate --type=account --id=acc_123 --full

# Create snapshots for all aggregates
summa verify:create-snapshots --batch-size=1000

# Show snapshot stats
summa verify:status
```

### Performance Comparison

| Scenario | Current (Full) | With Snapshots |
|----------|:---:|:---:|
| 10K events per aggregate | ~50ms | ~5ms |
| 100K events per aggregate | ~500ms | ~50ms |
| 1M events per aggregate | ~5s | ~50ms |
| Daily reconciliation (100K accounts) | ~14 hours | ~1.4 hours |

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Snapshot corruption | Snapshots are verified against event store before use; fall back to full if mismatch |
| Missed tamper between snapshots | Block checkpoints still run on new events since last checkpoint |
| Storage overhead | Snapshot table is tiny (1 row per aggregate per snapshot interval) |
| Snapshot version drift | Snapshots are append-only; old snapshots remain valid |

---

## Implementation Priority

Recommended implementation order based on impact and dependencies:

```
Week 1─2:  Event Store Partitioning
           └── No dependencies, highest storage impact
Week 2─3:  Snapshot-based Hash Verification
           └── Benefits from partitioning (faster scans)
Week 3─5:  Message Queue
           └── Foundation for CQRS
Week 5─8:  CQRS Pattern
           └── Requires Message Queue for event delivery
```

## Estimated Total Timeline

| Phase | Duration | Deliverable |
|-------|:---:|-----------|
| Event Store Partitioning | 2 weeks | Partitioned ledger_event, auto-management worker, migration CLI |
| Hash Snapshot Verification | 1.5 weeks | hash_snapshot table, snapshot-accelerated verify, CLI commands |
| Message Queue | 2.5 weeks | @summa/message-queue package, Redis Streams + Kafka adapters |
| CQRS | 3.5 weeks | @summa/projections package, built-in projections, CQRS adapter |
| Integration testing | 1 week | End-to-end tests, performance benchmarks |
| **Total** | **~10.5 weeks** | **50K–200K TPS capability** |

## Success Criteria

- [ ] Event store handles 1B+ rows without query degradation
- [ ] Hash verification completes in < 2 hours for full reconciliation
- [ ] Event delivery latency < 50ms (Redis Streams) or < 200ms (Kafka)
- [ ] Read queries served from projections with < 10ms p99 latency
- [ ] Zero data loss during partition migration
- [ ] All existing tests pass without modification
