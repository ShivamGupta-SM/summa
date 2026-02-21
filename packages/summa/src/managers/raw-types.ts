// =============================================================================
// RAW SQL ROW TYPES
// =============================================================================
// PostgreSQL returns snake_case column names from raw queries.
// These types match the database column names exactly.
//
// After the immutability refactor:
// - RawAccountRow = JOIN of account_balance (static) + account_balance_version (latest state)
// - RawTransactionRow = JOIN of transaction_record (static) + transaction_status (latest state)

/** Static properties from account_balance (immutable after creation) */
export interface RawAccountStaticRow {
	id: string;
	holder_id: string;
	holder_type: string;
	currency: string;
	allow_overdraft: boolean;
	overdraft_limit?: number;
	account_type?: string | null;
	account_code?: string | null;
	parent_account_id?: string | null;
	normal_balance?: string | null;
	indicator?: string | null;
	name?: string | null;
	metadata: Record<string, unknown>;
	created_at: string | Date;
}

/** State snapshot from account_balance_version (append-only) */
export interface RawAccountVersionRow {
	version: number;
	balance: number;
	credit_balance: number;
	debit_balance: number;
	pending_credit: number;
	pending_debit: number;
	status: string;
	checksum?: string | null;
	freeze_reason?: string | null;
	frozen_at?: string | Date | null;
	frozen_by?: string | null;
	closed_at?: string | Date | null;
	closed_by?: string | null;
	closure_reason?: string | null;
}

/**
 * Combined account view — result of joining account_balance + latest account_balance_version.
 * This is the primary type used by managers for account operations.
 * `version` replaces the old `lock_version` field.
 */
export interface RawAccountRow extends RawAccountStaticRow, RawAccountVersionRow {}

/** Static properties from transaction_record (immutable after creation) */
export interface RawTransactionStaticRow {
	id: string;
	type: string | null;
	reference: string;
	amount: number;
	currency: string;
	description: string | null;
	source_account_id: string | null;
	destination_account_id: string | null;
	source_system_account_id: string | null;
	destination_system_account_id: string | null;
	is_hold: boolean;
	hold_expires_at: string | Date | null;
	parent_id: string | null;
	is_reversal: boolean;
	correlation_id: string;
	meta_data: Record<string, unknown> | null;
	created_at: string | Date;
}

/** Status state from transaction_status (append-only) */
export interface RawTransactionStatusRow {
	status: string;
	committed_amount: number | null;
	refunded_amount: number;
	posted_at: string | Date | null;
}

/**
 * Combined transaction view — result of joining transaction_record + latest transaction_status.
 * This is the primary type used by managers for transaction operations.
 */
export interface RawTransactionRow extends RawTransactionStaticRow, RawTransactionStatusRow {
	processing_at: string | Date | null;
}

/** Shape of the latest account_balance_version row. Used by managers for balance operations. */
export interface LatestVersion {
	version: number;
	balance: number;
	credit_balance: number;
	debit_balance: number;
	pending_debit: number;
	pending_credit: number;
	status: string;
	checksum?: string | null;
	freeze_reason: string | null;
	frozen_at: string | Date | null;
	frozen_by: string | null;
	closed_at: string | Date | null;
	closed_by: string | null;
	closure_reason: string | null;
}

export interface RawHoldSummaryRow {
	id: string;
	source_account_id: string;
	amount: number;
	reference: string;
	meta_data: Record<string, unknown> | null;
}

export interface RawCountRow {
	count: number;
}

export interface RawIdRow {
	id: string;
}

export interface RawRowCountResult {
	rowCount: number;
}

export interface RawSystemAccountRow {
	id: string;
	identifier: string;
	name: string;
	allow_overdraft: boolean;
	currency: string;
	created_at: string | Date;
}

export interface RawLimitRow {
	id: string;
	account_id: string;
	limit_type: string;
	max_amount: number;
	category: string | null;
	enabled: boolean;
	created_at: string | Date;
	updated_at: string | Date;
}
