import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	char,
	index,
	integer,
	jsonb,
	pgSchema,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

export const summaSchema = pgSchema("@summa-ledger/summa");

// =============================================================================
// 0. LEDGER REGISTRY (Multi-tenancy)
// =============================================================================
// Each ledger is an isolated tenant namespace.

export const ledger = summaSchema.table("ledger", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: varchar("name", { length: 255 }).unique().notNull(),
	metadata: jsonb("metadata"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LedgerRow = typeof ledger.$inferSelect;
export type LedgerInsert = typeof ledger.$inferInsert;

// =============================================================================
// 1. EVENT STORE (Source of Truth)
// =============================================================================
// Immutable append-only event log with hash chains for tamper detection.

export const ledgerEvent = summaSchema.table(
	"ledger_event",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ledgerId: uuid("ledger_id")
			.notNull()
			.references(() => ledger.id),
		sequenceNumber: bigserial("sequence_number", { mode: "number" }).unique().notNull(),

		aggregateType: varchar("aggregate_type", { length: 50 }).notNull(),
		aggregateId: uuid("aggregate_id").notNull(),
		aggregateVersion: integer("aggregate_version").notNull(),

		eventType: varchar("event_type", { length: 100 }).notNull(),
		eventData: jsonb("event_data").notNull(),

		correlationId: uuid("correlation_id").notNull(),
		hash: varchar("hash", { length: 64 }).notNull(),
		prevHash: varchar("prev_hash", { length: 64 }),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("uq_ledger_event_aggregate_version").on(
			table.ledgerId,
			table.aggregateType,
			table.aggregateId,
			table.aggregateVersion,
		),
		index("idx_ledger_event_ledger").on(table.ledgerId),
		index("idx_ledger_event_aggregate").on(table.ledgerId, table.aggregateType, table.aggregateId),
		index("idx_ledger_event_correlation").on(table.ledgerId, table.correlationId),
	],
);

export type LedgerEventRow = typeof ledgerEvent.$inferSelect;
export type LedgerEventInsert = typeof ledgerEvent.$inferInsert;

// =============================================================================
// 2. ACCOUNT BALANCE (Projection)
// =============================================================================
// Materialized view of account state, derived from events.

export const accountBalance = summaSchema.table(
	"account_balance",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ledgerId: uuid("ledger_id")
			.notNull()
			.references(() => ledger.id),
		indicator: varchar("indicator", { length: 255 }).unique(),

		holderId: varchar("holder_id", { length: 255 }).notNull(),
		holderType: varchar("holder_type", { length: 100 }).notNull(),

		balance: bigint("balance", { mode: "number" }).notNull().default(0),
		creditBalance: bigint("credit_balance", { mode: "number" }).notNull().default(0),
		debitBalance: bigint("debit_balance", { mode: "number" }).notNull().default(0),
		pendingCredit: bigint("pending_credit", { mode: "number" }).notNull().default(0),
		pendingDebit: bigint("pending_debit", { mode: "number" }).notNull().default(0),

		currency: char("currency", { length: 3 }).notNull().default("INR"),
		lockVersion: integer("lock_version").notNull().default(1),
		checksum: varchar("checksum", { length: 64 }),
		lastSequenceNumber: bigint("last_sequence_number", { mode: "number" }).notNull().default(0),

		allowOverdraft: boolean("allow_overdraft").notNull().default(false),
		overdraftLimit: bigint("overdraft_limit", { mode: "number" }),
		status: varchar("status", { length: 20 }).notNull().default("active"),

		// Chart of Accounts fields (optional — set when CoA classification is used)
		accountType: varchar("account_type", { length: 20 }),
		accountCode: varchar("account_code", { length: 50 }).unique(),
		parentAccountId: uuid("parent_account_id"),
		normalBalance: varchar("normal_balance", { length: 10 }),

		// Freeze tracking
		freezeReason: text("freeze_reason"),
		frozenAt: timestamp("frozen_at", { withTimezone: true }),
		frozenBy: varchar("frozen_by", { length: 100 }),

		// Closure tracking
		closedAt: timestamp("closed_at", { withTimezone: true }),
		closedBy: varchar("closed_by", { length: 100 }),
		closureReason: text("closure_reason"),

		metadata: jsonb("metadata").notNull().default({}),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		uniqueIndex("uq_account_balance_holder_currency").on(
			table.ledgerId,
			table.holderId,
			table.currency,
		),
		index("idx_account_balance_ledger").on(table.ledgerId),
		index("idx_account_balance_sequence").on(table.lastSequenceNumber),
		index("idx_account_balance_status").on(table.status),
		index("idx_account_balance_holder_lookup").on(table.ledgerId, table.holderId, table.holderType),
		index("idx_account_balance_type").on(table.ledgerId, table.accountType),
		index("idx_account_balance_parent").on(table.parentAccountId),
	],
);

