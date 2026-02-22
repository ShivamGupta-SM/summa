// =============================================================================
// SYSTEM ACCOUNT INITIALIZATION
// =============================================================================
// Creates/ensures system accounts exist on service startup.
// System accounts are platform-owned sinks/sources (prefixed with @).

import type { SummaContext } from "@summa/core";
import { createTableResolver } from "@summa/core/db";

// =============================================================================
// INITIALIZE
// =============================================================================

/**
 * Ensure all system accounts exist. Safe to call multiple times (idempotent).
 * Reads the system account definitions from ctx.options.systemAccounts.
 */
export async function initializeSystemAccounts(ctx: SummaContext, ledgerId: string): Promise<void> {
	const { adapter, options, logger, dialect } = ctx;
	const t = createTableResolver(ctx.options.schema);

	const systemAccounts = options.systemAccounts;
	const entries = Object.entries(systemAccounts);

	for (const [key, identifier] of entries) {
		// Use ON CONFLICT to handle concurrent replicas racing to create the same account
		const rows = await adapter.raw<{ id: string }>(
			`INSERT INTO ${t("system_account")} (ledger_id, identifier, name, allow_overdraft, currency)
       VALUES ($1, $2, $3, $4, $5)
       ${dialect.onConflictDoNothing(["ledger_id", "identifier"])}
       ${dialect.returning(["id"])}`,
			[ledgerId, identifier, `System Account: ${key}`, true, options.currency],
		);

		if (rows.length > 0) {
			logger.info("System account created", { ledgerId, identifier });
		}
	}

	logger.info("System accounts initialized", { ledgerId, count: entries.length });
}

// =============================================================================
// LOOKUP
// =============================================================================

/**
 * Get a system account by its identifier (e.g., "@World").
 */
export async function getSystemAccount(
	ctx: SummaContext,
	identifier: string,
	ledgerId: string,
): Promise<{
	id: string;
	identifier: string;
	name: string;
	allowOverdraft: boolean;
	currency: string;
} | null> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<{
		id: string;
		identifier: string;
		name: string;
		allow_overdraft: boolean;
		currency: string;
	}>(
		`SELECT id, identifier, name, allow_overdraft, currency
     FROM ${t("system_account")}
     WHERE ledger_id = $1 AND identifier = $2
     LIMIT 1`,
		[ledgerId, identifier],
	);

	const row = rows[0];
	if (!row) return null;

	return {
		id: row.id,
		identifier: row.identifier,
		name: row.name,
		allowOverdraft: row.allow_overdraft,
		currency: row.currency,
	};
}

/**
 * Check if an identifier refers to a system account.
 */
export function isSystemAccountIdentifier(identifier: string): boolean {
	return identifier.startsWith("@");
}
