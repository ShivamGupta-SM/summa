// =============================================================================
// BANK RECONCILIATION PLUGIN
// =============================================================================
// Import external bank feeds, auto-match to ledger transactions, manual resolve.
//
// Schema: external_transaction, match_result
// Hooks: none (external data, no ledger intercept needed)
// Workers: bank-auto-matcher (exact reference + fuzzy amount match)

import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
	TableDefinition,
} from "@summa/core";
import { SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import { getLedgerId } from "../managers/ledger-helpers.js";
import { jaroWinkler, normalizedLevenshtein } from "./string-similarity.js";

// =============================================================================
// TYPES
// =============================================================================

export interface BankReconciliationOptions {
	/** Auto-match confidence threshold (0-1). Default: 0.85 */
	matchThreshold?: number;
	/** Auto-match worker interval. Default: "5m" */
	matchInterval?: string;
	/** String similarity threshold for fuzzy reference matching (0-1). Default: 0.7 */
	similarityThreshold?: number;
	/** Date window (in days) for fuzzy matching. Default: 3 */
	dateWindowDays?: number;
}

export type ExternalTxnStatus = "unmatched" | "matched" | "manually_matched" | "excluded";
export type MatchMethod = "auto_exact" | "auto_fuzzy" | "manual";

export interface ExternalTransaction {
	id: string;
	feedId: string;
	externalId: string;
	accountIdentifier: string;
	amount: number;
	direction: "credit" | "debit";
	reference: string;
	description: string;
	transactionDate: string;
	status: ExternalTxnStatus;
	importedAt: string;
}

export interface MatchResult {
	id: string;
	externalTransactionId: string;
	ledgerTransactionId: string;
	confidence: number;
	method: MatchMethod;
	matchedAt: string;
}

export interface BankReconciliationSummary {
	totalExternal: number;
	matched: number;
	unmatched: number;
	excluded: number;
	discrepancyAmount: number;
}

// =============================================================================
// RAW ROW TYPES
// =============================================================================

interface RawExternalTxnRow {
	id: string;
	feed_id: string;
	external_id: string;
	account_identifier: string;
	amount: number;
	direction: string;
	reference: string;
	description: string;
	transaction_date: string | Date;
	status: string;
	imported_at: string | Date;
}

interface RawMatchRow {
	id: string;
	external_transaction_id: string;
	ledger_transaction_id: string;
	confidence: number;
	method: string;
	matched_at: string | Date;
}

// =============================================================================
// SCHEMA
// =============================================================================

const bankReconSchema: Record<string, TableDefinition> = {
	external_transaction: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			feed_id: { type: "text", notNull: true },
			ledger_id: { type: "text", notNull: true },
			external_id: { type: "text", notNull: true },
			account_identifier: { type: "text", notNull: true },
			amount: { type: "bigint", notNull: true },
			direction: { type: "text", notNull: true },
			reference: { type: "text", notNull: true, default: "''" },
			description: { type: "text", notNull: true, default: "''" },
			transaction_date: { type: "timestamp", notNull: true },
			status: { type: "text", notNull: true, default: "'unmatched'" },
			imported_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_ext_txn_feed", columns: ["feed_id"] },
			{
				name: "idx_ext_txn_external_id",
				columns: ["external_id", "feed_id"],
				unique: true,
			},
			{ name: "idx_ext_txn_status", columns: ["status"] },
			{ name: "idx_ext_txn_reference", columns: ["reference"] },
			{ name: "idx_ext_txn_ledger", columns: ["ledger_id"] },
		],
	},
	match_result: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			external_transaction_id: {
				type: "uuid",
				notNull: true,
				references: { table: "external_transaction", column: "id" },
			},
			ledger_transaction_id: { type: "text", notNull: true },
			confidence: { type: "integer", notNull: true },
			method: { type: "text", notNull: true },
			matched_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "idx_match_result_ext",
				columns: ["external_transaction_id"],
				unique: true,
			},
			{
				name: "idx_match_result_ledger",
				columns: ["ledger_transaction_id"],
			},
		],
	},
};

// =============================================================================
// HELPERS
// =============================================================================

function toIso(v: string | Date): string {
	return v instanceof Date ? v.toISOString() : String(v);
}

