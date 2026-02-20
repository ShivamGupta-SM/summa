export type TransactionType = "credit" | "debit" | "transfer";
export type TransactionStatus =
	| "pending"
	| "inflight"
	| "posted"
	| "expired"
	| "voided"
	| "reversed";

export interface LedgerTransaction {
	id: string;
	reference: string;
	type: TransactionType;
	status: TransactionStatus;
	/** Amount in smallest units (paise/cents) */
	amount: number;
	/** Decimal string for display (e.g., "254.90") */
	amountDecimal: string;
	currency: string;
	description: string;
	sourceAccountId: string | null;
	destinationAccountId: string | null;
	correlationId: string;
	isReversal: boolean;
	parentId: string | null;
	metadata: Record<string, unknown>;
	createdAt: string;
	postedAt: string | null;
}
