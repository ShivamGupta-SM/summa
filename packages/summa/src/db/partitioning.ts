// =============================================================================
// TABLE PARTITIONING HELPERS
// =============================================================================
// Generates DDL for converting Summa tables to PostgreSQL range-partitioned
// tables and provides a plugin for automated partition maintenance.
//
// Users must run the initial conversion DDL themselves (one-time migration).
// The maintenance plugin creates future partitions ahead of time and optionally
// detaches old ones.

import type { SummaContext, SummaPlugin } from "@summa/core";
import { createTableResolver } from "@summa/core/db";

// =============================================================================
// TYPES
// =============================================================================

export type PartitionInterval = "daily" | "weekly" | "monthly";

export interface PartitionTableConfig {
	/** Partition strategy. Currently only range on created_at is supported. */
	type: "range";
	/** Column to partition on. Default: "created_at" */
	column?: string;
	/** Partition interval. */
	interval: PartitionInterval;
}

export interface PartitionDDLOptions {
	/** PostgreSQL schema name. Default: "summa" */
	schema?: string;
	/** Table configurations. Key = SQL table name (snake_case). */
	tables: Record<string, PartitionTableConfig>;
}

export interface PartitionMaintenanceOptions {
	/** Tables to manage partitions for. Key = SQL table name (snake_case). */
	tables: Record<string, { interval: PartitionInterval }>;
	/** Create partitions this many intervals ahead. Default: 3 */
	createAhead?: number;
	/** Detach partitions older than this many intervals. Null = never detach. Default: null */
	retainPartitions?: number | null;
	/** How often the maintenance worker runs. Default: "1d" */
	workerInterval?: string;
	/** PostgreSQL schema. Default: "summa" */
	schema?: string;
}

// =============================================================================
// DDL GENERATION
// =============================================================================

/**
 * Generate DDL statements for converting existing Summa tables to partitioned tables.
 *
 * WARNING: This is a destructive migration. Users should:
 * 1. Back up the database
 * 2. Run these statements during a maintenance window
 * 3. Test thoroughly before enabling in production
 *
 * Returns an array of SQL statements to execute in order.
 */
export function generatePartitionDDL(options: PartitionDDLOptions): string[] {
	const schema = options.schema ?? "summa";
	const statements: string[] = [];

	statements.push(`-- Summa Table Partitioning DDL`);
	statements.push(`-- Generated for schema: ${schema}`);
	statements.push(`-- WARNING: Run during maintenance window. Back up data first.`);
	statements.push(``);

	for (const [tableName, config] of Object.entries(options.tables)) {
		const col = config.column ?? "created_at";
		const qualifiedName = `"${schema}"."${tableName}"`;
		const tempName = `"${schema}"."${tableName}_old"`;

		statements.push(`-- === ${tableName} (${config.interval} partitions on ${col}) ===`);

		// Step 1: Rename existing table
		statements.push(`ALTER TABLE ${qualifiedName} RENAME TO "${tableName}_old";`);

		// Step 2: Create new partitioned table with same structure
		statements.push(
			`CREATE TABLE ${qualifiedName} (LIKE ${tempName} INCLUDING ALL) PARTITION BY RANGE (${col});`,
		);

		// Step 3: Create initial partitions for current + next periods
		const now = new Date();
		const partitions = generatePartitionRanges(tableName, config.interval, now, 3);
		for (const p of partitions) {
			statements.push(
				`CREATE TABLE ${partitionTableName(schema, tableName, p.suffix)} PARTITION OF ${qualifiedName} FOR VALUES FROM ('${p.from}') TO ('${p.to}');`,
			);
		}

		// Step 4: Create a default partition for data outside defined ranges
		statements.push(
			`CREATE TABLE "${schema}"."${tableName}_default" PARTITION OF ${qualifiedName} DEFAULT;`,
		);

		// Step 5: Migrate data
		statements.push(`INSERT INTO ${qualifiedName} SELECT * FROM ${tempName};`);

		// Step 6: Drop old table (user should verify data first)
		statements.push(`-- Verify data, then: DROP TABLE ${tempName};`);
		statements.push(``);
	}

	return statements;
}

// =============================================================================
// PARTITION MAINTENANCE PLUGIN
// =============================================================================

/**
 * Plugin that automatically creates future partitions and optionally detaches old ones.
 * Run alongside your Summa instance to prevent partition exhaustion.
 */
