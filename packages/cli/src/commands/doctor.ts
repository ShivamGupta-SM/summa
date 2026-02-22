// =============================================================================
// DOCTOR COMMAND — Diagnose common setup issues
// =============================================================================

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { detectPackageManager } from "../utils/detect-pm.js";
import { findConfigFile, getConfig } from "../utils/get-config.js";

export const doctorCommand = new Command("doctor")
	.description("Diagnose common setup issues")
	.option("--url <url>", "PostgreSQL connection URL (or set DATABASE_URL)")
	.action(async (options: { url?: string }) => {
		const parent = doctorCommand.parent;
		const cwd: string = parent?.opts().cwd ?? process.cwd();
		const configFlag: string | undefined = parent?.opts().config;

		p.intro(pc.bgCyan(pc.black(" summa doctor ")));

		let passed = 0;
		let warnings = 0;
		let errors = 0;

		// ---- 1. Package Manager & Dependencies ----
		p.log.step(pc.bold("Environment"));

		const pm = detectPackageManager(cwd);
		p.log.info(`  Package manager: ${pc.cyan(pm)}`);

		const nodeVersion = process.version;
		const major = parseInt(nodeVersion.slice(1), 10);
		if (major >= 18) {
			p.log.success(`  Node.js:         ${pc.green(nodeVersion)}`);
			passed++;
		} else {
			p.log.error(`  Node.js:         ${pc.red(nodeVersion)} ${pc.dim("(requires >= 18)")}`);
			errors++;
		}

		// Check if summa is installed
		try {
			await import("@summa-ledger/summa/db" as string);
			p.log.success(`  summa:           ${pc.green("installed")}`);
			passed++;
		} catch {
			p.log.error(`  summa:           ${pc.red("not found")} ${pc.dim(`run: ${pm} add summa`)}`);
			errors++;
		}

		// Check if pg is available
		try {
			await import("pg");
			p.log.success(`  pg driver:       ${pc.green("installed")}`);
			passed++;
		} catch {
			p.log.warning(
				`  pg driver:       ${pc.yellow("not found")} ${pc.dim("needed for migrate/verify/status")}`,
			);
			warnings++;
		}

		// ---- 2. Config File ----
		p.log.step(pc.bold("Configuration"));

		const configFile = findConfigFile(cwd, configFlag);
		if (configFile) {
			p.log.success(`  Config file:     ${pc.green("found")} ${pc.dim(configFile)}`);
			passed++;
		} else {
			p.log.error(`  Config file:     ${pc.red("missing")} ${pc.dim("run: npx summa init")}`);
			errors++;
		}

		// Try loading the config
		let _configLoaded = false;
		let configDbUrl: string | undefined;
		let schema = "summa";

		if (configFile) {
			const config = await getConfig({ cwd, configPath: configFlag });
			if (config?.options) {
				_configLoaded = true;
				p.log.success(`  Config parse:    ${pc.green("ok")}`);
				passed++;

				// Check adapter
				const db = config.options.database;
				if (db) {
					p.log.success(`  Database adapter:${pc.green(" configured")}`);
					passed++;
				} else {
					p.log.error(
						`  Database adapter:${pc.red(" missing")} ${pc.dim("database field required in config")}`,
					);
					errors++;
				}

				// Check system accounts
				const sysAccts = config.options.systemAccounts;
				if (sysAccts && typeof sysAccts === "object" && Object.keys(sysAccts).length > 0) {
					p.log.success(
						`  System accounts: ${pc.green(`${String(Object.keys(sysAccts).length)} configured`)}`,
					);
					passed++;
				} else {
					p.log.warning(
						`  System accounts: ${pc.yellow("none configured")} ${pc.dim("recommended: world, fees, suspense")}`,
					);
					warnings++;
				}

				if (typeof db === "object" && "connectionString" in db) {
					configDbUrl = db.connectionString as string;
				}
				if (typeof config.options.schema === "string" && config.options.schema.length > 0) {
					schema = config.options.schema;
				}
			} else {
				p.log.error(
					`  Config parse:    ${pc.red("failed")} ${pc.dim("could not extract summa options")}`,
				);
				errors++;
			}
		}

		// ---- 3. Environment Variables ----
		p.log.step(pc.bold("Environment Variables"));

		const dbUrl = options.url ?? configDbUrl ?? process.env.DATABASE_URL;
		if (dbUrl) {
			// Mask the URL for display
			const masked = dbUrl.replace(/\/\/[^@]+@/, "//***@");
			p.log.success(`  DATABASE_URL:    ${pc.green("set")} ${pc.dim(masked)}`);
			passed++;
		} else {
			p.log.error(
				`  DATABASE_URL:    ${pc.red("not set")} ${pc.dim("required for database operations")}`,
			);
			errors++;
		}

		// Check for .env file
		const envPath = resolve(cwd, ".env");
		const envLocalPath = resolve(cwd, ".env.local");
		if (existsSync(envPath) || existsSync(envLocalPath)) {
			p.log.success(`  .env file:       ${pc.green("found")}`);
			passed++;
		} else if (!dbUrl) {
			p.log.warning(
				`  .env file:       ${pc.yellow("not found")} ${pc.dim("create .env with DATABASE_URL")}`,
			);
			warnings++;
		}

		// ---- 4. Database Connection ----
		if (dbUrl) {
			p.log.step(pc.bold("Database Connection"));

			let pg: typeof import("pg");
			try {
				pg = await import("pg");
			} catch {
				p.log.warning(`  ${pc.yellow("Skipping DB checks")} ${pc.dim("pg driver not installed")}`);
				warnings++;
				printSummary(passed, warnings, errors);
				return;
			}

			const client = new pg.default.Client({ connectionString: dbUrl });
			try {
				await client.connect();
				p.log.success(`  Connection:      ${pc.green("ok")}`);
				passed++;

				// Check schema exists
				const schemaResult = await client.query(
					`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
					[schema],
				);
				if (schemaResult.rows.length > 0) {
					p.log.success(`  Schema "${schema}": ${pc.green("exists")}`);
					passed++;
				} else {
					p.log.warning(
						`  Schema "${schema}": ${pc.yellow("not found")} ${pc.dim("run: npx summa migrate push")}`,
					);
					warnings++;
				}

				// Check core tables exist
				const _t = (table: string) =>
					schema === "public" ? `"${table}"` : `"${schema}"."${table}"`;
				const coreTables = [
					"account_balance",
					"transaction_record",
					"entry_record",
					"ledger_event",
				];
				let coreTablesFound = 0;

				for (const tableName of coreTables) {
					const tableResult = await client.query(
						`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
						[schema, tableName],
					);
					if (tableResult.rows.length > 0) coreTablesFound++;
				}

				if (coreTablesFound === coreTables.length) {
					p.log.success(
						`  Core tables:     ${pc.green(`${coreTablesFound}/${coreTables.length} present`)}`,
					);
					passed++;
				} else if (coreTablesFound > 0) {
					p.log.warning(
						`  Core tables:     ${pc.yellow(`${coreTablesFound}/${coreTables.length} present`)} ${pc.dim("run: npx summa migrate push")}`,
					);
					warnings++;
				} else {
					p.log.error(
						`  Core tables:     ${pc.red("none found")} ${pc.dim("run: npx summa migrate push")}`,
					);
					errors++;
				}

				// Check migrations table
				const migTable =
					schema === "public" ? `"_summa_migrations"` : `"${schema}"."_summa_migrations"`;
				try {
					const migResult = await client.query(`SELECT COUNT(*)::int AS count FROM ${migTable}`);
					const migCount = Number(migResult.rows[0]?.count ?? 0);
					if (migCount > 0) {
						p.log.success(`  Migrations:      ${pc.green(`${migCount} applied`)}`);
						passed++;

						// Check migration freshness
						const lastMig = await client.query(
							`SELECT applied_at FROM ${migTable} ORDER BY id DESC LIMIT 1`,
						);
						if (lastMig.rows[0]?.applied_at) {
							const appliedAt = new Date(lastMig.rows[0].applied_at);
							const daysAgo = Math.floor(
								(Date.now() - appliedAt.getTime()) / (1000 * 60 * 60 * 24),
							);
							if (daysAgo > 90) {
								p.log.warning(
									`  Last migration:  ${pc.yellow(`${daysAgo} days ago`)} ${pc.dim("consider checking for schema updates")}`,
								);
								warnings++;
							} else {
								p.log.info(`  Last migration:  ${pc.dim(`${daysAgo} day(s) ago`)}`);
							}
						}
					} else {
						p.log.warning(
							`  Migrations:      ${pc.yellow("none applied")} ${pc.dim("run: npx summa migrate push")}`,
						);
						warnings++;
					}
				} catch {
					p.log.warning(
						`  Migrations:      ${pc.yellow("table not found")} ${pc.dim("run: npx summa migrate push")}`,
					);
					warnings++;
				}

				// Check immutability triggers
				const triggerResult = await client.query(
					`SELECT COUNT(*)::int AS count FROM information_schema.triggers WHERE trigger_schema = $1 AND trigger_name LIKE 'trg_immutable_%'`,
					[schema],
				);
				const triggerCount = Number(triggerResult.rows[0]?.count ?? 0);
				if (triggerCount > 0) {
					p.log.success(
						`  Triggers:        ${pc.green(`${triggerCount} immutability trigger(s)`)}`,
					);
					passed++;
				} else {
					p.log.warning(
						`  Triggers:        ${pc.yellow("none")} ${pc.dim("run: npx summa migrate push")}`,
					);
					warnings++;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				p.log.error(`  Connection:      ${pc.red("failed")} ${pc.dim(message)}`);
				errors++;
			} finally {
				await client.end().catch(() => {});
			}
		}

		printSummary(passed, warnings, errors);
	});

function printSummary(passed: number, warnings: number, errors: number) {
	const parts = [
		pc.green(`${passed} passed`),
		...(warnings > 0 ? [pc.yellow(`${warnings} warning(s)`)] : []),
		...(errors > 0 ? [pc.red(`${errors} error(s)`)] : []),
	].join(pc.dim(" / "));

	if (errors > 0) {
		p.outro(`${pc.red("Issues found that need attention.")} ${pc.dim(`(${parts})`)}`);
		process.exitCode = 1;
	} else if (warnings > 0) {
		p.outro(`${pc.yellow("Setup looks good with minor warnings.")} ${pc.dim(`(${parts})`)}`);
	} else {
		p.outro(`${pc.green("Everything looks healthy!")} ${pc.dim(`(${parts})`)}`);
	}
}
