// =============================================================================
// SCHEDULED TRANSACTIONS PLUGIN -- Process due scheduled transactions
// =============================================================================
// Polls for scheduled transactions whose next_execution_at has passed,
// executes them via the transaction manager (credit/debit/transfer), and
// handles recurrence rescheduling or failure after max retries.
//
// Status is tracked via entity_status_log (append-only) instead of a mutable
// status column on the scheduled_transaction table.  Mutable execution
// counters (execution_count, retry_count, last_executed_at, next_execution_at,
// last_retry_at) are stored as metadata on the entity_status_log rows until a
// dedicated scheduled_transaction_execution table is introduced.

import type { SummaContext, SummaPlugin } from "@summa/core";
import { AGGREGATE_TYPES, SCHEDULED_EVENTS, SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import { transitionEntityStatus } from "../../infrastructure/entity-status.js";
import { appendEvent, withTransactionTimeout } from "../infrastructure/event-store.js";
import { creditAccount, debitAccount, transfer } from "../managers/transaction-manager.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const ENTITY_TYPE = "scheduled_transaction" as const;

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

/** Row shape returned by the LATERAL JOIN candidate query. */
interface RawScheduledDetailRow {
	id: string;
	reference: string | null;
	amount: number;
	currency: string;
	source_identifier: string;
	destination_identifier: string | null;
	scheduled_for: string | Date;
	recurrence: Recurrence | string | null;
	// Mutable fields come from entity_status_log metadata
	current_status: string;
	status_metadata: Record<string, unknown> | null;
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
				leaseRequired: true,
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
	const t = createTableResolver(ctx.options.schema);
	const { maxRetries, batchSize, maxBatchesPerRun } = options;

	for (let batch = 0; batch < maxBatchesPerRun; batch++) {
		const now = new Date().toISOString();

		// Fetch candidate IDs using a LATERAL JOIN to entity_status_log.
		// The sub-select finds the latest status row for each scheduled_transaction
		// and filters to those that are 'scheduled' with next_execution_at in the
		// metadata that has passed.
		const candidates = await ctx.adapter.raw<RawScheduledRow>(
			`SELECT st.id
       FROM ${t("scheduled_transaction")} st
       INNER JOIN LATERAL (
         SELECT esl.status, esl.metadata
         FROM ${t("entity_status_log")} esl
         WHERE esl.entity_type = '${ENTITY_TYPE}'
           AND esl.entity_id = st.id
         ORDER BY esl.created_at DESC
         LIMIT 1
       ) latest_status ON true
       WHERE latest_status.status = 'scheduled'
         AND (latest_status.metadata->>'next_execution_at')::timestamptz <= $1::timestamptz
       ORDER BY (latest_status.metadata->>'next_execution_at')::timestamptz ASC
       LIMIT $2`,
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
	const t = createTableResolver(ctx.options.schema);
	// -------------------------------------------------------------------------
	// Phase 1: Lock row, mark as processing, append PROCESSING event
	// -------------------------------------------------------------------------
	let detail: RawScheduledDetailRow | null = null;

	try {
		detail = await withTransactionTimeout(ctx, async (tx) => {
			// Lock the scheduled_transaction row and join to latest status
			const rows = await tx.raw<RawScheduledDetailRow>(
				`SELECT st.id, st.reference, st.amount, st.currency,
                st.source_identifier, st.destination_identifier,
                st.scheduled_for, st.recurrence,
                latest_status.status AS current_status,
                latest_status.metadata AS status_metadata
         FROM ${t("scheduled_transaction")} st
         INNER JOIN LATERAL (
           SELECT esl.status, esl.metadata
           FROM ${t("entity_status_log")} esl
           WHERE esl.entity_type = '${ENTITY_TYPE}'
             AND esl.entity_id = st.id
           ORDER BY esl.created_at DESC
           LIMIT 1
         ) latest_status ON true
         WHERE st.id = $1 AND latest_status.status = 'scheduled'
         ${ctx.dialect.forUpdateSkipLocked()}`,
				[scheduledId],
			);

			const row = rows[0];
			if (!row) {
				// Already picked up by another worker or no longer scheduled
				return null;
			}

			// Transition to processing
			await transitionEntityStatus({
				tx,
				entityType: ENTITY_TYPE,
				entityId: scheduledId,
				status: "processing",
				expectedCurrentStatus: "scheduled",
				metadata: row.status_metadata ?? undefined,
			});

			// Append PROCESSING event
			await appendEvent(
				tx,
				{
					aggregateType: AGGREGATE_TYPES.SCHEDULED_TRANSACTION,
					aggregateId: scheduledId,
					eventType: SCHEDULED_EVENTS.PROCESSING,
					eventData: {
						scheduledId,
						sourceIdentifier: row.source_identifier,
						destinationIdentifier: row.destination_identifier,
						amount: Number(row.amount),
					},
				},
				ctx.options.schema,
				ctx.options.advanced.hmacSecret,
			);

			return row;
		});
	} catch (error) {
		ctx.logger.error("Phase 1 failed for scheduled transaction", {
			scheduledId,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}

	if (!detail) {
		return;
	}

	// Extract mutable fields from status metadata
	const statusMeta = detail.status_metadata ?? {};
	const executionCount = Number(statusMeta.execution_count ?? 0);
	const retryCount = Number(statusMeta.retry_count ?? 0);

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
		await handleExecutionFailure(ctx, scheduledId, detail, maxRetries, error, {
			executionCount,
			retryCount,
		});
		return;
	}

	// -------------------------------------------------------------------------
	// Phase 3: Mark completed or rescheduled, append event
	// -------------------------------------------------------------------------
	try {
		await withTransactionTimeout(ctx, async (tx) => {
			const recurrence = parseRecurrence(detail.recurrence);
			const newExecutionCount = executionCount + 1;
			const now = new Date();

			if (recurrence && shouldReschedule(recurrence, newExecutionCount)) {
				// Compute next execution time
				const nextExecution = computeNextExecution(now, recurrence);

				// Transition back to scheduled with updated metadata
				await transitionEntityStatus({
					tx,
					entityType: ENTITY_TYPE,
					entityId: scheduledId,
					status: "scheduled",
					expectedCurrentStatus: "processing",
					reason: "rescheduled",
					metadata: {
						execution_count: newExecutionCount,
						retry_count: 0,
						last_executed_at: now.toISOString(),
						next_execution_at: nextExecution.toISOString(),
						last_retry_at: null,
					},
				});

				await appendEvent(
					tx,
					{
						aggregateType: AGGREGATE_TYPES.SCHEDULED_TRANSACTION,
						aggregateId: scheduledId,
						eventType: SCHEDULED_EVENTS.RESCHEDULED,
						eventData: {
							scheduledId,
							executionCount: newExecutionCount,
							nextExecutionAt: nextExecution.toISOString(),
							intervalMs: recurrence.intervalMs,
						},
					},
					ctx.options.schema,
					ctx.options.advanced.hmacSecret,
				);

				ctx.logger.info("Scheduled transaction rescheduled", {
					scheduledId,
					executionCount: newExecutionCount,
					nextExecutionAt: nextExecution.toISOString(),
				});
			} else {
				// One-shot or max executions reached -- mark completed
				await transitionEntityStatus({
					tx,
					entityType: ENTITY_TYPE,
					entityId: scheduledId,
					status: "completed",
					expectedCurrentStatus: "processing",
					metadata: {
						execution_count: newExecutionCount,
						retry_count: 0,
						last_executed_at: now.toISOString(),
						next_execution_at: null,
						last_retry_at: null,
					},
				});

				await appendEvent(
					tx,
					{
						aggregateType: AGGREGATE_TYPES.SCHEDULED_TRANSACTION,
						aggregateId: scheduledId,
						eventType: SCHEDULED_EVENTS.COMPLETED,
						eventData: {
							scheduledId,
							executionCount: newExecutionCount,
						},
					},
					ctx.options.schema,
					ctx.options.advanced.hmacSecret,
				);

				ctx.logger.info("Scheduled transaction completed", {
					scheduledId,
					executionCount: newExecutionCount,
				});
			}
		});
	} catch (error) {
		// Phase 3 failure: the financial operation succeeded but we could not
		// update the status. Log prominently so operators can reconcile.
		ctx.logger.error(
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
	counters: { executionCount: number; retryCount: number },
): Promise<void> {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const currentRetryCount = counters.retryCount + 1;
	const nowIso = new Date().toISOString();

	try {
		await withTransactionTimeout(ctx, async (tx) => {
			if (currentRetryCount >= maxRetries) {
				// Max retries exceeded -- mark as failed permanently
				await transitionEntityStatus({
					tx,
					entityType: ENTITY_TYPE,
					entityId: scheduledId,
					status: "failed",
					expectedCurrentStatus: "processing",
					reason: errorMessage,
					metadata: {
						execution_count: counters.executionCount,
						retry_count: currentRetryCount,
						last_executed_at:
							(detail.status_metadata as Record<string, unknown>)?.last_executed_at ?? null,
						next_execution_at: null,
						last_retry_at: nowIso,
					},
				});

				await appendEvent(
					tx,
					{
						aggregateType: AGGREGATE_TYPES.SCHEDULED_TRANSACTION,
						aggregateId: scheduledId,
						eventType: SCHEDULED_EVENTS.FAILED,
						eventData: {
							scheduledId,
							retryCount: currentRetryCount,
							error: errorMessage,
						},
					},
					ctx.options.schema,
					ctx.options.advanced.hmacSecret,
				);

				ctx.logger.error("Scheduled transaction permanently failed", {
					scheduledId,
					retryCount: currentRetryCount,
					error: errorMessage,
				});
			} else {
				// Revert to scheduled for retry on next run
				await transitionEntityStatus({
					tx,
					entityType: ENTITY_TYPE,
					entityId: scheduledId,
					status: "scheduled",
					expectedCurrentStatus: "processing",
					reason: `retry ${currentRetryCount}/${maxRetries}: ${errorMessage}`,
					metadata: {
						execution_count: counters.executionCount,
						retry_count: currentRetryCount,
						last_executed_at:
							(detail.status_metadata as Record<string, unknown>)?.last_executed_at ?? null,
						next_execution_at:
							(detail.status_metadata as Record<string, unknown>)?.next_execution_at ?? null,
						last_retry_at: nowIso,
					},
				});

				ctx.logger.info("Scheduled transaction execution failed, will retry", {
					scheduledId,
					retryCount: currentRetryCount,
					maxRetries,
					error: errorMessage,
				});
			}
		});
	} catch (updateError) {
		ctx.logger.error("Failed to update scheduled transaction after execution failure", {
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
		throw SummaError.invalidArgument(
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
