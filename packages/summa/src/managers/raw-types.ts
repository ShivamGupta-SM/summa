// =============================================================================
// RAW SQL ROW TYPES
// =============================================================================
// PostgreSQL returns snake_case column names from raw queries.
// These types match the database column names exactly.

export interface RawAccountRow {
	id: string;
	holder_id: string;
	holder_type: string;
	balance: number;
	credit_balance: number;
	debit_balance: number;
	pending_credit: number;
	pending_debit: number;
	currency: string;
	lock_version: number;
	allow_overdraft: boolean;
	status: string;
	metadata: Record<string, unknown>;
	indicator?: string | null;
	freeze_reason?: string | null;
	frozen_at?: string | Date | null;
	frozen_by?: string | null;
	closed_at?: string | Date | null;
	closed_by?: string | null;
	closure_reason?: string | null;
	created_at: string | Date;
	updated_at: string | Date;
}

export interface RawTransactionRow {
	id: string;
	reference: string;
	status: string;
	amount: number;
	currency: string;
	description: string | null;
	source_account_id: string | null;
	destination_account_id: string | null;
	source_system_account_id: string | null;
	destination_system_account_id: string | null;
	is_hold: boolean;
	hold_expires_at: string | Date | null;
	processing_at: string | Date | null;
	parent_id: string | null;
	is_reversal: boolean;
	refunded_amount: number;
	committed_amount: number | null;
	correlation_id: string;
	meta_data: Record<string, unknown> | null;
	created_at: string | Date;
	posted_at: string | Date | null;
}

export interface RawBalanceUpdateRow {
	balance_before: number;
	balance_after: number;
	lock_version: number;
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
