// =============================================================================
// REGULATORY REPORTING PLUGIN
// =============================================================================
// Read-only export of ledger data in SAF-T and XBRL-JSON formats.
// Zero impact on core — no schema, no hooks, no workers. Pure reporting layer.

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

export interface RegulatoryReportingOptions {
	/** Company info for report headers */
	company?: {
		name: string;
		taxId: string;
		address?: string;
		country?: string;
	};
}

export interface SaftReport {
	header: {
		auditFileVersion: string;
		companyName: string;
		taxRegistrationNumber: string;
		startDate: string;
		endDate: string;
		generatedAt: string;
		currencyCode: string;
	};
	masterFiles: {
		generalLedgerAccounts: SaftAccount[];
	};
	generalLedgerEntries: {
		numberOfEntries: number;
		totalDebit: number;
		totalCredit: number;
		journals: SaftJournal[];
	};
}

export interface SaftAccount {
	accountId: string;
	accountCode: string | null;
	accountDescription: string;
	accountType: string;
	closingBalance: number;
}

export interface SaftJournal {
	journalId: string;
	description: string;
	transactions: SaftTransaction[];
}

export interface SaftTransaction {
	transactionId: string;
	transactionDate: string;
	description: string;
	lines: Array<{
		accountId: string;
		debitAmount?: number;
		creditAmount?: number;
	}>;
}

export interface XbrlReport {
	documentInfo: {
		documentType: string;
	};
	facts: XbrlFact[];
}

export interface XbrlFact {
	concept: string;
	entity: string;
	period: { startDate: string; endDate: string } | { instant: string };
	unit: string;
	value: number | string;
}

// =============================================================================
// RAW ROW TYPES
// =============================================================================

interface RawAccountRow {
	id: string;
	account_code: string | null;
	holder_id: string;
	account_type: string;
	balance: number;
	currency: string;
}

interface RawEntryRow {
	id: string;
	transaction_id: string;
	account_id: string;
	entry_type: string;
	amount: number;
	created_at: string | Date;
}

interface RawBalanceAggRow {
	account_type: string;
	total_balance: number;
	total_debit: number;
	total_credit: number;
}

// =============================================================================
// HELPERS
// =============================================================================

function toIso(v: string | Date): string {
	return v instanceof Date ? v.toISOString() : String(v);
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function generateSaftReport(
	ctx: SummaContext,
	params: { startDate: string; endDate: string },
	companyInfo?: RegulatoryReportingOptions["company"],
): Promise<SaftReport> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	// Fetch all accounts for this ledger
	const accounts = await ctx.adapter.raw<RawAccountRow>(
		`SELECT id, account_code, holder_id, account_type, balance, currency
		 FROM ${t("account")} WHERE ledger_id = $1`,
		[ledgerId],
	);

	// Fetch entries in the reporting period
	const entries = await ctx.adapter.raw<RawEntryRow>(
		`SELECT er.id, er.transaction_id, er.account_id, er.entry_type, er.amount, er.created_at
		 FROM ${t("entry")} er
		 JOIN ${t("account")} ab ON er.account_id = ab.id
		 WHERE ab.ledger_id = $1
		   AND er.created_at >= $2::timestamptz
		   AND er.created_at <= $3::timestamptz
		 ORDER BY er.created_at`,
		[ledgerId, params.startDate, params.endDate],
	);

	// Build SAF-T account master data
	const saftAccounts: SaftAccount[] = accounts.map((a) => ({
		accountId: a.id,
		accountCode: a.account_code,
		accountDescription: `${a.account_type ?? "unknown"} — ${a.holder_id}`,
		accountType: a.account_type ?? "unknown",
		closingBalance: Number(a.balance),
	}));

	// Group entries by transaction for journal structure
	const txnMap = new Map<string, RawEntryRow[]>();
	let totalDebit = 0;
	let totalCredit = 0;

	for (const entry of entries) {
		const list = txnMap.get(entry.transaction_id) ?? [];
		list.push(entry);
		txnMap.set(entry.transaction_id, list);
		if (entry.entry_type === "DEBIT") totalDebit += Number(entry.amount);
		else totalCredit += Number(entry.amount);
	}

	const transactions: SaftTransaction[] = [];
	for (const [txnId, txnEntries] of txnMap) {
		const firstEntry = txnEntries[0];
		if (!firstEntry) continue;
		transactions.push({
			transactionId: txnId,
			transactionDate: toIso(firstEntry.created_at),
			description: txnId,
			lines: txnEntries.map((e) => ({
				accountId: e.account_id,
				...(e.entry_type === "DEBIT"
					? { debitAmount: Number(e.amount) }
					: { creditAmount: Number(e.amount) }),
			})),
		});
	}

	return {
		header: {
			auditFileVersion: "2.0",
			companyName: companyInfo?.name ?? "Unknown",
			taxRegistrationNumber: companyInfo?.taxId ?? "",
			startDate: params.startDate,
			endDate: params.endDate,
			generatedAt: new Date().toISOString(),
			currencyCode: ctx.options.currency,
		},
		masterFiles: { generalLedgerAccounts: saftAccounts },
		generalLedgerEntries: {
			numberOfEntries: transactions.length,
			totalDebit,
			totalCredit,
			journals: [
				{
					journalId: "GL",
					description: "General Ledger",
					transactions,
				},
			],
		},
	};
}

