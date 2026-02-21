// =============================================================================
// SCHEMA MERGER
// =============================================================================
// Merges core tables with plugin-contributed tables into a single schema map.

import type { SummaOptions, TableDefinition } from "@summa/core";

// Core tables that are always present
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
	// IMMUTABLE after insert — static properties only.
	// All mutable state (balance, status, etc.) lives in account_balance_version.
	accountBalance: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			holder_id: { type: "text", notNull: true },
			holder_type: { type: "text", notNull: true, default: "'individual'" },
			currency: { type: "text", notNull: true },
			allow_overdraft: { type: "boolean", notNull: true, default: "false" },
			overdraft_limit: { type: "bigint", notNull: true, default: "0" },
			account_type: { type: "text" },
			account_code: { type: "text" },
			parent_account_id: {
				type: "uuid",
				references: { table: "account_balance", column: "id" },
			},
			normal_balance: { type: "text" },
			indicator: { type: "text" },
			name: { type: "text" },
			metadata: { type: "jsonb" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
			// Denormalized balance cache — opt-in via advanced.useDenormalizedBalance.
			// Updated atomically in the same transaction as account_balance_version inserts.
			// Eliminates LATERAL JOIN for balance reads when enabled.
			cached_balance: { type: "bigint", default: "0" },
			cached_credit_balance: { type: "bigint", default: "0" },
			cached_debit_balance: { type: "bigint", default: "0" },
			cached_pending_debit: { type: "bigint", default: "0" },
			cached_pending_credit: { type: "bigint", default: "0" },
			cached_version: { type: "integer", default: "0" },
			cached_status: { type: "text", default: "'active'" },
			cached_checksum: { type: "text" },
			cached_freeze_reason: { type: "text" },
			cached_frozen_at: { type: "timestamp" },
			cached_frozen_by: { type: "text" },
			cached_closed_at: { type: "timestamp" },
			cached_closed_by: { type: "text" },
			cached_closure_reason: { type: "text" },
		},
		indexes: [
			{ name: "uq_account_holder_currency", columns: ["holder_id", "currency"], unique: true },
			{ name: "idx_account_code", columns: ["account_code"] },
			{ name: "idx_account_parent", columns: ["parent_account_id"] },
		],
	},
	// APPEND-ONLY — each row is a complete state snapshot at a point in time.
	// Current state = latest version row for a given account_id.
	accountBalanceVersion: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			account_id: {
				type: "uuid",
				notNull: true,
				references: { table: "account_balance", column: "id" },
			},
			version: { type: "integer", notNull: true },
			balance: { type: "bigint", notNull: true, default: "0" },
			credit_balance: { type: "bigint", notNull: true, default: "0" },
			debit_balance: { type: "bigint", notNull: true, default: "0" },
			pending_credit: { type: "bigint", notNull: true, default: "0" },
			pending_debit: { type: "bigint", notNull: true, default: "0" },
			status: { type: "text", notNull: true, default: "'active'" },
			checksum: { type: "text" },
			freeze_reason: { type: "text" },
			frozen_at: { type: "timestamp" },
			frozen_by: { type: "text" },
			closed_at: { type: "timestamp" },
			closed_by: { type: "text" },
			closure_reason: { type: "text" },
			change_type: { type: "text", notNull: true },
			caused_by_event_id: { type: "uuid" },
			caused_by_transaction_id: { type: "uuid" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "uq_account_balance_version",
				columns: ["account_id", "version"],
				unique: true,
			},
			{
				name: "idx_account_balance_version_latest",
				columns: ["account_id", "version"],
			},
			{ name: "idx_account_balance_version_status", columns: ["status"] },
			{ name: "idx_account_balance_version_created", columns: ["created_at"] },
		],
	},
	// IMMUTABLE after insert — static properties only.
	// Balance state lives in system_account_version (updated via hot accounts batching).
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
			currency: { type: "text", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [{ name: "uq_system_account_identifier", columns: ["identifier"], unique: true }],
	},
	// APPEND-ONLY — each row is a balance snapshot for a system account.
	systemAccountVersion: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			account_id: {
				type: "uuid",
				notNull: true,
				references: { table: "system_account", column: "id" },
			},
			version: { type: "integer", notNull: true },
			balance: { type: "bigint", notNull: true, default: "0" },
			credit_balance: { type: "bigint", notNull: true, default: "0" },
			debit_balance: { type: "bigint", notNull: true, default: "0" },
			change_type: { type: "text", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "uq_system_account_version",
				columns: ["account_id", "version"],
				unique: true,
			},
			{
				name: "idx_system_account_version_latest",
				columns: ["account_id", "version"],
			},
		],
	},
	// IMMUTABLE after insert — core transaction data never changes.
	// Status lifecycle lives in transaction_status table.
	transactionRecord: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			type: { type: "text", notNull: true },
			reference: { type: "text", notNull: true },
			amount: { type: "bigint", notNull: true },
			currency: { type: "text", notNull: true },
			description: { type: "text" },
			metadata: { type: "jsonb" },
			source_account_id: { type: "uuid" },
			destination_account_id: { type: "uuid" },
			source_system_account_id: { type: "uuid" },
			destination_system_account_id: { type: "uuid" },
			is_hold: { type: "boolean", notNull: true, default: "false" },
			hold_expires_at: { type: "timestamp" },
			parent_id: { type: "uuid" },
			is_reversal: { type: "boolean", notNull: true, default: "false" },
			correlation_id: { type: "text" },
			meta_data: { type: "jsonb" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "uq_transaction_reference", columns: ["reference"], unique: true },
			{ name: "idx_transaction_type", columns: ["type"] },
			{ name: "idx_transaction_created", columns: ["created_at"] },
			{ name: "idx_transaction_source", columns: ["source_account_id"] },
			{ name: "idx_transaction_destination", columns: ["destination_account_id"] },
			{ name: "idx_transaction_hold_expires", columns: ["hold_expires_at"] },
			{ name: "idx_transaction_parent", columns: ["parent_id"] },
			{ name: "idx_transaction_is_hold", columns: ["is_hold"] },
		],
	},
	// APPEND-ONLY — each status transition creates a new row.
	// Current status = latest row for a given transaction_id.
	transactionStatus: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			transaction_id: {
				type: "uuid",
				notNull: true,
				references: { table: "transaction_record", column: "id" },
			},
			status: { type: "text", notNull: true },
			committed_amount: { type: "bigint" },
			refunded_amount: { type: "bigint" },
			posted_at: { type: "timestamp" },
			reason: { type: "text" },
			caused_by_event_id: { type: "uuid" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "idx_transaction_status_latest",
				columns: ["transaction_id", "created_at"],
			},
			{ name: "idx_transaction_status_status", columns: ["status"] },
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
			{ name: "idx_entry_account_created", columns: ["account_id", "created_at"] },
		],
	},
	// APPEND-ONLY — shared status history for all plugin workflow entities.
	// Every status transition across all plugins creates a new row.
	entityStatusLog: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			entity_type: { type: "text", notNull: true },
			entity_id: { type: "uuid", notNull: true },
			status: { type: "text", notNull: true },
			previous_status: { type: "text" },
			reason: { type: "text" },
			metadata: { type: "jsonb" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "idx_entity_status_log_latest",
				columns: ["entity_type", "entity_id", "created_at"],
			},
			{ name: "idx_entity_status_log_type", columns: ["entity_type"] },
		],
	},
	// APPEND-ONLY — Merkle tree nodes for block-level cryptographic proofs.
	// Each block checkpoint builds a Merkle tree; nodes are stored here.
	merkleNode: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			block_id: {
				type: "uuid",
				notNull: true,
				references: { table: "block_checkpoint", column: "id" },
			},
			level: { type: "integer", notNull: true },
			position: { type: "integer", notNull: true },
			hash: { type: "text", notNull: true },
			left_child_id: { type: "uuid" },
			right_child_id: { type: "uuid" },
			event_id: { type: "uuid" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "uq_merkle_node_block_level_position",
				columns: ["block_id", "level", "position"],
				unique: true,
			},
			{ name: "idx_merkle_node_block", columns: ["block_id"] },
			{ name: "idx_merkle_node_event", columns: ["event_id"] },
		],
	},
	// APPEND-ONLY — block-based hash chain checkpoints.
	// Each block covers a range of events and chains to the previous block.
	blockCheckpoint: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			block_sequence: { type: "bigint", notNull: true },
			from_event_sequence: { type: "bigint", notNull: true },
			to_event_sequence: { type: "bigint", notNull: true },
			event_count: { type: "integer", notNull: true },
			events_hash: { type: "text", notNull: true },
			block_hash: { type: "text", notNull: true },
			merkle_root: { type: "text" },
			tree_depth: { type: "integer" },
			prev_block_id: { type: "uuid" },
			prev_block_hash: { type: "text" },
			block_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "uq_block_checkpoint_sequence",
				columns: ["block_sequence"],
				unique: true,
			},
			{ name: "idx_block_checkpoint_at", columns: ["block_at"] },
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
	summaMigration: {
		columns: {
			id: { type: "serial", primaryKey: true, notNull: true },
			name: { type: "text", notNull: true },
			hash: { type: "text", notNull: true },
			applied_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [{ name: "uq_summa_migration_name", columns: ["name"], unique: true }],
	},
	rateLimitLog: {
		columns: {
			id: { type: "serial", primaryKey: true, notNull: true },
			key: { type: "text", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [{ name: "idx_rate_limit_log_key_created", columns: ["key", "created_at"] }],
	},
};

/**
 * Returns the full schema definition for all Summa tables (core + plugins).
 * This can be used by CLI tools, migration generators, and adapters to
 * understand the complete set of tables needed.
 *
 * Plugins can contribute new tables or extend existing ones by setting
 * `extend: true` on their table definition. Extended tables merge columns
 * and indexes into the existing definition. Column name collisions throw.
 */
export function getSummaTables(
	options?: Pick<SummaOptions, "plugins">,
): Record<string, TableDefinition> {
	// Deep clone core tables so plugins don't mutate the original
	const merged: Record<string, TableDefinition> = {};
	for (const [name, def] of Object.entries(CORE_TABLES)) {
		merged[name] = {
			columns: { ...def.columns },
			indexes: def.indexes ? [...def.indexes] : undefined,
		};
	}

	const pluginNewTables: Record<string, TableDefinition> = {};

	for (const plugin of options?.plugins ?? []) {
		if (!plugin.schema) continue;

		for (const [tableName, tableDef] of Object.entries(plugin.schema)) {
			if (tableDef.extend) {
				// Extension mode: merge columns/indexes into existing table
				const target = merged[tableName] ?? pluginNewTables[tableName];
				if (!target) {
					throw new Error(
						`Plugin "${plugin.id}" tries to extend table "${tableName}" but it does not exist.`,
					);
				}

				// Check for column name collisions
				for (const colName of Object.keys(tableDef.columns)) {
					if (target.columns[colName]) {
						throw new Error(
							`Plugin "${plugin.id}" tries to add column "${colName}" to table "${tableName}" but it already exists.`,
						);
					}
				}

				// Merge columns and indexes
				Object.assign(target.columns, tableDef.columns);
				if (tableDef.indexes) {
					target.indexes = [...(target.indexes ?? []), ...tableDef.indexes];
				}
			} else {
				// Creation mode: new table
				if (pluginNewTables[tableName] || merged[tableName]) {
					throw new Error(
						`Table "${tableName}" is already defined. Plugin "${plugin.id}" cannot override it.`,
					);
				}
				pluginNewTables[tableName] = tableDef;
			}
		}
	}

	return { ...merged, ...pluginNewTables };
}

/** Returns only the core tables (without plugin tables). */
export function getCoreTables(): Record<string, TableDefinition> {
	return { ...CORE_TABLES };
}
