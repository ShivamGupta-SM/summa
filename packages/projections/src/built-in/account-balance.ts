// =============================================================================
// ACCOUNT BALANCE PROJECTION
// =============================================================================
// Maintains a denormalized projection_account_balance table from
// TransactionPosted events. Provides fast balance lookups without
// hitting the primary event store.

import type { StoredEvent, SummaContext, TableDefinition } from "@summa/core";
import type { SummaTransactionAdapter } from "@summa/core/db";
import { createTableResolver } from "@summa/core/db";
import type { Projection } from "../types.js";

// =============================================================================
// SCHEMA
// =============================================================================

export const accountBalanceProjectionSchema: Record<string, TableDefinition> = {
	projection_account_balance: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			account_id: { type: "text", notNull: true },
			ledger_id: { type: "text", notNull: true },
			balance: { type: "bigint", notNull: true, default: "0" },
			last_event_sequence: { type: "bigint", notNull: true, default: "0" },
			updated_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "uq_proj_account_balance_account",
				columns: ["ledger_id", "account_id"],
				unique: true,
			},
		],
	},
};

// =============================================================================
// PROJECTION
// =============================================================================

export const AccountBalanceProjection: Projection = {
	id: "account-balance",
	description: "Maintains denormalized account balances from TransactionPosted events",
	eventTypes: ["TransactionPosted"],

	async handleEvent(
		event: StoredEvent,
		tx: SummaTransactionAdapter,
		ctx: SummaContext,
	): Promise<void> {
		const t = createTableResolver(ctx.options.schema);
		const d = ctx.dialect;
		const data = event.eventData as {
			entries?: Array<{
				accountId: string;
				entryType: "DEBIT" | "CREDIT";
				amount: number;
				balanceAfter: number;
			}>;
		};

		if (!data.entries || !Array.isArray(data.entries)) return;

		// Extract ledger_id from the event's aggregate context
		const ledgerId = event.eventData.ledgerId as string | undefined;

		for (const entry of data.entries) {
			// Upsert balance — idempotent via sequence number check
			await tx.raw(
				`INSERT INTO ${t("projection_account_balance")} (id, account_id, ledger_id, balance, last_event_sequence, updated_at)
				 VALUES (${d.generateUuid()}, $1, $2, $3, $4, ${d.now()})
				 ON CONFLICT (ledger_id, account_id)
				 DO UPDATE SET
					balance = $3,
					last_event_sequence = $4,
					updated_at = ${d.now()}
				 WHERE ${t("projection_account_balance")}.last_event_sequence < $4`,
				[entry.accountId, ledgerId ?? "", entry.balanceAfter, event.sequenceNumber],
			);
		}
	},
};
