export type HoldStatus = "inflight" | "posted" | "voided" | "expired";

export interface Hold {
	id: string;
	sourceAccountId: string;
	destinationAccountId: string | null;
	/** Amount in smallest units — original hold amount */
	amount: number;
	amountDecimal: string;
	/** Committed amount — null if not committed yet */
	committedAmount: number | null;
	currency: string;
	status: HoldStatus;
	reference: string;
	description: string;
	metadata: Record<string, unknown>;
	expiresAt: string | null;
	createdAt: string;
}

export interface HoldDestination {
	/** Target account holder ID (for user accounts) */
	holderId?: string;
	/** System account identifier (e.g., "@World") */
	systemAccount?: string;
	/** Fixed amount in smallest units. Omit for remainder. */
	amount?: number;
	description?: string;
}
