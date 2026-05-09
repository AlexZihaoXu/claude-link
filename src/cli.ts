#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { loadSalt, saltPreview } from "./config/salt";
import { saltFilePath } from "./config/paths";
import { discoverSessionId } from "./config/session";
import { deriveAgentId, derivePeerId } from "./peer/id";

const argv = process.argv.slice(2);

async function main() {
	const sub = argv[0];

	if (!sub || sub === "--help" || sub === "-h") {
		// Implicit launcher when called bare? No — bare `claude-link` with no args
		// should print help, not silently exec claude. Users get the launcher with
		// `claude-link run` or by passing args (handled below).
		return showHelp(sub === undefined ? 0 : 0);
	}
	if (sub === "--version" || sub === "-v") {
		const { default: pkg } = await import("../package.json", { with: { type: "json" } });
		console.log(pkg.version);
		return;
	}

	switch (sub) {
		case "mcp":
			await (await import("./mcp")).run();
			return;
		case "id":
			await runId(argv.slice(1));
			return;
		case "config":
			await runConfig(argv.slice(1));
			return;
		case "run":
			await runLauncher(argv.slice(1));
			return;
		default:
			// Unknown subcommand — assume it's intended as a `claude` arg and
			// auto-run as launcher. This is what makes `claude-link --resume`
			// (and similar) work without users having to write `run --` first.
			await runLauncher(argv);
			return;
	}
}

function showHelp(exitCode: number): never {
	const help = `claude-link — P2P bridge between two Claude Code sessions

Usage:
  claude-link [<claude args>...]    Launch \`claude\` with the link environment set up.
                                    All args after the command are forwarded to claude.
  claude-link run [<claude args>]   Same as above, explicit form.
  claude-link mcp                   MCP stdio server (Claude spawns this; you don't run it).
  claude-link id [<session-id>]     Print the agent-id for a session-id (defaults to current session).
  claude-link config get|set|path   Manage the salt.
  claude-link --version             Print version.

Quick start:
  1. claude-link config set <a long random string>
  2. claude-link
  (in another terminal / on another machine, repeat with the SAME salt)
`;
	process.stdout.write(help);
	process.exit(exitCode);
}

/* ---------- launcher ---------- */

async function runLauncher(args: string[]): Promise<void> {
	const salt = await loadSalt();

	// Always set the launcher marker so the MCP server can verify the user
	// went through us. We also propagate the salt origin so MCP tools can
	// give better error messages.
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_LINK_LAUNCHER: "1",
		CLAUDE_LINK_LAUNCHER_PID: String(process.pid),
		CLAUDE_LINK_LAUNCHER_CWD: process.cwd(),
		CLAUDE_LINK_SALT_ORIGIN: salt.origin,
	};

	if (salt.value) {
		childEnv.CLAUDE_LINK_SALT = salt.value;
	}

	if (salt.origin === "none") {
		process.stderr.write(
			`claude-link: WARNING — no salt configured. The MCP server will refuse to connect peers until one is set.\n` +
				`  Run:  claude-link config set <a long random string>\n` +
				`  (Both ends of any link must use the same salt.)\n\n`,
		);
	} else {
		process.stderr.write(
			`claude-link: salt loaded from ${salt.origin} (${saltPreview(salt.value)})\n`,
		);
	}

	const claudeBin = process.env.CLAUDE_LINK_CLAUDE_BIN || "claude";
	const child = spawn(claudeBin, args, {
		stdio: "inherit",
		env: childEnv,
		shell: false,
	});

	child.on("error", (err) => {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			process.stderr.write(
				`claude-link: \`${claudeBin}\` not found on PATH. Install Claude Code first, or set CLAUDE_LINK_CLAUDE_BIN.\n`,
			);
			process.exit(127);
		}
		process.stderr.write(`claude-link: failed to spawn ${claudeBin}: ${err.message}\n`);
		process.exit(1);
	});

	const passSig = (sig: NodeJS.Signals) => {
		try {
			child.kill(sig);
		} catch {}
	};
	process.on("SIGINT", () => passSig("SIGINT"));
	process.on("SIGTERM", () => passSig("SIGTERM"));
	process.on("SIGHUP", () => passSig("SIGHUP"));

	child.on("exit", (code, signal) => {
		if (signal) {
			// Re-raise the same signal so our exit reflects it.
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 0);
	});
}

/* ---------- id ---------- */

async function runId(args: string[]): Promise<void> {
	const salt = await loadSalt();
	let sessionId: string | undefined = args[0];

	if (!sessionId) {
		const found = await discoverSessionId(process.cwd(), 1_000);
		if (!found) {
			process.stderr.write(
				`claude-link id: no session-id given and no recent JSONL in this project's claude dir.\n` +
					`  Pass one explicitly:  claude-link id <uuid>\n`,
			);
			process.exit(2);
		}
		sessionId = found.sessionId;
		process.stderr.write(`claude-link: using newest session ${sessionId}\n`);
	}

	const agentId = deriveAgentId(sessionId);
	console.log(`agent-id: ${agentId}`);
	if (salt.value) {
		console.log(`peer-id : ${derivePeerId(agentId, salt.value)}`);
	} else {
		console.log("peer-id : (no salt configured — set one to derive)");
	}
}

/* ---------- config ---------- */

async function runConfig(args: string[]): Promise<void> {
	const op = args[0];
	const { mkdir, writeFile, readFile, chmod } = await import("node:fs/promises");
	const { dirname } = await import("node:path");

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
				`claude-link config set <salt> — provide the salt as the next argument(s).\n`,
			);
			process.exit(2);
		}
		const path = saltFilePath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, value + "\n", "utf8");
		// Best-effort: lock down on POSIX. Windows ignores chmod silently.
		try {
			await chmod(path, 0o600);
		} catch {}
		process.stderr.write(`claude-link: salt written to ${path}\n`);
		return;
	}
	process.stderr.write(
		`claude-link config <get|set|path>\n` +
			`  get   — print where the current salt comes from (no value leak)\n` +
			`  set   — write a salt to ${saltFilePath()}\n` +
			`  path  — print the salt file path\n`,
	);
	process.exit(2);
}

await main();