function rawToExternal(row: RawExternalTxnRow): ExternalTransaction {
	return {
		id: row.id,
		feedId: row.feed_id,
		externalId: row.external_id,
		accountIdentifier: row.account_identifier,
		amount: Number(row.amount),
		direction: row.direction as "credit" | "debit",
		reference: row.reference,
		description: row.description,
		transactionDate: toIso(row.transaction_date),
		status: row.status as ExternalTxnStatus,
		importedAt: toIso(row.imported_at),
	};
}

function rawToMatch(row: RawMatchRow): MatchResult {
	return {
		id: row.id,
		externalTransactionId: row.external_transaction_id,
		ledgerTransactionId: row.ledger_transaction_id,
		confidence: Number(row.confidence),
		method: row.method as MatchMethod,
		matchedAt: toIso(row.matched_at),
	};
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function importFeed(
	ctx: SummaContext,
	params: {
		feedId: string;
		transactions: Array<{
			externalId: string;
			accountIdentifier: string;
			amount: number;
			direction: "credit" | "debit";
			reference?: string;
			description?: string;
			transactionDate: string;
		}>;
	},
): Promise<{ imported: number; skipped: number }> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);
	let imported = 0;
	let skipped = 0;

	for (const txn of params.transactions) {
		const affected = await ctx.adapter.rawMutate(
			`INSERT INTO ${t("external_transaction")}
			 (id, feed_id, ledger_id, external_id, account_identifier, amount, direction,
			  reference, description, transaction_date)
			 VALUES (${d.generateUuid()}, $1, $2, $3, $4, $5, $6, $7, $8, $9)
			 ON CONFLICT (external_id, feed_id) DO NOTHING`,
			[
				params.feedId,
				ledgerId,
				txn.externalId,
				txn.accountIdentifier,
				txn.amount,
				txn.direction,
				txn.reference ?? "",
				txn.description ?? "",
				txn.transactionDate,
			],
		);
		if (affected > 0) imported++;
		else skipped++;
	}

	return { imported, skipped };
}

export async function runAutoMatch(
	ctx: SummaContext,
	matchThreshold: number,
	similarityThreshold = 0.7,
	dateWindowDays = 3,
): Promise<{ matched: number }> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);
	let matched = 0;

	const unmatched = await ctx.adapter.raw<RawExternalTxnRow>(
		`SELECT * FROM ${t("external_transaction")}
		 WHERE ledger_id = $1 AND status = 'unmatched'
		 ORDER BY transaction_date DESC LIMIT 500`,
		[ledgerId],
	);

	for (const ext of unmatched) {
		// Strategy 1: Exact reference + amount match
		const exactMatch = await ctx.adapter.raw<{ id: string }>(
			`SELECT tr.id FROM ${t("transaction_record")} tr
			 WHERE tr.reference = $1 AND tr.amount = $2
			   AND NOT EXISTS (
			     SELECT 1 FROM ${t("match_result")} mr
			     WHERE mr.ledger_transaction_id = tr.id
			   )
			 LIMIT 1`,
			[ext.reference, ext.amount],
		);

		if (exactMatch[0]) {
			await ctx.adapter.rawMutate(
				`INSERT INTO ${t("match_result")}
				 (id, external_transaction_id, ledger_transaction_id, confidence, method)
				 VALUES (${d.generateUuid()}, $1, $2, 100, 'auto_exact')`,
				[ext.id, exactMatch[0].id],
			);
			await ctx.adapter.rawMutate(
				`UPDATE ${t("external_transaction")} SET status = 'matched' WHERE id = $1`,
				[ext.id],
			);
			matched++;
			continue;
		}

		// Strategy 2: Fuzzy match — amount + date window + string similarity on reference/description
		if (matchThreshold < 1.0) {
			const candidates = await ctx.adapter.raw<{
				id: string;
				reference: string;
				description: string;
			}>(
				`SELECT tr.id, tr.reference, COALESCE(tr.description, '') as description
				 FROM ${t("transaction_record")} tr
				 WHERE tr.amount = $1
				   AND tr.created_at >= $2::timestamptz - INTERVAL '${dateWindowDays} days'
				   AND tr.created_at <= $2::timestamptz + INTERVAL '${dateWindowDays} days'
				   AND NOT EXISTS (
				     SELECT 1 FROM ${t("match_result")} mr
				     WHERE mr.ledger_transaction_id = tr.id
				   )
				 LIMIT 10`,
				[ext.amount, ext.transaction_date],
			);

			// Score each candidate using string similarity
			let bestCandidate: { id: string; confidence: number } | null = null;

			for (const candidate of candidates) {
				// Reference similarity (primary signal)
				const refSimilarity =
					ext.reference && candidate.reference
						? jaroWinkler(ext.reference.toLowerCase(), candidate.reference.toLowerCase())
						: 0;

				// Description similarity (secondary signal)
				const descSimilarity =
					ext.description && candidate.description
						? normalizedLevenshtein(
								ext.description.toLowerCase(),
								candidate.description.toLowerCase(),
							)
						: 0;

				// Composite confidence: amount match is implicit (WHERE clause), so weight strings
				// Amount match: 0.50 (guaranteed by query)
				// Reference:    0.35
				// Description:  0.15
				const confidence = 0.5 + refSimilarity * 0.35 + descSimilarity * 0.15;

				if (
					confidence >= similarityThreshold &&
					(!bestCandidate || confidence > bestCandidate.confidence)
				) {
					bestCandidate = { id: candidate.id, confidence };
				}
			}

			if (bestCandidate) {
				const confidenceInt = Math.round(bestCandidate.confidence * 100);
				await ctx.adapter.rawMutate(
					`INSERT INTO ${t("match_result")}
					 (id, external_transaction_id, ledger_transaction_id, confidence, method)
					 VALUES (${d.generateUuid()}, $1, $2, $3, 'auto_fuzzy')`,
					[ext.id, bestCandidate.id, confidenceInt],
				);
				await ctx.adapter.rawMutate(
					`UPDATE ${t("external_transaction")} SET status = 'matched' WHERE id = $1`,
					[ext.id],
				);
				matched++;
			}
		}
	}

	return { matched };
}

