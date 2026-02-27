// =============================================================================
// SCHEMA MERGER
// =============================================================================
// Merges core tables with plugin-contributed tables into a single schema map.

import type { SummaOptions, TableDefinition } from "@summa-ledger/core";

// Core tables that are always present
const CORE_TABLES: Record<string, TableDefinition> = {
	// Ledger registry — each ledger is an isolated tenant namespace.
	ledger: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			name: { type: "text", notNull: true },
			metadata: { type: "jsonb" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [{ name: "uq_ledger_name", columns: ["name"], unique: true }],
	},

	// UNIFIED ACCOUNT — merges user accounts + system accounts.
	// Mutable balance state updated in-place, protected by HMAC checksum.
	// Optimistic locking via UPDATE ... WHERE version = $expected.
	account: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			ledger_id: {
				type: "uuid",
				notNull: true,
				references: { table: "ledger", column: "id" },
			},
			holder_id: { type: "text", notNull: true },
			holder_type: { type: "text", notNull: true, default: "'individual'" },
			currency: { type: "text", notNull: true },
			is_system: { type: "boolean", notNull: true, default: "false" },
			system_identifier: { type: "text" },
			name: { type: "text" },
			account_type: { type: "text" },
			account_code: { type: "text" },
			parent_account_id: {
				type: "uuid",
				references: { table: "account", column: "id" },
			},
			normal_balance: { type: "text" },
			indicator: { type: "text" },
			allow_overdraft: { type: "boolean", notNull: true, default: "false" },
			overdraft_limit: { type: "bigint", notNull: true, default: "0" },
			metadata: { type: "jsonb" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
			// Mutable balance state — protected by HMAC checksum
			balance: { type: "bigint", notNull: true, default: "0" },
			credit_balance: { type: "bigint", notNull: true, default: "0" },
			debit_balance: { type: "bigint", notNull: true, default: "0" },
			pending_debit: { type: "bigint", notNull: true, default: "0" },
			pending_credit: { type: "bigint", notNull: true, default: "0" },
			version: { type: "integer", notNull: true, default: "0" },
			status: { type: "text", notNull: true, default: "'active'" },
			checksum: { type: "text" },
			freeze_reason: { type: "text" },
			frozen_at: { type: "timestamp" },
			frozen_by: { type: "text" },
			closed_at: { type: "timestamp" },
			closed_by: { type: "text" },
			closure_reason: { type: "text" },
		},
		indexes: [
			{ name: "idx_account_ledger", columns: ["ledger_id"] },
			{
				name: "uq_account_holder_currency",
				columns: ["ledger_id", "holder_id", "currency"],
				unique: true,
			},
			{ name: "idx_account_code", columns: ["ledger_id", "account_code"] },
			{ name: "idx_account_parent", columns: ["parent_account_id"] },
			{
				name: "uq_account_system_identifier",
				columns: ["ledger_id", "system_identifier"],
				unique: true,
			},
			{ name: "idx_account_is_system", columns: ["is_system"] },
		],
	},

	// TRANSFER — immutable transaction header with mutable status column.
	// Status transitions logged in entity_status_log.
	transfer: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			ledger_id: {
				type: "uuid",
				notNull: true,
				references: { table: "ledger", column: "id" },
			},
			type: { type: "text", notNull: true },
			status: { type: "text", notNull: true },
			reference: { type: "text", notNull: true },
			amount: { type: "bigint", notNull: true },
			currency: { type: "text", notNull: true },
			description: { type: "text" },
			source_account_id: {
				type: "uuid",
				references: { table: "account", column: "id" },
			},
			destination_account_id: {
				type: "uuid",
				references: { table: "account", column: "id" },
			},
			correlation_id: { type: "text" },
			metadata: { type: "jsonb" },
			is_hold: { type: "boolean", notNull: true, default: "false" },
			hold_expires_at: { type: "timestamp" },
			parent_id: {
				type: "uuid",
				references: { table: "transfer", column: "id" },
			},
			is_reversal: { type: "boolean", notNull: true, default: "false" },
			committed_amount: { type: "bigint" },
			refunded_amount: { type: "bigint" },
			effective_date: { type: "timestamp", notNull: true, default: "NOW()" },
			posted_at: { type: "timestamp" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_transfer_ledger", columns: ["ledger_id"] },
			{
				name: "uq_transfer_reference",
				columns: ["ledger_id", "reference"],
				unique: true,
			},
			{ name: "idx_transfer_type", columns: ["type"] },
			{ name: "idx_transfer_status", columns: ["status"] },
			{ name: "idx_transfer_created", columns: ["created_at"] },
			{ name: "idx_transfer_effective_date", columns: ["effective_date"] },
			{ name: "idx_transfer_source", columns: ["source_account_id"] },
			{ name: "idx_transfer_destination", columns: ["destination_account_id"] },
			{ name: "idx_transfer_hold_expires", columns: ["hold_expires_at"] },
			{ name: "idx_transfer_parent", columns: ["parent_id"] },
			{ name: "idx_transfer_is_hold", columns: ["is_hold"] },
			{ name: "idx_transfer_correlation", columns: ["correlation_id"] },
		],
	},

	// ENTRY — immutable double-entry journal lines with hash chain fields.
	// Entries ARE the event log. Per-account hash chains for tamper detection.
	entry: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			transfer_id: {
				type: "uuid",
				notNull: true,
				references: { table: "transfer", column: "id" },
			},
			account_id: {
				type: "uuid",
				notNull: true,
				references: { table: "account", column: "id" },
			},
			entry_type: { type: "text", notNull: true },
			amount: { type: "bigint", notNull: true },
			currency: { type: "text", notNull: true },
			balance_before: { type: "bigint" },
			balance_after: { type: "bigint" },
			account_version: { type: "integer" },
			// Hash chain fields — per-account tamper-proof chain
			sequence_number: { type: "bigint", notNull: true },
			hash: { type: "text", notNull: true },
			prev_hash: { type: "text" },
			// FX fields
			original_amount: { type: "bigint" },
			original_currency: { type: "text" },
			exchange_rate: { type: "bigint" },
			effective_date: { type: "timestamp", notNull: true, default: "NOW()" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_entry_transfer", columns: ["transfer_id"] },
			{ name: "idx_entry_account", columns: ["account_id"] },
			{ name: "idx_entry_account_created", columns: ["account_id", "created_at"] },
			{ name: "idx_entry_effective_date", columns: ["account_id", "effective_date"] },
			{
				name: "uq_entry_account_version",
				columns: ["account_id", "account_version"],
				unique: true,
			},
			{
				name: "uq_entry_sequence",
				columns: ["sequence_number"],
				unique: true,
			},
			{ name: "idx_entry_account_sequence", columns: ["account_id", "sequence_number"] },
		],
	},

	// APPEND-ONLY — shared status history for all entities.
	// Tracks transfer status transitions, account lifecycle changes, and plugin workflow states.
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
			entry_id: { type: "uuid" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "uq_merkle_node_block_level_position",
				columns: ["block_id", "level", "position"],
				unique: true,
			},
			{ name: "idx_merkle_node_block", columns: ["block_id"] },
			{ name: "idx_merkle_node_entry", columns: ["entry_id"] },
		],
	},

	// APPEND-ONLY — block-based hash chain checkpoints.
	blockCheckpoint: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			ledger_id: {
				type: "uuid",
				notNull: true,
				references: { table: "ledger", column: "id" },
			},
			block_sequence: { type: "bigint", notNull: true },
			from_entry_sequence: { type: "bigint", notNull: true },
			to_entry_sequence: { type: "bigint", notNull: true },
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
				columns: ["ledger_id", "block_sequence"],
				unique: true,
			},
			{ name: "idx_block_checkpoint_at", columns: ["block_at"] },
		],
	},

	idempotencyKey: {
		columns: {
			ledger_id: {
				type: "uuid",
				notNull: true,
				references: { table: "ledger", column: "id" },
			},
			key: { type: "text", notNull: true },
			response: { type: "jsonb", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
			expires_at: { type: "timestamp", notNull: true },
		},
		indexes: [
			{ name: "uq_idempotency_ledger_key", columns: ["ledger_id", "key"], unique: true },
			{ name: "idx_idempotency_expires", columns: ["expires_at"] },
		],
	},

	workerLease: {
		columns: {
			worker_id: { type: "text", primaryKey: true, notNull: true },
			lease_holder: { type: "text", notNull: true },
			lease_until: { type: "timestamp", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
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
