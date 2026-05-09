// Smoke test: does node + node-pty work on this Windows machine?
// Spawns `claude --version` (a quick non-interactive command) inside a PTY and
// reports whether anything comes out cleanly without crashes.
//
// Run:  node scripts/probe-pty.cjs

const pty = require("node-pty");

let received = "";
let exited = false;

const term = pty.spawn(process.platform === "win32" ? "claude.exe" : "claude", ["--version"], {
	name: "xterm-256color",
	cols: 80,
	rows: 24,
	cwd: process.cwd(),
	env: process.env,
});

const KILL_AFTER_MS = 8_000;
const killer = setTimeout(() => {
	if (!exited) {
		console.error(`probe-pty: TIMEOUT — claude --version did not exit within ${KILL_AFTER_MS}ms`);
		try { term.kill(); } catch {}
		process.exit(2);
	}
}, KILL_AFTER_MS);

term.onData((data) => {
	received += data;
});

term.onExit(({ exitCode }) => {
	exited = true;
	clearTimeout(killer);
	console.log("=== exit code:", exitCode);
	console.log("=== bytes received:", received.length);
	console.log("=== first 200 chars:");
	console.log(JSON.stringify(received.slice(0, 200)));
	process.exit(exitCode ?? 0);
});

// Try writing something during the run to provoke the same code path that
// crashed on Bun. claude --version exits before anything's written, but if
// the write path itself is broken we'll see ERR_SOCKET_CLOSED.
setTimeout(() => {
	try {
		term.write("\n");
	} catch (e) {
		console.error("write threw:", e?.message ?? e);
	}
}, 500);

process.on("uncaughtException", (err) => {
	console.error("UNCAUGHT:", err?.code, err?.message);
});
