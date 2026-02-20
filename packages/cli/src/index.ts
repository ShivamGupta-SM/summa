#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTelemetry } from "@summa/telemetry";
import { Command } from "commander";
import pc from "picocolors";
import { generateCommand } from "./commands/generate.js";
import { infoCommand } from "./commands/info.js";
import { initCommand } from "./commands/init.js";
import { migrateCommand } from "./commands/migrate.js";
import { secretCommand } from "./commands/secret.js";
import { statusCommand } from "./commands/status.js";
import { telemetryCommand } from "./commands/telemetry.js";
import { verifyCommand } from "./commands/verify.js";

// Graceful shutdown
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const __dirname = dirname(fileURLToPath(import.meta.url));

let cliVersion = "0.1.0";
try {
	const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
	cliVersion = pkg.version ?? cliVersion;
} catch {
	// Fallback version
}

const BANNER = `
  ${pc.bold(pc.cyan("summa"))} ${pc.dim(`v${cliVersion}`)}
  ${pc.dim("Event-sourced double-entry ledger")}
`;

const program = new Command()
	.name("summa")
	.description("CLI for summa — event-sourced double-entry ledger")
	.version(cliVersion, "-v, --version")
	.option("--cwd <dir>", "Working directory", process.cwd())
	.option("-c, --config <path>", "Path to summa config file")
	.action(() => {
		console.log(BANNER);
		program.help();
	});

program.addCommand(initCommand);
program.addCommand(generateCommand);
program.addCommand(migrateCommand);
program.addCommand(statusCommand);
program.addCommand(verifyCommand);
program.addCommand(infoCommand);
program.addCommand(secretCommand);
program.addCommand(telemetryCommand);

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
	if (error instanceof Error && "code" in error && error.code === "commander.version") {
		process.exit(0);
	}
	const message = error instanceof Error ? error.message : String(error);
	const errorCode = error instanceof Error && "code" in error ? String(error.code) : undefined;

	// Track error via telemetry (fire-and-forget)
	const telemetry = createTelemetry({ version: cliVersion });
	const command = process.argv.slice(2).join(" ");
	telemetry.track("cli.error", { command, errorCode, message: sanitizeErrorMessage(message) });

	console.error(pc.red(sanitizeErrorMessage(message)));
	process.exit(1);
}
