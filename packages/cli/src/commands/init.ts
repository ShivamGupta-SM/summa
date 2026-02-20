import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { detectPackageManager, getInstallCommand } from "../utils/detect-pm.js";
import { findConfigFile } from "../utils/get-config.js";

const CONFIG_FILENAME = "summa.config.ts";

// =============================================================================
// ADAPTER DEFINITIONS
// =============================================================================

interface AdapterChoice {
	value: string;
	label: string;
	hint: string;
	pkg: string;
	peerDeps: string[];
}

const adapters: AdapterChoice[] = [
	{
		value: "drizzle",
		label: "Drizzle ORM",
		hint: "recommended",
		pkg: "@summa/drizzle-adapter",
		peerDeps: ["drizzle-orm"],
	},
	{
		value: "prisma",
		label: "Prisma",
		hint: "prisma client",
		pkg: "@summa/prisma-adapter",
		peerDeps: ["@prisma/client"],
	},
	{
		value: "kysely",
		label: "Kysely",
		hint: "type-safe SQL",
		pkg: "@summa/kysely-adapter",
		peerDeps: ["kysely"],
	},
	{
		value: "memory",
		label: "In-Memory",
		hint: "testing only",
		pkg: "@summa/memory-adapter",
		peerDeps: [],
	},
];

// =============================================================================
// AVAILABLE PLUGINS
// =============================================================================

interface PluginChoice {
	value: string;
	label: string;
	hint: string;
	importName: string;
}

const availablePlugins: PluginChoice[] = [
	{
		value: "auditLog",
		label: "Audit Log",
		hint: "immutable audit trail for all operations",
		importName: "auditLog",
	},
	{
		value: "reconciliation",
		label: "Reconciliation",
		hint: "periodic balance verification & integrity checks",
		importName: "reconciliation",
	},
	{
		value: "snapshots",
		label: "Balance Snapshots",
		hint: "historical balance queries & end-of-month reports",
		importName: "snapshots",
	},
	{
		value: "velocityLimits",
		label: "Velocity Limits",
		hint: "rate limiting for transactions per account",
		importName: "velocityLimits",
	},
	{
		value: "holdExpiry",
		label: "Hold Expiry",
		hint: "automatic expiration of stale holds",
		importName: "holdExpiry",
	},
	{
		value: "outbox",
		label: "Outbox",
		hint: "reliable event delivery via outbox pattern",
		importName: "outbox",
	},
	{
		value: "dlqManager",
		label: "Dead Letter Queue",
		hint: "handle failed event processing",
		importName: "dlqManager",
	},
	{
		value: "hotAccounts",
		label: "Hot Accounts",
		hint: "optimized high-throughput system accounts",
		importName: "hotAccounts",
	},
	{
		value: "scheduledTransactions",
		label: "Scheduled Transactions",
		hint: "background transaction scheduling",
		importName: "scheduledTransactions",
	},
	{
		value: "maintenance",
		label: "Maintenance",
		hint: "system maintenance & cleanup tasks",
		importName: "maintenance",
	},
];

// =============================================================================
// CONFIG TEMPLATE GENERATOR
// =============================================================================

