// =============================================================================
// SCHEMA PREFIX — Qualifies table names with the configured PostgreSQL schema.
// =============================================================================

/**
 * Creates a function that qualifies table names with the configured PostgreSQL schema.
 * Returns properly quoted identifiers for direct use in SQL.
 *
 * - `"public"` → `"table_name"` (standard quoting, no schema prefix)
 * - `"ledger"` → `"ledger"."table_name"` (schema-qualified)
 *
 * @example
 * ```ts
 * const t = createTableResolver("ledger");
 * // In raw SQL:
 * `SELECT * FROM ${t("account_balance")} WHERE ...`
 * // Produces: SELECT * FROM "ledger"."account_balance" WHERE ...
 * ```
 */
export function createTableResolver(schema: string): (tableName: string) => string {
	if (schema === "public") {
		return (tableName: string) => `"${tableName}"`;
	}
	return (tableName: string) => `"${schema}"."${tableName}"`;
}
