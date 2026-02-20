import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { platform } from "node:os";
import { Command } from "commander";
import pc from "picocolors";

export const secretCommand = new Command("secret")
	.description("Generate a random secret key")
	.option("-l, --length <n>", "Length in bytes", "32")
	.option("--base64", "Output in base64 instead of hex")
	.option("--env", "Output in .env format (SUMMA_SECRET=...)")
	.option("--copy", "Copy to clipboard")
	.action((options: { length: string; base64?: boolean; env?: boolean; copy?: boolean }) => {
		const length = parseInt(options.length, 10);
		if (!Number.isFinite(length) || length < 1 || length > 1024) {
			console.error("Length must be between 1 and 1024");
			process.exitCode = 1;
			return;
		}

		const bytes = randomBytes(length);
		const secret = options.base64 ? bytes.toString("base64") : bytes.toString("hex");

		if (options.env) {
			const output = `SUMMA_SECRET=${secret}`;
			process.stdout.write(`${output}\n`);

			if (options.copy) {
				try {
					const os = platform();
					if (os === "darwin") execSync("pbcopy", { input: output });
					else if (os === "linux") execSync("xclip -selection clipboard", { input: output });
					else if (os === "win32") execSync("clip", { input: output });
					console.error(pc.green("Copied to clipboard"));
				} catch {
					console.error(pc.yellow("Could not copy to clipboard"));
				}
			}
		} else {
			process.stdout.write(`${secret}\n`);

			if (options.copy) {
				try {
					const os = platform();
					if (os === "darwin") execSync("pbcopy", { input: secret });
					else if (os === "linux") execSync("xclip -selection clipboard", { input: secret });
					else if (os === "win32") execSync("clip", { input: secret });
					console.error(pc.green("Copied to clipboard"));
				} catch {
					console.error(pc.yellow("Could not copy to clipboard"));
				}
			}
		}
	});
