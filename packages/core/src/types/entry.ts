export type EntryType = "DEBIT" | "CREDIT";

export interface EntryRecord {
	id: string;
	transactionId: string;
	accountId: string | null;
	systemAccountId: string | null;
	entryType: EntryType;
	amount: number;
	currency: string;
	balanceBefore: number | null;
	balanceAfter: number | null;
	isHotAccount: boolean;
	accountLockVersion: number | null;
	createdAt: Date;
}