export type AccountBalanceRow = typeof accountBalance.$inferSelect;
export type AccountBalanceInsert = typeof accountBalance.$inferInsert;

// =============================================================================
// 3. SYSTEM ACCOUNT
// =============================================================================
// Platform-owned accounts (prefixed with @). Always allow overdraft.

export const systemAccount = summaSchema.table("system_account", {
	id: uuid("id").primaryKey().defaultRandom(),
	ledgerId: uuid("ledger_id")
		.notNull()
		.references(() => ledger.id),
	identifier: varchar("identifier", { length: 100 }).notNull(),
	name: varchar("name", { length: 255 }).notNull(),

	balance: bigint("balance", { mode: "number" }).notNull().default(0),
	creditBalance: bigint("credit_balance", { mode: "number" }).notNull().default(0),
	debitBalance: bigint("debit_balance", { mode: "number" }).notNull().default(0),

	allowOverdraft: boolean("allow_overdraft").notNull().default(true),
	currency: char("currency", { length: 3 }).notNull().default("INR"),
	lockVersion: integer("lock_version").notNull().default(1),
	lastSequenceNumber: bigint("last_sequence_number", { mode: "number" }).notNull().default(0),

	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SystemAccountRow = typeof systemAccount.$inferSelect;
export type SystemAccountInsert = typeof systemAccount.$inferInsert;

// =============================================================================
// 4. TRANSACTION RECORD
// =============================================================================
// Records every financial transaction with full lifecycle tracking.

export const transactionRecord = summaSchema.table(
	"transaction_record",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ledgerId: uuid("ledger_id")
			.notNull()
			.references(() => ledger.id),
		type: varchar("type", { length: 50 }).notNull(),
		reference: varchar("reference", { length: 255 }).notNull(),
		status: varchar("status", { length: 20 }).notNull().default("pending"),

		amount: bigint("amount", { mode: "number" }).notNull(),
		currency: char("currency", { length: 3 }).notNull().default("INR"),
		description: text("description"),

		sourceAccountId: uuid("source_account_id"),
		destinationAccountId: uuid("destination_account_id"),
		sourceSystemAccountId: uuid("source_system_account_id"),
		destinationSystemAccountId: uuid("destination_system_account_id"),

		isHold: boolean("is_hold").notNull().default(false),
		committedAmount: bigint("committed_amount", { mode: "number" }),
		holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
		processingAt: timestamp("processing_at", { withTimezone: true }),

		parentId: uuid("parent_id"),
		isReversal: boolean("is_reversal").notNull().default(false),
		refundedAmount: bigint("refunded_amount", { mode: "number" }).notNull().default(0),

		correlationId: uuid("correlation_id").notNull().defaultRandom(),
		metaData: jsonb("meta_data"),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		postedAt: timestamp("posted_at", { withTimezone: true }),
	},
	(table) => [
		index("idx_txn_record_ledger").on(table.ledgerId),
		uniqueIndex("uq_txn_record_reference").on(table.ledgerId, table.reference),
		index("idx_txn_record_status").on(table.status),
		index("idx_txn_record_type").on(table.type),
		index("idx_txn_record_source").on(table.sourceAccountId),
		index("idx_txn_record_destination").on(table.destinationAccountId),
		index("idx_txn_record_hold_expiry").on(table.holdExpiresAt),
		index("idx_txn_record_parent").on(table.parentId),
		index("idx_txn_record_correlation").on(table.correlationId),
		index("idx_txn_record_created_at").on(table.createdAt),
	],
);

export type TransactionRecordRow = typeof transactionRecord.$inferSelect;
export type TransactionRecordInsert = typeof transactionRecord.$inferInsert;

// =============================================================================
// 5. ENTRY RECORD (Double-entry)
// =============================================================================
// Every transaction produces exactly balanced debit + credit entries.

export const entryRecord = summaSchema.table(
	"entry_record",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		transactionId: uuid("transaction_id")
			.notNull()
			.references(() => transactionRecord.id),

		accountId: uuid("account_id").references(() => accountBalance.id),
		systemAccountId: uuid("system_account_id").references(() => systemAccount.id),

		entryType: varchar("entry_type", { length: 10 }).notNull(), // 'DEBIT' | 'CREDIT'
		amount: bigint("amount", { mode: "number" }).notNull(),
		currency: char("currency", { length: 3 }).notNull().default("INR"),

		balanceBefore: bigint("balance_before", { mode: "number" }),
		balanceAfter: bigint("balance_after", { mode: "number" }),
		isHotAccount: boolean("is_hot_account").notNull().default(false),
		accountLockVersion: integer("account_lock_version"),

		/** Original amount before FX conversion (null for same-currency) */
		originalAmount: bigint("original_amount", { mode: "number" }),
		/** Original currency code before FX conversion (null for same-currency) */
		originalCurrency: char("original_currency", { length: 3 }),
		/** Exchange rate used, stored as integer with 6 decimal precision (null for same-currency) */
		exchangeRate: bigint("exchange_rate", { mode: "number" }),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("idx_entry_record_transaction").on(table.transactionId),
		index("idx_entry_record_account").on(table.accountId),
		index("idx_entry_record_system_account").on(table.systemAccountId),
		index("idx_entry_record_version").on(table.accountId, table.accountLockVersion),
		index("idx_entry_record_created_at").on(table.createdAt),
	],
);

