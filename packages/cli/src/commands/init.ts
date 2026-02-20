import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

const CONFIG_FILENAME = "summa.config.ts";

interface AdapterChoice {
	value: string;
	label: string;
	hint: string;
	pkg: string;
	peerDeps: string[];
	template: (currency: string) => string;
}

const adapters: AdapterChoice[] = [
	{
		value: "drizzle",
		label: "Drizzle ORM",
		hint: "recommended",
		pkg: "@summa/drizzle-adapter",
		peerDeps: ["drizzle-orm"],
		template: (currency) => `import { defineConfig } from "summa/config";
import { drizzleAdapter } from "@summa/drizzle-adapter";
import { schema } from "@summa/drizzle-adapter/schema";
import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle(process.env.DATABASE_URL!);

export default defineConfig({
  database: drizzleAdapter({ db, schema }),
  currency: "${currency}",
  systemAccounts: {
    world: "@World",
    fees: "@Fees",
    suspense: "@Suspense",
  },
  plugins: [],
});
`,
	},
	{
		value: "prisma",
		label: "Prisma",
		hint: "prisma client",
		pkg: "@summa/prisma-adapter",
		peerDeps: ["@prisma/client"],
		template: (currency) => `import { defineConfig } from "summa/config";
import { prismaAdapter } from "@summa/prisma-adapter";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export default defineConfig({
  database: prismaAdapter({ prisma }),
  currency: "${currency}",
  systemAccounts: {
    world: "@World",
    fees: "@Fees",
    suspense: "@Suspense",
  },
  plugins: [],
});
`,
	},
	{
		value: "kysely",
		label: "Kysely",
		hint: "type-safe SQL",
		pkg: "@summa/kysely-adapter",
		peerDeps: ["kysely"],
		template: (currency) => `import { defineConfig } from "summa/config";
import { kyselyAdapter } from "@summa/kysely-adapter";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

const db = new Kysely({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),
});

export default defineConfig({
  database: kyselyAdapter({ db }),
  currency: "${currency}",
  systemAccounts: {
    world: "@World",
    fees: "@Fees",
    suspense: "@Suspense",
  },
  plugins: [],
});
`,
	},
	{
		value: "memory",
		label: "In-Memory",
		hint: "testing only",
		pkg: "@summa/memory-adapter",
		peerDeps: [],
		template: (currency) => `import { defineConfig } from "summa/config";
import { memoryAdapter } from "@summa/memory-adapter";

export default defineConfig({
  database: memoryAdapter(),
  currency: "${currency}",
  systemAccounts: {
    world: "@World",
    fees: "@Fees",
    suspense: "@Suspense",
  },
  plugins: [],
});
`,
	},
];

export const initCommand = new Command("init")
	.description("Initialize a new summa configuration file")
	.option("-f, --force", "Overwrite existing config file")
	.option("-y, --yes", "Skip prompts and use defaults (drizzle, USD)")
	.action(async (options: { force?: boolean; yes?: boolean }) => {
		const configPath = resolve(process.cwd(), CONFIG_FILENAME);

		if (existsSync(configPath) && !options.force) {
			p.log.warning(`${CONFIG_FILENAME} already exists. Use ${pc.bold("--force")} to overwrite.`);
			process.exitCode = 1;
			return;
		}

		p.intro(pc.bgCyan(pc.black(" summa init ")));

		let adapterKey = "drizzle";
		let currency = "USD";

		if (!options.yes) {
			const answers = await p.group(
				{
					adapter: () =>
						p.select({
							message: "Which database adapter?",
							options: adapters.map((a) => ({
								value: a.value,
								label: a.label,
								hint: a.hint,
							})),
							initialValue: "drizzle",
						}),
					currency: () =>
						p.text({
							message: "Default currency code?",
							placeholder: "USD",
							defaultValue: "USD",
							validate: (v) => {
								if (!/^[A-Z]{3,4}$/.test(v.toUpperCase())) {
									return "Enter a valid ISO currency code (e.g. USD, EUR, INR)";
								}
							},
						}),
				},
				{
					onCancel: () => {
						p.cancel("Setup cancelled.");
						process.exit(0);
					},
				},
			);

			adapterKey = answers.adapter;
			currency = answers.currency.toUpperCase();
		}

		const adapter = adapters.find((a) => a.value === adapterKey);
		if (!adapter) {
			p.log.error("Unknown adapter selected.");
			process.exitCode = 1;
			return;
		}
		const config = adapter.template(currency);

		const s = p.spinner();
		s.start("Creating config file");
		writeFileSync(configPath, config, "utf-8");
		s.stop(`Created ${pc.bold(CONFIG_FILENAME)}`);

		const deps = ["summa", adapter.pkg, ...adapter.peerDeps];

		p.note(
			[
				`${pc.bold("1.")} Install dependencies:`,
				`   ${pc.cyan(`pnpm add ${deps.join(" ")}`)}`,
				"",
				`${pc.bold("2.")} Set your ${pc.cyan("DATABASE_URL")} environment variable`,
				"",
				...(adapterKey === "drizzle"
					? [
							`${pc.bold("3.")} Generate & apply migrations:`,
							`   ${pc.cyan("npx drizzle-kit generate")}`,
							`   ${pc.cyan("npx drizzle-kit push")}`,
						]
					: adapterKey === "prisma"
						? [`${pc.bold("3.")} Push schema to database:`, `   ${pc.cyan("npx prisma db push")}`]
						: [`${pc.bold("3.")} Run your database migrations`]),
			].join("\n"),
			"Next steps",
		);

		p.outro(`You're all set! ${pc.dim("Read more at https://github.com/summa-ledger/summa")}`);
	});
