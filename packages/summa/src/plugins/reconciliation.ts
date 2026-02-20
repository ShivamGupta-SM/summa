// =============================================================================
// RECONCILIATION PLUGIN -- Event store vs projection integrity verification
// =============================================================================
// Daily reconciliation verifies that the event store and materialized projections
// (account_balance, entry_record, system_account) remain consistent.
//
// Checks performed:
//   Step 0:  Per-transaction double-entry balance (debits == credits)
//   Step 0b: Duplicate entry detection
//   Step 0c: Lock version monotonicity per account
//   Step 1:  User account snapshot-based balance verification (batched)
//   Step 2:  System account full SUM with pending hot entries
//   Step 3:  Block chain hash verification via verifyRecentBlocks
//
// All SQL uses ctx.adapter.raw() with $1, $2 parameterized queries.

import type { SummaContext, SummaPlugin } from "@summa/core";
import { createBlockCheckpoint, verifyRecentBlocks } from "../infrastructure/hash-chain.js";

// =============================================================================
// TYPES
// =============================================================================

interface ReconciliationWatermark {
	id: number;
	last_entry_created_at: string | null;
	last_run_date: string | null;
	last_mismatches: number;
}

interface ReconciliationResult {
	run_date: string;
	status: string;
	total_mismatches: number;
	step0_result: Record<string, unknown>;
	step0b_result: Record<string, unknown>;
	step0c_result: Record<string, unknown>;
	step1_result: Record<string, unknown>;
	step2_result: Record<string, unknown>;
	step3_result: Record<string, unknown>;
	duration_ms: number;
}

interface ReconciliationStatusParams {
	limit?: number;
	offset?: number;
}