export async function manualMatch(
	ctx: SummaContext,
	params: { externalTransactionId: string; ledgerTransactionId: string },
): Promise<MatchResult> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;

	// Verify external transaction exists and is unmatched
	const ext = await ctx.adapter.raw<RawExternalTxnRow>(
		`SELECT * FROM ${t("external_transaction")} WHERE id = $1`,
		[params.externalTransactionId],
	);
	if (!ext[0]) throw SummaError.notFound("External transaction not found");
	if (ext[0].status !== "unmatched") {
		throw SummaError.conflict(`External transaction is already ${ext[0].status}`);
	}

	const rows = await ctx.adapter.raw<RawMatchRow>(
		`INSERT INTO ${t("match_result")}
		 (id, external_transaction_id, ledger_transaction_id, confidence, method)
		 VALUES (${d.generateUuid()}, $1, $2, 100, 'manual')
		 RETURNING *`,
		[params.externalTransactionId, params.ledgerTransactionId],
	);

	await ctx.adapter.rawMutate(
		`UPDATE ${t("external_transaction")} SET status = 'manually_matched' WHERE id = $1`,
		[params.externalTransactionId],
	);

	const match = rows[0];
	if (!match) throw SummaError.internal("Failed to create match result");
	return rawToMatch(match);
}

export async function excludeTransaction(
	ctx: SummaContext,
	externalTransactionId: string,
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const affected = await ctx.adapter.rawMutate(
		`UPDATE ${t("external_transaction")} SET status = 'excluded'
		 WHERE id = $1 AND status = 'unmatched'`,
		[externalTransactionId],
	);
	if (affected === 0) {
		throw SummaError.conflict("External transaction not found or not in unmatched status");
	}
}

export async function getReconciliationSummary(
	ctx: SummaContext,
	feedId?: string,
): Promise<BankReconciliationSummary> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const feedCondition = feedId ? " AND feed_id = $2" : "";
	const queryParams: unknown[] = [ledgerId];
	if (feedId) queryParams.push(feedId);

	const rows = await ctx.adapter.raw<{
		status: string;
		count: number;
		total_amount: number;
	}>(
		`SELECT status, COUNT(*)::int as count, COALESCE(SUM(amount), 0) as total_amount
		 FROM ${t("external_transaction")}
		 WHERE ledger_id = $1${feedCondition}
		 GROUP BY status`,
		queryParams,
	);

	let totalExternal = 0;
	let matchedCount = 0;
	let unmatchedCount = 0;
	let excludedCount = 0;
	let unmatchedAmount = 0;

	for (const row of rows) {
		const count = Number(row.count);
		totalExternal += count;
		if (row.status === "matched" || row.status === "manually_matched") {
			matchedCount += count;
		} else if (row.status === "unmatched") {
			unmatchedCount += count;
			unmatchedAmount += Number(row.total_amount);
		} else if (row.status === "excluded") {
			excludedCount += count;
		}
	}

	return {
		totalExternal,
		matched: matchedCount,
		unmatched: unmatchedCount,
		excluded: excludedCount,
		discrepancyAmount: unmatchedAmount,
	};
}

