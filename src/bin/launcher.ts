#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { loadSalt, saltPreview } from "../config/salt";
import { which } from "../util/which";

/**
 * Pure passthrough launcher. Spawns `claude` with stdio inherited so the user
 * experience is identical to running `claude` directly. The only side effect
 * is setting CLAUDE_LINK_* env vars so the MCP server (Claude's grandchild)
 * can self-verify the launcher path and resolve the salt without re-reading
 * its file.
 *
 * Earlier versions tried to PTY-wrap claude so peer messages could be
 * injected as user-typed input. node-pty + Bun + Windows ConPTY proved too
 * flaky in practice (`Socket is closed` races, dropped keystrokes), so we
 * dropped that and let the agent retrieve peer messages via the link_inbox
 * tool instead.
 */

const args = process.argv.slice(2);

async function main() {
	const salt = await loadSalt();
	const claudeBinName = process.env.CLAUDE_LINK_CLAUDE_BIN || "claude";
	const claudeBin = which(claudeBinName) ?? claudeBinName;
	const cwd = process.cwd();

	if (claudeBin === claudeBinName && which(claudeBinName) === null) {
		process.stderr.write(
			`claude-link: \`${claudeBinName}\` not found on PATH.\n` +
				`  Install Claude Code first (https://claude.com/code), or override the binary with:\n` +
				`    CLAUDE_LINK_CLAUDE_BIN=/full/path/to/claude claude-link\n`,
		);
		process.exit(127);
	}

	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_LINK_LAUNCHER: "1",
		CLAUDE_LINK_LAUNCHER_PID: String(process.pid),
		CLAUDE_LINK_LAUNCHER_CWD: cwd,
		CLAUDE_LINK_SALT_ORIGIN: salt.origin,
	};
	if (salt.value) env.CLAUDE_LINK_SALT = salt.value;

	if (process.stderr.isTTY) {
		const note = salt.value
			? `claude-link: salt loaded from ${salt.origin} (${saltPreview(salt.value)})`
			: `claude-link: WARNING — no salt configured. Run \`claude-link-config set <random>\` to enable peer connections.`;
		process.stderr.write(note + "\n");
	}

	const child = spawn(claudeBin, args, {
		stdio: "inherit",
		env,
		cwd,
		shell: false,
	});

	child.on("error", (err) => {
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
			try {
				process.kill(process.pid, signal);
			} catch {}
			return;
		}
		process.exit(code ?? 0);
	});
}

main().catch((err) => {
	process.stderr.write(`claude-link: ${err?.message ?? err}\n`);
	process.exit(1);
});
