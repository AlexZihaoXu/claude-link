#!/usr/bin/env bun
import * as pty from "node-pty";
import { loadSalt, saltPreview } from "../config/salt";
import { newIpcAddress, IPC_ENV_ADDR, IPC_ENV_TOKEN } from "../util/ipc-protocol";
import { IpcServer } from "../wrapper/ipc-server";
import { which } from "../util/which";

/**
 * Pure passthrough launcher. Spawns `claude` in a PTY and proxies stdin /
 * stdout / resize / signals so the user experience is identical to invoking
 * `claude` directly. The launcher's only side effect is hosting an IPC server
 * the MCP server (Claude's grandchild) connects to for inject-as-typed.
 *
 * The launcher takes NO args of its own — every argv is forwarded to claude.
 */

const args = process.argv.slice(2);

async function main() {
	const salt = await loadSalt();
	const ipc = newIpcAddress();

	const claudeBinName = process.env.CLAUDE_LINK_CLAUDE_BIN || "claude";
	// node-pty's spawn does not honor PATHEXT on Windows the way the OS shell
	// does, so resolve `claude` → `claude.exe` (or `.cmd` etc.) explicitly.
	const claudeBin = which(claudeBinName) ?? claudeBinName;
	const cwd = process.cwd();

	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_LINK_LAUNCHER: "1",
		CLAUDE_LINK_LAUNCHER_PID: String(process.pid),
		CLAUDE_LINK_LAUNCHER_CWD: cwd,
		CLAUDE_LINK_SALT_ORIGIN: salt.origin,
		[IPC_ENV_ADDR]: ipc.addr,
		[IPC_ENV_TOKEN]: ipc.token,
	};
	if (salt.value) env.CLAUDE_LINK_SALT = salt.value;

	const cols = process.stdout.columns ?? 80;
	const rows = process.stdout.rows ?? 24;
	const isTty = !!process.stdout.isTTY;

	// If `which` couldn't resolve and the user didn't override, fail fast with a
	// clear message instead of letting node-pty surface a cryptic
	// "File not found:" error.
	if (claudeBin === claudeBinName && which(claudeBinName) === null) {
		process.stderr.write(
			`claude-link: \`${claudeBinName}\` not found on PATH.\n` +
				`  Install Claude Code first (https://claude.com/code), or override the binary with:\n` +
				`    CLAUDE_LINK_CLAUDE_BIN=/full/path/to/claude claude-link\n`,
		);
		process.exit(127);
	}

	let term: pty.IPty;
	try {
		term = pty.spawn(claudeBin, args, {
			name: process.env.TERM ?? "xterm-256color",
			cols,
			rows,
			cwd,
			env: env as Record<string, string>,
		});
	} catch (err: any) {
		process.stderr.write(`claude-link: failed to spawn ${claudeBin}: ${err?.message ?? err}\n`);
		process.exit(1);
	}

	// Tell the user (only once, on stderr) where the salt came from so they
	// know whether they're in zero-config mode or running with their own.
	if (isTty) {
		const note = salt.value
			? `claude-link: salt loaded from ${salt.origin} (${saltPreview(salt.value)})`
			: `claude-link: WARNING — no salt configured. Run \`claude-link-config set <random>\` to enable peer connections.`;
		process.stderr.write(note + "\n");
	}

	// IPC server for the MCP grandchild.
	const ipcServer = new IpcServer(ipc.addr, ipc.token, {
		onInject: (bytes, _interrupt) => {
			term.write(bytes);
		},
	});
	await ipcServer.start();

	// stdin → PTY (raw mode so claude sees real keystrokes, including ESC)
	if (process.stdin.isTTY) {
		(process.stdin as any).setRawMode?.(true);
	}
	process.stdin.resume();
	process.stdin.on("data", (chunk: Buffer) => {
		term.write(chunk.toString("utf8"));
	});

	// PTY → stdout
	term.onData((data: string) => {
		process.stdout.write(data);
	});

	// Resize forwarding
	const onResize = () => {
		const c = process.stdout.columns ?? 80;
		const r = process.stdout.rows ?? 24;
		try {
			term.resize(c, r);
		} catch {}
	};
	process.stdout.on("resize", onResize);

	// Forward signals
	const onSignal = (sig: NodeJS.Signals) => {
		try {
			term.kill(sig);
		} catch {}
	};
	process.on("SIGINT", () => onSignal("SIGINT"));
	process.on("SIGTERM", () => onSignal("SIGTERM"));
	process.on("SIGHUP", () => onSignal("SIGHUP"));

	// Wait for claude to exit; proxy exit code.
	const exitInfo: { code: number; signal: number } = await new Promise((resolve) => {
		term.onExit(({ exitCode, signal }) => {
			resolve({ code: exitCode, signal: signal ?? 0 });
		});
	});

	// Restore terminal & cleanup
	if (process.stdin.isTTY) {
		try {
			(process.stdin as any).setRawMode?.(false);
		} catch {}
	}
	try {
		process.stdin.pause();
	} catch {}
	await ipcServer.stop();

	process.exit(exitInfo.code ?? 0);
}

main().catch((err) => {
	process.stderr.write(`claude-link: ${err?.message ?? err}\n`);
	process.exit(1);
});
