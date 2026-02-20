import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

const generateCommand = new Command("generate")
	.description("Generate SQL migration files from the summa Drizzle schema")
	.option("-o, --out <dir>", "Output directory for migrations", "./drizzle")
	.action((options: { out: string }) => {
		p.intro(pc.bgCyan(pc.black(" summa migrate generate ")));

		p.note(
			[
				"Summa uses Drizzle ORM for database schema management.",
				"",
				`${pc.bold("1.")} Ensure your ${pc.cyan("drizzle.config.ts")} includes the summa schema:`,
				"",
				`   ${pc.dim('import { schema } from "@summa/drizzle-adapter/schema";')}`,
				"",
				`${pc.bold("2.")} Generate migrations:`,
				"",
				`   ${pc.cyan(`npx drizzle-kit generate --out ${options.out}`)}`,
				"",
				`${pc.bold("3.")} Apply migrations:`,
				"",
				`   ${pc.cyan("npx drizzle-kit push")}`,
				`   ${pc.dim("# or: npx drizzle-kit migrate")}`,
			].join("\n"),
			"Migration guide",
		);

		p.outro(pc.dim("Run these commands to generate and apply your schema changes."));
	});

const statusSubCommand = new Command("status").description("Show pending migrations").action(() => {
	p.intro(pc.bgCyan(pc.black(" summa migrate status ")));

	p.note(
		[
			"To check migration status, use drizzle-kit directly:",
			"",
			`  ${pc.cyan("npx drizzle-kit check")}`,
			"",
			pc.dim("This will show any pending schema changes that need to be migrated."),
		].join("\n"),
		"Migration status",
	);

	p.outro(pc.dim("Run the command above to see pending changes."));
});

export const migrateCommand = new Command("migrate")
	.description("Manage summa database migrations (via drizzle-kit)")
	.addCommand(generateCommand)
	.addCommand(statusSubCommand);
