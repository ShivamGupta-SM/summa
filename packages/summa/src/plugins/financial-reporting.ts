// =============================================================================
// FINANCIAL REPORTING PLUGIN -- Trial balance, balance sheet, income statement
// =============================================================================
// Depends on Feature 1 (Chart of Accounts) for account type grouping.
// Read-only: no schema, no hooks, no workers.

import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
} from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { getLedgerId } from "../managers/ledger-helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export interface FinancialReportingOptions {
	/** Base path for reporting endpoints. Default: "/reports" */
	basePath?: string;
}

export interface AccountLineItem {
	accountId: string;
	accountCode: string | null;
	holderId: string;
	accountType: string;
	currency: string;
	debitBalance: number;
	creditBalance: number;
	balance: number;
	/** Present when convertTo is used and currency differs from target */
	convertedBalance?: number;
}

export interface TrialBalance {
	accounts: AccountLineItem[];
	totalDebits: number;
	totalCredits: number;
	balanced: boolean;
	asOfDate: string;
}

export interface BalanceSheet {
	assets: { accounts: AccountLineItem[]; total: number };
	liabilities: { accounts: AccountLineItem[]; total: number };
	equity: { accounts: AccountLineItem[]; total: number };
	balanced: boolean;
	asOfDate: string;
}

export interface IncomeStatement {
	revenue: { accounts: AccountLineItem[]; total: number };
	expenses: { accounts: AccountLineItem[]; total: number };
	netIncome: number;
	dateFrom: string;
	dateTo: string;
}

interface RawReportRow {
	id: string;
	account_code: string | null;
	holder_id: string;
	account_type: string;
	currency: string;
	debit_balance: number;
	credit_balance: number;
	balance: number;
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

function rowToLineItem(
	row: RawReportRow,
	convertTo?: string,
	fxRates?: Record<string, number>,
): AccountLineItem {
	const balance = Number(row.balance);
	const item: AccountLineItem = {
		accountId: row.id,
		accountCode: row.account_code,
		holderId: row.holder_id,
		accountType: row.account_type,
		currency: row.currency,
		debitBalance: Number(row.debit_balance),
		creditBalance: Number(row.credit_balance),
		balance,
	};

	if (convertTo && fxRates && row.currency !== convertTo) {
		const rate = fxRates[row.currency];
		if (rate) {
			item.convertedBalance = Math.round(balance * rate);
		}
	}

	return item;
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function getTrialBalance(
	ctx: SummaContext,
	_params?: { asOfDate?: string; convertTo?: string; fxRates?: Record<string, number> },
): Promise<TrialBalance> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const convertTo =
		_params?.convertTo ??
		(ctx.options.functionalCurrency !== ctx.options.currency
			? ctx.options.functionalCurrency
			: undefined);
	const fxRates = _params?.fxRates;

	const rows = await ctx.adapter.raw<RawReportRow>(
		`SELECT id, account_code, holder_id, account_type, currency, debit_balance, credit_balance, balance
     FROM ${t("account")}
     WHERE ledger_id = $1
       AND account_type IS NOT NULL
     ORDER BY account_code ASC NULLS LAST`,
		[ledgerId],
	);

	const accounts = rows.map((r) => rowToLineItem(r, convertTo, fxRates));
	let totalDebits = 0;
	let totalCredits = 0;

	for (const acct of accounts) {
		totalDebits += acct.debitBalance;
		totalCredits += acct.creditBalance;
	}

	return {
		accounts,
		totalDebits,
		totalCredits,
		balanced: totalDebits === totalCredits,
		asOfDate: new Date().toISOString(),
	};
}

export async function getBalanceSheet(
	ctx: SummaContext,
	_params?: { asOfDate?: string; convertTo?: string; fxRates?: Record<string, number> },
): Promise<BalanceSheet> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const convertTo =
		_params?.convertTo ??
		(ctx.options.functionalCurrency !== ctx.options.currency
			? ctx.options.functionalCurrency
			: undefined);
	const fxRates = _params?.fxRates;

	const rows = await ctx.adapter.raw<RawReportRow>(
		`SELECT id, account_code, holder_id, account_type, currency, debit_balance, credit_balance, balance
     FROM ${t("account")}
     WHERE ledger_id = $1
       AND account_type IN ('asset', 'liability', 'equity')
     ORDER BY account_type, account_code ASC NULLS LAST`,
		[ledgerId],
	);

	const assets: AccountLineItem[] = [];
	const liabilities: AccountLineItem[] = [];
	const equity: AccountLineItem[] = [];
	let assetTotal = 0;
	let liabilityTotal = 0;
	let equityTotal = 0;

