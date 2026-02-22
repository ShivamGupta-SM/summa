export type AccountStatus = "active" | "frozen" | "closed";
export type HolderType = "individual" | "organization" | "system";
export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type NormalBalance = "debit" | "credit";

export interface Account {
	id: string;
	holderId: string;
	holderType: HolderType;
	status: AccountStatus;
	currency: string;
	balance: number;
	creditBalance: number;
	debitBalance: number;
	pendingCredit: number;
	pendingDebit: number;
	allowOverdraft: boolean;
	overdraftLimit: number;
	accountType: AccountType | null;
	accountCode: string | null;
	parentAccountId: string | null;
	normalBalance: NormalBalance | null;
	indicator: string | null;
	freezeReason: string | null;
	frozenAt: Date | null;
	frozenBy: string | null;
	closedAt: Date | null;
	closedBy: string | null;
	closureReason: string | null;
	metadata: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
}

export interface AccountBalance {
	/** Settled balance in smallest units (paise/cents) */
	balance: number;
	/** Credit balance total */
	creditBalance: number;
	/** Debit balance total */
	debitBalance: number;
	/** Pending/inflight credits */
	pendingCredit: number;
	/** Pending/inflight debits (held amounts) */
	pendingDebit: number;
	/** Available = balance - pendingDebit */
	availableBalance: number;
	currency: string;
}
