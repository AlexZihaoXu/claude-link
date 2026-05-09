#!/usr/bin/env node
// claude-link launcher — runs under Node (NOT Bun) because node-pty + Bun +
// Windows ConPTY is unreliable. This file is generated/maintained by hand
// rather than compiled from TS so installs from github work without a build
// step. Keep it small.

"use strict";

const pty = require("node-pty");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// ---------- env ----------

const args = process.argv.slice(2);
const claudeBinName = process.env.CLAUDE_LINK_CLAUDE_BIN || "claude";

function which(name) {
	if (!name) return null;
	if (path.isAbsolute(name) || name.includes(path.sep) || name.includes("/")) {
		return existsAsFile(name) ? name : null;
	}
	const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
	const exts =
		process.platform === "win32"
			? ["", ...((process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase()))]
			: [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			const p = path.join(dir, name + ext);
			if (existsAsFile(p)) return p;
		}
	}
	return null;
}
function existsAsFile(p) {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

const claudeBin = which(claudeBinName);
if (!claudeBin) {
	process.stderr.write(
		`claude-link: \`${claudeBinName}\` not found on PATH.\n` +
			`  Install Claude Code first (https://claude.com/code), or set CLAUDE_LINK_CLAUDE_BIN.\n`,
	);
	process.exit(127);
}

// ---------- salt + config dir (mirrors src/config/salt + paths) ----------

function configDir() {
	if (process.platform === "win32" && process.env.APPDATA) {
		return path.join(process.env.APPDATA, "claude-link");
	}
	return path.join(os.homedir(), ".config", "claude-link");
}
function saltFilePath() {
	return process.env.CLAUDE_LINK_SALT_FILE || path.join(configDir(), "salt");
}
function loadSalt() {
	const env = process.env.CLAUDE_LINK_SALT;
	if (env && env.trim()) return { value: env.trim(), origin: "env" };
	try {
		const raw = fs.readFileSync(saltFilePath(), "utf8").trim();
		if (raw) return { value: raw, origin: "file" };
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	return { value: null, origin: "none" };
}
function saltPreview(salt) {
	if (!salt) return "(none)";
	if (salt.length <= 6) return "***";
	return salt.slice(0, 3) + "…" + salt.slice(-3);
}

// ---------- IPC (mirrors src/util/ipc-protocol + wrapper/ipc-server) ----------

function newIpcAddress() {
	const id = crypto.randomBytes(8).toString("hex");
	const token = crypto.randomBytes(16).toString("hex");
	if (process.platform === "win32") {
		return { addr: `\\\\.\\pipe\\claude-link-${process.pid}-${id}`, token };
	}
	return { addr: path.join(os.tmpdir(), `claude-link-${process.pid}-${id}.sock`), token };
}

function startIpcServer({ addr, token, onInject }) {
	if (process.platform !== "win32") {
		try {
			fs.unlinkSync(addr);
		} catch {}
	}
	const clients = new Set();
	const server = net.createServer((sock) => {
		clients.add(sock);
		sock.setEncoding("utf8");
		let authed = false;
		let buf = "";
		const reply = (msg) => {
			try {
				sock.write(JSON.stringify(msg) + "\n");
			} catch {}
		};
		sock.on("data", (chunk) => {
			buf += chunk;
			while (true) {
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				let req;
				try {
					req = JSON.parse(line);
				} catch {
					reply({ id: 0, ok: false, error: { code: "bad-json", msg: "bad json" } });
					continue;
				}
				switch (req.op) {
					case "auth":
						if (req.token === token) {
							authed = true;
							reply({ id: req.id, ok: true });
						} else {
							reply({ id: req.id, ok: false, error: { code: "bad-token", msg: "auth failed" } });
							sock.end();
						}
						break;
					case "ping":
						if (!authed) {
							reply({ id: req.id, ok: false, error: { code: "unauth", msg: "auth required" } });
							sock.end();
						} else reply({ id: req.id, ok: true });
						break;
					case "inject":
						if (!authed) {
							reply({ id: req.id, ok: false, error: { code: "unauth", msg: "auth required" } });
							sock.end();
							break;
						}
						try {
							onInject(req.bytes, !!req.interrupt);
							reply({ id: req.id, ok: true });
						} catch (err) {
							reply({ id: req.id, ok: false, error: { code: "inject-failed", msg: err.message } });
						}
						break;
					default:
						reply({
							id: (req && req.id) || 0,
							ok: false,
							error: { code: "unknown-op", msg: "unknown op " + (req && req.op) },
						});
				}
			}
		});
		sock.on("close", () => clients.delete(sock));
		sock.on("error", () => clients.delete(sock));
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(addr, () => {
			server.off("error", reject);
			resolve({
				stop: () =>
					new Promise((r) => {
						for (const c of clients) {
							try {
								c.destroy();
							} catch {}
						}
						clients.clear();
						server.close(() => {
							if (process.platform !== "win32") {
								try {
									fs.unlinkSync(addr);
								} catch {}
							}
							r();
						});
					}),
			});
		});
	});
}

// ---------- main ----------

(async function main() {
	const salt = loadSalt();
	const ipc = newIpcAddress();
	const cwd = process.cwd();

	const env = Object.assign({}, process.env, {
		CLAUDE_LINK_LAUNCHER: "1",
		CLAUDE_LINK_LAUNCHER_PID: String(process.pid),
		CLAUDE_LINK_LAUNCHER_CWD: cwd,
		CLAUDE_LINK_SALT_ORIGIN: salt.origin,
		CLAUDE_LINK_IPC_ADDR: ipc.addr,
		CLAUDE_LINK_IPC_TOKEN: ipc.token,
	});
	if (salt.value) env.CLAUDE_LINK_SALT = salt.value;

	if (process.stderr.isTTY) {
		const note = salt.value
			? `claude-link: salt loaded from ${salt.origin} (${saltPreview(salt.value)})`
			: `claude-link: WARNING — no salt configured. Run \`claude-link-config set <random>\` to enable peer connections.`;
		process.stderr.write(note + "\n");
	}

	const cols = process.stdout.columns || 80;
	const rows = process.stdout.rows || 24;

	let term;
	try {
		term = pty.spawn(claudeBin, args, {
			name: process.env.TERM || "xterm-256color",
			cols,
			rows,
			cwd,
			env,
		});
	} catch (err) {
		process.stderr.write(`claude-link: failed to spawn ${claudeBin}: ${err && err.message}\n`);
		process.exit(1);
	}

	const ipcServer = await startIpcServer({
		addr: ipc.addr,
		token: ipc.token,
		onInject: (bytes /*, interrupt */) => {
			try {
				term.write(bytes);
			} catch {}
		},
	});

	if (process.stdin.isTTY) {
		try {
			process.stdin.setRawMode(true);
		} catch {}
	}
	process.stdin.resume();
	// Forward stdin as raw bytes — converting Buffer → utf8 string can mangle
	// control bytes (e.g. backspace 0x7f gets misinterpreted, which is why
	// Backspace on Git Bash was acting like Ctrl+W / "delete word").
	process.stdin.on("data", (chunk) => {
		try {
			term.write(chunk);
		} catch {}
	});

	term.onData((data) => {
		try {
			process.stdout.write(data);
		} catch {}
	});

	const onResize = () => {
		try {
			term.resize(process.stdout.columns || 80, process.stdout.rows || 24);
		} catch {}
	};
	process.stdout.on("resize", onResize);

	const onSig = (sig) => {
		try {
			term.kill(sig);
		} catch {}
	};
	process.on("SIGINT", () => onSig("SIGINT"));
	process.on("SIGTERM", () => onSig("SIGTERM"));
	if (process.platform !== "win32") process.on("SIGHUP", () => onSig("SIGHUP"));

	term.onExit(({ exitCode }) => {
		(async () => {
			// Restore terminal modes that claude (or any TUI) may have set and
			// not cleaned up: focus-events, win32-input-mode, mouse modes,
			// alternate screen, bracketed paste, plus a cursor-on. Without this,
			// the host terminal can send stray escape responses to bash that
			// look like garbage at the prompt (";32;100;1;...").
			try {
				process.stdout.write(
					"\x1b[?1004l" + // focus events off
						"\x1b[?9001l" + // win32-input-mode off
						"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" + // mouse modes off
						"\x1b[?1049l" + // leave alt-screen if still in
						"\x1b[?2004l" + // bracketed paste off
						"\x1b[?25h", // cursor on
				);
			} catch {}

			if (process.stdin.isTTY) {
				try {
					process.stdin.setRawMode(false);
				} catch {}
			}
			// Drop any bytes the terminal queued up (e.g. delayed query
			// responses) so they don't leak into bash's read buffer.
			try {
				process.stdin.removeAllListeners("data");
				process.stdin.pause();
			} catch {}
			try {
				await ipcServer.stop();
			} catch {}
			process.exit(exitCode == null ? 0 : exitCode);
		})();
	});

	process.on("uncaughtException", (err) => {
		if (err && err.code === "ERR_SOCKET_CLOSED") return;
		console.error(err);
		process.exit(1);
	});
})();