interface Mismatch {
	step: string;
	detail: Record<string, unknown>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const BATCH_SIZE = 500;

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function reconciliation(): SummaPlugin {
	return {
		id: "reconciliation",

		init: async (ctx: SummaContext) => {
			// Create watermark row if it doesn't exist
			await ctx.adapter.rawMutate(
				`INSERT INTO reconciliation_watermark (id, last_entry_created_at, last_run_date, last_mismatches)
				 VALUES (1, NULL, NULL, 0)
				 ON CONFLICT (id) DO NOTHING`,
				[],
			);
			ctx.logger.info("Reconciliation plugin initialized");
		},

		workers: [
			{
				id: "daily-reconciliation",
				description: "Verify event store vs projection consistency across all accounts",
				handler: async (ctx: SummaContext) => {
					await dailyReconciliation(ctx);
				},
				interval: "1d",
				leaseRequired: true,
			},
			{
				id: "block-checkpoint",
				description: "Create hourly block checkpoint for hash chain integrity",
				handler: async (ctx: SummaContext) => {
					const result = await createBlockCheckpoint(ctx);
					if (result) {
						ctx.logger.info("Block checkpoint created", {
							blockHash: result.blockHash,
							eventCount: result.eventCount,
						});
					}
				},
				interval: "1h",
				leaseRequired: true,
			},
		],
	};
}

// =============================================================================
// DAILY RECONCILIATION
// =============================================================================

async function dailyReconciliation(ctx: SummaContext): Promise<void> {
	const startMs = Date.now();
	const runDate = new Date().toISOString();
	const mismatches: Mismatch[] = [];

	ctx.logger.info("Daily reconciliation starting", { runDate });

	// ---- Fetch watermark ----
	const watermarkRows = await ctx.adapter.raw<ReconciliationWatermark>(
		`SELECT id, last_entry_created_at, last_run_date, last_mismatches
		 FROM reconciliation_watermark
		 WHERE id = 1
		 LIMIT 1`,
		[],
	);
	const watermark = watermarkRows[0] ?? null;
	const watermarkDate = watermark?.last_entry_created_at ?? null;

	// =========================================================================
	// Step 0: Per-transaction double-entry balance check (incremental)
	// =========================================================================
	// For every transaction, SUM(CREDIT amounts) must equal SUM(DEBIT amounts).
	// We only check entries created since the last watermark for efficiency.

	let step0Sql = `
		SELECT
			e.transaction_id,
			SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END) AS total_credits,
			SUM(CASE WHEN e.entry_type = 'DEBIT' THEN e.amount ELSE 0 END) AS total_debits
		FROM entry_record e`;

	const step0Params: unknown[] = [];
	if (watermarkDate) {
		step0Sql += ` WHERE e.created_at > $1`;
		step0Params.push(watermarkDate);
	}

	step0Sql += `
		GROUP BY e.transaction_id
		HAVING SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END)
		    != SUM(CASE WHEN e.entry_type = 'DEBIT' THEN e.amount ELSE 0 END)`;

	const step0Rows = await ctx.adapter.raw<{
		transaction_id: string;
		total_credits: number;
		total_debits: number;
	}>(step0Sql, step0Params);

	for (const row of step0Rows) {
		mismatches.push({
			step: "step0_double_entry",
			detail: {
				transactionId: row.transaction_id,
				totalCredits: Number(row.total_credits),
				totalDebits: Number(row.total_debits),
			},
		});
	}

	const step0Result = {
		checked: true,
		incremental: !!watermarkDate,
		imbalancedTransactions: step0Rows.length,
	};

	ctx.logger.info("Step 0 complete: double-entry balance check", step0Result);

	// =========================================================================
	// Step 0b: Duplicate entry detection (incremental)
	// =========================================================================
	// Each (transaction_id, account_id/system_account_id, entry_type) should be
	// unique for non-hot entries. Hot account entries may have multiples by design,
	// so we only check non-hot entries.

	let step0bSql = `
		SELECT
			e.transaction_id,
			COALESCE(e.account_id::text, '') AS account_id,
			COALESCE(e.system_account_id::text, '') AS system_account_id,
			e.entry_type,
			COUNT(*) AS cnt
		FROM entry_record e
		WHERE e.is_hot_account = false`;

	const step0bParams: unknown[] = [];
	if (watermarkDate) {
		step0bSql += ` AND e.created_at > $1`;
		step0bParams.push(watermarkDate);
	}

	step0bSql += `
		GROUP BY e.transaction_id, e.account_id, e.system_account_id, e.entry_type
		HAVING COUNT(*) > 1`;

	const step0bRows = await ctx.adapter.raw<{
		transaction_id: string;
		account_id: string;
		system_account_id: string;
		entry_type: string;
		cnt: number;
	}>(step0bSql, step0bParams);

	for (const row of step0bRows) {
		mismatches.push({
			step: "step0b_duplicate_entry",
			detail: {
				transactionId: row.transaction_id,
				accountId: row.account_id || null,
				systemAccountId: row.system_account_id || null,
				entryType: row.entry_type,
				duplicateCount: Number(row.cnt),
			},
		});
	}

	const step0bResult = {
		checked: true,
		incremental: !!watermarkDate,
		duplicatesFound: step0bRows.length,
	};

	ctx.logger.info("Step 0b complete: duplicate entry detection", step0bResult);

	// =========================================================================
	// Step 0c: Lock version monotonicity check (incremental)
	// =========================================================================
	// For each account, entry lock versions must be strictly increasing over time.
	// This detects lost updates or stale-write bugs.

	let step0cSql = `
		SELECT
			sub.account_id,
			sub.entry_type,
			sub.created_at,
			sub.account_lock_version,
			sub.prev_lock_version
		FROM (
			SELECT
				e.account_id,
				e.entry_type,
				e.created_at,
				e.account_lock_version,
				LAG(e.account_lock_version) OVER (
					PARTITION BY e.account_id
					ORDER BY e.created_at ASC, e.id ASC
				) AS prev_lock_version
			FROM entry_record e
			WHERE e.account_id IS NOT NULL
			  AND e.account_lock_version IS NOT NULL`;

	const step0cParams: unknown[] = [];
	if (watermarkDate) {
		step0cSql += ` AND e.created_at > $1`;
		step0cParams.push(watermarkDate);
	}

	step0cSql += `
		) sub
		WHERE sub.prev_lock_version IS NOT NULL
		  AND sub.account_lock_version <= sub.prev_lock_version
		LIMIT 100`;

	const step0cRows = await ctx.adapter.raw<{
		account_id: string;
		entry_type: string;
		created_at: string | Date;
		account_lock_version: number;
		prev_lock_version: number;
	}>(step0cSql, step0cParams);

	for (const row of step0cRows) {
		mismatches.push({
			step: "step0c_lock_version_monotonicity",
			detail: {
				accountId: row.account_id,
				entryType: row.entry_type,
				createdAt: String(row.created_at),
				lockVersion: Number(row.account_lock_version),
				prevLockVersion: Number(row.prev_lock_version),
			},
		});
	}

	const step0cResult = {
		checked: true,
		incremental: !!watermarkDate,
		violationsFound: step0cRows.length,
	};

	ctx.logger.info("Step 0c complete: lock version monotonicity check", step0cResult);

	// =========================================================================
	// Step 1: User accounts -- snapshot-based balance verification (batched)
	// =========================================================================
	// For each user account, the current balance should equal:
	//   SUM(CREDIT entries) - SUM(DEBIT entries)
	// We process in batches of BATCH_SIZE using keyset pagination on id.

	let step1Checked = 0;
	let step1Mismatches = 0;
	let lastAccountId = "";

	while (true) {
		const accountBatch = await ctx.adapter.raw<{
			id: string;
			holder_id: string;
			balance: number;
			credit_balance: number;
			debit_balance: number;
		}>(
			`SELECT id, holder_id, balance, credit_balance, debit_balance
			 FROM account_balance
			 WHERE id > $1
			 ORDER BY id ASC
			 LIMIT $2`,
			[lastAccountId, BATCH_SIZE],
		);

		if (accountBatch.length === 0) break;

		// Collect account IDs for batch entry lookup
		const accountIds = accountBatch.map((a) => a.id);

		// Query entry totals for this batch of accounts
		// Use ANY($1::uuid[]) for array parameter
		const entryTotals = await ctx.adapter.raw<{
			account_id: string;
			total_credits: number;
			total_debits: number;
		}>(
			`SELECT
				e.account_id,
				COALESCE(SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END), 0) AS total_credits,
				COALESCE(SUM(CASE WHEN e.entry_type = 'DEBIT' THEN e.amount ELSE 0 END), 0) AS total_debits
			 FROM entry_record e
			 WHERE e.account_id = ANY($1::uuid[])
			   AND e.is_hot_account = false
			 GROUP BY e.account_id`,
			[accountIds],
		);

		// Build a lookup map
		const totalsByAccountId = new Map<string, { total_credits: number; total_debits: number }>();
		for (const et of entryTotals) {
			totalsByAccountId.set(et.account_id, {
				total_credits: Number(et.total_credits),
				total_debits: Number(et.total_debits),
			});
		}

		for (const acct of accountBatch) {
			step1Checked++;
			const totals = totalsByAccountId.get(acct.id);
			const entryCredits = totals?.total_credits ?? 0;
			const entryDebits = totals?.total_debits ?? 0;
			const expectedBalance = entryCredits - entryDebits;
			const actualBalance = Number(acct.balance);

			if (expectedBalance !== actualBalance) {
				step1Mismatches++;
				mismatches.push({
					step: "step1_user_account_balance",
					detail: {
						accountId: acct.id,
						holderId: acct.holder_id,
						expectedBalance,
						actualBalance,
						entryCredits,
						entryDebits,
					},
				});
			}

			// Also verify credit_balance and debit_balance projections
			const actualCreditBalance = Number(acct.credit_balance);
			const actualDebitBalance = Number(acct.debit_balance);

			if (entryCredits !== actualCreditBalance) {
				step1Mismatches++;
				mismatches.push({
					step: "step1_user_account_credit_balance",
					detail: {
						accountId: acct.id,
						holderId: acct.holder_id,
						expectedCreditBalance: entryCredits,
						actualCreditBalance,
					},
				});
			}

			if (entryDebits !== actualDebitBalance) {
				step1Mismatches++;
				mismatches.push({
					step: "step1_user_account_debit_balance",
					detail: {
						accountId: acct.id,
						holderId: acct.holder_id,
						expectedDebitBalance: entryDebits,
						actualDebitBalance,
					},
				});
			}
		}

		lastAccountId = accountBatch[accountBatch.length - 1]?.id;
		if (accountBatch.length < BATCH_SIZE) break;
	}

	const step1Result = {
		checked: true,
		accountsChecked: step1Checked,
		mismatches: step1Mismatches,
	};

	ctx.logger.info("Step 1 complete: user account balance verification", step1Result);

	// =========================================================================
	// Step 2: System accounts -- full SUM with pending hot entries
	// =========================================================================
	// System accounts use the hot account pattern. Their effective balance is:
	//   SUM(hot_account_entry.amount WHERE status='pending')
	// plus the already-consolidated balance.
	// We verify by comparing settled entry sums + pending hot entries.

	const systemAccounts = await ctx.adapter.raw<{
		id: string;
		identifier: string;
	}>(`SELECT id, identifier FROM system_account ORDER BY id ASC`, []);

	let step2Checked = 0;
	let step2Mismatches = 0;

	for (const sysAcct of systemAccounts) {
		step2Checked++;

		// Get entry-based totals for this system account
		const sysEntryRows = await ctx.adapter.raw<{
			total_credits: number;
			total_debits: number;
		}>(
			`SELECT
				COALESCE(SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END), 0) AS total_credits,
				COALESCE(SUM(CASE WHEN e.entry_type = 'DEBIT' THEN e.amount ELSE 0 END), 0) AS total_debits
			 FROM entry_record e
			 WHERE e.system_account_id = $1`,
			[sysAcct.id],
		);

		const sysEntries = sysEntryRows[0];
		if (!sysEntries) continue;

		const entryNetCredits = Number(sysEntries.total_credits) - Number(sysEntries.total_debits);

		// Get pending hot account entries for this system account
		const hotPendingRows = await ctx.adapter.raw<{
			pending_sum: number;
		}>(
			`SELECT COALESCE(SUM(amount), 0) AS pending_sum
			 FROM hot_account_entry
			 WHERE account_id = $1
			   AND status = 'pending'`,
			[sysAcct.id],
		);

		const pendingHotSum = Number(hotPendingRows[0]?.pending_sum ?? 0);

		// The hot_account_entry amounts are signed:
		//   CREDIT => +amount, DEBIT => -amount
		// So the net impact from hot entries is directly their sum.
		// The entry_record for system accounts has is_hot_account = true,
		// meaning they were recorded alongside hot_account_entry inserts.
		// We verify: net entry credits should be consistent with hot entries.

		// Get consolidated (flushed) hot account totals
		const hotConsolidatedRows = await ctx.adapter.raw<{
			consolidated_sum: number;
		}>(
			`SELECT COALESCE(SUM(amount), 0) AS consolidated_sum
			 FROM hot_account_entry
			 WHERE account_id = $1
			   AND status = 'consolidated'`,
			[sysAcct.id],
		);

		const consolidatedHotSum = Number(hotConsolidatedRows[0]?.consolidated_sum ?? 0);

		// Total hot account net = consolidated + pending
		const totalHotNet = consolidatedHotSum + pendingHotSum;

		// entryNetCredits should equal totalHotNet
		// (both represent the net flow into the system account)
		if (entryNetCredits !== totalHotNet) {
			step2Mismatches++;
			mismatches.push({
				step: "step2_system_account_balance",
				detail: {
					systemAccountId: sysAcct.id,
					identifier: sysAcct.identifier,
					entryNetCredits,
					totalHotNet,
					pendingHotSum,
					consolidatedHotSum,
				},
			});
		}
	}

	const step2Result = {
		checked: true,
		systemAccountsChecked: step2Checked,
		mismatches: step2Mismatches,
	};

	ctx.logger.info("Step 2 complete: system account balance verification", step2Result);

	// =========================================================================
	// Step 3: Block chain verification via verifyRecentBlocks
	// =========================================================================

	let step3Result: Record<string, unknown>;

	try {
		const blockResult = await verifyRecentBlocks(ctx);

		if (blockResult.blocksFailed > 0) {
			for (const failure of blockResult.failures) {
				mismatches.push({
					step: "step3_block_chain",
					detail: {
						blockId: failure.blockId,
						blockSequence: failure.blockSequence,
						reason: failure.reason,
					},
				});
			}
		}

		step3Result = {
			checked: true,
			blocksVerified: blockResult.blocksVerified,
			blocksValid: blockResult.blocksValid,
			blocksFailed: blockResult.blocksFailed,
			failures: blockResult.failures,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		ctx.logger.error("Step 3 block chain verification failed", {
			error: errorMessage,
		});
		step3Result = {
			checked: false,
			error: errorMessage,
		};
	}

	ctx.logger.info("Step 3 complete: block chain verification", step3Result);

	// =========================================================================
	// Update watermark
	// =========================================================================

	// Get the latest entry created_at as the new watermark
	const latestEntryRows = await ctx.adapter.raw<{
		max_created_at: string | null;
	}>(`SELECT MAX(created_at)::text AS max_created_at FROM entry_record`, []);

	const newWatermarkDate = latestEntryRows[0]?.max_created_at ?? watermarkDate;

	await ctx.adapter.rawMutate(
		`UPDATE reconciliation_watermark
		 SET last_entry_created_at = $1,
		     last_run_date = $2,
		     last_mismatches = $3
		 WHERE id = 1`,
		[newWatermarkDate, runDate, mismatches.length],
	);

	// =========================================================================
	// Upsert reconciliation result
	// =========================================================================

	const durationMs = Date.now() - startMs;
	const status = mismatches.length === 0 ? "healthy" : "mismatches_found";

	await ctx.adapter.rawMutate(
		`INSERT INTO reconciliation_result (
			run_date,
			status,
			total_mismatches,
			step0_result,
			step0b_result,
			step0c_result,
			step1_result,
			step2_result,
			step3_result,
			duration_ms,
			mismatches
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		 ON CONFLICT (run_date) DO UPDATE SET
			status = EXCLUDED.status,
			total_mismatches = EXCLUDED.total_mismatches,
			step0_result = EXCLUDED.step0_result,
			step0b_result = EXCLUDED.step0b_result,
			step0c_result = EXCLUDED.step0c_result,
			step1_result = EXCLUDED.step1_result,
			step2_result = EXCLUDED.step2_result,
			step3_result = EXCLUDED.step3_result,
			duration_ms = EXCLUDED.duration_ms,
			mismatches = EXCLUDED.mismatches`,
		[
			runDate,
			status,
			mismatches.length,
			JSON.stringify(step0Result),
			JSON.stringify(step0bResult),
			JSON.stringify(step0cResult),
			JSON.stringify(step1Result),
			JSON.stringify(step2Result),
			JSON.stringify(step3Result),
			durationMs,
			JSON.stringify(mismatches),
		],
	);

	ctx.logger.info("Daily reconciliation complete", {
		runDate,
		status,
		totalMismatches: mismatches.length,
		durationMs,
	});

	if (mismatches.length > 0) {
		ctx.logger.error("Reconciliation found mismatches", {
			count: mismatches.length,
			mismatches: mismatches.slice(0, 20), // Log first 20 for visibility
		});
	}
}

// =============================================================================
// QUERY RECONCILIATION STATUS
// =============================================================================

export async function getReconciliationStatus(
	ctx: SummaContext,
	params?: ReconciliationStatusParams,
): Promise<{
	watermark: {
		lastEntryCreatedAt: string | null;
		lastRunDate: string | null;
		lastMismatches: number;
	};
	recentResults: ReconciliationResult[];
}> {
	const limit = Math.min(params?.limit ?? 10, 100);
	const offset = params?.offset ?? 0;

	// Fetch watermark
	const watermarkRows = await ctx.adapter.raw<ReconciliationWatermark>(
		`SELECT id, last_entry_created_at, last_run_date, last_mismatches
		 FROM reconciliation_watermark
		 WHERE id = 1
		 LIMIT 1`,
		[],
	);

	const wm = watermarkRows[0];
	const watermark = {
		lastEntryCreatedAt: wm?.last_entry_created_at ?? null,
		lastRunDate: wm?.last_run_date ?? null,
		lastMismatches: Number(wm?.last_mismatches ?? 0),
	};

	// Fetch recent results
	const resultRows = await ctx.adapter.raw<ReconciliationResult>(
		`SELECT
			run_date,
			status,
			total_mismatches,
			step0_result,
			step0b_result,
			step0c_result,
			step1_result,
			step2_result,
			step3_result,
			duration_ms
		 FROM reconciliation_result
		 ORDER BY run_date DESC
		 LIMIT $1
		 OFFSET $2`,
		[limit, offset],
	);

	return {
		watermark,
		recentResults: resultRows.map((r) => ({
			run_date: String(r.run_date),
			status: r.status,
			total_mismatches: Number(r.total_mismatches),
			step0_result:
				typeof r.step0_result === "string" ? JSON.parse(r.step0_result) : r.step0_result,
			step0b_result:
				typeof r.step0b_result === "string" ? JSON.parse(r.step0b_result) : r.step0b_result,
			step0c_result:
				typeof r.step0c_result === "string" ? JSON.parse(r.step0c_result) : r.step0c_result,
			step1_result:
				typeof r.step1_result === "string" ? JSON.parse(r.step1_result) : r.step1_result,
			step2_result:
				typeof r.step2_result === "string" ? JSON.parse(r.step2_result) : r.step2_result,
			step3_result:
				typeof r.step3_result === "string" ? JSON.parse(r.step3_result) : r.step3_result,
			duration_ms: Number(r.duration_ms),
		})),
	};
}
