// =============================================================================
// RAW SQL ROW TYPES
// =============================================================================
// PostgreSQL returns snake_case column names from raw queries.
// These types match the database column names exactly.
//
// After the v2 redesign:
// - RawAccountRow = direct read from `account` table (unified, mutable balance)
// - RawTransferRow = direct read from `transfer` table (status is a column)

/** Account row — direct read from the unified `account` table. */
export interface RawAccountRow {
	id: string;
	ledger_id: string;
	holder_id: string;
	holder_type: string;
	currency: string;
	is_system: boolean;
	system_identifier: string | null;
	name: string | null;
	account_type: string | null;
	account_code: string | null;
	parent_account_id: string | null;
	normal_balance: string | null;
	indicator: string | null;
	allow_overdraft: boolean;
	overdraft_limit: number;
	metadata: Record<string, unknown>;
	created_at: string | Date;
	// Mutable balance state
	balance: number;
	credit_balance: number;
	debit_balance: number;
	pending_debit: number;
	pending_credit: number;
	version: number;
	status: string;
	checksum: string | null;
	freeze_reason: string | null;
	frozen_at: string | Date | null;
	frozen_by: string | null;
	closed_at: string | Date | null;
	closed_by: string | null;
	closure_reason: string | null;
}

/** Transfer row — direct read from the `transfer` table. */
export interface RawTransferRow {
	id: string;
	ledger_id: string;
	type: string;
	status: string;
	reference: string;
	amount: number;
	currency: string;
	description: string | null;
	source_account_id: string | null;
	destination_account_id: string | null;
	correlation_id: string | null;
	metadata: Record<string, unknown> | null;
	is_hold: boolean;
	hold_expires_at: string | Date | null;
	parent_id: string | null;
	is_reversal: boolean;
	committed_amount: number | null;
	refunded_amount: number | null;
	effective_date: string | Date;
	posted_at: string | Date | null;
	created_at: string | Date;
}

/** Entry row — direct read from the `entry` table. */
export interface RawEntryRow {
	id: string;
	transfer_id: string;
	account_id: string;
	entry_type: string;
	amount: number;
	currency: string;
	balance_before: number | null;
	balance_after: number | null;
	account_version: number | null;
	sequence_number: number;
	hash: string;
	prev_hash: string | null;
	original_amount: number | null;
	original_currency: string | null;
	exchange_rate: number | null;
	effective_date: string | Date;
	created_at: string | Date;
}

export interface RawHoldSummaryRow {
	id: string;
	source_account_id: string;
	amount: number;
	reference: string;
	metadata: Record<string, unknown> | null;
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
