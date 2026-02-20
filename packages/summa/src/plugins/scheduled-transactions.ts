// =============================================================================
// SCHEDULED TRANSACTIONS PLUGIN -- Process due scheduled transactions
// =============================================================================
// Polls for scheduled transactions whose next_execution_at has passed,
// executes them via the transaction manager (credit/debit/transfer), and
// handles recurrence rescheduling or failure after max retries.

import type { SummaContext, SummaPlugin } from "@summa/core";
import { AGGREGATE_TYPES, SCHEDULED_EVENTS } from "@summa/core";
import { appendEvent, withTransactionTimeout } from "../infrastructure/event-store.js";
import { creditAccount, debitAccount, transfer } from "../managers/transaction-manager.js";

// =============================================================================
// OPTIONS
// =============================================================================

export interface ScheduledTransactionsOptions {
	/** Max retries before marking as failed. Default: 3 */
	maxRetries?: number;
	/** Batch size for candidate fetching. Default: 100 */
	batchSize?: number;
	/** Max batches per run (safety cap). Default: 50 */
	maxBatchesPerRun?: number;
}

// =============================================================================
// RAW ROW TYPES
// =============================================================================

interface RawScheduledRow {
	id: string;
}

interface RawScheduledDetailRow {
	id: string;
	reference: string | null;
	amount: number;
	currency: string;
	source_identifier: string;
	destination_identifier: string | null;
	scheduled_for: string | Date;
	recurrence: Recurrence | string | null;
	status: string;
	last_executed_at: string | Date | null;
	next_execution_at: string | Date | null;
	execution_count: number;
	retry_count: number;
	last_retry_at: string | Date | null;
}

