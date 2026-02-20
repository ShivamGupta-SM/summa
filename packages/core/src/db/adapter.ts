// =============================================================================
// SUMMA ADAPTER INTERFACE
// =============================================================================
// Financial-grade database adapter with transaction, locking, and raw SQL support.
// Extends beyond simple CRUD — double-entry bookkeeping demands it.

export interface Where {
	field: string;
	operator: WhereOperator;
	value: unknown;
}

export type WhereOperator =
	| "eq"
	| "ne"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "in"
	| "like"
	| "is_null"
	| "is_not_null";

export interface SortBy {
	field: string;
	direction: "asc" | "desc";
}

export interface SummaAdapter {
	id: string;

	// CRUD operations
	create<T extends Record<string, unknown>>(data: { model: string; data: T }): Promise<T>;

	findOne<T>(data: { model: string; where: Where[]; forUpdate?: boolean }): Promise<T | null>;

	findMany<T>(data: {
		model: string;
		where?: Where[];
		limit?: number;
		offset?: number;
		sortBy?: SortBy;
	}): Promise<T[]>;

	update<T>(data: {
		model: string;
		where: Where[];
		update: Record<string, unknown>;
	}): Promise<T | null>;

	delete(data: { model: string; where: Where[] }): Promise<void>;

	count(data: { model: string; where?: Where[] }): Promise<number>;

	// Financial-critical operations
	transaction<T>(fn: (tx: SummaTransactionAdapter) => Promise<T>): Promise<T>;

	advisoryLock(key: number): Promise<void>;

	raw<T>(sql: string, params: unknown[]): Promise<T[]>;

	rawMutate(sql: string, params: unknown[]): Promise<number>;

	// Adapter capabilities
	options?: SummaAdapterOptions;
}

export type SummaTransactionAdapter = Omit<SummaAdapter, "transaction">;

export interface SummaAdapterOptions {
	supportsAdvisoryLocks: boolean;
	supportsForUpdate: boolean;
	supportsReturning: boolean;
	dialectName: "postgres" | "mysql" | "sqlite";
	dialect?: import("./dialect.js").SqlDialect;
}
