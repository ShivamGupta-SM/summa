import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import type { ColumnDefinition, TableDefinition } from "@summa/core";
import { Command } from "commander";
import pc from "picocolors";
import { getConfig } from "../utils/get-config.js";

// =============================================================================
// SQL GENERATION HELPERS
// =============================================================================

function toSnakeCase(str: string): string {
	return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function pgType(col: ColumnDefinition): string {
	switch (col.type) {
		case "uuid":
			return "UUID";
		case "text":
			return "TEXT";
		case "bigint":
			return "BIGINT";
		case "integer":
			return "INTEGER";
		case "boolean":
			return "BOOLEAN";
		case "timestamp":
			return "TIMESTAMPTZ";
		case "jsonb":
			return "JSONB";
		case "serial":
			return "SERIAL";
		case "tsvector":
			return "TSVECTOR";
		default:
			return "TEXT";
	}
}

function columnSQL(colName: string, col: ColumnDefinition, schema: string): string {
	const parts = [colName, pgType(col)];
	if (col.primaryKey) parts.push("PRIMARY KEY");
	if (col.notNull && !col.primaryKey) parts.push("NOT NULL");
	if (col.default) {
		const def = col.default === "NOW()" ? "NOW()" : col.default;
		parts.push(`DEFAULT ${def}`);
	}
	if (col.references) {
		const refTable = qualifyTable(schema, toSnakeCase(col.references.table));
		parts.push(`REFERENCES ${refTable}(${col.references.column})`);
	}
	return `  ${parts.join(" ")}`;
}

function qualifyTable(schema: string, tableName: string): string {
	if (schema === "public") return `"${tableName}"`;
	return `"${schema}"."${tableName}"`;
}

function createTableSQL(tableName: string, def: TableDefinition, schema: string): string {
	const sqlTableName = toSnakeCase(tableName);
	const qualified = qualifyTable(schema, sqlTableName);
	const colLines: string[] = [];

	for (const [colName, col] of Object.entries(def.columns)) {
		colLines.push(columnSQL(colName, col, schema));
	}

	let sql = `CREATE TABLE IF NOT EXISTS ${qualified} (\n${colLines.join(",\n")}\n);\n`;

	if (def.indexes) {
		for (const idx of def.indexes) {
			const cols = idx.columns.join(", ");
			const kind = idx.unique ? "UNIQUE INDEX" : "INDEX";
			const using = idx.using ? ` USING ${idx.using}` : "";
			const qualifiedIdx = schema === "public" ? idx.name : `"${schema}".${idx.name}`;
			sql += `CREATE ${kind} IF NOT EXISTS ${qualifiedIdx} ON ${qualified}${using} (${cols});\n`;
		}
	}

	return sql;
}

function dropTableSQL(tableName: string, schema: string): string {
	return `DROP TABLE IF EXISTS ${qualifyTable(schema, toSnakeCase(tableName))} CASCADE;\n`;
}

function dropIndexSQL(indexName: string, schema: string): string {
	const qualified = schema === "public" ? indexName : `"${schema}".${indexName}`;
	return `DROP INDEX IF EXISTS ${qualified};\n`;
}

// =============================================================================
// IMMUTABILITY TRIGGERS — Last line of defense for financial data
// =============================================================================

/** Tables that MUST NOT allow UPDATE or DELETE at the DB level. */
const IMMUTABLE_TABLES: ReadonlySet<string> = new Set([
	"account_balance",
	"account_balance_version",
	"transaction_record",
	"transaction_status",
	"entry_record",
	"ledger_event",
	"block_checkpoint",
	"merkle_node",
	"entity_status_log",
	"system_account",
	"system_account_version",
]);

/**
 * Tables that allow UPDATE on specific columns (e.g., denormalized cache columns).
 * The trigger function checks that only allowed columns change; immutable columns
 * (those NOT in this list) raise an exception if modified.
 */
const ACCOUNT_BALANCE_IMMUTABLE_COLUMNS = [
	"id",
	"ledger_id",
	"holder_id",
	"holder_type",
	"currency",
	"allow_overdraft",
	"overdraft_limit",
	"account_type",
	"account_code",
	"parent_account_id",
	"normal_balance",
	"indicator",
	"name",
	"metadata",
	"created_at",
] as const;

/**
 * Generate SQL to create immutability enforcement triggers.
 * These triggers prevent UPDATE and DELETE on financial tables at the DB level,
 * serving as the last line of defense even if application code has bugs.
 *
 * account_balance uses a special trigger that allows UPDATE of cached_* columns
 * (denormalized balance cache) while protecting all immutable columns.
 */
function immutabilityTriggersSQL(schema: string): string {
	const parts: string[] = [];

	// Create the shared trigger function (full immutability — no updates allowed)
	parts.push(`
CREATE OR REPLACE FUNCTION "${schema}".prevent_update_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Table %.% is immutable — UPDATE and DELETE are not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;`);

	// Create a column-aware trigger for account_balance that allows cached_* column updates
	// but protects all immutable columns (id, holder_id, currency, etc.)
	const colChecks = ACCOUNT_BALANCE_IMMUTABLE_COLUMNS.map(
		(col) => `    OLD.${col} IS DISTINCT FROM NEW.${col}`,
	).join(" OR\n");

	parts.push(`
CREATE OR REPLACE FUNCTION "${schema}".prevent_account_balance_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Table %.% is immutable — DELETE is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME;
    RETURN NULL;
  END IF;
  -- Allow UPDATE only if immutable columns are unchanged (cached_* columns may change)
  IF
${colChecks}
  THEN
    RAISE EXCEPTION 'Table %.% immutable columns cannot be modified — only cached_* columns may be updated', TG_TABLE_SCHEMA, TG_TABLE_NAME;
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`);

	// Create triggers for each immutable table
	for (const tableName of IMMUTABLE_TABLES) {
		const qualified = qualifyTable(schema, tableName);
		const triggerName = `trg_immutable_${tableName}`;

		if (tableName === "account_balance") {
			// Use column-aware trigger for account_balance
			parts.push(`
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name = '${tableName}') THEN
    DROP TRIGGER IF EXISTS ${triggerName} ON ${qualified};
    CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OR DELETE ON ${qualified}
      FOR EACH ROW
      EXECUTE FUNCTION "${schema}".prevent_account_balance_mutation();
  END IF;
END $$;`);
		} else {
			parts.push(`
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name = '${tableName}') THEN
    DROP TRIGGER IF EXISTS ${triggerName} ON ${qualified};
    CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OR DELETE ON ${qualified}
      FOR EACH ROW
      EXECUTE FUNCTION "${schema}".prevent_update_delete();
  END IF;
END $$;`);
		}
	}

	return parts.join("\n");
}

interface MigrationPlan {
	tablesToCreate: Array<{ name: string; sqlName: string; def: TableDefinition }>;
	tablesToAlter: Array<{
		name: string;
		sqlName: string;
		columnsToAdd: Array<{ name: string; col: ColumnDefinition }>;
	}>;
	indexesToCreate: Array<{ sql: string; name: string }>;
}

async function buildMigrationPlan(
	client: import("pg").Client,
	tables: Record<string, TableDefinition>,
	schema: string,
): Promise<MigrationPlan> {
	const plan: MigrationPlan = {
		tablesToCreate: [],
		tablesToAlter: [],
		indexesToCreate: [],
	};

	for (const [tableName, def] of Object.entries(tables)) {
		const sqlName = toSnakeCase(tableName);

		const tableExists = await client.query(
			`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
			[schema, sqlName],
		);

		if (tableExists.rows.length === 0) {
			plan.tablesToCreate.push({ name: tableName, sqlName, def });
		} else {
			const existingCols = await client.query(
				`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
				[schema, sqlName],
			);
			const existingColNames = new Set(existingCols.rows.map((r) => String(r.column_name)));

			const columnsToAdd: Array<{ name: string; col: ColumnDefinition }> = [];
			for (const [colName, col] of Object.entries(def.columns)) {
				if (!existingColNames.has(colName)) {
					columnsToAdd.push({ name: colName, col });
				}
			}

			if (columnsToAdd.length > 0) {
				plan.tablesToAlter.push({ name: tableName, sqlName, columnsToAdd });
			}

			if (def.indexes) {
				const existingIndexes = await client.query(
					`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
					[schema, sqlName],
				);
				const existingIdxNames = new Set(existingIndexes.rows.map((r) => String(r.indexname)));

				for (const idx of def.indexes) {
					if (!existingIdxNames.has(idx.name)) {
						const cols = idx.columns.join(", ");
						const kind = idx.unique ? "UNIQUE INDEX" : "INDEX";
						const using = idx.using ? ` USING ${idx.using}` : "";
						const qualified = qualifyTable(schema, sqlName);
						const qualifiedIdx = schema === "public" ? idx.name : `"${schema}".${idx.name}`;
						plan.indexesToCreate.push({
							sql: `CREATE ${kind} IF NOT EXISTS ${qualifiedIdx} ON ${qualified}${using} (${cols});`,
							name: idx.name,
						});
					}
				}
			}
		}
	}

	return plan;
}

function planIsEmpty(plan: MigrationPlan): boolean {
	return (
		plan.tablesToCreate.length === 0 &&
		plan.tablesToAlter.length === 0 &&
		plan.indexesToCreate.length === 0
	);
}

// =============================================================================
// MIGRATION TRACKING HELPERS
// =============================================================================

function migrationsTable(schema: string): string {
	return qualifyTable(schema, "_summa_migrations");
}

async function ensureMigrationsTable(client: import("pg").Client, schema: string): Promise<void> {
	const mt = migrationsTable(schema);
	await client.query(`
		CREATE TABLE IF NOT EXISTS ${mt} (
			id SERIAL PRIMARY KEY,
			name TEXT NOT NULL,
			hash TEXT NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT uq_summa_migration_name UNIQUE (name)
		);
	`);
}

function hashSQL(sql: string): string {
	return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

function planToUpSQL(plan: MigrationPlan, schema: string): string {
	const parts: string[] = [];

	for (const table of plan.tablesToCreate) {
		parts.push(createTableSQL(table.name, table.def, schema));
	}

	for (const alter of plan.tablesToAlter) {
		const qualified = qualifyTable(schema, alter.sqlName);
		for (const col of alter.columnsToAdd) {
			const colType = pgType(col.col);
			const notNull = col.col.notNull ? " NOT NULL" : "";
			const def = col.col.default
				? ` DEFAULT ${col.col.default === "NOW()" ? "NOW()" : col.col.default}`
				: "";
			parts.push(
				`ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS ${col.name} ${colType}${notNull}${def};`,
			);
		}
	}

	for (const idx of plan.indexesToCreate) {
		parts.push(idx.sql);
	}

	// Append immutability triggers
	parts.push(immutabilityTriggersSQL(schema));

	return parts.join("\n\n");
}

function planToDownSQL(plan: MigrationPlan, schema: string): string {
	const parts: string[] = [];

	for (const idx of plan.indexesToCreate) {
		parts.push(dropIndexSQL(idx.name, schema));
	}

	for (const alter of plan.tablesToAlter) {
		const qualified = qualifyTable(schema, alter.sqlName);
		for (const col of alter.columnsToAdd) {
			parts.push(`ALTER TABLE ${qualified} DROP COLUMN IF EXISTS ${col.name};`);
		}
	}

	for (const table of [...plan.tablesToCreate].reverse()) {
		parts.push(dropTableSQL(table.name, schema));
	}

	return parts.join("\n\n");
}

interface LoadedContext {
	dbUrl: string;
	pg: typeof import("pg");
	tables: Record<string, TableDefinition>;
	schema: string;
}

async function loadContext(command: Command, urlOption?: string): Promise<LoadedContext | null> {
	const parent = command.parent?.parent;
	const cwd: string = parent?.opts().cwd ?? process.cwd();
	const configFlag: string | undefined = parent?.opts().config;

	let configDbUrl: string | undefined;
	let schema = "summa";
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

	const dbUrl = urlOption ?? configDbUrl ?? process.env.DATABASE_URL;
	if (!dbUrl) {
		p.log.error(`${pc.red("No DATABASE_URL")} ${pc.dim("set DATABASE_URL or use --url")}`);
		process.exitCode = 1;
		return null;
	}

	let pg: typeof import("pg");
	try {
		pg = await import("pg");
	} catch {
		p.log.error(`${pc.red("pg not installed")} ${pc.dim("run: pnpm add -D pg")}`);
		process.exitCode = 1;
		return null;
	}

	let tables: Record<string, TableDefinition>;
	try {
		const mod = await import("summa/db" as string);
		const getSummaTables = mod.getSummaTables as (opts?: {
			plugins?: unknown[];
		}) => Record<string, TableDefinition>;
		tables = getSummaTables(config?.options ? { plugins: config.options.plugins } : undefined);
	} catch {
		p.log.error(
			`${pc.red("Could not load summa schema.")} ${pc.dim("Ensure summa is installed.")}`,
		);
		process.exitCode = 1;
		return null;
	}

	return { dbUrl, pg, tables, schema };
}

// =============================================================================
// PUSH COMMAND — apply schema directly to database
// =============================================================================

const pushCommand = new Command("push")
	.description("Push summa schema directly to the database")
	.option("--url <url>", "PostgreSQL connection URL (or set DATABASE_URL)")
	.option("-y, --yes", "Skip confirmation prompt")
	.action(async (options: { url?: string; yes?: boolean }) => {
		p.intro(pc.bgCyan(pc.black(" summa migrate push ")));

		const ctx = await loadContext(pushCommand, options.url);
		if (!ctx) return;

		const s = p.spinner();
		s.start("Loading schema definitions...");
		s.stop(`Loaded ${pc.cyan(String(Object.keys(ctx.tables).length))} table definitions`);

		const client = new ctx.pg.default.Client({ connectionString: ctx.dbUrl });

		try {
			await client.connect();

			// Create schema if non-public
			if (ctx.schema !== "public") {
				await client.query(`CREATE SCHEMA IF NOT EXISTS "${ctx.schema}"`);
			}

			// Ensure migrations table exists
			await ensureMigrationsTable(client, ctx.schema);

			const s2 = p.spinner();
			s2.start("Analyzing database schema...");
			const plan = await buildMigrationPlan(client, ctx.tables, ctx.schema);
			s2.stop("Schema analysis complete");

			if (planIsEmpty(plan)) {
				p.log.success(`${pc.green("Schema is up to date.")} No changes needed.`);
				p.outro(pc.dim("Database schema matches summa definitions."));
				return;
			}

			// Show plan
			p.log.step(pc.bold("Migration Plan"));

			if (plan.tablesToCreate.length > 0) {
				p.log.info(
					`  ${pc.green("CREATE")} ${plan.tablesToCreate.map((t) => pc.cyan(t.sqlName)).join(", ")}`,
				);
			}

			for (const alter of plan.tablesToAlter) {
				const cols = alter.columnsToAdd.map((c) => pc.magenta(c.name)).join(", ");
				p.log.info(`  ${pc.yellow("ALTER")}  ${pc.cyan(alter.sqlName)} add columns: ${cols}`);
			}

			if (plan.indexesToCreate.length > 0) {
				p.log.info(`  ${pc.blue("INDEX")}  ${plan.indexesToCreate.length} index(es) to create`);
			}

			// Confirm
			if (!options.yes) {
				const confirmed = await p.confirm({
					message: "Apply these changes to the database?",
					initialValue: false,
				});

				if (p.isCancel(confirmed) || !confirmed) {
					p.cancel("Migration cancelled.");
					process.exit(0);
				}
			}

			// Execute inside a transaction so partial failures are rolled back
			// (PostgreSQL supports transactional DDL)
			const s3 = p.spinner();
			s3.start("Applying migrations...");

			let statementsRun = 0;

			await client.query("BEGIN");
			try {
				for (const table of plan.tablesToCreate) {
					const sql = createTableSQL(table.name, table.def, ctx.schema);
					for (const stmt of sql.split(";\n").filter(Boolean)) {
						await client.query(`${stmt};`);
						statementsRun++;
					}
				}

				for (const alter of plan.tablesToAlter) {
					const qualifiedAlter = qualifyTable(ctx.schema, alter.sqlName);
					for (const col of alter.columnsToAdd) {
						const colType = pgType(col.col);
						const notNull = col.col.notNull ? " NOT NULL" : "";
						const def = col.col.default
							? ` DEFAULT ${col.col.default === "NOW()" ? "NOW()" : col.col.default}`
							: "";
						await client.query(
							`ALTER TABLE ${qualifiedAlter} ADD COLUMN IF NOT EXISTS ${col.name} ${colType}${notNull}${def};`,
						);
						statementsRun++;
					}
				}

				for (const idx of plan.indexesToCreate) {
					await client.query(idx.sql);
					statementsRun++;
				}

				// Apply immutability triggers on financial tables
				const triggerSQL = immutabilityTriggersSQL(ctx.schema);
				for (const stmt of triggerSQL
					.split(";")
					.map((s) => s.trim())
					.filter((s) => s.length > 0 && !s.startsWith("--"))) {
					await client.query(`${stmt};`);
					statementsRun++;
				}

				// Record migration in tracking table
				const upSQL = planToUpSQL(plan, ctx.schema);
				const migrationName = `push_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
				const mt = migrationsTable(ctx.schema);
				await client.query(`INSERT INTO ${mt} (name, hash) VALUES ($1, $2)`, [
					migrationName,
					hashSQL(upSQL),
				]);

				await client.query("COMMIT");
			} catch (ddlError) {
				await client.query("ROLLBACK").catch(() => {});
				throw ddlError;
			}

			s3.stop(`Applied ${pc.cyan(String(statementsRun))} statement(s)`);
			p.outro(pc.green("Migration completed successfully!"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			p.log.error(`${pc.red("Migration failed:")} ${pc.dim(message)}`);
			process.exitCode = 1;
		} finally {
			await client.end().catch(() => {});
		}
	});

// =============================================================================
// GENERATE SUBCOMMAND — produce SQL migration files
// =============================================================================

const generateSubCommand = new Command("generate")
	.description("Generate SQL migration files")
	.option("--url <url>", "PostgreSQL connection URL (or set DATABASE_URL)")
	.option("-o, --out <dir>", "Output directory for migrations", "./summa/migrations")
	.action(async (options: { url?: string; out: string }) => {
		p.intro(pc.bgCyan(pc.black(" summa migrate generate ")));

		const ctx = await loadContext(generateSubCommand, options.url);
		if (!ctx) return;

		const client = new ctx.pg.default.Client({ connectionString: ctx.dbUrl });

		try {
			await client.connect();

			if (ctx.schema !== "public") {
				await client.query(`CREATE SCHEMA IF NOT EXISTS "${ctx.schema}"`);
			}
			await ensureMigrationsTable(client, ctx.schema);

			const s = p.spinner();
			s.start("Analyzing database schema...");
			const plan = await buildMigrationPlan(client, ctx.tables, ctx.schema);
			s.stop("Analysis complete");

			if (planIsEmpty(plan)) {
				p.log.success(`${pc.green("Schema is up to date.")} No migration needed.`);
				p.outro(pc.dim("Nothing to generate."));
				return;
			}

			const upSQL = planToUpSQL(plan, ctx.schema);
			const downSQL = planToDownSQL(plan, ctx.schema);

			const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const migrationName = `${timestamp}_summa_migration`;
			const fileName = `${migrationName}.sql`;

			const outDir = resolve(process.cwd(), options.out);
			if (!existsSync(outDir)) {
				mkdirSync(outDir, { recursive: true });
			}

			const content = [
				`-- Summa Migration: ${migrationName}`,
				`-- Generated at: ${new Date().toISOString()}`,
				`-- Hash: ${hashSQL(upSQL)}`,
				"",
				"-- Up",
				upSQL,
				"",
				"-- Down",
				downSQL,
			].join("\n");

			const filePath = resolve(outDir, fileName);
			writeFileSync(filePath, content, "utf-8");

			p.log.success(`Generated migration: ${pc.cyan(fileName)}`);

			if (plan.tablesToCreate.length > 0) {
				p.log.info(
					`  ${pc.green("CREATE")} ${plan.tablesToCreate.map((t) => pc.cyan(t.sqlName)).join(", ")}`,
				);
			}
			for (const alter of plan.tablesToAlter) {
				const cols = alter.columnsToAdd.map((c) => pc.magenta(c.name)).join(", ");
				p.log.info(`  ${pc.yellow("ALTER")}  ${pc.cyan(alter.sqlName)} add columns: ${cols}`);
			}
			if (plan.indexesToCreate.length > 0) {
				p.log.info(`  ${pc.blue("INDEX")}  ${plan.indexesToCreate.length} index(es)`);
			}

			p.outro(
				`${pc.dim("Apply with:")} ${pc.cyan(`npx summa migrate push`)} ${pc.dim("or run the SQL file directly.")}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			p.log.error(`${pc.red("Generate failed:")} ${pc.dim(message)}`);
			process.exitCode = 1;
		} finally {
			await client.end().catch(() => {});
		}
	});

// =============================================================================
// STATUS SUBCOMMAND — show pending schema changes
// =============================================================================

const statusSubCommand = new Command("status")
	.description("Show pending schema changes")
	.option("--url <url>", "PostgreSQL connection URL (or set DATABASE_URL)")
	.action(async (options: { url?: string }) => {
		p.intro(pc.bgCyan(pc.black(" summa migrate status ")));

		const ctx = await loadContext(statusSubCommand, options.url);
		if (!ctx) return;

		const client = new ctx.pg.default.Client({ connectionString: ctx.dbUrl });

		try {
			await client.connect();
			await ensureMigrationsTable(client, ctx.schema);

			const s = p.spinner();
			s.start("Checking schema...");
			const plan = await buildMigrationPlan(client, ctx.tables, ctx.schema);
			s.stop("Analysis complete");

			if (planIsEmpty(plan)) {
				p.log.success(`${pc.green("Schema is up to date.")} No pending changes.`);
			} else {
				p.log.step(pc.bold("Pending Changes"));

				if (plan.tablesToCreate.length > 0) {
					p.log.info(
						`  ${pc.green("+")} ${plan.tablesToCreate.length} table(s) to create: ${plan.tablesToCreate.map((t) => pc.cyan(t.sqlName)).join(", ")}`,
					);
				}

				for (const alter of plan.tablesToAlter) {
					p.log.info(
						`  ${pc.yellow("~")} ${pc.cyan(alter.sqlName)}: ${alter.columnsToAdd.length} column(s) to add`,
					);
				}

				if (plan.indexesToCreate.length > 0) {
					p.log.info(`  ${pc.blue("+")} ${plan.indexesToCreate.length} index(es) to create`);
				}

				p.log.info("");
				p.log.info(`  Run ${pc.cyan("npx summa migrate push")} to apply these changes.`);
			}

			// Show migration history summary
			const mt = migrationsTable(ctx.schema);
			const history = await client.query(`SELECT COUNT(*) as count FROM ${mt}`);
			const count = Number(history.rows[0].count);
			if (count > 0) {
				p.log.info(
					`\n  ${pc.dim(`${count} migration(s) applied. Run`)} ${pc.cyan("npx summa migrate list")} ${pc.dim("to see history.")}`,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			p.log.error(`${pc.red("Connection failed:")} ${pc.dim(message)}`);
			process.exitCode = 1;
		} finally {
			await client.end().catch(() => {});
		}

		p.outro(pc.dim("summa migrate status complete"));
	});

// =============================================================================
// LIST SUBCOMMAND — show applied migration history
// =============================================================================

const listSubCommand = new Command("list")
	.description("List applied migrations")
	.option("--url <url>", "PostgreSQL connection URL (or set DATABASE_URL)")
	.option("-n, --limit <n>", "Number of migrations to show", "20")
	.action(async (options: { url?: string; limit: string }) => {
		p.intro(pc.bgCyan(pc.black(" summa migrate list ")));

		const ctx = await loadContext(listSubCommand, options.url);
		if (!ctx) return;

		const client = new ctx.pg.default.Client({ connectionString: ctx.dbUrl });

		try {
			await client.connect();
			await ensureMigrationsTable(client, ctx.schema);

			const mt = migrationsTable(ctx.schema);
			const limit = Math.max(1, Number.parseInt(options.limit, 10) || 20);
			const result = await client.query(
				`SELECT id, name, hash, applied_at FROM ${mt} ORDER BY id DESC LIMIT $1`,
				[limit],
			);

			if (result.rows.length === 0) {
				p.log.info(`${pc.dim("No migrations have been applied yet.")}`);
				p.outro(pc.dim("Run npx summa migrate push to apply the schema."));
				return;
			}

			p.log.step(pc.bold("Applied Migrations"));

			for (const row of result.rows) {
				const date = new Date(row.applied_at).toLocaleString();
				p.log.info(
					`  ${pc.dim(`#${row.id}`)} ${pc.cyan(row.name)} ${pc.dim(`[${row.hash}]`)} ${pc.dim(date)}`,
				);
			}

			const total = await client.query(`SELECT COUNT(*) as count FROM ${mt}`);
			const totalCount = Number(total.rows[0].count);
			if (totalCount > result.rows.length) {
				p.log.info(
					`\n  ${pc.dim(`Showing ${result.rows.length} of ${totalCount} migrations. Use --limit to show more.`)}`,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			p.log.error(`${pc.red("Failed:")} ${pc.dim(message)}`);
			process.exitCode = 1;
		} finally {
			await client.end().catch(() => {});
		}

		p.outro(pc.dim("summa migrate list complete"));
	});

// =============================================================================
// ROLLBACK SUBCOMMAND — undo last N migration(s) using SQL files
// =============================================================================

const rollbackSubCommand = new Command("rollback")
	.description("Rollback last migration(s) using generated SQL files")
	.option("--url <url>", "PostgreSQL connection URL (or set DATABASE_URL)")
	.option("-n, --steps <n>", "Number of migrations to rollback", "1")
	.option("-d, --dir <dir>", "Directory containing migration SQL files", "./summa/migrations")
	.option("-y, --yes", "Skip confirmation prompt")
	.action(async (options: { url?: string; steps: string; dir: string; yes?: boolean }) => {
		p.intro(pc.bgCyan(pc.black(" summa migrate rollback ")));

		const ctx = await loadContext(rollbackSubCommand, options.url);
		if (!ctx) return;

		const client = new ctx.pg.default.Client({ connectionString: ctx.dbUrl });

		try {
			await client.connect();
			await ensureMigrationsTable(client, ctx.schema);

			const mt = migrationsTable(ctx.schema);
			const steps = Math.max(1, Number.parseInt(options.steps, 10) || 1);
			const result = await client.query(
				`SELECT id, name, hash FROM ${mt} ORDER BY id DESC LIMIT $1`,
				[steps],
			);

			if (result.rows.length === 0) {
				p.log.info(`${pc.dim("No migrations to rollback.")}`);
				p.outro(pc.dim("Nothing to do."));
				return;
			}

			// Look for corresponding SQL files with -- Down sections
			const migrationsDir = resolve(process.cwd(), options.dir);
			let migrationFiles: string[] = [];
			if (existsSync(migrationsDir)) {
				migrationFiles = readdirSync(migrationsDir)
					.filter((f) => f.endsWith(".sql"))
					.sort();
			}

			const rollbackPlans: Array<{ row: (typeof result.rows)[0]; downSQL: string | null }> = [];

			for (const row of result.rows) {
				let downSQL: string | null = null;

				// Try to find the matching SQL file by hash
				for (const file of migrationFiles) {
					// Normalize CRLF → LF to handle Windows line endings
					const content = readFileSync(resolve(migrationsDir, file), "utf-8").replace(
						/\r\n/g,
						"\n",
					);
					if (content.includes(`Hash: ${row.hash}`)) {
						const downMatch = content.split("-- Down\n");
						if (downMatch.length > 1 && downMatch[1]) {
							downSQL = downMatch[1].trim();
						}
						break;
					}
				}

				rollbackPlans.push({ row, downSQL });
			}

			// Show what will be rolled back
			p.log.step(pc.bold("Rollback Plan"));

			for (const { row, downSQL } of rollbackPlans) {
				if (downSQL) {
					p.log.info(`  ${pc.red("ROLLBACK")} ${pc.cyan(row.name)} ${pc.dim(`[${row.hash}]`)}`);
				} else {
					p.log.info(
						`  ${pc.red("ROLLBACK")} ${pc.cyan(row.name)} ${pc.yellow("(no SQL file found — record only)")}`,
					);
				}
			}

			if (!options.yes) {
				const confirmed = await p.confirm({
					message: `Rollback ${rollbackPlans.length} migration(s)?`,
					initialValue: false,
				});

				if (p.isCancel(confirmed) || !confirmed) {
					p.cancel("Rollback cancelled.");
					process.exit(0);
				}
			}

			const s = p.spinner();
			s.start("Rolling back...");

			await client.query("BEGIN");
			try {
				for (const { row, downSQL } of rollbackPlans) {
					if (downSQL) {
						// Execute each statement in the down SQL
						const statements = downSQL
							.split(";\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0 && !s.startsWith("--"));

						for (const stmt of statements) {
							const sql = stmt.endsWith(";") ? stmt : `${stmt};`;
							await client.query(sql);
						}
					}

					// Remove from migration tracking
					await client.query(`DELETE FROM ${mt} WHERE id = $1`, [row.id]);
				}
				await client.query("COMMIT");
			} catch (rollbackError) {
				await client.query("ROLLBACK").catch(() => {});
				throw rollbackError;
			}

			s.stop(`Rolled back ${pc.cyan(String(rollbackPlans.length))} migration(s)`);
			p.outro(pc.green("Rollback completed successfully!"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			p.log.error(`${pc.red("Rollback failed:")} ${pc.dim(message)}`);
			process.exitCode = 1;
		} finally {
			await client.end().catch(() => {});
		}
	});

// =============================================================================
// MIGRATE PARENT COMMAND
// =============================================================================

export const migrateCommand = new Command("migrate")
	.description("Manage summa database schema and migrations")
	.addCommand(pushCommand)
	.addCommand(generateSubCommand)
	.addCommand(statusSubCommand)
	.addCommand(listSubCommand)
	.addCommand(rollbackSubCommand);
