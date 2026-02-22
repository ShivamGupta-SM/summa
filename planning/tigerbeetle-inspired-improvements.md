# TigerBeetle-Inspired Improvements

**Status:** Partially implemented
**Date:** 2026-02-22

After a deep code comparison of TigerBeetle (Zig, in-memory financial database) and Summa
(TypeScript, PostgreSQL-backed ledger), the following patterns were identified and adopted.

---

## Implemented

### 1. Field-by-Field Idempotency Validation

**TigerBeetle pattern:** `create_transfer_exists()` returns specific errors like
`.exists_with_different_amount`, `.exists_with_different_flags`, etc.

**Problem in Summa (before):** When an idempotency key matched, the cached result was
returned without checking if the request fields (amount, holderId, etc.) were the same.
This meant a client could accidentally reuse a key with different parameters and silently
get the wrong cached result.

**Implementation:**

- **File:** `packages/summa/src/managers/idempotency.ts`
- Added `IdempotencyRequestFields` interface — stores original request params alongside the key
- Added `findIdempotencyFieldMismatch()` — compares fields one-by-one, returns mismatched field name
- Updated `checkIdempotencyKeyInTx()` — accepts optional `requestFields`, validates on cache hit
- Updated `saveIdempotencyKeyInTx()` — stores `requestFields` in new `request_fields` JSONB column
- On mismatch, throws: `"Idempotency key 'X' already used with different amount"`

**Migration required:** Add `request_fields JSONB` column to `idempotency_key` table:
```sql
ALTER TABLE summa.idempotency_key ADD COLUMN request_fields JSONB;
```

---

### 2. Transient Error Classification

**TigerBeetle pattern:** `CreateTransferResult.transient()` classifies each error as either
transient (balance changes, account not found yet) or deterministic (validation failures).

**Problem in Summa (before):** All `SummaError` instances had the same shape — clients
couldn't distinguish "retry might work" from "this will always fail." This forced
clients to either retry everything (wasteful) or retry nothing (losing valid retries).

**Implementation:**

- **File:** `packages/core/src/error/codes.ts`
  - Added `transient?: boolean` to `RawErrorCode` type
  - Classified each `BASE_ERROR_CODES` entry as transient or deterministic

- **File:** `packages/core/src/error/index.ts`
  - Added `readonly transient: boolean` to `SummaError` class
  - Updated constructor to accept `transient` option
  - Updated `fromCode()` to pass through transient from error code registry
  - Updated all static factory methods with correct transient classification

**Classification:**

| Error | Transient? | Why |
|-------|-----------|-----|
| `INSUFFICIENT_BALANCE` | Yes | Balance may increase |
| `ACCOUNT_FROZEN` | Yes | Account may unfreeze |
| `LIMIT_EXCEEDED` | Yes | Limit window may reset |
| `NOT_FOUND` | Yes | Account may be created |
| `HOLD_EXPIRED` | Yes | New hold can be created |
| `RATE_LIMITED` | Yes | Rate limit resets over time |
| `OPTIMISTIC_LOCK_CONFLICT` | Yes | Version conflict resolves on retry |
| `ACCOUNT_CLOSED` | No | Closure is permanent |
| `INVALID_ARGUMENT` | No | Bad input stays bad |
| `DUPLICATE` | No | Duplicate is permanent |
| `CONFLICT` | No | Conflict is permanent |
| `INTERNAL` | No | Server bug, not transient |
| `CHAIN_INTEGRITY_VIOLATION` | No | Tampering detected |

**Client usage:**
```ts
try {
  await summa.transactions.transfer({ ... });
} catch (err) {
  if (err instanceof SummaError && err.transient) {
    // Safe to retry with a NEW idempotency key
    await retry(() => summa.transactions.transfer({ ..., idempotencyKey: newKey() }));
  } else {
    // Don't retry — this will always fail
    throw err;
  }
}
```

---

### 3. Balancing Transfers

**TigerBeetle pattern:** `balancing_debit` flag auto-caps transfer amount to available
balance instead of failing. Amount field becomes an upper limit.

```zig
if (t.flags.balancing_debit) {
    amount = @min(amount, dr_account.credits_posted -| dr_balance);
}
```

