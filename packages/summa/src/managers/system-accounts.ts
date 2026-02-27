// =============================================================================
// SYSTEM ACCOUNT INITIALIZATION
// =============================================================================
// Creates/ensures system accounts exist on service startup.
// System accounts are accounts with is_system=true and a system_identifier prefix (@).

import type { SummaContext } from "@summa-ledger/core";
import { computeBalanceChecksum } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";

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

	const initialChecksum = computeBalanceChecksum(
		{
			balance: 0,
			creditBalance: 0,
			debitBalance: 0,
			pendingDebit: 0,
			pendingCredit: 0,
			lockVersion: 0,
		},
		ctx.options.advanced.hmacSecret,
	);

	for (const [key, identifier] of entries) {
		// Use ON CONFLICT to handle concurrent replicas racing to create the same account
		const rows = await adapter.raw<{ id: string }>(
			`INSERT INTO ${t("account")} (
				ledger_id, holder_id, holder_type, currency,
				is_system, system_identifier, name,
				allow_overdraft, version, status, checksum
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			${dialect.onConflictDoNothing(["ledger_id", "system_identifier"])}
			${dialect.returning(["id"])}`,
			[
				ledgerId,
				identifier,
				"system",
				options.currency,
				true,
				identifier,
				`System Account: ${key}`,
				true,
				0,
				"active",
				initialChecksum,
			],
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
		system_identifier: string;
		name: string;
		allow_overdraft: boolean;
		currency: string;
	}>(
		`SELECT id, system_identifier, name, allow_overdraft, currency
     FROM ${t("account")}
     WHERE ledger_id = $1 AND system_identifier = $2 AND is_system = true
     LIMIT 1`,
		[ledgerId, identifier],
	);

	const row = rows[0];
	if (!row) return null;

	return {
		id: row.id,
		identifier: row.system_identifier,
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