interface Recurrence {
	intervalMs: number;
	maxExecutions?: number;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function scheduledTransactions(options?: ScheduledTransactionsOptions): SummaPlugin {
	const maxRetries = options?.maxRetries ?? 3;
	const batchSize = options?.batchSize ?? 100;
	const maxBatchesPerRun = options?.maxBatchesPerRun ?? 50;

	return {
		id: "scheduled-transactions",

		workers: [
			{
				id: "scheduled-processor",
				description: "Processes scheduled transactions that are due for execution",
				interval: "1m",
				leaseRequired: false,
				handler: async (ctx: SummaContext) => {
					await processScheduledTransactions(ctx, {
						maxRetries,
						batchSize,
						maxBatchesPerRun,
					});
				},
			},
		],
	};
}

// =============================================================================
// PROCESS SCHEDULED TRANSACTIONS
// =============================================================================

async function processScheduledTransactions(
	ctx: SummaContext,
	options: Required<ScheduledTransactionsOptions>,
): Promise<void> {
	const { maxRetries, batchSize, maxBatchesPerRun } = options;

	for (let batch = 0; batch < maxBatchesPerRun; batch++) {
		const now = new Date().toISOString();

		// Fetch candidate IDs outside a long-running transaction
		const candidates = await ctx.adapter.raw<RawScheduledRow>(
			`SELECT id FROM scheduled_transaction
       WHERE status = 'scheduled' AND next_execution_at <= $1
       ORDER BY next_execution_at ASC LIMIT $2`,
			[now, batchSize],
		);

		if (candidates.length === 0) {
			break;
		}

		for (const candidate of candidates) {
			await processSingleScheduledTransaction(ctx, candidate.id, maxRetries);
		}
	}
}

// =============================================================================
// PROCESS SINGLE SCHEDULED TRANSACTION (3-phase)
// =============================================================================

async function processSingleScheduledTransaction(
	ctx: SummaContext,
	scheduledId: string,
	maxRetries: number,
): Promise<void> {
	// -------------------------------------------------------------------------
	// Phase 1: Lock row, mark as processing, append PROCESSING event
	// -------------------------------------------------------------------------
	let detail: RawScheduledDetailRow | null = null;

	try {
		detail = await withTransactionTimeout(ctx, async (tx) => {
			const rows = await tx.raw<RawScheduledDetailRow>(
				`SELECT * FROM scheduled_transaction
         WHERE id = $1 AND status = 'scheduled'
         ${ctx.dialect.forUpdateSkipLocked()}`,
				[scheduledId],
			);

			const row = rows[0];
			if (!row) {
				// Already picked up by another worker or no longer scheduled
				return null;
			}

			// Mark as processing
			await tx.rawMutate(
				`UPDATE scheduled_transaction
         SET status = 'processing'
         WHERE id = $1`,
				[scheduledId],
			);

			// Append PROCESSING event
			await appendEvent(tx, {
				aggregateType: AGGREGATE_TYPES.SCHEDULED_TRANSACTION,
				aggregateId: scheduledId,
				eventType: SCHEDULED_EVENTS.PROCESSING,
				eventData: {
					scheduledId,
					sourceIdentifier: row.source_identifier,
					destinationIdentifier: row.destination_identifier,
					amount: Number(row.amount),
				},
			});

			return row;
		});
	} catch (error) {
		ctx.logger.info("Phase 1 failed for scheduled transaction", {
			scheduledId,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}

	if (!detail) {
		return;
	}

	// -------------------------------------------------------------------------
	// Phase 2: Execute the financial operation
	// -------------------------------------------------------------------------
	try {
		await executeScheduledTransaction(ctx, {
			amount: Number(detail.amount),
			currency: detail.currency,
			sourceIdentifier: detail.source_identifier,
			destinationIdentifier: detail.destination_identifier,
			reference: detail.reference ?? `scheduled-${scheduledId}-${Date.now()}`,
			scheduledId,
		});
	} catch (error) {
		// Execution failed -- handle retry or permanent failure
		await handleExecutionFailure(ctx, scheduledId, detail, maxRetries, error);
		return;
	}

	// -------------------------------------------------------------------------
	// Phase 3: Mark completed or rescheduled, append event
	// -------------------------------------------------------------------------
	try {
		await withTransactionTimeout(ctx, async (tx) => {
			const recurrence = parseRecurrence(detail.recurrence);
			const executionCount = Number(detail.execution_count) + 1;
			const now = new Date();

			if (recurrence && shouldReschedule(recurrence, executionCount)) {
				// Compute next execution time
				const nextExecution = computeNextExecution(now, recurrence);

				await tx.rawMutate(
					`UPDATE scheduled_transaction
           SET status = 'scheduled',
               last_executed_at = $1,
               next_execution_at = $2,
               execution_count = $3,
               retry_count = 0
           WHERE id = $4`,
					[now.toISOString(), nextExecution.toISOString(), executionCount, scheduledId],
				);

				await appendEvent(tx, {
					aggregateType: AGGREGATE_TYPES.SCHEDULED_TRANSACTION,
					aggregateId: scheduledId,
					eventType: SCHEDULED_EVENTS.RESCHEDULED,
					eventData: {
						scheduledId,
						executionCount,
						nextExecutionAt: nextExecution.toISOString(),
						intervalMs: recurrence.intervalMs,
					},
				});

				ctx.logger.info("Scheduled transaction rescheduled", {
					scheduledId,
					executionCount,
					nextExecutionAt: nextExecution.toISOString(),
				});
			} else {
				// One-shot or max executions reached -- mark completed
				await tx.rawMutate(
					`UPDATE scheduled_transaction
           SET status = 'completed',
               last_executed_at = $1,
               execution_count = $2,
               retry_count = 0
           WHERE id = $3`,
					[now.toISOString(), executionCount, scheduledId],
				);

				await appendEvent(tx, {
					aggregateType: AGGREGATE_TYPES.SCHEDULED_TRANSACTION,
					aggregateId: scheduledId,
					eventType: SCHEDULED_EVENTS.COMPLETED,
					eventData: {
						scheduledId,
						executionCount,
					},
				});

				ctx.logger.info("Scheduled transaction completed", {
					scheduledId,
					executionCount,
				});
			}
		});
	} catch (error) {
		// Phase 3 failure: the financial operation succeeded but we could not
		// update the status. Log prominently so operators can reconcile.
		ctx.logger.info(
			"Phase 3 failed for scheduled transaction -- manual reconciliation may be required",
			{
				scheduledId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}

// =============================================================================
// EXECUTION FAILURE HANDLER
// =============================================================================

async function handleExecutionFailure(
	ctx: SummaContext,
	scheduledId: string,
	detail: RawScheduledDetailRow,
	maxRetries: number,
	error: unknown,
): Promise<void> {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const currentRetryCount = Number(detail.retry_count) + 1;

	try {
		await withTransactionTimeout(ctx, async (tx) => {
			if (currentRetryCount >= maxRetries) {
				// Max retries exceeded -- mark as failed permanently
				await tx.rawMutate(
					`UPDATE scheduled_transaction
           SET status = 'failed',
               retry_count = $1,
               last_retry_at = ${ctx.dialect.now()}
           WHERE id = $2`,
					[currentRetryCount, scheduledId],
				);

				await appendEvent(tx, {
					aggregateType: AGGREGATE_TYPES.SCHEDULED_TRANSACTION,
					aggregateId: scheduledId,
					eventType: SCHEDULED_EVENTS.FAILED,
					eventData: {
						scheduledId,
						retryCount: currentRetryCount,
						error: errorMessage,
					},
				});

				ctx.logger.info("Scheduled transaction permanently failed", {
					scheduledId,
					retryCount: currentRetryCount,
					error: errorMessage,
				});
			} else {
				// Revert to scheduled for retry on next run
				await tx.rawMutate(
					`UPDATE scheduled_transaction
           SET status = 'scheduled',
               retry_count = $1,
               last_retry_at = ${ctx.dialect.now()}
           WHERE id = $2`,
					[currentRetryCount, scheduledId],
				);

				ctx.logger.info("Scheduled transaction execution failed, will retry", {
					scheduledId,
					retryCount: currentRetryCount,
					maxRetries,
					error: errorMessage,
				});
			}
		});
	} catch (updateError) {
		ctx.logger.info("Failed to update scheduled transaction after execution failure", {
			scheduledId,
			originalError: errorMessage,
			updateError: updateError instanceof Error ? updateError.message : String(updateError),
		});
	}
}

// =============================================================================
// EXECUTE SCHEDULED TRANSACTION
// =============================================================================
// Routes the scheduled transaction to the appropriate financial operation
// based on identifier prefixes:
//   - "@" prefix = system account
//   - "holderId:holderType" format = user account
//   - System source + user dest -> creditAccount
//   - User source + system dest -> debitAccount
//   - User source + user dest -> transfer

interface ExecuteParams {
	amount: number;
	currency: string;
	sourceIdentifier: string;
	destinationIdentifier: string | null;
	reference: string;
	scheduledId: string;
}

async function executeScheduledTransaction(
	ctx: SummaContext,
	params: ExecuteParams,
): Promise<void> {
	const { amount, sourceIdentifier, destinationIdentifier, reference, scheduledId } = params;

	const sourceIsSystem = isSystemAccount(sourceIdentifier);
	const destIsSystem = destinationIdentifier ? isSystemAccount(destinationIdentifier) : true; // No destination defaults to system-like behavior

	if (sourceIsSystem && !destIsSystem && destinationIdentifier) {
		// System source + user dest -> credit the user account
		const dest = parseUserIdentifier(destinationIdentifier);
		await creditAccount(ctx, {
			holderId: dest.holderId,
			amount,
			reference,
			sourceSystemAccount: sourceIdentifier,
			description: `Scheduled transaction ${scheduledId}`,
		});
	} else if (!sourceIsSystem && (destIsSystem || !destinationIdentifier)) {
		// User source + system dest (or no dest) -> debit the user account
		const source = parseUserIdentifier(sourceIdentifier);
		await debitAccount(ctx, {
			holderId: source.holderId,
			amount,
			reference,
			destinationSystemAccount: destinationIdentifier ?? undefined,
			description: `Scheduled transaction ${scheduledId}`,
		});
	} else if (!sourceIsSystem && !destIsSystem && destinationIdentifier) {
		// User source + user dest -> transfer between accounts
		const source = parseUserIdentifier(sourceIdentifier);
		const dest = parseUserIdentifier(destinationIdentifier);
		await transfer(ctx, {
			sourceHolderId: source.holderId,
			destinationHolderId: dest.holderId,
			amount,
			reference,
			description: `Scheduled transaction ${scheduledId}`,
		});
	} else {
		// System-to-system: not a valid user-facing operation
		throw new Error(
			`Unsupported scheduled transaction route: source=${sourceIdentifier}, destination=${destinationIdentifier}`,
		);
	}
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Check if an identifier represents a system account.
 * System accounts are prefixed with "@" (e.g., "@World", "@Fees").
 */
function isSystemAccount(identifier: string): boolean {
	return identifier.startsWith("@");
}

/**
 * Parse a user identifier in "holderId:holderType" format.
 * Falls back to treating the entire string as holderId if no colon present.
 */
function parseUserIdentifier(identifier: string): {
	holderId: string;
	holderType: string | undefined;
} {
	const colonIndex = identifier.indexOf(":");
	if (colonIndex === -1) {
		return { holderId: identifier, holderType: undefined };
	}
	return {
		holderId: identifier.substring(0, colonIndex),
		holderType: identifier.substring(colonIndex + 1),
	};
}

/**
 * Compute the next execution date by adding the recurrence interval.
 */
function computeNextExecution(fromDate: Date, recurrence: Recurrence): Date {
	return new Date(fromDate.getTime() + recurrence.intervalMs);
}

/**
 * Parse a recurrence value from the database (may be JSONB object or string).
 */
function parseRecurrence(raw: Recurrence | string | null | undefined): Recurrence | null {
	if (!raw) {
		return null;
	}
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as Recurrence;
			if (typeof parsed.intervalMs === "number" && parsed.intervalMs > 0) {
				return parsed;
			}
			return null;
		} catch {
			return null;
		}
	}
	if (typeof raw.intervalMs === "number" && raw.intervalMs > 0) {
		return raw;
	}
	return null;
}

/**
 * Determine if a recurring transaction should be rescheduled based on
 * execution count vs. maxExecutions limit.
 */
function shouldReschedule(recurrence: Recurrence, executionCount: number): boolean {
	if (recurrence.maxExecutions != null && executionCount >= recurrence.maxExecutions) {
		return false;
	}
	return true;
}
