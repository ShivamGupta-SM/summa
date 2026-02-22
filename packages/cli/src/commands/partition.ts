// =============================================================================
// PARTITION COMMAND — Event store partitioning DDL generation & status
// =============================================================================
// Generates SQL for converting ledger_event to a PostgreSQL range-partitioned
// table. Does NOT auto-execute — outputs a SQL file for manual review.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { getConfig } from "../utils/get-config.js";

// =============================================================================
// PARTITION COMMAND
// =============================================================================

export const partitionCommand = new Command("partition")
	.description("Manage event store partitioning")
	.addCommand(generateSubCommand())
	.addCommand(statusSubCommand());

// =============================================================================
// GENERATE SUBCOMMAND
// =============================================================================

function generateSubCommand(): Command {
	return new Command("generate")
		.description("Generate SQL for partitioning ledger_event table")
		.option("--interval <interval>", "Partition interval (monthly|weekly)", "monthly")
		.option("--schema <schema>", "PostgreSQL schema name", "@summa-ledger/summa")
		.option("-o, --output <path>", "Output file path (default: auto-generated)")
		.action(async (options: { interval: string; schema: string; output?: string }) => {
			const parent = partitionCommand.parent;
			const cwd: string = parent?.opts().cwd ?? process.cwd();
			const configFlag: string | undefined = parent?.opts().config;

			p.intro(pc.bgCyan(pc.black(" summa partition generate ")));

			// Resolve schema from config if available
			let schema = options.schema;
			const config = await getConfig({ cwd, configPath: configFlag });
			if (config?.options) {
				if (typeof config.options.schema === "string" && config.options.schema.length > 0) {
					schema = config.options.schema;
				}
			}

			const interval = options.interval as "monthly" | "weekly";
			if (interval !== "monthly" && interval !== "weekly") {
				p.log.error(`${pc.red("Invalid interval:")} ${interval}. Use "monthly" or "weekly".`);
				p.outro(pc.dim("Aborted."));
				process.exitCode = 1;
				return;
			}

			const s = p.spinner();
			s.start("Generating partition DDL...");

			// Build the full migration SQL
			const lines: string[] = [];
			const q = (table: string) => (schema === "public" ? `"${table}"` : `"${schema}"."${table}"`);

			lines.push(
				"-- =============================================================================",
			);
			lines.push("-- SUMMA EVENT STORE PARTITIONING MIGRATION");
			lines.push(`-- Schema: ${schema}`);
			lines.push(`-- Interval: ${interval}`);
			lines.push(`-- Generated: ${new Date().toISOString()}`);
			lines.push(
				"-- =============================================================================",
			);
			lines.push("-- WARNING: Run during a maintenance window. Back up your data first.");
			lines.push("-- This script converts ledger_event to a range-partitioned table.");
			lines.push("--");
			lines.push("-- PostgreSQL requires that unique constraints on partitioned tables");
			lines.push("-- include the partition key column. Existing constraints are dropped and");
			lines.push("-- recreated with created_at included.");
			lines.push(
				"-- =============================================================================",
			);
			lines.push("");

			// Phase 1: Drop constraints that block partitioning
			lines.push("-- PHASE 1: Drop constraints incompatible with partitioning");
			lines.push(
				`ALTER TABLE ${q("ledger_event")} DROP CONSTRAINT IF EXISTS uq_ledger_event_aggregate_version;`,
			);
			lines.push(`ALTER INDEX IF EXISTS ${q("uq_ledger_event_aggregate_version")} CASCADE;`);
			lines.push(
				`ALTER TABLE ${q("ledger_event")} DROP CONSTRAINT IF EXISTS ledger_event_sequence_number_key;`,
			);
			lines.push(`DROP INDEX IF EXISTS ${q("idx_ledger_event_aggregate")};`);
			lines.push(`DROP INDEX IF EXISTS ${q("idx_ledger_event_correlation")};`);
			lines.push("");

			// Phase 2-5: Use generatePartitionDDL for rename + create + migrate
			let ddlStatements: string[];
			try {
				const summaDb = await import("@summa-ledger/summa/db" as string);
				ddlStatements = summaDb.generatePartitionDDL({
					schema,
					tables: {
						ledger_event: { type: "range", interval },
					},
				});
			} catch {
				p.log.error(
					`${pc.red("summa not installed")} ${pc.dim("run: pnpm add @summa-ledger/summa")}`,
				);
				p.outro(pc.dim("Aborted."));
				process.exitCode = 1;
				return;
			}
			lines.push("-- PHASE 2-5: Rename, create partitioned table, migrate data");
			for (const stmt of ddlStatements) {
				lines.push(stmt);
			}
			lines.push("");

			// Phase 6: Re-add constraints with partition key included
			lines.push("-- PHASE 6: Re-add constraints with created_at (partition key) included");
			lines.push(
				`CREATE UNIQUE INDEX uq_ledger_event_aggregate_version ON ${q("ledger_event")} (ledger_id, aggregate_type, aggregate_id, aggregate_version, created_at);`,
			);
			lines.push(
				`CREATE UNIQUE INDEX uq_ledger_event_sequence ON ${q("ledger_event")} (sequence_number, created_at);`,
			);
			lines.push(
				`CREATE INDEX idx_ledger_event_aggregate ON ${q("ledger_event")} (ledger_id, aggregate_type, aggregate_id);`,
			);
			lines.push(
				`CREATE INDEX idx_ledger_event_correlation ON ${q("ledger_event")} (ledger_id, correlation_id);`,
			);
			lines.push("");

			// Phase 7: Immutability trigger re-application
			lines.push("-- PHASE 7: Re-apply immutability trigger (auto-propagates to child partitions)");
			lines.push(`CREATE OR REPLACE FUNCTION "${schema}".prevent_update_delete()`);
			lines.push("RETURNS TRIGGER AS $$");
			lines.push("BEGIN");
			lines.push("  RAISE EXCEPTION 'Table %.% is immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME;");
			lines.push("  RETURN NULL;");
			lines.push("END;");
			lines.push("$$ LANGUAGE plpgsql;");
			lines.push("");
			lines.push(`DROP TRIGGER IF EXISTS trg_immutable_ledger_event ON ${q("ledger_event")};`);
			lines.push(`CREATE TRIGGER trg_immutable_ledger_event`);
			lines.push(`  BEFORE UPDATE OR DELETE ON ${q("ledger_event")}`);
			lines.push(`  FOR EACH ROW EXECUTE FUNCTION "${schema}".prevent_update_delete();`);
			lines.push("");

			// Phase 8: Cleanup note
			lines.push("-- PHASE 8: After verifying row counts match, drop old table:");
			lines.push(`-- DROP TABLE ${q("ledger_event_old")};`);

			const sql = lines.join("\n");

			// Write output
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const outputPath = options.output
				? resolve(cwd, options.output)
				: resolve(cwd, `summa_partition_ledger_event_${timestamp}.sql`);

			writeFileSync(outputPath, sql, "utf-8");
			s.stop(`${pc.green("Generated")} partition DDL`);

			p.log.info(`SQL written to: ${pc.cyan(outputPath)}`);
			p.log.warn(
				`${pc.yellow("Do NOT auto-execute.")} Review the SQL, back up your data, then run during a maintenance window.`,
			);
			p.outro(pc.green("Done."));
		});
}

