// =============================================================================
// LIMIT TYPES -- Shared velocity limit type definitions
// =============================================================================

export type LimitType = "per_transaction" | "daily" | "monthly";

export interface AccountLimitInfo {
	id: string;
	accountId: string;
	limitType: LimitType;
	maxAmount: number;
	category: string | null;
	enabled: boolean;
	createdAt: Date;
	updatedAt: Date;
}