export type EntryRecordRow = typeof entryRecord.$inferSelect;
export type EntryRecordInsert = typeof entryRecord.$inferInsert;

// =============================================================================
// 6. OUTBOX (Reliable event publishing)
// =============================================================================

export const outbox = summaSchema.table(
	"outbox",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		eventId: uuid("event_id").references(() => ledgerEvent.id),
		topic: varchar("topic", { length: 100 }).notNull(),
		payload: jsonb("payload").notNull(),
		status: varchar("status", { length: 20 }).notNull().default("pending"),
		retryCount: integer("retry_count").notNull().default(0),
		maxRetries: integer("max_retries").notNull().default(5),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		processedAt: timestamp("processed_at", { withTimezone: true }),
	},
	(table) => [
		index("idx_outbox_pending").on(table.status, table.createdAt),
		index("idx_outbox_cleanup").on(table.processedAt),
	],
);

export type OutboxRow = typeof outbox.$inferSelect;
export type OutboxInsert = typeof outbox.$inferInsert;

// =============================================================================
// 8. HOT ACCOUNT ENTRY QUEUE
// =============================================================================
// Async batched updates for high-volume system accounts.

export const hotAccountEntry = summaSchema.table(
	"hot_account_entry",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		sequenceNumber: bigserial("sequence_number", { mode: "number" }).unique().notNull(),
		accountId: uuid("account_id").notNull(),
		amount: bigint("amount", { mode: "number" }).notNull(),
		entryType: varchar("entry_type", { length: 10 }).notNull(),
		transactionId: uuid("transaction_id").notNull(),
		status: varchar("status", { length: 20 }).notNull().default("pending"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		processedAt: timestamp("processed_at", { withTimezone: true }),
	},
	(table) => [
		index("idx_hot_account_pending").on(table.status, table.accountId, table.sequenceNumber),
	],
);

export type HotAccountEntryRow = typeof hotAccountEntry.$inferSelect;
export type HotAccountEntryInsert = typeof hotAccountEntry.$inferInsert;

// =============================================================================
// 10. PROCESSED EVENTS (consumer idempotency)
// =============================================================================
// Tracks which outbox events have been successfully published for deduplication.

export const processedEvent = summaSchema.table(
	"processed_event",
	{
		id: uuid("id").primaryKey(),
		topic: varchar("topic", { length: 100 }).notNull(),
		payload: jsonb("payload"),
		processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("idx_processed_event_cleanup").on(table.processedAt)],
);

export type ProcessedEventRow = typeof processedEvent.$inferSelect;

// =============================================================================
// 11. IDEMPOTENCY KEYS (24-hour TTL)
// =============================================================================

export const idempotencyKey = summaSchema.table(
	"idempotency_key",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ledgerId: uuid("ledger_id")
			.notNull()
			.references(() => ledger.id),
		key: varchar("key", { length: 255 }).notNull(),
		reference: varchar("reference", { length: 255 }),
		resultEventId: uuid("result_event_id"),
		resultData: jsonb("result_data"),
		expiresAt: timestamp("expires_at", { withTimezone: true })
			.notNull()
			.default(sql`NOW() + INTERVAL '24 hours'`),
	},
	(table) => [
		uniqueIndex("uq_idempotency_ledger_key").on(table.ledgerId, table.key),
		index("idx_idempotency_reference").on(table.reference),
		index("idx_idempotency_expires").on(table.expiresAt),
	],
);

