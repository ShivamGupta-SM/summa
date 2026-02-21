import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
// FRAMEWORK DEFINITIONS
// =============================================================================

interface FrameworkChoice {
	value: string;
	label: string;
	hint: string;
	handlerImport: string;
	handlerFactory: string;
	routeFile: string;
}

const frameworks: FrameworkChoice[] = [
	{
		value: "next",
		label: "Next.js",
		hint: "App Router catch-all route",
		handlerImport: 'import { createSummaNextHandler } from "summa/api/next";',
		handlerFactory: "createSummaNextHandler",
		routeFile: "app/api/ledger/[...path]/route.ts",
	},
	{
		value: "hono",
		label: "Hono",
		hint: "lightweight web framework",
		handlerImport: 'import { createSummaHono } from "summa/api/hono";',
		handlerFactory: "createSummaHono",
		routeFile: "src/routes/ledger.ts",
	},
	{
		value: "express",
		label: "Express",
		hint: "classic Node.js framework",
		handlerImport: 'import { createSummaExpress } from "summa/api/express";',
		handlerFactory: "createSummaExpress",
		routeFile: "src/routes/ledger.ts",
	},
	{
		value: "fastify",
		label: "Fastify",
		hint: "high-performance framework",
		handlerImport: 'import { createSummaFastify } from "summa/api/fastify";',
		handlerFactory: "createSummaFastify",
		routeFile: "src/routes/ledger.ts",
	},
	{
		value: "none",
		label: "None / Other",
		hint: "skip API route scaffolding",
		handlerImport: "",
		handlerFactory: "",
		routeFile: "",
	},
];

function detectFramework(cwd: string): string | null {
	const pkgPath = resolve(cwd, "package.json");
	if (!existsSync(pkgPath)) return null;

	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

		if ("next" in allDeps) return "next";
		if ("hono" in allDeps) return "hono";
		if ("fastify" in allDeps) return "fastify";
		if ("express" in allDeps) return "express";
	} catch {
		// Ignore parse errors
	}
	return null;
}

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
// ROUTE FILE GENERATOR
// =============================================================================

function generateRouteFile(framework: FrameworkChoice): string {
	const lines: string[] = [];

	switch (framework.value) {
		case "next":
			lines.push('import { summa } from "@/summa.config";');
			lines.push(framework.handlerImport);
			lines.push("");
			lines.push(
				`const handler = ${framework.handlerFactory}(summa, { basePath: "/api/ledger" });`,
			);
			lines.push("");
			lines.push("export const { GET, POST, PUT, PATCH, DELETE } = handler;");
			break;
		case "hono":
			lines.push('import { summa } from "../summa.config";');
			lines.push(framework.handlerImport);
			lines.push("");
			lines.push(
				`export const ledger = ${framework.handlerFactory}(summa, { basePath: "/ledger" });`,
			);
			break;
		case "express":
			lines.push('import { summa } from "../summa.config";');
			lines.push(framework.handlerImport);
			lines.push("");
			lines.push(
				`export const ledgerRouter = ${framework.handlerFactory}(summa, { basePath: "/ledger" });`,
			);
			lines.push("");
			lines.push("// app.use('/ledger', ledgerRouter);");
			break;
		case "fastify":
			lines.push('import { summa } from "../summa.config";');
			lines.push(framework.handlerImport);
			lines.push("");
			lines.push(
				`export const ledgerPlugin = ${framework.handlerFactory}(summa, { basePath: "/ledger" });`,
			);
			lines.push("");
			lines.push("// fastify.register(ledgerPlugin);");
			break;
	}

	lines.push("");
	return lines.join("\n");
}

// =============================================================================
// CLIENT SDK TEMPLATE GENERATOR
// =============================================================================

