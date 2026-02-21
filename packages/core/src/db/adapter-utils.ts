// =============================================================================
// SHARED ADAPTER UTILITIES
// =============================================================================
// Common helpers used by all SQL adapter implementations (drizzle, prisma, kysely).
// Handles camelCase ↔ snake_case conversion and WHERE clause building.

import type { Where } from "./adapter.js";

export function toSnakeCase(str: string): string {
	return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function toCamelCase(str: string): string {
	return str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function keysToSnake(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[toSnakeCase(key)] = value;
	}
	return result;
}

export function keysToCamel(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[toCamelCase(key)] = value;
	}
	return result;
}

/** Default placeholder function: PostgreSQL-style $1, $2, etc. */
function defaultPlaceholder(index: number): string {
	return `$${index}`;
}

/**
 * Build a SQL WHERE clause from an array of Where conditions.
 * Returns the clause string (without the WHERE keyword) and parameter values.
 * Parameter numbering starts at startIndex (for $1, $2, etc.).
 *
 * @param where - Array of conditions
 * @param startIndex - Starting parameter index (default: 1)
 * @param placeholder - Parameter placeholder function, e.g. `dialect.paramPlaceholder`.
 *                      Defaults to PostgreSQL-style `$N` placeholders.
 */
export function buildWhereClause(
	where: Where[],
	startIndex: number = 1,
	placeholder: (index: number) => string = defaultPlaceholder,
): { clause: string; params: unknown[] } {
	if (where.length === 0) {
		return { clause: "TRUE", params: [] };
	}

	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIdx = startIndex;

	for (const w of where) {
		const col = toSnakeCase(w.field);

		switch (w.operator) {
			case "eq":
				conditions.push(`"${col}" = ${placeholder(paramIdx)}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "ne":
				conditions.push(`"${col}" != ${placeholder(paramIdx)}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "gt":
				conditions.push(`"${col}" > ${placeholder(paramIdx)}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "gte":
				conditions.push(`"${col}" >= ${placeholder(paramIdx)}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "lt":
				conditions.push(`"${col}" < ${placeholder(paramIdx)}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "lte":
				conditions.push(`"${col}" <= ${placeholder(paramIdx)}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "in": {
				const values = w.value as unknown[];
				const placeholders = values.map((_, i) => placeholder(paramIdx + i)).join(", ");
				conditions.push(`"${col}" IN (${placeholders})`);
				params.push(...values);
				paramIdx += values.length;
				break;
			}
			case "like":
				conditions.push(`"${col}" LIKE ${placeholder(paramIdx)}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "is_null":
				conditions.push(`"${col}" IS NULL`);
				break;
			case "is_not_null":
				conditions.push(`"${col}" IS NOT NULL`);
				break;
		}
	}

	return { clause: conditions.join(" AND "), params };
}
