import { drizzleAdapter } from "@summa/drizzle-adapter";
import { getTestInstance, type TestInstance } from "@summa/test-utils";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const DATABASE_URL =
	process.env.DATABASE_URL ?? "postgresql://summa:summa@localhost:5432/summa_test";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
	if (!pool) {
		pool = new pg.Pool({ connectionString: DATABASE_URL });
	}
	return pool;
}

export async function createTestSchema(): Promise<void> {
	const client = await getPool().connect();
	try {
		// Drop all summa tables if they exist (clean slate per test suite)
		await client.query(`
			DROP TABLE IF EXISTS
				failed_event,
				account_transaction_log,
				account_limit,
				worker_lease,
				block_checkpoint,
				scheduled_transaction,
				account_snapshot,
				reconciliation_watermark,
				reconciliation_result,
				idempotency_key,
				processed_event,
				hot_account_failed_sequence,
				hot_account_entry,
				dead_letter_queue,
				outbox,
				entry_record,
				transaction_record,
				system_account,
				account_balance,
				ledger_event
			CASCADE
		`);

		// Create all tables via raw SQL since drizzle-orm doesn't have a
		// programmatic "create table" API. Use the schema definitions to generate DDL.
		await client.query(`
			CREATE EXTENSION IF NOT EXISTS "pgcrypto";

			CREATE TABLE ledger_event (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				sequence_number BIGSERIAL UNIQUE NOT NULL,
				aggregate_type VARCHAR(50) NOT NULL,
				aggregate_id UUID NOT NULL,
				aggregate_version INTEGER NOT NULL,
				event_type VARCHAR(100) NOT NULL,
				event_data JSONB NOT NULL,
				correlation_id UUID NOT NULL,
				hash VARCHAR(64) NOT NULL,
				prev_hash VARCHAR(64),
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE UNIQUE INDEX uq_ledger_event_aggregate_version ON ledger_event(aggregate_type, aggregate_id, aggregate_version);
			CREATE INDEX idx_ledger_event_aggregate ON ledger_event(aggregate_type, aggregate_id);
			CREATE INDEX idx_ledger_event_correlation ON ledger_event(correlation_id);

			CREATE TABLE account_balance (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				ledger_id UUID NOT NULL DEFAULT gen_random_uuid(),
				indicator VARCHAR(255) UNIQUE,
				holder_id VARCHAR(255) NOT NULL,
				holder_type VARCHAR(100) NOT NULL,
				balance BIGINT NOT NULL DEFAULT 0,
				credit_balance BIGINT NOT NULL DEFAULT 0,
				debit_balance BIGINT NOT NULL DEFAULT 0,
				pending_credit BIGINT NOT NULL DEFAULT 0,
				pending_debit BIGINT NOT NULL DEFAULT 0,
				currency CHAR(3) NOT NULL DEFAULT 'INR',
				lock_version INTEGER NOT NULL DEFAULT 1,
				last_sequence_number BIGINT NOT NULL DEFAULT 0,
				allow_overdraft BOOLEAN NOT NULL DEFAULT false,
				overdraft_limit BIGINT,
				status VARCHAR(20) NOT NULL DEFAULT 'active',
				freeze_reason TEXT,
				frozen_at TIMESTAMPTZ,
				frozen_by VARCHAR(100),
				closed_at TIMESTAMPTZ,
				closed_by VARCHAR(100),
				closure_reason TEXT,
				metadata JSONB NOT NULL DEFAULT '{}',
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE UNIQUE INDEX uq_account_balance_holder ON account_balance(ledger_id, holder_id, holder_type, currency);
			CREATE UNIQUE INDEX uq_account_balance_holder_currency ON account_balance(holder_id, currency);
			CREATE INDEX idx_account_balance_sequence ON account_balance(last_sequence_number);
			CREATE INDEX idx_account_balance_status ON account_balance(status);
			CREATE INDEX idx_account_balance_holder_lookup ON account_balance(holder_id, holder_type);

			CREATE TABLE system_account (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				identifier VARCHAR(100) UNIQUE NOT NULL,
				name VARCHAR(255) NOT NULL,
				balance BIGINT NOT NULL DEFAULT 0,
				credit_balance BIGINT NOT NULL DEFAULT 0,
				debit_balance BIGINT NOT NULL DEFAULT 0,
				allow_overdraft BOOLEAN NOT NULL DEFAULT true,
				currency CHAR(3) NOT NULL DEFAULT 'INR',
				lock_version INTEGER NOT NULL DEFAULT 1,
				last_sequence_number BIGINT NOT NULL DEFAULT 0,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);

			CREATE TABLE transaction_record (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				reference VARCHAR(255) UNIQUE NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'pending',
				amount BIGINT NOT NULL,
				currency CHAR(3) NOT NULL DEFAULT 'INR',
				description TEXT,
				source_account_id UUID,
				destination_account_id UUID,
				source_system_account_id UUID,
				destination_system_account_id UUID,
				is_hold BOOLEAN NOT NULL DEFAULT false,
				committed_amount BIGINT,
				hold_expires_at TIMESTAMPTZ,
				processing_at TIMESTAMPTZ,
				parent_id UUID,
				is_reversal BOOLEAN NOT NULL DEFAULT false,
				refunded_amount BIGINT NOT NULL DEFAULT 0,
				correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
				meta_data JSONB,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				posted_at TIMESTAMPTZ
			);
			CREATE INDEX idx_txn_record_status ON transaction_record(status);
			CREATE INDEX idx_txn_record_reference ON transaction_record(reference);
			CREATE INDEX idx_txn_record_source ON transaction_record(source_account_id);
			CREATE INDEX idx_txn_record_destination ON transaction_record(destination_account_id);
			CREATE INDEX idx_txn_record_hold_expiry ON transaction_record(hold_expires_at);
			CREATE INDEX idx_txn_record_parent ON transaction_record(parent_id);
			CREATE INDEX idx_txn_record_correlation ON transaction_record(correlation_id);
			CREATE INDEX idx_txn_record_created_at ON transaction_record(created_at);

			CREATE TABLE entry_record (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				transaction_id UUID NOT NULL REFERENCES transaction_record(id),
				account_id UUID REFERENCES account_balance(id),
				system_account_id UUID REFERENCES system_account(id),
				entry_type VARCHAR(10) NOT NULL,
				amount BIGINT NOT NULL,
				currency CHAR(3) NOT NULL DEFAULT 'INR',
				balance_before BIGINT,
				balance_after BIGINT,
				is_hot_account BOOLEAN NOT NULL DEFAULT false,
				account_lock_version INTEGER,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE INDEX idx_entry_record_transaction ON entry_record(transaction_id);
			CREATE INDEX idx_entry_record_account ON entry_record(account_id);
			CREATE INDEX idx_entry_record_system_account ON entry_record(system_account_id);
			CREATE INDEX idx_entry_record_version ON entry_record(account_id, account_lock_version);
			CREATE INDEX idx_entry_record_created_at ON entry_record(created_at);

			CREATE TABLE outbox (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				event_id UUID REFERENCES ledger_event(id),
				topic VARCHAR(100) NOT NULL,
				payload JSONB NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'pending',
				retry_count INTEGER NOT NULL DEFAULT 0,
				max_retries INTEGER NOT NULL DEFAULT 5,
				last_error TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				processed_at TIMESTAMPTZ
			);
			CREATE INDEX idx_outbox_pending ON outbox(status, created_at);
			CREATE INDEX idx_outbox_cleanup ON outbox(processed_at);

			CREATE TABLE dead_letter_queue (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				outbox_id UUID REFERENCES outbox(id),
				topic VARCHAR(100) NOT NULL,
				payload JSONB NOT NULL,
				error_message TEXT NOT NULL,
				retry_count INTEGER NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'pending',
				resolved_at TIMESTAMPTZ,
				resolved_by VARCHAR(100),
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE INDEX idx_dlq_status ON dead_letter_queue(status, created_at);

			CREATE TABLE hot_account_entry (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				sequence_number BIGSERIAL UNIQUE NOT NULL,
				account_id UUID NOT NULL,
				amount BIGINT NOT NULL,
				entry_type VARCHAR(10) NOT NULL,
				transaction_id UUID NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'pending',
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				processed_at TIMESTAMPTZ
			);
			CREATE INDEX idx_hot_account_pending ON hot_account_entry(status, account_id, sequence_number);

			CREATE TABLE hot_account_failed_sequence (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				account_id UUID NOT NULL,
				entry_ids JSONB NOT NULL,
				error_message TEXT,
				net_delta BIGINT NOT NULL DEFAULT 0,
				credit_delta BIGINT NOT NULL DEFAULT 0,
				debit_delta BIGINT NOT NULL DEFAULT 0,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE INDEX idx_hot_account_failed_account ON hot_account_failed_sequence(account_id);

			CREATE TABLE processed_event (
				id UUID PRIMARY KEY,
				topic VARCHAR(100) NOT NULL,
				payload JSONB,
				processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE INDEX idx_processed_event_cleanup ON processed_event(processed_at);

			CREATE TABLE idempotency_key (
				key VARCHAR(255) PRIMARY KEY,
				reference VARCHAR(255),
				result_event_id UUID,
				result_data JSONB,
				expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
			);
			CREATE INDEX idx_idempotency_reference ON idempotency_key(reference);
			CREATE INDEX idx_idempotency_expires ON idempotency_key(expires_at);

			CREATE TABLE reconciliation_result (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				run_date VARCHAR(50) UNIQUE NOT NULL,
				status VARCHAR(20) NOT NULL,
				total_mismatches INTEGER NOT NULL DEFAULT 0,
				step0_result JSONB,
				step0b_result JSONB,
				step0c_result JSONB,
				step1_result JSONB,
				step2_result JSONB,
				step3_result JSONB,
				duration_ms INTEGER,
				mismatches JSONB,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE INDEX idx_reconciliation_status ON reconciliation_result(status);

			CREATE TABLE reconciliation_watermark (
				id INTEGER PRIMARY KEY DEFAULT 1,
				last_entry_created_at TIMESTAMPTZ,
				last_run_date DATE,
				last_mismatches INTEGER DEFAULT 0,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);

			CREATE TABLE account_snapshot (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				account_id UUID NOT NULL,
				snapshot_date DATE NOT NULL,
				balance BIGINT NOT NULL,
				credit_balance BIGINT NOT NULL DEFAULT 0,
				debit_balance BIGINT NOT NULL DEFAULT 0,
				pending_credit BIGINT NOT NULL DEFAULT 0,
				pending_debit BIGINT NOT NULL DEFAULT 0,
				available_balance BIGINT NOT NULL DEFAULT 0,
				currency CHAR(3) NOT NULL DEFAULT 'INR',
				account_status VARCHAR(20) NOT NULL DEFAULT 'active',
				checkpoint_hash VARCHAR(64),
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE UNIQUE INDEX uq_account_snapshot_account_date ON account_snapshot(account_id, snapshot_date);

			CREATE TABLE scheduled_transaction (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				ledger_id UUID NOT NULL,
				reference VARCHAR(255),
				amount BIGINT NOT NULL,
				currency CHAR(3) NOT NULL DEFAULT 'INR',
				source_identifier VARCHAR(255) NOT NULL,
				destination_identifier VARCHAR(255),
				scheduled_for TIMESTAMPTZ NOT NULL,
				recurrence JSONB,
				status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
				last_executed_at TIMESTAMPTZ,
				next_execution_at TIMESTAMPTZ,
				execution_count INTEGER NOT NULL DEFAULT 0,
				retry_count INTEGER NOT NULL DEFAULT 0,
				last_retry_at TIMESTAMPTZ
			);
			CREATE INDEX idx_scheduled_pending ON scheduled_transaction(next_execution_at);

			CREATE TABLE block_checkpoint (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				block_sequence BIGSERIAL UNIQUE NOT NULL,
				block_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				from_event_sequence BIGINT NOT NULL,
				to_event_sequence BIGINT NOT NULL,
				event_count INTEGER NOT NULL,
				events_hash VARCHAR(64) NOT NULL,
				block_hash VARCHAR(64) NOT NULL,
				prev_block_id UUID,
				prev_block_hash VARCHAR(64)
			);
			CREATE INDEX idx_block_checkpoint_sequence ON block_checkpoint(to_event_sequence);

			CREATE TABLE worker_lease (
				worker_id VARCHAR(100) PRIMARY KEY,
				lease_holder VARCHAR(100) NOT NULL,
				lease_until TIMESTAMPTZ NOT NULL,
				acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE INDEX idx_worker_lease_until ON worker_lease(lease_until);

			CREATE TABLE account_limit (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				account_id UUID NOT NULL REFERENCES account_balance(id) ON DELETE CASCADE,
				limit_type VARCHAR(20) NOT NULL,
				max_amount BIGINT NOT NULL,
				category VARCHAR(50),
				enabled BOOLEAN NOT NULL DEFAULT true,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE UNIQUE INDEX uq_account_limit ON account_limit(account_id, limit_type, category);
			CREATE INDEX idx_account_limit_account ON account_limit(account_id);

			CREATE TABLE account_transaction_log (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				account_id UUID NOT NULL REFERENCES account_balance(id) ON DELETE CASCADE,
				ledger_txn_id UUID NOT NULL,
				txn_type VARCHAR(20) NOT NULL,
				amount BIGINT NOT NULL,
				category VARCHAR(50),
				reference VARCHAR(255),
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE INDEX idx_txn_log_account_time ON account_transaction_log(account_id, created_at);
			CREATE INDEX idx_txn_log_account_category ON account_transaction_log(account_id, category, created_at);
			CREATE UNIQUE INDEX idx_txn_log_txn_account ON account_transaction_log(ledger_txn_id, account_id);

			CREATE TABLE failed_event (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				topic VARCHAR(100) NOT NULL,
				event_data JSONB NOT NULL,
				error_message TEXT,
				retry_count INTEGER NOT NULL DEFAULT 0,
				last_retry_at TIMESTAMPTZ,
				resolved BOOLEAN NOT NULL DEFAULT false,
				resolved_at TIMESTAMPTZ,
				resolved_by VARCHAR(100),
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			CREATE INDEX idx_failed_event_unresolved ON failed_event(resolved, created_at);
		`);
	} finally {
		client.release();
	}
}

export async function cleanupTables(): Promise<void> {
	const client = await getPool().connect();
	try {
		await client.query(`
			TRUNCATE TABLE
				failed_event,
				account_transaction_log,
				account_limit,
				worker_lease,
				block_checkpoint,
				scheduled_transaction,
				account_snapshot,
				reconciliation_watermark,
				reconciliation_result,
				idempotency_key,
				processed_event,
				hot_account_failed_sequence,
				hot_account_entry,
				dead_letter_queue,
				outbox,
				entry_record,
				transaction_record,
				system_account,
				account_balance,
				ledger_event
			CASCADE
		`);
	} finally {
		client.release();
	}
}

export async function closePool(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = null;
	}
}

export async function createIntegrationInstance(): Promise<TestInstance> {
	const db = drizzle(getPool());
	const adapter = drizzleAdapter(db);
	return getTestInstance({ adapter, currency: "USD" });
}
