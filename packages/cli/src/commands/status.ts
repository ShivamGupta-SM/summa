import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { findConfigFile, getConfig, type ResolvedSummaConfig } from "../utils/get-config.js";

export const statusCommand = new Command("status")
	.description("Show current summa system status")
	.option("--url <url>", "PostgreSQL connection URL (or set DATABASE_URL)")
	.action(async (options: { url?: string }) => {
		const parent = statusCommand.parent;
		const cwd: string = parent?.opts().cwd ?? process.cwd();
		const configFlag: string | undefined = parent?.opts().config;

		p.intro(pc.bgCyan(pc.black(" summa status ")));

		// ---- Configuration ----
		p.log.step(pc.bold("Configuration"));

		const configFile = findConfigFile(cwd, configFlag);
		if (configFile) {
			p.log.success(`  Config file:   ${pc.green("found")} ${pc.dim(configFile)}`);
		} else {
			p.log.warning(
				`  Config file:   ${pc.yellow("missing")} ${pc.dim("run summa init to create one")}`,
			);
		}

		// Load config for DATABASE_URL extraction, plugin info, etc.
		let configDbUrl: string | undefined;
		let loaded: ResolvedSummaConfig | null = null;

		if (configFile) {
			loaded = await getConfig({ cwd, configPath: configFlag });
			if (loaded) {
				p.log.success(`  Config loaded: ${pc.green("ok")}`);

				// Extract adapter info
				const db = loaded.options.database;
				const adapterId = typeof db === "object" && "id" in db ? (db as { id: string }).id : null;
				if (adapterId) {
					p.log.info(`  Adapter:       ${pc.cyan(adapterId)}`);
				}

				// Currency
				p.log.info(`  Currency:      ${pc.cyan(loaded.options.currency ?? "USD")}`);

				// System accounts from config
				const sysAccts = loaded.options.systemAccounts;
				if (sysAccts && typeof sysAccts === "object") {
					const entries = Object.entries(sysAccts);
					if (entries.length > 0) {
						const labels = entries
							.map(([key, val]) => {
								const identifier =
									typeof val === "string"
										? val
										: ((val as { identifier?: string })?.identifier ?? key);
								return `${key}(${pc.dim(identifier)})`;
							})
							.join(", ");
						p.log.info(`  Sys accounts:  ${labels}`);
					}
				}

				// Plugins
				const plugins = loaded.options.plugins ?? [];
				if (plugins.length > 0) {
					const pluginNames = plugins.map((pl) => pc.cyan(pl.id)).join(", ");
					p.log.info(`  Plugins:       ${pluginNames}`);
				} else {
					p.log.info(`  Plugins:       ${pc.dim("none")}`);
				}

				// Advanced options (only if non-default)
				const adv = loaded.options.advanced;
				if (adv) {
					const advParts: string[] = [];
					if (adv.hotAccountThreshold != null)
						advParts.push(`hotThreshold=${adv.hotAccountThreshold}`);
					if (adv.idempotencyTTL != null) advParts.push(`idempotencyTTL=${adv.idempotencyTTL}ms`);
					if (adv.enableEventSourcing === false) advParts.push("eventSourcing=off");
					if (adv.enableHashChain === false) advParts.push("hashChain=off");
					if (advParts.length > 0) {
						p.log.info(`  Advanced:      ${pc.dim(advParts.join(", "))}`);
					}
				}

				// Try to extract DB URL from config database object
				if (typeof db === "object" && "connectionString" in db) {
					configDbUrl = db.connectionString as string;
				}
			} else {
				p.log.warning(
					`  Config loaded: ${pc.yellow("failed")} ${pc.dim("could not resolve summa options")}`,
				);
			}
		}

		// ---- Database ----
		const dbUrl = options.url ?? configDbUrl ?? process.env.DATABASE_URL;
		if (!dbUrl) {
			p.log.step(pc.bold("Database"));
			p.log.warning(
				`  Connection:    ${pc.yellow("no DATABASE_URL")} ${pc.dim("set DATABASE_URL or use --url")}`,
			);
			p.outro(pc.dim("Set DATABASE_URL to see full status."));
			return;
		}

		let pg: typeof import("pg");
		try {
			pg = await import("pg");
		} catch {
			p.log.error(`  ${pc.red("pg not installed")} ${pc.dim("run: pnpm add -D pg")}`);
			p.outro(pc.dim("Install pg to connect to the database."));
			return;
		}

		// Resolve schema from config
		const schema =
			loaded?.options &&
			typeof loaded.options.schema === "string" &&
			loaded.options.schema.length > 0
				? loaded.options.schema
				: "@summa-ledger/summa";
		const t = (table: string) => (schema === "public" ? `"${table}"` : `"${schema}"."${table}"`);

		const client = new pg.default.Client({ connectionString: dbUrl });

		try {
			await client.connect();
			p.log.step(pc.bold("Database"));
			p.log.success(`  Connection:    ${pc.green("connected")}`);

			// ---- Ledger Statistics ----
			p.log.step(pc.bold("Ledger Statistics"));

			const accountCount = await safeQuery(
				client,
				`SELECT COUNT(*)::int AS count FROM ${t("account_balance")}`,
			);
			p.log.info(`  Accounts:      ${pc.cyan(String(accountCount?.count ?? 0))}`);

			const sysAccountCount = await safeQuery(
				client,
				`SELECT COUNT(*)::int AS count FROM ${t("system_account")}`,
			);
			p.log.info(`  System accts:  ${pc.cyan(String(sysAccountCount?.count ?? 0))}`);

			const txnCount = await safeQuery(
				client,
				`SELECT COUNT(*)::int AS count FROM ${t("transaction_record")}`,
			);
			p.log.info(`  Transactions:  ${pc.cyan(String(txnCount?.count ?? 0))}`);

			const holdCount = await safeQuery(
				client,
				`SELECT COUNT(*)::int AS count FROM ${t("transaction_record")} WHERE is_hold = true AND status = 'inflight'`,
			);
			p.log.info(`  Active holds:  ${pc.cyan(String(holdCount?.count ?? 0))}`);

			const eventCount = await safeQuery(
				client,
				`SELECT COUNT(*)::int AS count FROM ${t("ledger_event")}`,
			);
			p.log.info(`  Events:        ${pc.cyan(String(eventCount?.count ?? 0))}`);

			// ---- Integrity ----
			p.log.step(pc.bold("Integrity"));

			const lastBlock = await safeQuery(
				client,
				`SELECT block_hash, block_sequence, event_count FROM ${t("block_checkpoint")} ORDER BY block_sequence DESC LIMIT 1`,
			);
			if (lastBlock) {
				p.log.info(
					`  Last block:    ${pc.cyan(`#${lastBlock.block_sequence}`)} ${pc.dim(`(${lastBlock.event_count} events, hash: ${String(lastBlock.block_hash).slice(0, 12)}...)`)}`,
				);
			} else {
				p.log.warning(
					`  Last block:    ${pc.yellow("none")} ${pc.dim("no block checkpoints yet")}`,
				);
			}

			// Double-entry balance check (use latest version rows for accurate totals)
			const deBalance = await safeQuery(
				client,
				`SELECT COALESCE(SUM(v.balance), 0)::bigint AS total
				 FROM ${t("account_balance")} a
				 JOIN LATERAL (
				   SELECT balance FROM ${t("account_balance_version")}
				   WHERE account_id = a.id ORDER BY version DESC LIMIT 1
				 ) v ON true`,
			);
			const sysBalance = await safeQuery(
				client,
				`SELECT COALESCE(SUM(v.balance), 0)::bigint AS total
				 FROM ${t("system_account")} sa
				 JOIN LATERAL (
				   SELECT balance FROM ${t("system_account_version")}
				   WHERE system_account_id = sa.id ORDER BY version DESC LIMIT 1
				 ) v ON true`,
			);
			const hotBalance = await safeQuery(
				client,
				`SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM ${t("hot_account_entry")} WHERE status = 'pending'`,
			);

			const userTotal = Number(deBalance?.total ?? 0);
			const systemTotal = Number(sysBalance?.total ?? 0);
			const hotTotal = Number(hotBalance?.total ?? 0);
			const grandTotal = userTotal + systemTotal + hotTotal;

			if (grandTotal === 0) {
				p.log.success(
					`  Balance check: ${pc.green("balanced")} ${pc.dim(`user(${userTotal}) + system(${systemTotal}) + hot(${hotTotal}) = 0`)}`,
				);
			} else {
				p.log.error(
					`  Balance check: ${pc.red("IMBALANCED")} ${pc.dim(`user(${userTotal}) + system(${systemTotal}) + hot(${hotTotal}) = ${grandTotal}`)}`,
				);
			}

			// Last reconciliation
			const lastRecon = await safeQuery(
				client,
				`SELECT run_date, status, total_mismatches, duration_ms FROM ${t("reconciliation_result")} ORDER BY created_at DESC LIMIT 1`,
			);
			if (lastRecon) {
				const status = String(lastRecon.status);
				const reconStatus = status === "healthy" ? pc.green(status) : pc.red(status);
				p.log.info(
					`  Last recon:    ${reconStatus} ${pc.dim(`(${lastRecon.run_date}, ${lastRecon.total_mismatches} mismatches, ${lastRecon.duration_ms}ms)`)}`,
				);
			} else {
				p.log.warning(
					`  Last recon:    ${pc.yellow("never")} ${pc.dim("no reconciliation runs yet")}`,
				);
			}

			// Outbox status
			const outboxPending = await safeQuery(
				client,
				`SELECT COUNT(*)::int AS count FROM ${t("outbox")} WHERE processed_at IS NULL`,
			);
			const dlqCount = await safeQuery(
				client,
				`SELECT COUNT(*)::int AS count FROM ${t("dead_letter_queue")} WHERE status = 'pending'`,
			);
			p.log.info(
				`  Outbox queue:  ${pc.cyan(String(outboxPending?.count ?? 0))} pending, ${pc.cyan(String(dlqCount?.count ?? 0))} in DLQ`,
			);

			// Migration freshness
			const migTable =
				schema === "public" ? `"_summa_migrations"` : `"${schema}"."_summa_migrations"`;
			const lastMig = await safeQuery(
				client,
				`SELECT name, applied_at FROM ${migTable} ORDER BY id DESC LIMIT 1`,
			);
			if (lastMig?.applied_at) {
				const appliedAt = new Date(lastMig.applied_at as string);
				const daysAgo = Math.floor((Date.now() - appliedAt.getTime()) / (1000 * 60 * 60 * 24));
				p.log.info(
					`  Last migration:${daysAgo > 90 ? pc.yellow(` ${daysAgo}d ago`) : pc.dim(` ${daysAgo}d ago`)} ${pc.dim(`(${String(lastMig.name)})`)}`,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			p.log.error(`  Connection:    ${pc.red("failed")} ${pc.dim(message)}`);
		} finally {
			await client.end().catch(() => {});
		}

		p.outro(pc.dim("summa status complete"));
	});

async function safeQuery(
	client: import("pg").Client,
	sql: string,
): Promise<Record<string, unknown> | null> {
	try {
		const result = await client.query(sql);
		return (result.rows[0] as Record<string, unknown>) ?? null;
	} catch {
		return null;
	}
}