export async function generateXbrlReport(
	ctx: SummaContext,
	params: { startDate: string; endDate: string },
	companyInfo?: RegulatoryReportingOptions["company"],
): Promise<XbrlReport> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	// Aggregate balances by account type
	const balances = await ctx.adapter.raw<RawBalanceAggRow>(
		`SELECT account_type,
		        SUM(balance) as total_balance,
		        SUM(debit_balance) as total_debit,
		        SUM(credit_balance) as total_credit
		 FROM ${t("account")}
		 WHERE ledger_id = $1 AND account_type IS NOT NULL
		 GROUP BY account_type`,
		[ledgerId],
	);

	const entity = companyInfo?.taxId ?? ledgerId;
	const period = {
		startDate: params.startDate,
		endDate: params.endDate,
	};
	const unit = ctx.options.currency;

	const conceptMap: Record<string, string> = {
		asset: "ifrs-full:Assets",
		liability: "ifrs-full:Liabilities",
		equity: "ifrs-full:Equity",
		revenue: "ifrs-full:Revenue",
		expense: "ifrs-full:CostOfSales",
	};

	const facts: XbrlFact[] = [];

	for (const row of balances) {
		const concept = conceptMap[row.account_type];
		if (concept) {
			facts.push({
				concept,
				entity,
				period,
				unit,
				value: Number(row.total_balance),
			});
		}
	}

	// Net income fact
	const revenue = balances.find((b) => b.account_type === "revenue");
	const expense = balances.find((b) => b.account_type === "expense");
	if (revenue || expense) {
		facts.push({
			concept: "ifrs-full:ProfitLoss",
			entity,
			period,
			unit,
			value: Number(revenue?.total_credit ?? 0) - Number(expense?.total_debit ?? 0),
		});
	}

	return {
		documentInfo: {
			documentType: "https://xbrl.org/2021/xbrl-json",
		},
		facts,
	};
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function regulatoryReporting(options?: RegulatoryReportingOptions): SummaPlugin {
	return {
		id: "regulatory-reporting",

		$Infer: {} as { SaftReport: SaftReport; XbrlReport: XbrlReport },

		// Pure read-only — no schema, no hooks, no workers

		endpoints: [
			{
				method: "GET",
				path: "/regulatory/saf-t",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const { startDate, endDate } = req.query;
					if (!startDate || !endDate) {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "startDate and endDate required",
							},
						});
					}
					const report = await generateSaftReport(ctx, { startDate, endDate }, options?.company);
					return jsonRes(200, report);
				},
			},
			{
				method: "GET",
				path: "/regulatory/xbrl",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const { startDate, endDate } = req.query;
					if (!startDate || !endDate) {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "startDate and endDate required",
							},
						});
					}
					const report = await generateXbrlReport(ctx, { startDate, endDate }, options?.company);
					return jsonRes(200, report);
				},
			},
		],
	};
}
