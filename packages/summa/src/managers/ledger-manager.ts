// =============================================================================
// LEDGER MANAGER
// =============================================================================
// CRUD operations for ledger registry. Each ledger is an isolated tenant.

import { randomUUID } from "node:crypto";
import type { Ledger, SummaContext } from "@summa/core";
import { SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import { initializeSystemAccounts } from "./system-accounts.js";

// =============================================================================
// CREATE LEDGER
// =============================================================================

export async function createLedger(
	ctx: SummaContext,
	params: {
		name: string;
		metadata?: Record<string, unknown>;
	},
): Promise<Ledger> {
	const t = createTableResolver(ctx.options.schema);
	const id = randomUUID();

	const rows = await ctx.adapter.raw<{
		id: string;
		name: string;
		metadata: Record<string, unknown> | null;
		created_at: string | Date;
	}>(
		`INSERT INTO ${t("ledger")} (id, name, metadata)
     VALUES ($1, $2, $3)
     RETURNING *`,
		[id, params.name, JSON.stringify(params.metadata ?? {})],
	);

	const row = rows[0];
	if (!row) throw SummaError.internal("Failed to create ledger");

	// Initialize per-ledger system accounts
	await initializeSystemAccounts(ctx, id);

	ctx.logger.info("Ledger created", { ledgerId: id, name: params.name });

	return {
		id: row.id,
		name: row.name,
		metadata: (row.metadata ?? {}) as Record<string, unknown>,
		createdAt: new Date(row.created_at),
	};
}

// =============================================================================
// GET LEDGER
// =============================================================================

export async function getLedger(ctx: SummaContext, ledgerId: string): Promise<Ledger> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.readAdapter.raw<{
		id: string;
		name: string;
		metadata: Record<string, unknown> | null;
		created_at: string | Date;
	}>(`SELECT * FROM ${t("ledger")} WHERE id = $1 LIMIT 1`, [ledgerId]);

	const row = rows[0];
	if (!row) throw SummaError.notFound(`Ledger "${ledgerId}" not found`);

	return {
		id: row.id,
		name: row.name,
		metadata: (row.metadata ?? {}) as Record<string, unknown>,
		createdAt: new Date(row.created_at),
	};
}

// =============================================================================
// LIST LEDGERS
// =============================================================================

export async function listLedgers(ctx: SummaContext): Promise<Ledger[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.readAdapter.raw<{
		id: string;
		name: string;
		metadata: Record<string, unknown> | null;
		created_at: string | Date;
	}>(`SELECT * FROM ${t("ledger")} ORDER BY created_at ASC`, []);

	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		metadata: (row.metadata ?? {}) as Record<string, unknown>,
		createdAt: new Date(row.created_at),
	}));
}