export async function listUnmatchedTransactions(
	ctx: SummaContext,
	params?: { feedId?: string; limit?: number; offset?: number },
): Promise<ExternalTransaction[]> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const conditions: string[] = ["ledger_id = $1", "status = 'unmatched'"];
	const queryParams: unknown[] = [ledgerId];
	let idx = 2;

	if (params?.feedId) {
		conditions.push(`feed_id = $${idx++}`);
		queryParams.push(params.feedId);
	}

	queryParams.push(params?.limit ?? 50, params?.offset ?? 0);

	const rows = await ctx.adapter.raw<RawExternalTxnRow>(
		`SELECT * FROM ${t("external_transaction")}
		 WHERE ${conditions.join(" AND ")}
		 ORDER BY transaction_date DESC
		 LIMIT $${idx++} OFFSET $${idx}`,
		queryParams,
	);
	return rows.map(rawToExternal);
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function bankReconciliation(options?: BankReconciliationOptions): SummaPlugin {
	const matchThreshold = options?.matchThreshold ?? 0.85;
	const similarityThreshold = options?.similarityThreshold ?? 0.7;
	const dateWindowDays = options?.dateWindowDays ?? 3;

	return {
		id: "bank-reconciliation",

		$Infer: {} as {
			ExternalTransaction: ExternalTransaction;
			MatchResult: MatchResult;
			BankReconciliationSummary: BankReconciliationSummary;
		},

		schema: bankReconSchema,

		workers: [
			{
				id: "bank-auto-matcher",
				description: "Auto-match unmatched external transactions to ledger entries",
				interval: options?.matchInterval ?? "5m",
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const result = await runAutoMatch(
						ctx,
						matchThreshold,
						similarityThreshold,
						dateWindowDays,
					);
					if (result.matched > 0) {
						ctx.logger.info("Bank auto-match completed", {
							matched: result.matched,
						});
					}
				},
			},
		],

		endpoints: [
			{
				method: "POST",
				path: "/bank/import",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as Parameters<typeof importFeed>[1];
					if (!body.feedId || !body.transactions?.length) {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "feedId and transactions[] required",
							},
						});
					}
					const result = await importFeed(ctx, body);
					return jsonRes(200, result);
				},
			},
			{
				method: "POST",
				path: "/bank/match",
				handler: async (_req: PluginApiRequest, ctx: SummaContext) => {
					const result = await runAutoMatch(ctx, matchThreshold);
					return jsonRes(200, result);
				},
			},
			{
				method: "POST",
				path: "/bank/manual-match",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as {
						externalTransactionId: string;
						ledgerTransactionId: string;
					};
					if (!body.externalTransactionId || !body.ledgerTransactionId) {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "externalTransactionId and ledgerTransactionId required",
							},
						});
					}
					const result = await manualMatch(ctx, body);
					return jsonRes(200, result);
				},
			},
			{
				method: "POST",
				path: "/bank/exclude/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					await excludeTransaction(ctx, req.params.id ?? "");
					return jsonRes(200, { success: true });
				},
			},
			{
				method: "GET",
				path: "/bank/summary",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const summary = await getReconciliationSummary(ctx, req.query.feedId);
					return jsonRes(200, summary);
				},
			},
			{
				method: "GET",
				path: "/bank/unmatched",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const txns = await listUnmatchedTransactions(ctx, {
						feedId: req.query.feedId,
						limit: req.query.limit ? Number(req.query.limit) : undefined,
						offset: req.query.offset ? Number(req.query.offset) : undefined,
					});
					return jsonRes(200, txns);
				},
			},
		],
	};
}
