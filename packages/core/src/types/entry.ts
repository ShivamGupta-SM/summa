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
	/** Original amount before FX conversion (null for same-currency) */
	originalAmount: number | null;
	/** Original currency code before FX conversion (null for same-currency) */
	originalCurrency: string | null;
	/** Exchange rate used for FX conversion, stored as integer with 6 decimal precision (null for same-currency) */
	exchangeRate: number | null;
	createdAt: Date;
}
