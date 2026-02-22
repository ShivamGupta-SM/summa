# Tier 3: Long-Term Scaling (200K–1M+ TPS)

> Database Sharding, Dedicated Event Store, Hot Account Dedicated Buffer, and Multi-Region Support

**Status:** Planning
**Author:** Engineering
**Date:** 2026-02-21

## Overview

Tier 3 improvements target **200,000–1,000,000+ TPS** through horizontal database scaling, purpose-built event storage, dedicated high-throughput buffers, and multi-region deployment. These are **architectural changes** that require significant planning and testing.

**Prerequisites:** All Tier 1 and Tier 2 features must be in place (see `docs/content/docs/scaling.mdx` and `planning/tier2-scaling-plan.md`). Specifically:
- CQRS is running (read/write separation)
- Message Queue is operational (event delivery)
- Event Store is partitioned (time-range)
- Hash snapshots are enabled

| Feature | Estimated Effort | Impact | Risk |
|---------|:---:|:---:|:---:|
| Database Sharding by Account | 4–6 weeks | Very High | High |
| Dedicated Event Store | 3–4 weeks | High | Medium |
| Hot Account Dedicated Buffer | 2–3 weeks | High | Medium |
| Multi-Region Support | 6–8 weeks | Very High | Very High |

---

## 1. Database Sharding by Account

### Problem

Even with read replicas and CQRS, the **primary database** remains a single point of write bottleneck. PostgreSQL single-instance write throughput reaches 50K–100K TPS for simple writes, but Summa's double-entry transactions with advisory locks and hash chains realistically cap at **30K–100K TPS** after Tier 2 optimizations (see `tier2-scaling-plan.md` — PostgreSQL Scaling Reality section for detailed benchmarks). To go beyond that, writes must be distributed across multiple database instances.

### Current Architecture

```
All writes ──▶ Single Primary DB
               ├── account_balance
               ├── entry_record
               ├── transaction_record
               └── ledger_event
```

### Proposed Architecture

```
                    ┌──────────────────┐
                    │  Shard Router     │
                    │  (hash of         │
                    │   holder_id)      │
                    └────────┬─────────┘
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         ┌─────────┐   ┌─────────┐   ┌─────────┐
         │ Shard 0  │   │ Shard 1  │   │ Shard 2  │
         │ a-h      │   │ i-p      │   │ q-z      │
         │          │   │          │   │          │
         │ Primary  │   │ Primary  │   │ Primary  │
         │ Replica  │   │ Replica  │   │ Replica  │
         └─────────┘   └─────────┘   └─────────┘
```

### Sharding Strategy Decision

| Strategy | Pros | Cons | Verdict |
|----------|------|------|---------|
| **Hash of holder_id** | Even distribution, all account ops on same shard | Cross-account transactions need distributed tx | **Recommended** |
| Range of holder_id | Easy rebalancing | Hot-spot risk (popular ranges) | Not recommended |
| Hash of account_id | Per-account isolation | Holder's accounts may span shards | Only if single-account txns dominate |
| Tenant-based | Natural isolation | Only works for multi-tenant setups | Niche use case |