// =============================================================================
// STATUS SUBCOMMAND
// =============================================================================

function statusSubCommand(): Command {
	return new Command("status")
		.description("Show current partition status for ledger_event")
		.option("--url <url>", "PostgreSQL connection URL (or set DATABASE_URL)")
		.option("--schema <schema>", "PostgreSQL schema name", "@summa-ledger/summa")
		.action(async (options: { url?: string; schema?: string }) => {
			const parent = partitionCommand.parent;
			const cwd: string = parent?.opts().cwd ?? process.cwd();
			const configFlag: string | undefined = parent?.opts().config;

			p.intro(pc.bgCyan(pc.black(" summa partition status ")));

			let configDbUrl: string | undefined;
			let schema = options.schema ?? "@summa-ledger/summa";
			const config = await getConfig({ cwd, configPath: configFlag });
			if (config?.options) {
				const db = config.options.database;
				if (typeof db === "object" && "connectionString" in db) {
					configDbUrl = db.connectionString as string;
				}
				if (typeof config.options.schema === "string" && config.options.schema.length > 0) {
					schema = config.options.schema;
				}
			}

			const dbUrl = options.url ?? configDbUrl ?? process.env.DATABASE_URL;
			if (!dbUrl) {
				p.log.error(`${pc.red("No DATABASE_URL")} ${pc.dim("set DATABASE_URL or use --url")}`);
				p.outro(pc.dim("Cannot check partition status without a database connection."));
				process.exitCode = 1;
				return;
			}

			let pg: typeof import("pg");
			try {
				pg = await import("pg");
			} catch {
				p.log.error(`${pc.red("pg not installed")} ${pc.dim("run: pnpm add -D pg")}`);
				p.outro(pc.dim("Install pg to connect to the database."));
				process.exitCode = 1;
				return;
			}

			const client = new pg.default.Client({ connectionString: dbUrl });

			try {
				await client.connect();

				const s = p.spinner();
				s.start("Checking partition status...");

				// Check if ledger_event is partitioned
				const isPartitioned = await client.query(
					`SELECT c.relkind
						 FROM pg_class c
						 JOIN pg_namespace n ON n.oid = c.relnamespace
						 WHERE n.nspname = $1 AND c.relname = 'ledger_event'`,
					[schema],
				);

				if (isPartitioned.rows.length === 0) {
					s.stop(`${pc.yellow("Table not found")} ledger_event does not exist in schema ${schema}`);
					p.outro(pc.dim("Run migrate push first."));
					return;
				}

				const relkind = isPartitioned.rows[0]?.relkind;
				if (relkind !== "p") {
					s.stop(
						`${pc.yellow("Not partitioned")} ledger_event is a regular table (relkind=${relkind})`,
					);
					p.log.info(`Run ${pc.cyan("npx summa partition generate")} to create partition DDL.`);
					p.outro(pc.dim("Done."));
					return;
				}

				// List child partitions
				const partitions = await client.query(
					`SELECT
							child.relname AS partition_name,
							pg_relation_size(child.oid) AS size_bytes,
							(SELECT reltuples::bigint FROM pg_class WHERE oid = child.oid) AS estimated_rows
						 FROM pg_inherits i
						 JOIN pg_class child ON child.oid = i.inhrelid
						 JOIN pg_class parent ON parent.oid = i.inhparent
						 JOIN pg_namespace n ON n.oid = parent.relnamespace
						 WHERE n.nspname = $1 AND parent.relname = 'ledger_event'
						 ORDER BY child.relname ASC`,
					[schema],
				);

				s.stop(
					`${pc.green("Partitioned")} ledger_event has ${partitions.rows.length} partition(s)`,
				);

				if (partitions.rows.length > 0) {
					p.log.info("");
					p.log.info(
						`${pc.bold(pc.dim("Partition".padEnd(40)))} ${pc.bold(pc.dim("Est. Rows".padStart(12)))} ${pc.bold(pc.dim("Size".padStart(10)))}`,
					);
					for (const row of partitions.rows) {
						const name = String(row.partition_name);
						const rows = Number(row.estimated_rows);
						const sizeBytes = Number(row.size_bytes);
						const sizeStr = formatBytes(sizeBytes);

						p.log.info(`  ${name.padEnd(38)} ${String(rows).padStart(12)} ${sizeStr.padStart(10)}`);
					}
				}

				p.outro(pc.green("Done."));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				p.log.error(`Connection failed: ${pc.dim(message)}`);
				process.exitCode = 1;
			} finally {
				await client.end().catch(() => {});
			}
		});
}

// =============================================================================
// HELPERS
// =============================================================================

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const value = bytes / 1024 ** i;
	return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
