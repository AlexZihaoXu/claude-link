#!/usr/bin/env bun
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { loadSalt, saltPreview } from "../config/salt";
import { saltFilePath } from "../config/paths";

const args = process.argv.slice(2);
const op = args[0];

async function run() {
	if (op === "path") {
		console.log(saltFilePath());
		return;
	}
	if (op === "get") {
		const salt = await loadSalt();
		console.log(JSON.stringify({ origin: salt.origin, preview: saltPreview(salt.value) }));
		return;
	}
	if (op === "set") {
		const value = args.slice(1).join(" ").trim();
		if (!value) {
			process.stderr.write(
				`claude-link-config set <salt> — provide the salt as the next argument(s).\n`,
			);
			process.exit(2);
		}
		const path = saltFilePath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, value + "\n", "utf8");
		try {
			await chmod(path, 0o600);
		} catch {}
		process.stderr.write(`claude-link-config: salt written to ${path}\n`);
		return;
	}
	process.stderr.write(
		`Usage: claude-link-config <get|set|path>\n` +
			`  get   — print where the current salt comes from (no value leak)\n` +
			`  set   — write a salt to ${saltFilePath()}\n` +
			`  path  — print the salt file path\n`,
	);
	process.exit(2);
}

await run();