**Recommendation:** Hash of `holder_id` — ensures all accounts for a holder are co-located, which keeps the most common operation (credit/debit a holder's account) shard-local.

### Implementation Plan

#### Phase 1: Shard-Aware Adapter (Week 1–3)

**New package:** `packages/sharding/`

```ts
// packages/sharding/src/shard-router.ts

export interface ShardConfig {
  /** Total number of shards */
  shardCount: number;

  /** Mapping of shard index → adapter */
  shards: Map<number, SummaAdapter>;

  /** Function to extract shard key from operation context */
  shardKeyExtractor: (model: string, data: Record<string, unknown>) => string;
}

export function createShardedAdapter(config: ShardConfig): SummaAdapter {
  function getShard(key: string): SummaAdapter {
    const hash = murmurHash3(key);
    const shardIndex = hash % config.shardCount;
    return config.shards.get(shardIndex)!;
  }

  return {
    id: "sharded",

    create: async (data) => {
      const key = config.shardKeyExtractor(data.model, data.data);
      return getShard(key).create(data);
    },

    findOne: async (data) => {
      // Extract shard key from where clauses
      const key = extractShardKeyFromWhere(data.where, data.model);
      if (key) return getShard(key).findOne(data);
      // Scatter-gather if no shard key in query
      return scatterGatherFindOne(config.shards, data);
    },

    transaction: async (fn) => {
      // Single-shard transactions work normally
      // Cross-shard transactions need 2PC (see Phase 3)
      throw new Error("Use shardTransaction() for shard-aware transactions");
    },
    // ...
  };
}
```

Key shard-key extraction rules:

| Table | Shard Key Source | Notes |
|-------|-----------------|-------|
| `account_balance` | `holder_id` column | Direct |
| `entry_record` | `account_id` → lookup `holder_id` | Requires join or cache |
| `transaction_record` | Debit account's `holder_id` | Convention: shard by debit side |
| `ledger_event` | `aggregate_id` (which is account ID) | Direct |
| `idempotency_key` | Hash of the key itself | Any shard works |

#### Phase 2: Cross-Shard Transaction Coordinator (Week 3–4)

For transactions that involve accounts on different shards (e.g., transfer between two holders on different shards):

```ts
// packages/sharding/src/cross-shard.ts

export interface CrossShardTransaction {
  /** Prepare phase: lock resources on all involved shards */
  prepare(): Promise<PrepareResult>;

  /** Commit phase: commit on all shards */
  commit(): Promise<void>;

  /** Rollback phase: rollback on all shards */
  rollback(): Promise<void>;
}

export async function executeShardTransaction<T>(
  coordinator: ShardCoordinator,
  shards: SummaAdapter[],
  fn: (txAdapters: Map<number, SummaTransactionAdapter>) => Promise<T>,
): Promise<T> {
  // 1. BEGIN on all involved shards
  // 2. Execute user function with per-shard tx adapters
  // 3. PREPARE TRANSACTION on all shards (2PC prepare)
  // 4. COMMIT PREPARED on all shards (2PC commit)
  // On any failure: ROLLBACK PREPARED on all shards
}
```

**Important:** PostgreSQL supports `PREPARE TRANSACTION` for 2-phase commit. This must be enabled in `postgresql.conf`:
```
max_prepared_transactions = 100
```

#### Phase 3: Shard Management CLI (Week 4–5)

```bash
# Initialize sharding (creates shard metadata table)
summa shard:init --count=4

# Check shard distribution
summa shard:status
# Output:
#   Shard 0: 25,142 accounts (24.8%)
#   Shard 1: 25,634 accounts (25.3%)
#   Shard 2: 25,021 accounts (24.7%)
#   Shard 3: 25,503 accounts (25.2%)

# Rebalance (move accounts between shards)
summa shard:rebalance --dry-run
summa shard:rebalance --execute

# Add a new shard (online)
summa shard:add --connection-string="postgres://..."

# Migrate existing single-DB to sharded setup
summa shard:migrate --source=postgres://single-db --count=4
```

#### Phase 4: Shard-Aware Plugins (Week 5–6)

Update plugins that run queries across all data:

| Plugin | Change Required |
|--------|----------------|
| `reconciliation` | Run per-shard, aggregate results |
| `snapshots` | Run per-shard (natural isolation) |
| `maintenance` | Run per-shard for cleanup; global for partition management |
| `hot-accounts` | Shard-local (hot accounts are per-shard) |
| `statements` | Route to correct shard by holder_id |

Key files to modify:
- `packages/summa/src/plugins/reconciliation.ts` — Shard-aware reconciliation
- `packages/summa/src/plugins/snapshots.ts` — Per-shard snapshot generation
- `packages/summa/src/plugins/maintenance.ts` — Per-shard cleanup
- `packages/summa/src/infrastructure/worker-runner.ts` — Support per-shard worker execution
- `packages/summa/src/context/context.ts` — Add `shardConfig` to `SummaContext`

### Migration Strategy (Zero-Downtime)

1. **Setup phase:** Create shard databases, install schema on each
2. **Shadow-write phase:** Write to both old single DB and new sharded DBs
3. **Backfill phase:** Copy historical data to correct shards (batched, throttled)
4. **Verify phase:** Compare checksums between old DB and sharded DBs
5. **Cutover:** Switch reads to sharded DBs, then switch writes
6. **Cleanup:** Decommission old single DB after 1 week

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Cross-shard transactions are slow | Minimize cross-shard txns by sharding on holder_id; use saga pattern for rare cross-shard ops |
| Uneven shard distribution | Monitor distribution; automatic rebalancing CLI command |
| Shard failure takes down subset of accounts | Each shard has its own replica for HA; circuit breaker prevents cascade |
| Complexity explosion | Start with 2–4 shards; only add more as needed |
| 2PC deadlocks | Set aggressive lock timeout (1s) on prepared transactions; automatic rollback |

---

## 2. Dedicated Event Store

### Problem

Currently, `ledger_event` lives in the same PostgreSQL database as the projection tables (`account_balance`, `entry_record`, etc.). This means:
- Event writes compete with projection writes for I/O
- Event store has different access patterns (append-only, sequential reads) than projections (random reads, updates)
- Can't optimize storage engine for append-only workload

### Current Architecture

```
Single PostgreSQL Instance
├── ledger_event (append-only, sequential)
├── account_balance (random R/W)
├── entry_record (random R/W)
└── transaction_record (random R/W)
```

### Proposed Architecture

```
Event Store Database              Projection Database
(optimized for append)            (optimized for queries)
┌─────────────────────┐          ┌─────────────────────┐
│ ledger_event        │ events   │ account_balance      │
│ block_checkpoint    │────────▶ │ entry_record         │
│ hash_snapshot       │ via MQ   │ transaction_record   │
│                     │          │ *_view tables        │
│ WAL: synchronous    │          │                      │
│ Storage: append-opt │          │ WAL: async OK        │
└─────────────────────┘          └─────────────────────┘
```

### Implementation Plan

#### Phase 1: Event Store Adapter Interface (Week 1–2)

```ts
// packages/core/src/db/event-store-adapter.ts

export interface EventStoreAdapter {
  /** Append an event (returns stored event with computed fields) */
  append(params: AppendEventParams): Promise<StoredEvent>;

  /** Read events for an aggregate */
  readStream(
    aggregateType: string,
    aggregateId: string,
    options?: { fromVersion?: number; limit?: number },
  ): Promise<StoredEvent[]>;

  /** Read all events since a global position */
  readAll(options?: { fromPosition?: bigint; limit?: number }): Promise<StoredEvent[]>;

  /** Get the latest event for an aggregate */
  getLatest(aggregateType: string, aggregateId: string): Promise<StoredEvent | null>;

  /** Transaction support for event store operations */
  transaction<T>(fn: (tx: EventStoreTransactionAdapter) => Promise<T>): Promise<T>;
}
```

This separates event store operations from general CRUD operations, allowing the event store to live on a different database.

Key files to create:
- `packages/core/src/db/event-store-adapter.ts` — EventStoreAdapter interface
- `packages/drizzle-adapter/src/event-store.ts` — Drizzle-based EventStoreAdapter implementation
- `packages/summa/src/infrastructure/event-store-bridge.ts` — Bridge between old `raw()` calls and new `EventStoreAdapter`

Key files to modify:
- `packages/summa/src/infrastructure/event-store.ts` — Use `EventStoreAdapter` instead of `ctx.adapter.raw()`
- `packages/summa/src/infrastructure/hash-chain.ts` — Use `EventStoreAdapter.readStream()`
- `packages/summa/src/context/context.ts` — Add `eventStoreAdapter` to `SummaContext`
- `packages/core/src/types/index.ts` — Add `SummaContext.eventStore?: EventStoreAdapter`

#### Phase 2: PostgreSQL Event Store Optimization (Week 2–3)

When the event store lives on its own PostgreSQL instance, optimize for append-only:

```sql
-- postgresql.conf for event store
shared_buffers = '8GB'           -- Large buffer for write caching
wal_level = 'replica'
synchronous_commit = 'on'        -- Durability guarantee for financial data
checkpoint_completion_target = 0.9
effective_io_concurrency = 200
random_page_cost = 1.1           -- SSD optimized

-- Disable autovacuum for append-only tables (no dead tuples)
ALTER TABLE ledger_event SET (autovacuum_enabled = false);

-- Use fillfactor 100 (no space reserved for updates — we never update)
ALTER TABLE ledger_event SET (fillfactor = 100);
```

#### Phase 3: Alternative Event Store Backends (Week 3–4)

For even higher throughput, support pluggable event store backends:

| Backend | Throughput | Durability | Complexity | Best For |
|---------|:---:|:---:|:---:|----------|
| **PostgreSQL (dedicated)** | 100K events/s | Strong | Low | Most deployments |
| EventStoreDB | 500K events/s | Strong | Medium | Event-sourcing-native |
| Apache Kafka | 1M+ events/s | Configurable | High | Massive scale |
| ScyllaDB | 1M+ events/s | Tunable | High | Write-heavy, global |

```ts
// Optional: EventStoreDB adapter
// packages/eventstoredb-adapter/src/index.ts
export function createEventStoreDBAdapter(options: {
  connectionString: string;
}): EventStoreAdapter {
  // Uses @eventstore/db-client
  // Maps aggregate_type + aggregate_id to stream names
  // Global position maps to $all stream position
}
```

### Migration Strategy

1. **Setup:** Create dedicated event store database, install schema
2. **Dual-write:** Modify `appendEvent()` to write to both old and new event store
3. **Backfill:** Copy historical events to new event store (by partition, for speed)
4. **Verify:** Compare event counts and hash chains between old and new
5. **Cutover:** Switch reads to new event store, then switch writes
6. **Cleanup:** Remove `ledger_event` from projection database after verification

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Distributed transaction between event store and projections | Event store is source of truth; projections are derived (eventually consistent via CQRS) |
| Event store database failure | Synchronous replication to standby; automatic failover |
| Migration data loss | Hash chain verification catches any missing or corrupted events |
| Increased operational complexity | Start with PostgreSQL-to-PostgreSQL separation (same ops skills) |

---

## 3. Hot Account Dedicated Buffer

### Problem

The existing hot accounts plugin (`hot_account_entry` table) batches entries every 30 seconds. This works for moderate throughput, but at extreme scale:
- 30s batching means up to 30s of "invisible" balance changes
- Batch processing still acquires row lock on `account_balance` for the system account
- All hot entries go through PostgreSQL even though they're transient

### Current Architecture

```
Transaction ──▶ hot_account_entry table ──▶ [30s batch] ──▶ system_account balance update
```

### Proposed Architecture

```
Transaction ──▶ Redis INCR (real-time) ──▶ [configurable flush] ──▶ system_account balance
                    │
                    └──▶ Redis GET (real-time available balance)
```

### Implementation Plan

#### Phase 1: Redis-Backed Hot Account Buffer (Week 1–2)

**New module in existing package:** `packages/summa/src/plugins/hot-account-buffer.ts`

```ts
// packages/summa/src/plugins/hot-account-buffer.ts

export interface HotAccountBufferOptions {
  /** Redis client for the buffer */
  redis: Redis;

  /** Account identifiers to buffer (system accounts) */
  accounts: string[];

  /** Flush interval. Default: "10s" */
  flushInterval?: string;

  /** Max buffered amount before force-flush (in minor units). Default: 1_000_000_00 ($1M) */
  maxBufferedAmount?: number;

  /** Key prefix. Default: "summa:hab:" */
  keyPrefix?: string;
}

export function hotAccountBuffer(options: HotAccountBufferOptions): SummaPlugin {
  return {
    id: "hot-account-buffer",

    hooks: {
      beforeTransaction: async (ctx, params) => {
        // If source or dest is a buffered account, redirect to Redis INCR
        if (isBufferedAccount(params.sourceAccount)) {
          await bufferDebit(options.redis, params.sourceAccount, params.amount);
          // Skip DB write for this side of the double entry
          params.skipSourceDbWrite = true;
        }
      },
    },

    workers: [
      {
        id: "hot-buffer-flusher",
        description: "Flushes accumulated Redis buffer amounts to database",
        interval: options.flushInterval ?? "10s",
        leaseRequired: true,
        handler: async (ctx) => {
          for (const accountId of options.accounts) {
            await flushBuffer(ctx, options.redis, accountId, options.keyPrefix);
          }
        },
      },
    ],

    endpoints: [
      {
        method: "GET",
        path: "/hot-buffer/status",
        handler: async (ctx) => {
          // Return current buffered amounts per account
          const status = await getBufferStatus(options.redis, options.accounts, options.keyPrefix);
          return { status: 200, body: status };
        },
      },
    ],
  };
}
```

#### Phase 2: Atomic Redis Operations (Week 2)

Use Redis Lua scripts for atomic buffer operations:

```lua
-- buffer_debit.lua
-- KEYS[1] = buffer key (e.g., summa:hab:@World:buffer)
-- KEYS[2] = count key (e.g., summa:hab:@World:count)
-- ARGV[1] = amount
-- ARGV[2] = max_buffered_amount

local current = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])

if tonumber(current) >= tonumber(ARGV[2]) then
  -- Signal force-flush needed
  redis.call('SET', KEYS[1] .. ':flush', '1')
end

return current
```

```lua
-- flush_buffer.lua
-- KEYS[1] = buffer key
-- KEYS[2] = count key
-- Atomically reads and resets the buffer

local amount = redis.call('GETSET', KEYS[1], '0')
local count = redis.call('GETSET', KEYS[2], '0')
redis.call('DEL', KEYS[1] .. ':flush')

return {amount or '0', count or '0'}
```

#### Phase 3: Real-Time Balance Reads (Week 2–3)

```ts
// Query real-time balance = DB balance + Redis buffer

export async function getHotAccountBalance(
  ctx: SummaContext,
  redis: Redis,
  accountId: string,
  keyPrefix: string,
): Promise<{ dbBalance: bigint; bufferedAmount: bigint; totalBalance: bigint }> {
  // 1. Read DB balance (from read replica)
  const dbBalance = await ctx.adapter.findOne<{ balance: bigint }>({
    model: "account_balance",
    where: [{ field: "id", operator: "eq", value: accountId }],
  });

  // 2. Read Redis buffer
  const buffered = await redis.get(`${keyPrefix}${accountId}:buffer`);

  const dbBal = BigInt(dbBalance?.balance ?? 0);
  const bufBal = BigInt(buffered ?? 0);

  return {
    dbBalance: dbBal,
    bufferedAmount: bufBal,
    totalBalance: dbBal + bufBal,
  };
}
```

Key files to create:
- `packages/summa/src/plugins/hot-account-buffer.ts` — Main plugin
- `packages/summa/src/plugins/hot-account-buffer-lua.ts` — Lua scripts as string constants

Key files to modify:
- `packages/summa/src/plugins/hot-accounts.ts` — Add option to use Redis buffer instead of DB table
- `packages/summa/src/plugins/index.ts` — Export new plugin
- `packages/summa/src/managers/system-accounts.ts` — Check Redis buffer for real-time balance
- `packages/summa/src/plugins/reconciliation.ts` — Include Redis buffer in system account reconciliation (Step 2)

### Performance Comparison

| Metric | Current (DB) | With Redis Buffer |
|--------|:---:|:---:|
| Hot account write latency | 2–5ms (DB INSERT) | 0.1–0.5ms (Redis INCR) |
| Throughput per account | ~5K TPS (row lock) | ~100K TPS (no locks) |
| Balance visibility delay | 30s (batch interval) | 0ms (real-time via Redis GET) |
| Durability | Immediate (DB) | Flush interval (10s default) |

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Redis failure loses buffered data | Max buffer amount cap triggers force-flush; Redis persistence; small flush interval |
| Buffer amount exceeds safe limit | `maxBufferedAmount` triggers immediate flush; alerts on threshold |
| Reconciliation mismatch | Include Redis buffer in reconciliation Step 2; log buffer state during flush |
| Double-counting during flush | Atomic Lua script for read+reset; single-writer via lease |

---

## 4. Multi-Region Support

### Problem

A single-region deployment has a hard latency floor: users far from the region experience 100–300ms round-trip times. For a global financial platform, this is unacceptable. Additionally, single-region creates a single point of failure for disaster recovery.

### Current Architecture

```
Region: us-east-1
┌─────────────────────────────────┐
│  Load Balancer                  │
│  Summa Instances (3)            │
│  PostgreSQL Primary + Replicas  │
│  Redis Cluster                  │
└─────────────────────────────────┘

All traffic ──▶ us-east-1 (regardless of user location)
```

### Proposed Architecture

```
                    ┌──────────────────┐
                    │   Global DNS     │
                    │   (Latency-based │
                    │    routing)      │
                    └────────┬─────────┘
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│   us-east-1      │ │   eu-west-1      │ │   ap-southeast-1 │
│   (PRIMARY)      │ │   (SECONDARY)    │ │   (SECONDARY)    │
│                  │ │                  │ │                  │
│ Summa Instances  │ │ Summa Instances  │ │ Summa Instances  │
│ PG Primary       │ │ PG Replica       │ │ PG Replica       │
│ PG Replica       │ │ Redis Replica    │ │ Redis Replica    │
│ Redis Primary    │ │                  │ │                  │
└──────────────────┘ └──────────────────┘ └──────────────────┘
         │                   ▲                   ▲
         │   Streaming       │   Streaming       │
         └───Replication─────┴───Replication──────┘
```

### Multi-Region Patterns

| Pattern | Reads | Writes | Consistency | Complexity |
|---------|:---:|:---:|:---:|:---:|
| **Active-Passive** | Local | Route to primary region | Strong | Low |
| Active-Active (conflict-free) | Local | Local (only local accounts) | Eventual | Medium |
| Active-Active (conflict resolution) | Local | Local (all accounts) | Eventual + merge | Very High |

**Recommendation:** Start with **Active-Passive** — all writes go to primary region, reads served locally. This is the simplest path and sufficient for most financial applications where write latency is less critical than read latency.

### Implementation Plan

#### Phase 1: Region-Aware Configuration (Week 1–2)

```ts
// packages/core/src/types/region.ts

export interface RegionConfig {
  /** This instance's region identifier */
  region: string;

  /** The primary (write) region */
  primaryRegion: string;

  /** Is this instance in the primary region? */
  isPrimary: boolean;

  /** Cross-region write endpoint (for secondary regions) */
  primaryWriteEndpoint?: string;
}

// Extended SummaOptions
export interface SummaOptions {
  // ... existing options
  region?: RegionConfig;
}
```

Key files to create:
- `packages/core/src/types/region.ts` — Region configuration types
- `packages/summa/src/infrastructure/region-router.ts` — Routes writes to primary region

Key files to modify:
- `packages/core/src/types/index.ts` — Export RegionConfig
- `packages/summa/src/context/context.ts` — Add `region` to SummaContext
- `packages/summa/src/api/handler.ts` — Region-aware request routing

#### Phase 2: Write Forwarding (Week 2–4)

Secondary regions forward write requests to the primary region:

```ts
// packages/summa/src/infrastructure/region-router.ts

export function createRegionRouter(config: RegionConfig) {
  return {
    /** Check if this request should be forwarded to primary */
    shouldForward(method: string): boolean {
      if (config.isPrimary) return false;
      return method !== "GET" && method !== "HEAD";
    },

    /** Forward a write request to the primary region */
    async forwardWrite(request: Request): Promise<Response> {
      const primaryUrl = new URL(request.url);
      primaryUrl.host = config.primaryWriteEndpoint!;

      const response = await fetch(primaryUrl.toString(), {
        method: request.method,
        headers: {
          ...Object.fromEntries(request.headers),
          "X-Forwarded-Region": config.region,
          "X-Original-Region": config.region,
        },
        body: request.body,
      });

      return response;
    },
  };
}
```

Integrate into API handlers:

```ts
// Modified API handler
app.post("/transactions/credit", async (req, res) => {
  if (regionRouter.shouldForward("POST")) {
    const result = await regionRouter.forwardWrite(req);
    return res.status(result.status).json(await result.json());
  }
  // Normal processing in primary region
  return await creditAccount(ctx, req.body);
});
```

#### Phase 3: Replication Lag Monitoring (Week 4–5)

```ts
// packages/summa/src/infrastructure/replication-monitor.ts

export interface ReplicationLagMonitor {
  /** Get current replication lag in milliseconds */
  getLag(): Promise<number>;

  /** Check if lag is within acceptable threshold */
  isHealthy(maxLagMs?: number): Promise<boolean>;

  /** Subscribe to lag threshold alerts */
  onLagExceeded(thresholdMs: number, callback: () => void): void;
}

export function createReplicationMonitor(
  primaryAdapter: SummaAdapter,
  replicaAdapter: SummaAdapter,
): ReplicationLagMonitor {
  return {
    async getLag() {
      // PostgreSQL: Compare pg_last_xact_replay_timestamp() on replica
      // with current timestamp on primary
      const [primary] = await primaryAdapter.raw<{ ts: string }>(
        "SELECT NOW() as ts", []
      );
      const [replica] = await replicaAdapter.raw<{ ts: string }>(
        "SELECT pg_last_xact_replay_timestamp() as ts", []
      );
      return new Date(primary!.ts).getTime() - new Date(replica!.ts).getTime();
    },

    async isHealthy(maxLagMs = 5000) {
      return (await this.getLag()) < maxLagMs;
    },

    onLagExceeded(thresholdMs, callback) {
      setInterval(async () => {
        if (!(await this.isHealthy(thresholdMs))) callback();
      }, 10_000);
    },
  };
}
```

#### Phase 4: Consistency Guarantees (Week 5–6)

Handle read-after-write consistency for users whose writes were forwarded to primary:

```ts
// Session-based consistency token

// After write (in primary region):
response.headers.set("X-Consistency-Token", lastEventSequenceNumber.toString());

// Before read (in secondary region):
const token = request.headers.get("X-Consistency-Token");
if (token) {
  // Wait until local replica has caught up to this sequence number
  await waitForReplicationCatchup(replicaAdapter, parseInt(token), {
    maxWaitMs: 5000,
    pollIntervalMs: 50,
  });
}
```

#### Phase 5: Disaster Recovery & Failover (Week 6–8)

```ts
// packages/summa/src/infrastructure/failover.ts

export interface FailoverConfig {
  /** How to detect primary failure */
  healthCheckInterval: string;  // "5s"

  /** How many consecutive failures before failover */
  failureThreshold: number;  // 3

  /** Automatic failover or manual */
  mode: "automatic" | "manual";
}

export function createFailoverManager(
  regions: RegionConfig[],
  config: FailoverConfig,
) {
  // 1. Health check primary region periodically
  // 2. After N consecutive failures, promote secondary to primary
  // 3. Update DNS (via cloud provider API)
  // 4. Reconfigure all instances to point to new primary
  // 5. Alert operators

  // For manual mode:
  // Expose CLI command: summa region:failover --promote=eu-west-1
}
```

CLI commands:

```bash
# Check replication status across regions
summa region:status
# Output:
#   us-east-1 (PRIMARY): healthy, 0ms lag
#   eu-west-1 (SECONDARY): healthy, 45ms lag
#   ap-southeast-1 (SECONDARY): healthy, 120ms lag

# Manual failover
summa region:failover --promote=eu-west-1 --reason="us-east-1 outage"

# Failback to original primary
summa region:failback --restore=us-east-1
```

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Split-brain during failover | Fencing: old primary must be verified down before promoting secondary |
| Data loss during failover | Synchronous replication to at least one secondary; accept small window for async replicas |
| Write latency for secondary regions | Active-Passive means writes traverse network; use regional caching for reads |
| Replication lag causes stale reads | Consistency tokens for read-after-write; lag monitoring with alerts |
| Operational complexity | Start with 2 regions (primary + one secondary); add more later |
| Cost | Secondary regions can use smaller instances if they only serve reads |

---

## Implementation Priority

Recommended implementation order based on impact, dependencies, and risk:

```
Month 1─2:  Hot Account Dedicated Buffer
            └── Builds on existing Redis; biggest perf win per effort

Month 2─3:  Dedicated Event Store
            └── Separates I/O patterns; enables independent scaling

Month 3─5:  Database Sharding
            └── Requires CQRS + MQ from Tier 2; highest complexity

Month 5─7:  Multi-Region Support
            └── Requires all other features; highest risk
```

## Estimated Total Timeline

| Phase | Duration | Deliverable |
|-------|:---:|-----------|
| Hot Account Dedicated Buffer | 3 weeks | Redis-backed buffer, Lua scripts, real-time balance reads |
| Dedicated Event Store | 3.5 weeks | EventStoreAdapter interface, PostgreSQL separation, optional EventStoreDB |
| Database Sharding | 5 weeks | @summa-ledger/sharding package, shard router, cross-shard 2PC, CLI tools |
| Multi-Region | 7 weeks | Region routing, write forwarding, replication monitoring, failover |
| Integration testing | 2 weeks | Cross-region tests, shard migration tests, chaos testing |
| **Total** | **~20.5 weeks** | **200K–1M+ TPS capability** |

## Success Criteria

- [ ] Hot account buffer sustains 100K+ TPS per system account
- [ ] Event store operates independently with < 1ms write latency overhead
- [ ] 4-shard setup handles 200K+ write TPS with < 5% cross-shard transactions
- [ ] Multi-region read latency < 10ms for local reads
- [ ] Automatic failover completes in < 60 seconds
- [ ] Zero data loss during all migration procedures
- [ ] All existing tests pass without modification
- [ ] Reconciliation catches any consistency issues introduced by distribution

---

## Complete Roadmap Summary

```
TIER 1 (DONE)           TIER 2 (~10 weeks)         TIER 3 (~20 weeks)
─────────────           ──────────────────         ──────────────────
✅ Connection Pool      Event Partitioning          Hot Account Buffer
✅ Read Replicas        Hash Snapshots              Dedicated Event Store
✅ Redis Storage        Message Queue               Database Sharding
✅ Background Workers   CQRS Pattern                Multi-Region

1K─50K TPS              50K─200K TPS               200K─1M+ TPS
```
