// =============================================================================
// TRANSACTION HISTORY PROJECTION
// =============================================================================
// Maintains a denormalized projection_transaction_history table from
// TransactionInitiated and TransactionPosted events. Provides fast
// transaction queries without joining events + entries.

import type { StoredEvent, SummaContext, TableDefinition } from "@summa-ledger/core";
import type { SummaTransactionAdapter } from "@summa-ledger/core/db";
import { createTableResolver } from "@summa-ledger/core/db";
import type { Projection } from "../types.js";

// =============================================================================
// SCHEMA
// =============================================================================

export const transactionHistoryProjectionSchema: Record<string, TableDefinition> = {
	projection_transaction_history: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			transaction_id: { type: "text", notNull: true },
			ledger_id: { type: "text", notNull: true },
			reference: { type: "text" },
			amount: { type: "bigint" },
			currency: { type: "text" },
			source_account: { type: "text" },
			destination_account: { type: "text" },
			description: { type: "text" },
			status: { type: "text", notNull: true, default: "'initiated'" },
			initiated_at: { type: "timestamp" },
			posted_at: { type: "timestamp" },
			last_event_sequence: { type: "bigint", notNull: true, default: "0" },
			event_data: { type: "jsonb" },
		},
		indexes: [
			{
				name: "uq_proj_txn_history_transaction",
				columns: ["ledger_id", "transaction_id"],
				unique: true,
			},
			{
				name: "idx_proj_txn_history_source",
				columns: ["ledger_id", "source_account"],
			},
			{
				name: "idx_proj_txn_history_destination",
				columns: ["ledger_id", "destination_account"],
			},
			{
				name: "idx_proj_txn_history_posted_at",
				columns: ["posted_at"],
			},
		],
	},
};

// =============================================================================
// PROJECTION
// =============================================================================

export const TransactionHistoryProjection: Projection = {
	id: "transaction-history",
	description: "Maintains denormalized transaction history from ledger events",
	eventTypes: ["TransactionInitiated", "TransactionPosted"],

	async handleEvent(
		event: StoredEvent,
		tx: SummaTransactionAdapter,
		ctx: SummaContext,
	): Promise<void> {
		const t = createTableResolver(ctx.options.schema);
		const d = ctx.dialect;

		if (event.eventType === "TransactionInitiated") {
			const data = event.eventData as {
				reference?: string;
				amount?: number;
				currency?: string;
				source?: string;
				destination?: string;
				description?: string;
				ledgerId?: string;
			};

			const ledgerId = data.ledgerId ?? "";

			await tx.raw(
				`INSERT INTO ${t("projection_transaction_history")}
				 (id, transaction_id, ledger_id, reference, amount, currency, source_account, destination_account, description, status, initiated_at, last_event_sequence, event_data)
				 VALUES (${d.generateUuid()}, $1, $2, $3, $4, $5, $6, $7, $8, 'initiated', $9, $10, $11)
				 ON CONFLICT (ledger_id, transaction_id)
				 DO UPDATE SET
					reference = COALESCE(EXCLUDED.reference, ${t("projection_transaction_history")}.reference),
					amount = COALESCE(EXCLUDED.amount, ${t("projection_transaction_history")}.amount),
					currency = COALESCE(EXCLUDED.currency, ${t("projection_transaction_history")}.currency),
					source_account = COALESCE(EXCLUDED.source_account, ${t("projection_transaction_history")}.source_account),
					destination_account = COALESCE(EXCLUDED.destination_account, ${t("projection_transaction_history")}.destination_account),
					description = COALESCE(EXCLUDED.description, ${t("projection_transaction_history")}.description),
					last_event_sequence = EXCLUDED.last_event_sequence,
					event_data = EXCLUDED.event_data
				 WHERE ${t("projection_transaction_history")}.last_event_sequence < EXCLUDED.last_event_sequence`,
				[
					event.aggregateId,
					ledgerId,
					data.reference ?? null,
					data.amount ?? null,
					data.currency ?? null,
					data.source ?? null,
					data.destination ?? null,
					data.description ?? null,
					event.createdAt,
					event.sequenceNumber,
					JSON.stringify(event.eventData),
				],
			);
		} else if (event.eventType === "TransactionPosted") {
			const data = event.eventData as {
				postedAt?: string;
				ledgerId?: string;
			};

			const ledgerId = data.ledgerId ?? "";

			await tx.raw(
				`UPDATE ${t("projection_transaction_history")}
				 SET status = 'posted',
				     posted_at = $1,
				     last_event_sequence = $2,
				     event_data = ${t("projection_transaction_history")}.event_data || $3::jsonb
				 WHERE ledger_id = $4 AND transaction_id = $5
				   AND last_event_sequence < $2`,
				[
					data.postedAt ?? event.createdAt.toISOString(),
					event.sequenceNumber,
					JSON.stringify({ posted: event.eventData }),
					ledgerId,
					event.aggregateId,
				],
			);
		}
	},
};
