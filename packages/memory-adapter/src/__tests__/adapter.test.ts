import { describe, expect, it } from "vitest";
import { memoryAdapter } from "../adapter.js";

// =============================================================================
// MEMORY ADAPTER TESTS
// =============================================================================

describe("memoryAdapter", () => {
	it("returns an adapter with id 'memory'", () => {
		const adapter = memoryAdapter();
		expect(adapter.id).toBe("memory");
	});

	it("exposes expected adapter options", () => {
		const adapter = memoryAdapter();
		expect(adapter.options).toEqual({
			supportsAdvisoryLocks: false,
			supportsForUpdate: false,
			supportsReturning: true,
			dialectName: "sqlite",
		});
	});

	// =========================================================================
	// CREATE
	// =========================================================================

	describe("create", () => {
		it("creates a record with auto-generated ID when no id is provided", async () => {
			const adapter = memoryAdapter();
			const result = await adapter.create({
				model: "user",
				data: { name: "Alice" },
			});

			expect(result.id).toBeDefined();
			expect(typeof result.id).toBe("string");
			expect((result.id as string).length).toBeGreaterThan(0);
			expect(result.name).toBe("Alice");
		});

		it("preserves the provided ID when one is given", async () => {
			const adapter = memoryAdapter();
			const result = await adapter.create({
				model: "user",
				data: { id: "custom-id-123", name: "Bob" },
			});

			expect(result.id).toBe("custom-id-123");
			expect(result.name).toBe("Bob");
		});

		it("stores data correctly and can be retrieved via findOne", async () => {
			const adapter = memoryAdapter();
			const _created = await adapter.create({
				model: "user",
				data: { id: "u1", name: "Charlie", age: 30, active: true },
			});

			const found = await adapter.findOne<Record<string, unknown>>({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "u1" }],
			});

			expect(found).not.toBeNull();
			expect(found?.id).toBe("u1");
			expect(found?.name).toBe("Charlie");
			expect(found?.age).toBe(30);
			expect(found?.active).toBe(true);
		});

		it("returns a copy of the data (mutations do not affect the store)", async () => {
			const adapter = memoryAdapter();
			const created = await adapter.create({
				model: "user",
				data: { id: "u1", name: "Dan" },
			});

			// Mutate the returned object
			created.name = "Mutated";

			const found = await adapter.findOne<Record<string, unknown>>({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "u1" }],
			});

			expect(found?.name).toBe("Dan");
		});
	});

	// =========================================================================
	// FIND ONE
	// =========================================================================

	describe("findOne", () => {
		it("finds a record by eq condition", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob" } });

			const result = await adapter.findOne<Record<string, unknown>>({
				model: "user",
				where: [{ field: "name", operator: "eq", value: "Bob" }],
			});

			expect(result).not.toBeNull();
			expect(result?.id).toBe("u2");
			expect(result?.name).toBe("Bob");
		});

		it("returns null when no record matches", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });

			const result = await adapter.findOne<Record<string, unknown>>({
				model: "user",
				where: [{ field: "name", operator: "eq", value: "NonExistent" }],
			});

			expect(result).toBeNull();
		});

		it("returns null for a model that has no records", async () => {
			const adapter = memoryAdapter();

			const result = await adapter.findOne<Record<string, unknown>>({
				model: "nonexistent_model",
				where: [{ field: "id", operator: "eq", value: "anything" }],
			});

			expect(result).toBeNull();
		});

		it("works with multiple where conditions (AND logic)", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice", role: "admin" } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob", role: "user" } });
			await adapter.create({ model: "user", data: { id: "u3", name: "Alice", role: "user" } });

			const result = await adapter.findOne<Record<string, unknown>>({
				model: "user",
				where: [
					{ field: "name", operator: "eq", value: "Alice" },
					{ field: "role", operator: "eq", value: "admin" },
				],
			});

			expect(result).not.toBeNull();
			expect(result?.id).toBe("u1");
		});

		it("returns a copy (mutations do not affect the store)", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });

			const found = await adapter.findOne<Record<string, unknown>>({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "u1" }],
			});

			found!.name = "Mutated";

			const foundAgain = await adapter.findOne<Record<string, unknown>>({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "u1" }],
			});

			expect(foundAgain?.name).toBe("Alice");
		});
	});

	// =========================================================================
	// FIND MANY
	// =========================================================================

	describe("findMany", () => {
		it("returns all records when no where clause is provided", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob" } });
			await adapter.create({ model: "user", data: { id: "u3", name: "Charlie" } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "user",
			});

			expect(results).toHaveLength(3);
		});

		it("returns empty array for non-existent model", async () => {
			const adapter = memoryAdapter();

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "nonexistent",
			});

			expect(results).toEqual([]);
		});

		it("filters records with where clause", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice", role: "admin" } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob", role: "user" } });
			await adapter.create({ model: "user", data: { id: "u3", name: "Charlie", role: "admin" } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "user",
				where: [{ field: "role", operator: "eq", value: "admin" }],
			});

			expect(results).toHaveLength(2);
			const names = results.map((r) => r.name);
			expect(names).toContain("Alice");
			expect(names).toContain("Charlie");
		});

		it("supports limit", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob" } });
			await adapter.create({ model: "user", data: { id: "u3", name: "Charlie" } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "user",
				limit: 2,
			});

			expect(results).toHaveLength(2);
		});

		it("supports offset", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice", order: 1 } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob", order: 2 } });
			await adapter.create({ model: "user", data: { id: "u3", name: "Charlie", order: 3 } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "user",
				sortBy: { field: "order", direction: "asc" },
				offset: 1,
			});

			expect(results).toHaveLength(2);
			expect(results[0].name).toBe("Bob");
			expect(results[1].name).toBe("Charlie");
		});

		it("supports limit and offset together", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice", order: 1 } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob", order: 2 } });
			await adapter.create({ model: "user", data: { id: "u3", name: "Charlie", order: 3 } });
			await adapter.create({ model: "user", data: { id: "u4", name: "Dan", order: 4 } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "user",
				sortBy: { field: "order", direction: "asc" },
				offset: 1,
				limit: 2,
			});

			expect(results).toHaveLength(2);
			expect(results[0].name).toBe("Bob");
			expect(results[1].name).toBe("Charlie");
		});

		it("supports sortBy ascending", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u3", name: "Charlie", age: 30 } });
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice", age: 25 } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob", age: 35 } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "user",
				sortBy: { field: "age", direction: "asc" },
			});

			expect(results).toHaveLength(3);
			expect(results[0].name).toBe("Alice");
			expect(results[1].name).toBe("Charlie");
			expect(results[2].name).toBe("Bob");
		});

		it("supports sortBy descending", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u3", name: "Charlie", age: 30 } });
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice", age: 25 } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob", age: 35 } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "user",
				sortBy: { field: "age", direction: "desc" },
			});

			expect(results).toHaveLength(3);
			expect(results[0].name).toBe("Bob");
			expect(results[1].name).toBe("Charlie");
			expect(results[2].name).toBe("Alice");
		});

		it("returns copies of records", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });

			const results = await adapter.findMany<Record<string, unknown>>({ model: "user" });
			results[0].name = "Mutated";

			const fresh = await adapter.findMany<Record<string, unknown>>({ model: "user" });
			expect(fresh[0].name).toBe("Alice");
		});
	});

	// =========================================================================
	// UPDATE
	// =========================================================================

	describe("update", () => {
		it("updates a matching record and returns the updated data", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice", age: 25 } });

			const updated = await adapter.update<Record<string, unknown>>({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "u1" }],
				update: { age: 26 },
			});

			expect(updated).not.toBeNull();
			expect(updated?.age).toBe(26);
			expect(updated?.name).toBe("Alice");
		});

		it("returns null when no record matches", async () => {
			const adapter = memoryAdapter();

			const updated = await adapter.update<Record<string, unknown>>({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "nonexistent" }],
				update: { age: 30 },
			});

			expect(updated).toBeNull();
		});

		it("returns null for a model that does not exist", async () => {
			const adapter = memoryAdapter();

			const updated = await adapter.update<Record<string, unknown>>({
				model: "nonexistent",
				where: [{ field: "id", operator: "eq", value: "u1" }],
				update: { name: "test" },
			});

			expect(updated).toBeNull();
		});

		it("merges data correctly (existing fields preserved, new fields added)", async () => {
			const adapter = memoryAdapter();
			await adapter.create({
				model: "user",
				data: { id: "u1", name: "Alice", age: 25, role: "user" },
			});

			const updated = await adapter.update<Record<string, unknown>>({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "u1" }],
				update: { age: 26, status: "active" },
			});

			expect(updated?.name).toBe("Alice");
			expect(updated?.age).toBe(26);
			expect(updated?.role).toBe("user");
			expect(updated?.status).toBe("active");
		});

		it("persists the update in the store", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });

			await adapter.update<Record<string, unknown>>({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "u1" }],
				update: { name: "Alice Updated" },
			});

			const found = await adapter.findOne<Record<string, unknown>>({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "u1" }],
			});

			expect(found?.name).toBe("Alice Updated");
		});
	});

	// =========================================================================
	// DELETE
	// =========================================================================

	describe("delete", () => {
		it("deletes matching records", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob" } });

			await adapter.delete({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "u1" }],
			});

			const all = await adapter.findMany<Record<string, unknown>>({ model: "user" });
			expect(all).toHaveLength(1);
			expect(all[0].name).toBe("Bob");
		});

		it("deletes multiple matching records", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice", role: "admin" } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob", role: "admin" } });
			await adapter.create({ model: "user", data: { id: "u3", name: "Charlie", role: "user" } });

			await adapter.delete({
				model: "user",
				where: [{ field: "role", operator: "eq", value: "admin" }],
			});

			const all = await adapter.findMany<Record<string, unknown>>({ model: "user" });
			expect(all).toHaveLength(1);
			expect(all[0].name).toBe("Charlie");
		});

		it("is a no-op when no records match", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });

			await adapter.delete({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "nonexistent" }],
			});

			const all = await adapter.findMany<Record<string, unknown>>({ model: "user" });
			expect(all).toHaveLength(1);
		});

		it("is a no-op for a model that does not exist", async () => {
			const adapter = memoryAdapter();

			// Should not throw
			await adapter.delete({
				model: "nonexistent",
				where: [{ field: "id", operator: "eq", value: "u1" }],
			});
		});
	});

	// =========================================================================
	// COUNT
	// =========================================================================

	describe("count", () => {
		it("counts all records in a model", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob" } });
			await adapter.create({ model: "user", data: { id: "u3", name: "Charlie" } });

			const count = await adapter.count({ model: "user" });
			expect(count).toBe(3);
		});

		it("returns 0 for a model with no records", async () => {
			const adapter = memoryAdapter();

			const count = await adapter.count({ model: "nonexistent" });
			expect(count).toBe(0);
		});

		it("counts with where filter", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice", role: "admin" } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob", role: "user" } });
			await adapter.create({ model: "user", data: { id: "u3", name: "Charlie", role: "admin" } });

			const count = await adapter.count({
				model: "user",
				where: [{ field: "role", operator: "eq", value: "admin" }],
			});

			expect(count).toBe(2);
		});

		it("counts with empty where array (returns all)", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });
			await adapter.create({ model: "user", data: { id: "u2", name: "Bob" } });

			const count = await adapter.count({ model: "user", where: [] });
			expect(count).toBe(2);
		});
	});

	// =========================================================================
	// WHERE OPERATORS
	// =========================================================================

	describe("where operators", () => {
		it("eq — matches equal values", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", status: "active" } });
			await adapter.create({ model: "item", data: { id: "i2", status: "inactive" } });

			const result = await adapter.findOne<Record<string, unknown>>({
				model: "item",
				where: [{ field: "status", operator: "eq", value: "active" }],
			});

			expect(result?.id).toBe("i1");
		});

		it("ne — matches not-equal values", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", status: "active" } });
			await adapter.create({ model: "item", data: { id: "i2", status: "inactive" } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "status", operator: "ne", value: "active" }],
			});

			expect(results).toHaveLength(1);
			expect(results[0].id).toBe("i2");
		});

		it("gt — matches greater-than values", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", amount: 10 } });
			await adapter.create({ model: "item", data: { id: "i2", amount: 20 } });
			await adapter.create({ model: "item", data: { id: "i3", amount: 30 } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "amount", operator: "gt", value: 15 }],
			});

			expect(results).toHaveLength(2);
			const ids = results.map((r) => r.id);
			expect(ids).toContain("i2");
			expect(ids).toContain("i3");
		});

		it("gte — matches greater-than-or-equal values", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", amount: 10 } });
			await adapter.create({ model: "item", data: { id: "i2", amount: 20 } });
			await adapter.create({ model: "item", data: { id: "i3", amount: 30 } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "amount", operator: "gte", value: 20 }],
			});

			expect(results).toHaveLength(2);
			const ids = results.map((r) => r.id);
			expect(ids).toContain("i2");
			expect(ids).toContain("i3");
		});

		it("lt — matches less-than values", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", amount: 10 } });
			await adapter.create({ model: "item", data: { id: "i2", amount: 20 } });
			await adapter.create({ model: "item", data: { id: "i3", amount: 30 } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "amount", operator: "lt", value: 25 }],
			});

			expect(results).toHaveLength(2);
			const ids = results.map((r) => r.id);
			expect(ids).toContain("i1");
			expect(ids).toContain("i2");
		});

		it("lte — matches less-than-or-equal values", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", amount: 10 } });
			await adapter.create({ model: "item", data: { id: "i2", amount: 20 } });
			await adapter.create({ model: "item", data: { id: "i3", amount: 30 } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "amount", operator: "lte", value: 20 }],
			});

			expect(results).toHaveLength(2);
			const ids = results.map((r) => r.id);
			expect(ids).toContain("i1");
			expect(ids).toContain("i2");
		});

		it("in — matches values in the provided array", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", status: "active" } });
			await adapter.create({ model: "item", data: { id: "i2", status: "inactive" } });
			await adapter.create({ model: "item", data: { id: "i3", status: "pending" } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "status", operator: "in", value: ["active", "pending"] }],
			});

			expect(results).toHaveLength(2);
			const ids = results.map((r) => r.id);
			expect(ids).toContain("i1");
			expect(ids).toContain("i3");
		});

		it("like — matches SQL LIKE pattern with % wildcard", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", name: "Apple Pie" } });
			await adapter.create({ model: "item", data: { id: "i2", name: "Banana Split" } });
			await adapter.create({ model: "item", data: { id: "i3", name: "Apple Sauce" } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "name", operator: "like", value: "Apple%" }],
			});

			expect(results).toHaveLength(2);
			const ids = results.map((r) => r.id);
			expect(ids).toContain("i1");
			expect(ids).toContain("i3");
		});

		it("like — matches SQL LIKE pattern with _ wildcard", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", code: "A1" } });
			await adapter.create({ model: "item", data: { id: "i2", code: "A2" } });
			await adapter.create({ model: "item", data: { id: "i3", code: "B1" } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "code", operator: "like", value: "A_" }],
			});

			expect(results).toHaveLength(2);
			const ids = results.map((r) => r.id);
			expect(ids).toContain("i1");
			expect(ids).toContain("i2");
		});

		it("like — is case insensitive", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", name: "HELLO" } });
			await adapter.create({ model: "item", data: { id: "i2", name: "hello" } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "name", operator: "like", value: "hello" }],
			});

			expect(results).toHaveLength(2);
		});

		it("like — returns false for non-string values", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", value: 123 } });

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "value", operator: "like", value: "123" }],
			});

			expect(results).toHaveLength(0);
		});

		it("is_null — matches null or undefined values", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", note: null } });
			await adapter.create({ model: "item", data: { id: "i2", note: "hello" } });
			await adapter.create({ model: "item", data: { id: "i3" } }); // note is undefined

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "note", operator: "is_null", value: null }],
			});

			expect(results).toHaveLength(2);
			const ids = results.map((r) => r.id);
			expect(ids).toContain("i1");
			expect(ids).toContain("i3");
		});

		it("is_not_null — matches non-null, non-undefined values", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "item", data: { id: "i1", note: null } });
			await adapter.create({ model: "item", data: { id: "i2", note: "hello" } });
			await adapter.create({ model: "item", data: { id: "i3" } }); // note is undefined

			const results = await adapter.findMany<Record<string, unknown>>({
				model: "item",
				where: [{ field: "note", operator: "is_not_null", value: null }],
			});

			expect(results).toHaveLength(1);
			expect(results[0].id).toBe("i2");
		});
	});

	// =========================================================================
	// TRANSACTION
	// =========================================================================

	describe("transaction", () => {
		it("commit — data persists after successful transaction", async () => {
			const adapter = memoryAdapter();

			await adapter.transaction(async (tx) => {
				await tx.create({ model: "user", data: { id: "u1", name: "Alice" } });
				await tx.create({ model: "user", data: { id: "u2", name: "Bob" } });
			});

			const all = await adapter.findMany<Record<string, unknown>>({ model: "user" });
			expect(all).toHaveLength(2);
		});

		it("rollback — data reverts on error", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u0", name: "Pre-existing" } });

			await expect(
				adapter.transaction(async (tx) => {
					await tx.create({ model: "user", data: { id: "u1", name: "Alice" } });
					throw new Error("Simulated failure");
				}),
			).rejects.toThrow("Simulated failure");

			const all = await adapter.findMany<Record<string, unknown>>({ model: "user" });
			expect(all).toHaveLength(1);
			expect(all[0].name).toBe("Pre-existing");
		});

		it("transaction adapter has correct options", async () => {
			const adapter = memoryAdapter();

			await adapter.transaction(async (tx) => {
				expect(tx.options).toEqual({
					supportsAdvisoryLocks: false,
					supportsForUpdate: false,
					supportsReturning: true,
					dialectName: "sqlite",
				});
			});
		});

		it("transaction adapter has id 'memory'", async () => {
			const adapter = memoryAdapter();

			await adapter.transaction(async (tx) => {
				expect(tx.id).toBe("memory");
			});
		});

		it("transaction returns the value from the callback", async () => {
			const adapter = memoryAdapter();

			const result = await adapter.transaction(async (tx) => {
				await tx.create({ model: "user", data: { id: "u1", name: "Alice" } });
				return "success";
			});

			expect(result).toBe("success");
		});

		it("rollback restores deleted records", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });

			await expect(
				adapter.transaction(async (tx) => {
					await tx.delete({
						model: "user",
						where: [{ field: "id", operator: "eq", value: "u1" }],
					});

					// Verify it is deleted within the transaction
					const count = await tx.count({ model: "user" });
					expect(count).toBe(0);

					throw new Error("Rollback");
				}),
			).rejects.toThrow("Rollback");

			// After rollback, the record should be restored
			const count = await adapter.count({ model: "user" });
			expect(count).toBe(1);

			const found = await adapter.findOne<Record<string, unknown>>({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "u1" }],
			});
			expect(found?.name).toBe("Alice");
		});
	});

	// =========================================================================
	// ADVISORY LOCK
	// =========================================================================

	describe("advisoryLock", () => {
		it("is a no-op and does not throw", async () => {
			const adapter = memoryAdapter();

			await expect(adapter.advisoryLock(12345)).resolves.toBeUndefined();
		});

		it("can be called multiple times without error", async () => {
			const adapter = memoryAdapter();

			await expect(adapter.advisoryLock(1)).resolves.toBeUndefined();
			await expect(adapter.advisoryLock(2)).resolves.toBeUndefined();
			await expect(adapter.advisoryLock(999)).resolves.toBeUndefined();
		});
	});

	// =========================================================================
	// RAW / RAW MUTATE
	// =========================================================================

	describe("raw and rawMutate", () => {
		it("raw throws 'Not supported in memory adapter'", async () => {
			const adapter = memoryAdapter();

			await expect(adapter.raw("SELECT 1", [])).rejects.toThrow("Not supported in memory adapter");
		});

		it("rawMutate throws 'Not supported in memory adapter'", async () => {
			const adapter = memoryAdapter();

			await expect(adapter.rawMutate("DELETE FROM users", [])).rejects.toThrow(
				"Not supported in memory adapter",
			);
		});
	});

	// =========================================================================
	// MULTIPLE MODELS
	// =========================================================================

	describe("multiple models", () => {
		it("stores records separately per model", async () => {
			const adapter = memoryAdapter();
			await adapter.create({ model: "user", data: { id: "u1", name: "Alice" } });
			await adapter.create({ model: "account", data: { id: "a1", balance: 100 } });

			const users = await adapter.findMany<Record<string, unknown>>({ model: "user" });
			const accounts = await adapter.findMany<Record<string, unknown>>({ model: "account" });

			expect(users).toHaveLength(1);
			expect(accounts).toHaveLength(1);
			expect(users[0].name).toBe("Alice");
			expect(accounts[0].balance).toBe(100);
		});
	});
});
