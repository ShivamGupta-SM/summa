// =============================================================================
// CHART OF ACCOUNTS MANAGER
// =============================================================================
// Provides hierarchy queries, type-based lookups, and accounting equation
// validation for accounts with accountType set.

import type { Account, AccountType, SummaContext } from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import type { RawAccountRow } from "./raw-types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface AccountNode {
	account: Account;
	children: AccountNode[];
}

export interface AccountingEquationResult {
	balanced: boolean;
	assets: number;
	liabilities: number;
	equity: number;
	difference: number;
}

// =============================================================================
// QUERIES
// =============================================================================

/**
 * Get all accounts of a given type (asset, liability, equity, revenue, expense).
 */
export async function getAccountsByType(
	ctx: SummaContext,
	accountType: AccountType,
	ledgerId: string,
): Promise<Account[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.readAdapter.raw<RawAccountRow>(
		`SELECT * FROM ${t("account")} WHERE ledger_id = $1 AND account_type = $2 ORDER BY account_code ASC NULLS LAST`,
		[ledgerId, accountType],
	);
	return rows.map(rawRowToAccount);
}

/**
 * Get child accounts of a given parent.
 */
export async function getChildAccounts(
	ctx: SummaContext,
	parentAccountId: string,
	ledgerId: string,
): Promise<Account[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.readAdapter.raw<RawAccountRow>(
		`SELECT * FROM ${t("account")} WHERE ledger_id = $1 AND parent_account_id = $2 ORDER BY account_code ASC NULLS LAST`,
		[ledgerId, parentAccountId],
	);
	return rows.map(rawRowToAccount);
}

/**
 * Build a hierarchical tree of accounts.
 * If rootAccountId is provided, returns the subtree rooted at that account.
 * Otherwise, returns all top-level accounts (those without a parent) and their subtrees.
 */
export async function getAccountHierarchy(
	ctx: SummaContext,
	ledgerId: string,
	rootAccountId?: string,
): Promise<AccountNode[]> {
	const t = createTableResolver(ctx.options.schema);
	// Fetch all accounts that have an account_type (i.e., are part of the CoA)
	const rows = await ctx.readAdapter.raw<RawAccountRow>(
		`SELECT * FROM ${t("account")} WHERE ledger_id = $1 AND account_type IS NOT NULL ORDER BY account_code ASC NULLS LAST`,
		[ledgerId],
	);

	const accounts = rows.map(rawRowToAccount);
	const byId = new Map<string, AccountNode>();
	const roots: AccountNode[] = [];

	// Build nodes
	for (const account of accounts) {
		byId.set(account.id, { account, children: [] });
	}

	// Link children to parents
	for (const account of accounts) {
		const node = byId.get(account.id)!;
		if (account.parentAccountId && byId.has(account.parentAccountId)) {
			byId.get(account.parentAccountId)?.children.push(node);
		} else {
			roots.push(node);
		}
	}

	// If a specific root is requested, find and return its subtree
	if (rootAccountId) {
		const root = byId.get(rootAccountId);
		if (!root) throw SummaError.notFound(`Account "${rootAccountId}" not found in chart`);
		return [root];
	}

	return roots;
}

/**
 * Validate the fundamental accounting equation: Assets = Liabilities + Equity.
 * Only considers accounts with accountType set.
 */
export async function validateAccountingEquation(
	ctx: SummaContext,
	ledgerId: string,
): Promise<AccountingEquationResult> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.readAdapter.raw<{ account_type: string; total: number }>(
		`SELECT account_type, SUM(balance) as total
     FROM ${t("account")}
     WHERE ledger_id = $1 AND account_type IN ('asset', 'liability', 'equity')
     GROUP BY account_type`,
		[ledgerId],
	);

	let assets = 0;
	let liabilities = 0;
	let equity = 0;

	for (const row of rows) {
		const total = Number(row.total);
		if (row.account_type === "asset") assets = total;
		else if (row.account_type === "liability") liabilities = total;
		else if (row.account_type === "equity") equity = total;
	}

	const difference = assets - (liabilities + equity);

	return {
		balanced: difference === 0,
		assets,
		liabilities,
		equity,
		difference,
	};
}

// =============================================================================
// HELPERS
// =============================================================================

function rawRowToAccount(row: RawAccountRow): Account {
	return {
		id: row.id,
		holderId: row.holder_id,
		holderType: row.holder_type as Account["holderType"],
		status: row.status as Account["status"],
		currency: row.currency,
		balance: Number(row.balance),
		creditBalance: Number(row.credit_balance),
		debitBalance: Number(row.debit_balance),
		pendingCredit: Number(row.pending_credit),
		pendingDebit: Number(row.pending_debit),
		allowOverdraft: row.allow_overdraft,
		overdraftLimit: Number(row.overdraft_limit ?? 0),
		accountType: (row.account_type as Account["accountType"]) ?? null,
		accountCode: row.account_code ?? null,
		parentAccountId: row.parent_account_id ?? null,
		normalBalance: (row.normal_balance as Account["normalBalance"]) ?? null,
		indicator: row.indicator ?? null,
		freezeReason: row.freeze_reason ?? null,
		frozenAt: row.frozen_at ? new Date(row.frozen_at) : null,
		frozenBy: row.frozen_by ?? null,
		closedAt: row.closed_at ? new Date(row.closed_at) : null,
		closedBy: row.closed_by ?? null,
		closureReason: row.closure_reason ?? null,
		metadata: (row.metadata ?? {}) as Record<string, unknown>,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.created_at),
	};
}