function generateClientTemplate(opts: { configPath: string; framework?: string }): string {
	const lines: string[] = [];

	lines.push('import { createSummaClient } from "@summa/client";');
	lines.push(`import type { InferSummaClient } from "@summa/client";`);
	lines.push(`import type { summa } from "./${opts.configPath.replace(/\.ts$/, "")}";`);
	lines.push("");
	lines.push("// Infer the full client type from your server-side Summa instance.");
	lines.push("// This gives you autocompletion for all accounts, transactions, holds, etc.");
	lines.push("type SummaClient = InferSummaClient<typeof summa>;");
	lines.push("");
	lines.push("export const client = createSummaClient<SummaClient>({");
	lines.push('  baseURL: process.env.NEXT_PUBLIC_SUMMA_URL ?? "http://localhost:3000/api/ledger",');
	lines.push("});");
	lines.push("");

	if (opts.framework === "next") {
		lines.push("// React hooks (Next.js / React)");
		lines.push('// import { createSummaReact } from "@summa/client/react";');
		lines.push("// export const { useSumma, SummaProvider } = createSummaReact(client);");
	}

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
		let frameworkKey = "none";
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

			// Step 2: Framework
			p.log.step(pc.bold("2. API Framework"));

			const detected = detectFramework(cwd);
			const frameworkOptions = frameworks.map((f) => ({
				value: f.value,
				label: f.label,
				hint: detected === f.value ? "detected" : f.hint,
			}));

			const frameworkResult = await p.select({
				message: "Which framework for API routes?",
				options: frameworkOptions,
				initialValue: detected ?? "none",
			});

			if (p.isCancel(frameworkResult)) {
				p.cancel("Setup cancelled.");
				process.exit(0);
			}
			frameworkKey = frameworkResult;

			// Step 3: Currency
			p.log.step(pc.bold("3. Set Currency"));

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

			// Step 4: Plugins
			p.log.step(pc.bold("4. Select Plugins"));

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

			// Step 5: System Accounts
			p.log.step(pc.bold("5. System Accounts"));

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

		// Generate .env.example if DATABASE_URL not already present
		if (adapterKey !== "memory") {
			const envExamplePath = resolve(cwd, ".env.example");
			let shouldWrite = true;

			if (existsSync(envExamplePath)) {
				const content = readFileSync(envExamplePath, "utf-8");
				if (content.includes("DATABASE_URL")) {
					shouldWrite = false;
				}
			}

			if (shouldWrite) {
				const envLine = "DATABASE_URL=postgres://user:pass@localhost:5432/mydb\n";
				if (existsSync(envExamplePath)) {
					const existing = readFileSync(envExamplePath, "utf-8");
					writeFileSync(envExamplePath, `${existing.trimEnd()}\n${envLine}`, "utf-8");
				} else {
					writeFileSync(envExamplePath, envLine, "utf-8");
				}
				p.log.success(`Created ${pc.bold(".env.example")} with DATABASE_URL`);
			}
		}

		// Scaffold API route handler
		const framework = frameworks.find((f) => f.value === frameworkKey);
		if (framework && framework.value !== "none" && framework.routeFile) {
			const routePath = resolve(cwd, framework.routeFile);
			if (!existsSync(routePath)) {
				const routeContent = generateRouteFile(framework);
				mkdirSync(dirname(routePath), { recursive: true });
				writeFileSync(routePath, routeContent, "utf-8");
				p.log.success(`Created ${pc.bold(framework.routeFile)}`);
			} else {
				p.log.info(`Route file already exists: ${pc.dim(framework.routeFile)}`);
			}
		}

		// Auto-install dependencies
		const deps = ["summa", adapter.pkg, ...adapter.peerDeps];
		const installCmd = getInstallCommand(pm, deps);
		let installed = false;

		if (!options.yes) {
			const shouldInstall = await p.confirm({
				message: `Install dependencies? ${pc.dim(installCmd)}`,
				initialValue: true,
			});

			if (!p.isCancel(shouldInstall) && shouldInstall) {
				const installSpinner = p.spinner();
				installSpinner.start("Installing dependencies");
				try {
					execSync(installCmd, { cwd, stdio: "pipe" });
					installSpinner.stop(`Installed ${pc.bold(deps.join(", "))}`);
					installed = true;
				} catch {
					installSpinner.stop(pc.red("Install failed"));
					p.log.warning(
						`Could not install automatically. Run manually:\n   ${pc.cyan(installCmd)}`,
					);
				}
			}
		}

		// Generate client SDK file
		if (!options.yes) {
			const shouldGenClient = await p.confirm({
				message: `Generate client SDK file? ${pc.dim("src/summa.client.ts")}`,
				initialValue: true,
			});

			if (!p.isCancel(shouldGenClient) && shouldGenClient) {
				const clientPath = resolve(cwd, "src/summa.client.ts");
				if (!existsSync(clientPath)) {
					const clientContent = generateClientTemplate({
						configPath: CONFIG_FILENAME,
						framework: frameworkKey !== "none" ? frameworkKey : undefined,
					});
					mkdirSync(dirname(clientPath), { recursive: true });
					writeFileSync(clientPath, clientContent, "utf-8");
					p.log.success(`Created ${pc.bold("src/summa.client.ts")}`);

					// Add @summa/client to install if not already installed
					if (!installed) {
						p.log.info(
							`Don't forget to install the client: ${pc.cyan(getInstallCommand(pm, ["@summa/client"]))}`,
						);
					} else {
						// Install client package too
						try {
							execSync(getInstallCommand(pm, ["@summa/client"]), { cwd, stdio: "pipe" });
							p.log.success(`Installed ${pc.bold("@summa/client")}`);
						} catch {
							p.log.info(
								`Install client manually: ${pc.cyan(getInstallCommand(pm, ["@summa/client"]))}`,
							);
						}
					}
				} else {
					p.log.info(`Client file already exists: ${pc.dim("src/summa.client.ts")}`);
				}
			}
		}

		// Next steps
		const nextSteps: string[] = [];
		let stepNum = 1;

		if (!installed) {
			nextSteps.push(
				`${pc.bold(`${stepNum}.`)} Install dependencies:`,
				`   ${pc.cyan(installCmd)}`,
				"",
			);
			stepNum++;
		}

		if (adapterKey !== "memory") {
			nextSteps.push(
				`${pc.bold(`${stepNum}.`)} Set your ${pc.cyan("DATABASE_URL")} environment variable:`,
				`   ${pc.dim('echo "DATABASE_URL=postgres://user:pass@localhost:5432/mydb" >> .env')}`,
			);
			stepNum++;
		}

		if (adapterKey === "drizzle") {
			nextSteps.push(
				"",
				`${pc.bold(`${stepNum}.`)} Generate & apply schema:`,
				`   ${pc.cyan("npx summa generate")}`,
				`   ${pc.cyan("npx drizzle-kit push")}`,
			);
			stepNum++;
		} else if (adapterKey === "prisma") {
			nextSteps.push(
				"",
				`${pc.bold(`${stepNum}.`)} Generate & push schema:`,
				`   ${pc.cyan("npx summa generate")}`,
				`   ${pc.cyan("npx prisma db push")}`,
			);
			stepNum++;
		} else if (adapterKey === "kysely") {
			nextSteps.push(
				"",
				`${pc.bold(`${stepNum}.`)} Apply schema:`,
				`   ${pc.cyan("npx summa migrate push")}`,
			);
			stepNum++;
		} else {
			nextSteps.push("", `${pc.bold(`${stepNum}.`)} In-memory adapter requires no migrations`);
			stepNum++;
		}

		if (selectedPlugins.length > 0) {
			nextSteps.push(
				"",
				`${pc.bold(`${stepNum}.`)} Plugins enabled: ${selectedPlugins.map((id) => pc.cyan(id)).join(", ")}`,
			);
		}

		if (nextSteps.length > 0) {
			p.note(nextSteps.join("\n"), "Next steps");
		}

		p.outro(
			`${pc.green("You're all set!")} ${pc.dim("Read more at https://github.com/summa-ledger/summa")}`,
		);
	});
