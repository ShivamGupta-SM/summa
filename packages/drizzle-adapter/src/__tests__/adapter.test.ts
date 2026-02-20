import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleAdapter } from "../adapter.js";

/**
 * Drizzle adapter unit tests.
 *
 * Tests the adapter's SQL generation, case conversion, and WHERE clause building
 * using a mocked Drizzle database instance. No PostgreSQL required.
 */

// Mock Drizzle database that captures executed SQL
function createMockDb() {
	const executed: { sql: string; params: unknown[] }[] = [];
	let nextResult: unknown[] = [];

	const db = {
		execute: vi.fn(async (sqlObj: unknown) => {
			// Capture the SQL for inspection
			const sqlStr = String(sqlObj);
			executed.push({ sql: sqlStr, params: [] });
			return { rows: nextResult, rowCount: nextResult.length };
		}),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
			return fn(db); // Pass same mock as transaction handle
		}),
	};

	return {
		db,
		executed,
		setNextResult: (rows: unknown[]) => {
			nextResult = rows;
		},
	};
}

describe("Drizzle Adapter", () => {
	let mock: ReturnType<typeof createMockDb>;

	beforeEach(() => {
		mock = createMockDb();
	});

	// =========================================================================
	// ADAPTER CREATION
	// =========================================================================

	it("creates adapter with correct options", () => {
		const adapter = drizzleAdapter(mock.db);
		expect(adapter.id).toBe("drizzle");
		expect(adapter.options).toMatchObject({
			supportsAdvisoryLocks: true,
			supportsForUpdate: true,
			supportsReturning: true,
			dialectName: "postgres",
		});
		expect(adapter.options.dialect).toBeDefined();
	});

	// =========================================================================
	// CREATE
	// =========================================================================

	it("create inserts data and returns camelCase keys", async () => {
		const adapter = drizzleAdapter(mock.db);

		mock.setNextResult([
			{ id: "uuid-1", holder_id: "user-1", holder_type: "individual", created_at: "2024-01-01" },
		]);

		const result = await adapter.create<Record<string, unknown>>({
			model: "account_balance",
			data: { id: "uuid-1", holderId: "user-1", holderType: "individual" },
		});

		expect(result.holderId).toBe("user-1");
		expect(result.holderType).toBe("individual");
		expect(result.createdAt).toBe("2024-01-01");
		expect(mock.db.execute).toHaveBeenCalledTimes(1);
	});

	it("create rejects empty data", async () => {
		const adapter = drizzleAdapter(mock.db);

		await expect(adapter.create({ model: "account_balance", data: {} })).rejects.toThrow(
			"Cannot insert empty data",
		);
	});

	// =========================================================================
	// FIND ONE
	// =========================================================================

	it("findOne returns null when no rows found", async () => {
		const adapter = drizzleAdapter(mock.db);
		mock.setNextResult([]);

		const result = await adapter.findOne({
			model: "account_balance",
			where: [{ field: "holderId", operator: "eq", value: "nonexistent" }],
		});

		expect(result).toBeNull();
	});

	it("findOne returns camelCase result", async () => {
		const adapter = drizzleAdapter(mock.db);
		mock.setNextResult([{ id: "uuid-1", holder_id: "user-1", lock_version: 3 }]);

		const result = await adapter.findOne<{ id: string; holderId: string; lockVersion: number }>({
			model: "account_balance",
			where: [{ field: "id", operator: "eq", value: "uuid-1" }],
		});

		expect(result).not.toBeNull();
		expect(result?.holderId).toBe("user-1");
		expect(result?.lockVersion).toBe(3);
	});

	// =========================================================================
	// FIND MANY
	// =========================================================================

	it("findMany returns array of camelCase results", async () => {
		const adapter = drizzleAdapter(mock.db);
		mock.setNextResult([
			{ id: "1", holder_id: "a", balance: 100 },
			{ id: "2", holder_id: "b", balance: 200 },
		]);

		const results = await adapter.findMany<{ id: string; holderId: string; balance: number }>({
			model: "account_balance",
		});

		expect(results).toHaveLength(2);
		expect(results[0]?.holderId).toBe("a");
		expect(results[1]?.holderId).toBe("b");
	});

	it("findMany with empty result returns empty array", async () => {
		const adapter = drizzleAdapter(mock.db);
		mock.setNextResult([]);

		const results = await adapter.findMany({ model: "account_balance" });
		expect(results).toEqual([]);
	});

	// =========================================================================
	// UPDATE
	// =========================================================================

	it("update returns null when row not found", async () => {
		const adapter = drizzleAdapter(mock.db);
		mock.setNextResult([]);

		const result = await adapter.update({
			model: "account_balance",
			where: [{ field: "id", operator: "eq", value: "nonexistent" }],
			update: { balance: 500 },
		});

		expect(result).toBeNull();
	});

	it("update rejects empty update data", async () => {
		const adapter = drizzleAdapter(mock.db);

		await expect(
			adapter.update({
				model: "account_balance",
				where: [{ field: "id", operator: "eq", value: "uuid-1" }],
				update: {},
			}),
		).rejects.toThrow("Cannot update");
	});

	// =========================================================================
	// COUNT
	// =========================================================================

	it("count returns number", async () => {
		const adapter = drizzleAdapter(mock.db);
		mock.setNextResult([{ count: 42 }]);

		const result = await adapter.count({ model: "account_balance" });
		expect(result).toBe(42);
	});

	it("count returns 0 when no match", async () => {
		const adapter = drizzleAdapter(mock.db);
		mock.setNextResult([]);

		const result = await adapter.count({ model: "account_balance" });
		expect(result).toBe(0);
	});

	// =========================================================================
	// RAW SQL
	// =========================================================================

	it("raw returns typed results", async () => {
		const adapter = drizzleAdapter(mock.db);
		mock.setNextResult([{ total: 1000 }]);

		const result = await adapter.raw<{ total: number }>(
			"SELECT SUM(balance) AS total FROM account_balance",
			[],
		);

		expect(result).toHaveLength(1);
		expect(result[0]?.total).toBe(1000);
	});

	it("rawMutate returns affected row count", async () => {
		const adapter = drizzleAdapter(mock.db);
		mock.setNextResult([]);

		const count = await adapter.rawMutate("DELETE FROM outbox WHERE processed_at < NOW()", []);

		expect(typeof count).toBe("number");
	});

	// =========================================================================
	// TRANSACTION
	// =========================================================================

	it("transaction wraps operations in a Drizzle transaction", async () => {
		const adapter = drizzleAdapter(mock.db);
		mock.setNextResult([{ id: "tx-result" }]);

		const result = await adapter.transaction(async (tx) => {
			expect(tx.id).toBe("drizzle");
			expect(tx.options).toMatchObject({
				supportsAdvisoryLocks: true,
				supportsForUpdate: true,
				supportsReturning: true,
				dialectName: "postgres",
			});
			expect(tx.options.dialect).toBeDefined();

			const rows = await tx.raw<{ id: string }>("SELECT 1", []);
			return rows[0]?.id;
		});

		expect(result).toBe("tx-result");
		expect(mock.db.transaction).toHaveBeenCalledTimes(1);
	});

	// =========================================================================
	// DELETE
	// =========================================================================

	it("delete executes without errors", async () => {
		const adapter = drizzleAdapter(mock.db);
		mock.setNextResult([]);

		await adapter.delete({
			model: "outbox",
			where: [{ field: "id", operator: "eq", value: "uuid-1" }],
		});

		expect(mock.db.execute).toHaveBeenCalledTimes(1);
	});
});
