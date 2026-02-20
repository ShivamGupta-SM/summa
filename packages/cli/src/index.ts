#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { migrateCommand } from "./commands/migrate.js";
import { statusCommand } from "./commands/status.js";
import { verifyCommand } from "./commands/verify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));

const program = new Command()
	.name("summa")
	.description("CLI for summa — event-sourced double-entry ledger")
	.version(pkg.version)
	.option("--cwd <dir>", "Working directory", process.cwd())
	.option("-c, --config <path>", "Path to summa config file");

program.addCommand(initCommand);
program.addCommand(migrateCommand);
program.addCommand(verifyCommand);
program.addCommand(statusCommand);

function sanitizeErrorMessage(message: string): string {
	return message
		.replace(/postgres(ql)?:\/\/[^\s]+/gi, "postgres://***")
		.replace(/(password|token|secret|key)[=:]\s*\S+/gi, "$1=***");
}

program.exitOverride();

try {
	await program.parseAsync();
} catch (error) {
	if (error instanceof Error && "code" in error && error.code === "commander.helpDisplayed") {
		process.exit(0);
	}
	const message = error instanceof Error ? error.message : String(error);
	console.error(sanitizeErrorMessage(message));
	process.exit(1);
}
