#!/usr/bin/env bun
import * as pty from "node-pty";
import { spawn as cpSpawn } from "node:child_process";
import { loadSalt, saltPreview } from "../config/salt";
import { newIpcAddress, IPC_ENV_ADDR, IPC_ENV_TOKEN } from "../util/ipc-protocol";
import { IpcServer } from "../wrapper/ipc-server";
import { which } from "../util/which";

// Suppress benign races between node-pty's internal socket and ConPTY/winpty
// teardown on Windows + Bun. `Socket is closed` errors here surface
// asynchronously from inside node-pty's own EventEmitter chain — there is no
// call site we can wrap to catch them. They're harmless: the worst case is a
// dropped keystroke / dropped inject. Swallow them; let everything else
// propagate normally.
process.on("uncaughtException", (err: any) => {
	if (err?.code === "ERR_SOCKET_CLOSED") return;
	console.error(err);
	process.exit(1);
});

/**
 * Headless claude modes (e.g. `--print` / `-p`) don't need a TTY and don't
 * need keystroke injection. Detecting them lets us bypass node-pty entirely,
 * which avoids both the Bun-on-Windows ConPTY rough edges and the unnecessary
 * IPC wiring.
 */
function isHeadlessMode(args: string[]): boolean {
	return args.some((a) => a === "--print" || a === "-p");
}

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

	if (isHeadlessMode(args)) {
		await runHeadless(claudeBinName, claudeBin, args, salt, ipc, cwd);
		return;
	}

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

	// Attach an error listener directly on the IPty (it extends EventEmitter
	// internally) so any error that gets emit'd doesn't crash the process. Most
	// of these are the same ConPTY socket race covered by uncaughtException
	// above; this is belt-and-suspenders.
	try {
		(term as any).on?.("error", () => {});
	} catch {}

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
			try {
				term.write(bytes);
			} catch {
				// PTY may have been torn down between the inject request and the
				// actual write. We don't surface the error to the MCP client —
				// it's transient and the agent will see "delivered" regardless.
			}
		},
	});
	await ipcServer.start();

	// stdin → PTY (raw mode so claude sees real keystrokes, including ESC)
	if (process.stdin.isTTY) {
		(process.stdin as any).setRawMode?.(true);
	}
	process.stdin.resume();
	process.stdin.on("data", (chunk: Buffer) => {
		try {
			term.write(chunk.toString("utf8"));
		} catch {
			// Same rationale as the inject handler — node-pty's write can fire
			// "Socket is closed" if ConPTY raced ahead. Don't crash the launcher.
		}
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

async function runHeadless(
	claudeBinName: string,
	claudeBin: string,
	args: string[],
	salt: Awaited<ReturnType<typeof loadSalt>>,
	ipc: ReturnType<typeof newIpcAddress>,
	cwd: string,
): Promise<void> {
	if (claudeBin === claudeBinName && which(claudeBinName) === null) {
		process.stderr.write(
			`claude-link: \`${claudeBinName}\` not found on PATH.\n` +
				`  Install Claude Code first (https://claude.com/code), or override with CLAUDE_LINK_CLAUDE_BIN.\n`,
		);
		process.exit(127);
	}

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

	const child = cpSpawn(claudeBin, args, {
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

	await new Promise<void>((resolve) => {
		child.on("exit", (code, signal) => {
			if (signal) {
				try {
					process.kill(process.pid, signal);
				} catch {}
				resolve();
				return;
			}
			process.exit(code ?? 0);
		});
	});
}

main().catch((err) => {
	process.stderr.write(`claude-link: ${err?.message ?? err}\n`);
	process.exit(1);
});
