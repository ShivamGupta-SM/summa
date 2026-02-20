// =============================================================================
// SCHEMA MERGER
// =============================================================================
// Merges core tables with plugin-contributed tables into a single schema map.

import type { SummaOptions, TableDefinition } from "@summa/core";

// Core tables that are always present (8 tables)
const CORE_TABLES: Record<string, TableDefinition> = {
	ledgerEvent: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			aggregate_type: { type: "text", notNull: true },
			aggregate_id: { type: "uuid", notNull: true },
			event_type: { type: "text", notNull: true },
			event_data: { type: "jsonb", notNull: true },
			sequence_number: { type: "integer", notNull: true },
			previous_hash: { type: "text" },
			event_hash: { type: "text", notNull: true },
			correlation_id: { type: "text" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_ledger_event_aggregate", columns: ["aggregate_type", "aggregate_id"] },
			{ name: "idx_ledger_event_correlation", columns: ["correlation_id"] },
			{
				name: "uq_ledger_event_sequence",
				columns: ["aggregate_type", "aggregate_id", "sequence_number"],
				unique: true,
			},
		],
	},
	accountBalance: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			holder_id: { type: "text", notNull: true },
			holder_type: { type: "text", notNull: true, default: "'individual'" },
			currency: { type: "text", notNull: true },
			balance: { type: "bigint", notNull: true, default: "0" },
			available_balance: { type: "bigint", notNull: true, default: "0" },
			pending_debit: { type: "bigint", notNull: true, default: "0" },
			pending_credit: { type: "bigint", notNull: true, default: "0" },
			status: { type: "text", notNull: true, default: "'active'" },
			lock_version: { type: "integer", notNull: true, default: "1" },
			name: { type: "text" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
			updated_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "uq_account_holder_currency", columns: ["holder_id", "currency"], unique: true },
			{ name: "idx_account_status", columns: ["status"] },
		],
	},
	systemAccount: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			identifier: { type: "text", notNull: true },
			account_id: {
				type: "uuid",
				notNull: true,
				references: { table: "account_balance", column: "id" },
			},
			name: { type: "text", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [{ name: "uq_system_account_identifier", columns: ["identifier"], unique: true }],
	},
	transactionRecord: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			type: { type: "text", notNull: true },
			status: { type: "text", notNull: true },
			reference: { type: "text", notNull: true },
			amount: { type: "bigint", notNull: true },
			currency: { type: "text", notNull: true },
			description: { type: "text" },
			metadata: { type: "jsonb" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
			posted_at: { type: "timestamp" },
		},
		indexes: [
			{ name: "uq_transaction_reference", columns: ["reference"], unique: true },
			{ name: "idx_transaction_status", columns: ["status"] },
			{ name: "idx_transaction_created", columns: ["created_at"] },
		],
	},
	entryRecord: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			transaction_id: {
				type: "uuid",
				notNull: true,
				references: { table: "transaction_record", column: "id" },
			},
			account_id: {
				type: "uuid",
				notNull: true,
				references: { table: "account_balance", column: "id" },
			},
			entry_type: { type: "text", notNull: true },
			amount: { type: "bigint", notNull: true },
			balance_after: { type: "bigint", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_entry_transaction", columns: ["transaction_id"] },
			{ name: "idx_entry_account", columns: ["account_id"] },
		],
	},
	idempotencyKey: {
		columns: {
			key: { type: "text", primaryKey: true, notNull: true },
			response: { type: "jsonb", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
			expires_at: { type: "timestamp", notNull: true },
		},
		indexes: [{ name: "idx_idempotency_expires", columns: ["expires_at"] }],
	},
	workerLease: {
		columns: {
			worker_id: { type: "text", primaryKey: true, notNull: true },
			lease_holder: { type: "text", notNull: true },
			lease_until: { type: "timestamp", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
	},
	processedEvent: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			event_id: { type: "uuid", notNull: true },
			topic: { type: "text", notNull: true },
			payload: { type: "jsonb" },
			processed_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [{ name: "uq_processed_event", columns: ["event_id", "topic"], unique: true }],
	},
};

/**
 * Returns the full schema definition for all Summa tables (core + plugins).
 * This can be used by CLI tools, migration generators, and adapters to
 * understand the complete set of tables needed.
 */
export function getSummaTables(
	options?: Pick<SummaOptions, "plugins">,
): Record<string, TableDefinition> {
	const pluginTables: Record<string, TableDefinition> = {};

	for (const plugin of options?.plugins ?? []) {
		if (plugin.schema) {
			for (const [tableName, tableDef] of Object.entries(plugin.schema)) {
				if (pluginTables[tableName] || CORE_TABLES[tableName]) {
					throw new Error(
						`Table "${tableName}" is already defined. Plugin "${plugin.id}" cannot override it.`,
					);
				}
				pluginTables[tableName] = tableDef;
			}
		}
	}

	return { ...CORE_TABLES, ...pluginTables };
}

/** Returns only the core tables (without plugin tables). */
export function getCoreTables(): Record<string, TableDefinition> {
	return { ...CORE_TABLES };
}