function generateConfigTemplate(opts: {
	adapterKey: string;
	currency: string;
	plugins: string[];
	systemAccounts: Record<string, string>;
}): string {
	const lines: string[] = [];

	// Imports
	lines.push('import { createSumma } from "summa";');

	switch (opts.adapterKey) {
		case "drizzle":
			lines.push('import { drizzleAdapter } from "@summa/drizzle-adapter";');
			lines.push('import { drizzle } from "drizzle-orm/node-postgres";');
			break;
		case "prisma":
			lines.push('import { prismaAdapter } from "@summa/prisma-adapter";');
			lines.push('import { PrismaClient } from "@prisma/client";');
			break;
		case "kysely":
			lines.push('import { kyselyAdapter } from "@summa/kysely-adapter";');
			lines.push('import { Kysely, PostgresDialect } from "kysely";');
			lines.push('import { Pool } from "pg";');
			break;
		case "memory":
			lines.push('import { memoryAdapter } from "@summa/memory-adapter";');
			break;
	}

	if (opts.plugins.length > 0) {
		const names = opts.plugins
			.map((id) => availablePlugins.find((p) => p.value === id)?.importName ?? id)
			.join(", ");
		lines.push(`import { ${names} } from "summa/plugins";`);
	}

	lines.push("");

	switch (opts.adapterKey) {
		case "drizzle":
			lines.push("const db = drizzle(process.env.DATABASE_URL!);");
			break;
		case "prisma":
			lines.push("const prisma = new PrismaClient();");
			break;
		case "kysely":
			lines.push("const db = new Kysely({");
			lines.push(
				"  dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),",
			);
			lines.push("});");
			break;
	}

	lines.push("");
	lines.push("export const summa = createSumma({");

	switch (opts.adapterKey) {
		case "drizzle":
			lines.push("  database: drizzleAdapter(db),");
			break;
		case "prisma":
			lines.push("  database: prismaAdapter(prisma),");
			break;
		case "kysely":
			lines.push("  database: kyselyAdapter(db),");
			break;
		case "memory":
			lines.push("  database: memoryAdapter(),");
			break;
	}

	lines.push(`  currency: "${opts.currency}",`);

	lines.push("  systemAccounts: {");
	for (const [key, value] of Object.entries(opts.systemAccounts)) {
		lines.push(`    ${key}: "${value}",`);
	}
	lines.push("  },");

	if (opts.plugins.length > 0) {
		const calls = opts.plugins
			.map((id) => `${availablePlugins.find((p) => p.value === id)?.importName ?? id}()`)
			.join(", ");
		lines.push(`  plugins: [${calls}],`);
	} else {
		lines.push("  plugins: [],");
	}

	lines.push("});");
	lines.push("");

	return lines.join("\n");
}

// =============================================================================
// INIT COMMAND
// =============================================================================