	for (const row of rows) {
		const item = rowToLineItem(row, convertTo, fxRates);
		const effectiveBalance = item.convertedBalance ?? item.balance;
		if (row.account_type === "asset") {
			assets.push(item);
			assetTotal += effectiveBalance;
		} else if (row.account_type === "liability") {
			liabilities.push(item);
			liabilityTotal += effectiveBalance;
		} else if (row.account_type === "equity") {
			equity.push(item);
			equityTotal += effectiveBalance;
		}
	}

	return {
		assets: { accounts: assets, total: assetTotal },
		liabilities: { accounts: liabilities, total: liabilityTotal },
		equity: { accounts: equity, total: equityTotal },
		balanced: assetTotal === liabilityTotal + equityTotal,
		asOfDate: new Date().toISOString(),
	};
}

export async function getIncomeStatement(
	ctx: SummaContext,
	params: {
		dateFrom: string;
		dateTo: string;
		convertTo?: string;
		fxRates?: Record<string, number>;
	},
): Promise<IncomeStatement> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const convertTo =
		params.convertTo ??
		(ctx.options.functionalCurrency !== ctx.options.currency
			? ctx.options.functionalCurrency
			: undefined);
	const fxRates = params.fxRates;

	const rows = await ctx.adapter.raw<RawReportRow>(
		`SELECT ab.id, ab.account_code, ab.holder_id, ab.account_type, ab.currency,
            COALESCE(SUM(CASE WHEN er.entry_type = 'DEBIT' THEN er.amount ELSE 0 END), 0) as debit_balance,
            COALESCE(SUM(CASE WHEN er.entry_type = 'CREDIT' THEN er.amount ELSE 0 END), 0) as credit_balance,
            COALESCE(SUM(CASE WHEN er.entry_type = 'CREDIT' THEN er.amount ELSE -er.amount END), 0) as balance
     FROM ${t("account")} ab
     JOIN ${t("entry")} er ON er.account_id = ab.id
     WHERE ab.ledger_id = $3
       AND ab.account_type IN ('revenue', 'expense')
       AND er.created_at >= $1::timestamptz
       AND er.created_at <= $2::timestamptz
     GROUP BY ab.id, ab.account_code, ab.holder_id, ab.account_type, ab.currency
     ORDER BY ab.account_type, ab.account_code ASC NULLS LAST`,
		[params.dateFrom, params.dateTo, ledgerId],
	);

	const revenue: AccountLineItem[] = [];
	const expenses: AccountLineItem[] = [];
	let revenueTotal = 0;
	let expenseTotal = 0;

	for (const row of rows) {
		const item = rowToLineItem(row, convertTo, fxRates);
		if (row.account_type === "revenue") {
			revenue.push(item);
			revenueTotal += item.convertedBalance ?? item.creditBalance;
		} else if (row.account_type === "expense") {
			expenses.push(item);
			expenseTotal += item.convertedBalance ?? item.debitBalance;
		}
	}

	return {
		revenue: { accounts: revenue, total: revenueTotal },
		expenses: { accounts: expenses, total: expenseTotal },
		netIncome: revenueTotal - expenseTotal,
		dateFrom: params.dateFrom,
		dateTo: params.dateTo,
	};
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function financialReporting(options?: FinancialReportingOptions): SummaPlugin {
	const basePath = options?.basePath ?? "/reports";

	return {
		id: "financial-reporting",

		endpoints: [
			{
				method: "GET",
				path: `${basePath}/trial-balance`,
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const fxRates = req.query.fxRates
						? (JSON.parse(req.query.fxRates) as Record<string, number>)
						: undefined;
					const result = await getTrialBalance(ctx, {
						asOfDate: req.query.asOfDate,
						convertTo: req.query.convertTo,
						fxRates,
					});
					return jsonRes(200, result);
				},
			},
			{
				method: "GET",
				path: `${basePath}/balance-sheet`,
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const fxRates = req.query.fxRates
						? (JSON.parse(req.query.fxRates) as Record<string, number>)
						: undefined;
					const result = await getBalanceSheet(ctx, {
						asOfDate: req.query.asOfDate,
						convertTo: req.query.convertTo,
						fxRates,
					});
					return jsonRes(200, result);
				},
			},
			{
				method: "GET",
				path: `${basePath}/income-statement`,
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const { dateFrom, dateTo } = req.query;
					if (!dateFrom || !dateTo) {
						return jsonRes(400, {
							error: {
								code: "VALIDATION_ERROR",
								message: "dateFrom and dateTo query params required",
							},
						});
					}
					const fxRates = req.query.fxRates
						? (JSON.parse(req.query.fxRates) as Record<string, number>)
						: undefined;
					const result = await getIncomeStatement(ctx, {
						dateFrom,
						dateTo,
						convertTo: req.query.convertTo,
						fxRates,
					});
					return jsonRes(200, result);
				},
			},
		],
	};
}