export function partitionMaintenance(options: PartitionMaintenanceOptions): SummaPlugin {
	const createAhead = options.createAhead ?? 3;
	const retainPartitions = options.retainPartitions ?? null;
	const workerInterval = options.workerInterval ?? "1d";
	const schema = options.schema ?? "summa";

	return {
		id: "partition-maintenance",

		workers: [
			{
				id: "partition-maintenance-worker",
				description: "Create future partitions and optionally detach old ones",
				interval: workerInterval,
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const now = new Date();
					let created = 0;
					let detached = 0;

					for (const [tableName, config] of Object.entries(options.tables)) {
						// Create future partitions
						const futureRanges = generatePartitionRanges(
							tableName,
							config.interval,
							now,
							createAhead,
						);
						for (const range of futureRanges) {
							const partName = partitionTableName(schema, tableName, range.suffix);
							try {
								// Use IF NOT EXISTS pattern via checking pg_class
								const exists = await ctx.adapter.raw<{ cnt: number }>(
									`SELECT COUNT(*)::int AS cnt FROM pg_class c
									 JOIN pg_namespace n ON n.oid = c.relnamespace
									 WHERE n.nspname = $1 AND c.relname = $2`,
									[schema, `${tableName}_${range.suffix}`],
								);
								if (exists[0] && exists[0].cnt === 0) {
									await ctx.adapter.raw(
										`CREATE TABLE ${partName} PARTITION OF ${t(tableName)} FOR VALUES FROM ('${range.from}') TO ('${range.to}')`,
										[],
									);
									created++;
									ctx.logger.info("Partition created", {
										table: tableName,
										partition: range.suffix,
									});
								}
							} catch (err) {
								ctx.logger.error("Failed to create partition", {
									table: tableName,
									partition: range.suffix,
									error: err instanceof Error ? err.message : String(err),
								});
							}
						}

						// Detach old partitions if configured
						if (retainPartitions != null) {
							const oldRanges = generatePartitionRanges(
								tableName,
								config.interval,
								shiftDate(now, config.interval, -retainPartitions),
								1,
							);
							for (const range of oldRanges) {
								const partName = partitionTableName(schema, tableName, range.suffix);
								try {
									const exists = await ctx.adapter.raw<{ cnt: number }>(
										`SELECT COUNT(*)::int AS cnt FROM pg_class c
										 JOIN pg_namespace n ON n.oid = c.relnamespace
										 WHERE n.nspname = $1 AND c.relname = $2`,
										[schema, `${tableName}_${range.suffix}`],
									);
									if (exists[0] && exists[0].cnt > 0) {
										await ctx.adapter.raw(
											`ALTER TABLE ${t(tableName)} DETACH PARTITION ${partName}`,
											[],
										);
										detached++;
										ctx.logger.info("Partition detached", {
											table: tableName,
											partition: range.suffix,
										});
									}
								} catch (err) {
									ctx.logger.error("Failed to detach partition", {
										table: tableName,
										partition: range.suffix,
										error: err instanceof Error ? err.message : String(err),
									});
								}
							}
						}
					}

					if (created > 0 || detached > 0) {
						ctx.logger.info("Partition maintenance completed", { created, detached });
					}
				},
			},
		],
	};
}

// =============================================================================
// HELPERS
// =============================================================================

interface PartitionRange {
	suffix: string;
	from: string;
	to: string;
}

function generatePartitionRanges(
	_tableName: string,
	interval: PartitionInterval,
	startDate: Date,
	count: number,
): PartitionRange[] {
	const ranges: PartitionRange[] = [];

	for (let i = 0; i < count; i++) {
		const current = shiftDate(startDate, interval, i);
		const next = shiftDate(startDate, interval, i + 1);

		const from = formatDateForPartition(current, interval);
		const to = formatDateForPartition(next, interval);
		const suffix = formatPartitionSuffix(current, interval);

		ranges.push({ suffix, from, to });
	}

	return ranges;
}

function shiftDate(date: Date, interval: PartitionInterval, offset: number): Date {
	const d = new Date(date);
	switch (interval) {
		case "daily":
			d.setUTCDate(d.getUTCDate() + offset);
			break;
		case "weekly":
			d.setUTCDate(d.getUTCDate() + offset * 7);
			break;
		case "monthly":
			d.setUTCMonth(d.getUTCMonth() + offset);
			d.setUTCDate(1); // Normalize to first of month
			break;
	}
	return d;
}

function formatDateForPartition(date: Date, interval: PartitionInterval): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, "0");
	const d = String(date.getUTCDate()).padStart(2, "0");

	switch (interval) {
		case "daily":
			return `${y}-${m}-${d}`;
		case "weekly":
			return `${y}-${m}-${d}`;
		case "monthly":
			return `${y}-${m}-01`;
	}
}

function formatPartitionSuffix(date: Date, interval: PartitionInterval): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, "0");
	const d = String(date.getUTCDate()).padStart(2, "0");

	switch (interval) {
		case "daily":
			return `${y}_${m}_${d}`;
		case "weekly":
			return `${y}_w${getISOWeek(date)}`;
		case "monthly":
			return `${y}_${m}`;
	}
}

function partitionTableName(schema: string, table: string, suffix: string): string {
	return `"${schema}"."${table}_${suffix}"`;
}

function getISOWeek(date: Date): string {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
	return String(weekNo).padStart(2, "0");
}