export const initCommand = new Command("init")
	.description("Initialize a new summa configuration file")
	.option("-f, --force", "Overwrite existing config file")
	.option("-y, --yes", "Skip prompts and use defaults (drizzle, USD)")
	.action(async (options: { force?: boolean; yes?: boolean }) => {
		const parent = initCommand.parent;
		const cwd: string = parent?.opts().cwd ?? process.cwd();

		const existing = findConfigFile(cwd);
		const configPath = resolve(cwd, CONFIG_FILENAME);

		if (existing && !options.force) {
			p.log.warning(
				`Config already exists at ${pc.dim(existing)}. Use ${pc.bold("--force")} to overwrite.`,
			);
			process.exitCode = 1;
			return;
		}

		p.intro(pc.bgCyan(pc.black(" summa init ")));

		const pm = detectPackageManager(cwd);
		let adapterKey = "drizzle";
		let currency = "USD";
		let selectedPlugins: string[] = [];
		let systemAccounts: Record<string, string> = {
			world: "@World",
			fees: "@Fees",
			suspense: "@Suspense",
		};

		if (!options.yes) {
			// Step 1: Database Adapter
			p.log.step(pc.bold("1. Configure Database Adapter"));

			const adapterResult = await p.select({
				message: "Which database adapter?",
				options: adapters.map((a) => ({
					value: a.value,
					label: a.label,
					hint: a.hint,
				})),
				initialValue: "drizzle",
			});

			if (p.isCancel(adapterResult)) {
				p.cancel("Setup cancelled.");
				process.exit(0);
			}
			adapterKey = adapterResult;

			// Step 2: Currency
			p.log.step(pc.bold("2. Set Currency"));

			const currencyResult = await p.text({
				message: "Default currency code?",
				placeholder: "USD",
				defaultValue: "USD",
				validate: (v) => {
					if (v == null || !/^[A-Z]{3,4}$/.test(v.toUpperCase())) {
						return "Enter a valid ISO currency code (e.g. USD, EUR, INR)";
					}
				},
			});

			if (p.isCancel(currencyResult)) {
				p.cancel("Setup cancelled.");
				process.exit(0);
			}
			currency = currencyResult.toUpperCase();

			// Step 3: Plugins
			p.log.step(pc.bold("3. Select Plugins"));

			const pluginResult = await p.multiselect({
				message: "Which plugins do you want to enable?",
				options: availablePlugins.map((pl) => ({
					value: pl.value,
					label: pl.label,
					hint: pl.hint,
				})),
				required: false,
			});

			if (p.isCancel(pluginResult)) {
				p.cancel("Setup cancelled.");
				process.exit(0);
			}
			selectedPlugins = pluginResult;

			// Step 4: System Accounts
			p.log.step(pc.bold("4. System Accounts"));

			const useDefaults = await p.confirm({
				message: `Use default system accounts? ${pc.dim("(@World, @Fees, @Suspense)")}`,
				initialValue: true,
			});

			if (p.isCancel(useDefaults)) {
				p.cancel("Setup cancelled.");
				process.exit(0);
			}

			if (!useDefaults) {
				const worldName = await p.text({
					message: "World account identifier (global counterparty)",
					placeholder: "@World",
					defaultValue: "@World",
				});
				if (p.isCancel(worldName)) {
					p.cancel("Setup cancelled.");
					process.exit(0);
				}

				const feesName = await p.text({
					message: "Fees account identifier",
					placeholder: "@Fees",
					defaultValue: "@Fees",
				});
				if (p.isCancel(feesName)) {
					p.cancel("Setup cancelled.");
					process.exit(0);
				}

				const suspenseName = await p.text({
					message: "Suspense account identifier",
					placeholder: "@Suspense",
					defaultValue: "@Suspense",
				});
				if (p.isCancel(suspenseName)) {
					p.cancel("Setup cancelled.");
					process.exit(0);
				}

				systemAccounts = {
					world: worldName,
					fees: feesName,
					suspense: suspenseName,
				};
			}
		}

		// Generate config
		const adapter = adapters.find((a) => a.value === adapterKey);
		if (!adapter) {
			p.log.error("Unknown adapter selected.");
			process.exitCode = 1;
			return;
		}

		const config = generateConfigTemplate({
			adapterKey,
			currency,
			plugins: selectedPlugins,
			systemAccounts,
		});

		const s = p.spinner();
		s.start("Creating config file");
		writeFileSync(configPath, config, "utf-8");
		s.stop(`Created ${pc.bold(CONFIG_FILENAME)}`);

		// Next steps
		const deps = ["summa", adapter.pkg, ...adapter.peerDeps];
		const installCmd = getInstallCommand(pm, deps);

		const nextSteps: string[] = [
			`${pc.bold("1.")} Install dependencies:`,
			`   ${pc.cyan(installCmd)}`,
			"",
			`${pc.bold("2.")} Set your ${pc.cyan("DATABASE_URL")} environment variable:`,
			`   ${pc.dim('echo "DATABASE_URL=postgres://user:pass@localhost:5432/mydb" >> .env')}`,
		];

		if (adapterKey === "drizzle") {
			nextSteps.push(
				"",
				`${pc.bold("3.")} Generate & apply schema:`,
				`   ${pc.cyan("npx summa generate")}`,
				`   ${pc.cyan("npx drizzle-kit push")}`,
			);
		} else if (adapterKey === "prisma") {
			nextSteps.push(
				"",
				`${pc.bold("3.")} Generate & push schema:`,
				`   ${pc.cyan("npx summa generate")}`,
				`   ${pc.cyan("npx prisma db push")}`,
			);
		} else if (adapterKey === "kysely") {
			nextSteps.push(
				"",
				`${pc.bold("3.")} Apply schema:`,
				`   ${pc.cyan("npx summa migrate push")}`,
			);
		} else {
			nextSteps.push("", `${pc.bold("3.")} In-memory adapter requires no migrations`);
		}

		if (selectedPlugins.length > 0) {
			nextSteps.push(
				"",
				`${pc.bold("4.")} Plugins enabled: ${selectedPlugins.map((id) => pc.cyan(id)).join(", ")}`,
			);
		}

		p.note(nextSteps.join("\n"), "Next steps");

		p.outro(
			`${pc.green("You're all set!")} ${pc.dim("Read more at https://github.com/ShivamGupta-SM/summa")}`,
		);
	});