**Problem in Summa (before):** To sweep all funds from an account, the client had to:
1. Query the balance
2. Use the balance as the transfer amount
3. Hope nobody else debited between step 1 and step 2 (race condition!)

**Implementation:**

- **File:** `packages/summa/src/managers/transaction-manager.ts`
  - Added `balancing?: boolean` to `debitAccount()` and `transfer()` params
  - When `balancing: true`, amount is capped: `Math.min(amount, availableBalance)`
  - Balance check is skipped (amount is already guaranteed to fit)
  - Original requested amount stored in metadata: `{ balancing: true, requestedAmount: 500 }`
  - Response `amount` field reflects actual debited amount (may be less than requested)

- **File:** `packages/summa/src/plugins/batch-engine.ts`
  - Added `balancing?: boolean` to `BatchableTransaction` interface
  - Batch engine's cumulative delta loop respects balancing flag
  - Capping happens against the running `balanceDeltas` map (not stale DB state)

**Usage:**
```ts
// Sweep up to $500 — gets whatever is available, no error if less
const txn = await summa.transactions.debit({
  holderId: "user_123",
  amount: 500_00,       // upper limit
  balancing: true,       // cap to available balance
  reference: "sweep-001",
});
console.log(txn.amount); // actual amount debited (e.g., 325_00)

// Transfer remaining balance to another account
const txn = await summa.transactions.transfer({
  sourceHolderId: "user_123",
  destinationHolderId: "settlement",
  amount: Number.MAX_SAFE_INTEGER,  // "as much as possible"
  balancing: true,
  reference: "final-settlement",
});
```

---

## Documented (Not Yet Implemented)

### 4. Closing Transfer Flag

**TigerBeetle pattern:** `closing_debit` / `closing_credit` flags atomically close an
account as a side-effect of a transfer. Reversible via void of pending transfer.

**Summa current state:** `closeAccount({ transferToHolderId })` already performs atomic
sweep + close in a single DB transaction. The difference from TigerBeetle:

| Aspect | TigerBeetle | Summa |
|--------|-------------|-------|
| Trigger | Flag on transfer | Separate `closeAccount()` call |
| Reversible | Void reopens account | Not reversible |
| Atomic with transfer | Same operation | Same DB transaction (via `transferToHolderId`) |

**Recommendation:** Summa's `closeAccount()` with `transferToHolderId` is functionally
equivalent. The reversible aspect could be added by:
1. Making `closeAccount` create a hold instead of posting immediately
2. Voiding the hold reopens the account
3. Committing the hold finalizes the closure

**Priority:** Low — existing `closeAccount()` covers the common case. Reversible closure
is a niche use case (hotel bookings, provisional account migrations).

---

## Patterns We Compared But Don't Need to Adopt

| TigerBeetle Pattern | Why Summa Already Covers It |
|---------------------|---------------------------|
| 4-counter balance model | Already has `credit_balance`, `debit_balance`, `pending_credit`, `pending_debit` |
| Lock-free processing | `optimistic` lock mode already skips `FOR UPDATE` |
| Per-item batch errors | Each batch item gets own `resolve`/`reject` Promise |
| Two-phase holds | Append-only `transaction_status` with inflight/posted/voided/expired |
| User metadata | JSONB `metadata` field (more flexible than TB's fixed `user_data_128/64/32`) |
| Hold expiry | Both inline check + background `expireHolds()` job |
| Overdraft control | `allow_overdraft` + `overdraft_limit` per account (more granular) |

---

## Future Considerations

### Linked Transfer Chains

TigerBeetle's linked flag creates atomic chains where all transfers succeed or all fail.
Summa's journal entries and multi-destination transfers cover most multi-leg use cases,
but true arbitrary grouping of independent transfers is not yet supported.

**If needed:** Implement using PostgreSQL `SAVEPOINT` within the batch engine:
1. `SAVEPOINT chain_start` before first linked item
2. Process all linked items sequentially
3. If any fails: `ROLLBACK TO chain_start`, reject all
4. If all succeed: `RELEASE SAVEPOINT chain_start`

### Deterministic Timestamps

TigerBeetle assigns consensus-based timestamps (no wall-clock dependency). Summa uses
PostgreSQL `NOW()`. This is fine for single-instance but may cause ordering issues in
multi-region deployments. Consider adopting for Tier 3 scaling.
