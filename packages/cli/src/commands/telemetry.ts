import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

export const telemetryCommand = new Command("telemetry")
	.description("Manage anonymous telemetry")
	.argument("[action]", "on | off | status")
	.action(async (action?: string) => {
		const { isTelemetryEnabled, writeTelemetryState } = await import("@summa-ledger/telemetry");

		p.intro(pc.bgCyan(pc.black(" summa telemetry ")));

		switch (action) {
			case "on":
				writeTelemetryState(true);
				p.log.success(pc.green("Telemetry enabled."));
				p.note(
					[
						"Summa collects anonymous usage data to help improve the project.",
						"",
						`${pc.bold("What is collected:")}`,
						`  - CLI command usage ${pc.dim("(which commands are run)")}`,
						`  - Adapter type ${pc.dim("(drizzle, prisma, kysely)")}`,
						`  - Plugin usage ${pc.dim("(which plugins are enabled)")}`,
						`  - Error counts ${pc.dim("(no error details or stack traces)")}`,
						"",
						`${pc.bold("What is NOT collected:")}`,
						`  - Database URLs, secrets, or credentials`,
						`  - Transaction data, account info, or balances`,
						`  - Source code or file contents`,
						`  - Any personally identifiable information`,
					].join("\n"),
					"Telemetry info",
				);
				break;

			case "off":
				writeTelemetryState(false);
				p.log.info(pc.dim("Telemetry disabled."));
				break;

			case "status":
			case undefined: {
				const enabled = isTelemetryEnabled();
				if (enabled) {
					p.log.success(`Telemetry: ${pc.green("enabled")}`);
				} else {
					p.log.info(`Telemetry: ${pc.dim("disabled")}`);
				}
				p.log.info(
					pc.dim(
						`Run ${pc.cyan("summa telemetry on")} or ${pc.cyan("summa telemetry off")} to change.`,
					),
				);
				break;
			}

			default:
				p.log.error(`Unknown action: ${pc.bold(action)}. Use "on", "off", or "status".`);
				process.exitCode = 1;
		}

		p.outro(pc.dim("summa telemetry"));
	});
