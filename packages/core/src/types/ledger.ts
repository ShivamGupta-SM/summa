export interface Ledger {
	id: string;
	name: string;
	metadata: Record<string, unknown>;
	createdAt: Date;
}