export type IdempotencyKeyRow = typeof idempotencyKey.$inferSelect;

// =============================================================================
// 16. BLOCK CHECKPOINTS (Azure SQL Ledger pattern)
// =============================================================================
// Each block = batch of events hashed together. Blocks chain via prevBlockHash.
// O(new events) per checkpoint -- never grows with total aggregate count.

export const blockCheckpoint = summaSchema.table(
	"block_checkpoint",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ledgerId: uuid("ledger_id")
			.notNull()
			.references(() => ledger.id),
		blockSequence: bigserial("block_sequence", { mode: "number" }).notNull(),
		blockAt: timestamp("block_at", { withTimezone: true }).notNull().defaultNow(),

		// Event range covered by this block
		fromEventSequence: bigint("from_event_sequence", { mode: "number" }).notNull(),
		toEventSequence: bigint("to_event_sequence", { mode: "number" }).notNull(),
		eventCount: integer("event_count").notNull(),

		// Block hash = SHA256(prevBlockHash + eventsHash)
		// eventsHash = SHA256(sorted event hashes in this block)
		eventsHash: varchar("events_hash", { length: 64 }).notNull(),
		blockHash: varchar("block_hash", { length: 64 }).notNull(),

		// Chain linkage
		prevBlockId: uuid("prev_block_id"),
		prevBlockHash: varchar("prev_block_hash", { length: 64 }),
	},
	(table) => [
		uniqueIndex("uq_block_checkpoint_sequence").on(table.ledgerId, table.blockSequence),
		index("idx_block_checkpoint_sequence").on(table.toEventSequence),
	],
);

export type BlockCheckpointRow = typeof blockCheckpoint.$inferSelect;

// =============================================================================
// 17. WORKER LEASE (distributed coordination)
// =============================================================================
// Used by the worker runner to prevent duplicate execution of lease-required
// workers across multiple processes/instances.

export const workerLease = summaSchema.table(
	"worker_lease",
	{
		workerId: varchar("worker_id", { length: 100 }).primaryKey(),
		leaseHolder: varchar("lease_holder", { length: 100 }).notNull(),
		leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
		acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("idx_worker_lease_until").on(table.leaseUntil)],
);

export type WorkerLeaseRow = typeof workerLease.$inferSelect;

// =============================================================================
// 18. ACCOUNT LIMITS (copied from wallet)
// =============================================================================

export const accountLimit = summaSchema.table(
	"account_limit",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		accountId: uuid("account_id")
			.notNull()
			.references(() => accountBalance.id, { onDelete: "cascade" }),

		// Limit type: per_transaction, daily, monthly
		limitType: varchar("limit_type", { length: 20 }).notNull(),

		// Max amount in smallest units (paise)
		maxAmount: bigint("max_amount", { mode: "number" }).notNull(),

		// Optional category filter (null = all)
		category: varchar("category", { length: 50 }),

		enabled: boolean("enabled").notNull().default(true),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		uniqueIndex("uq_account_limit").on(table.accountId, table.limitType, table.category),
		index("idx_account_limit_account").on(table.accountId),
	],
);

export type AccountLimitRow = typeof accountLimit.$inferSelect;
export type AccountLimitInsert = typeof accountLimit.$inferInsert;

// =============================================================================
// 19. TRANSACTION LOG (velocity tracking cache)
// =============================================================================

export const accountTransactionLog = summaSchema.table(
	"account_transaction_log",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		accountId: uuid("account_id")
			.notNull()
			.references(() => accountBalance.id, { onDelete: "cascade" }),
		ledgerTxnId: uuid("ledger_txn_id").notNull(),

		txnType: varchar("txn_type", { length: 20 }).notNull(),
		amount: bigint("amount", { mode: "number" }).notNull(),
		category: varchar("category", { length: 50 }),
		reference: varchar("reference", { length: 255 }),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("idx_txn_log_account_time").on(table.accountId, table.createdAt),
		index("idx_txn_log_account_category").on(table.accountId, table.category, table.createdAt),
		uniqueIndex("idx_txn_log_txn_account").on(table.ledgerTxnId, table.accountId),
	],
);

export type AccountTransactionLogRow = typeof accountTransactionLog.$inferSelect;
