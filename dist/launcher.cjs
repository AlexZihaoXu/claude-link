#!/usr/bin/env node
// claude-link launcher — runs under Node (NOT Bun) because node-pty + Bun +
// Windows ConPTY is unreliable. This file is generated/maintained by hand
// rather than compiled from TS so installs from github work without a build
// step. Keep it small.

"use strict";

// node-pty ships a `spawn-helper` binary in its prebuilds dir on POSIX.
// Some installers (notably bun's global install) drop the executable bit,
// causing `pty.spawn` to fail with a bare "posix_spawnp failed" the first
// time anything is launched. Restore +x before loading node-pty so the
// fix is in place by the time spawn() runs.
(function ensureSpawnHelperExecutable() {
	if (process.platform === "win32") return;
	try {
		const fsLocal = require("node:fs");
		const pathLocal = require("node:path");
		const ptyPkg = require.resolve("node-pty/package.json");
		const root = pathLocal.dirname(ptyPkg);
		const arch = process.arch;
		const helper = pathLocal.join(root, "prebuilds", `darwin-${arch}`, "spawn-helper");
		const linuxHelper = pathLocal.join(root, "prebuilds", `linux-${arch}`, "spawn-helper");
		for (const p of [helper, linuxHelper]) {
			try {
				const st = fsLocal.statSync(p);
				// Mode 0o111 = any execute bit. If none are set, add user+group+other +x.
				if (st.isFile() && (st.mode & 0o111) === 0) {
					fsLocal.chmodSync(p, st.mode | 0o755);
				}
			} catch {}
		}
	} catch {}
})();

const pty = require("node-pty");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const pkg = require("../package.json");

// ---------- env ----------

const args = process.argv.slice(2);
const claudeBinName = process.env.CLAUDE_LINK_CLAUDE_BIN || "claude";
// `--version` mode is a one-shot info call: silence our own banner so the
// stdout is just claude's version + ours, and append a claude-link line on
// successful exit so users can see both at a glance.
const isVersionMode = args.includes("--version");

function which(name) {
	if (!name) return null;
	if (path.isAbsolute(name) || name.includes(path.sep) || name.includes("/")) {
		return isRunnable(name) ? name : null;
	}
	const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
	const exts =
		process.platform === "win32"
			? ["", ...((process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase()))]
			: [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			const p = path.join(dir, name + ext);
			if (isRunnable(p)) return p;
		}
	}
	return null;
}

function isRunnable(p) {
	try {
		const st = fs.statSync(p);
		if (!st.isFile()) return false;
		// On POSIX, also require X_OK so we don't return paths that exist but
		// can't actually be exec'd (which would surface later as a confusing
		// posix_spawnp failure inside node-pty).
		if (process.platform !== "win32") {
			fs.accessSync(p, fs.constants.X_OK);
		}
		return true;
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
						// onInject may be async (chunked + paced writes). Wait for
						// it before replying so the MCP-side serialization (await
						// client.inject(...)) actually serializes — otherwise two
						// concurrent injects' chunks could interleave on the PTY.
						Promise.resolve()
							.then(async () => {
								try {
									await onInject(req.bytes, !!req.interrupt);
									reply({ id: req.id, ok: true });
								} catch (err) {
									reply({
										id: req.id,
										ok: false,
										error: { code: "inject-failed", msg: err && err.message },
									});
								}
							})
							.catch(() => {});
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

	if (process.stderr.isTTY && !isVersionMode) {
		const note = salt.value
			? `claude-link: salt loaded from ${salt.origin} (${saltPreview(salt.value)})`
			: `claude-link: WARNING — no salt configured. Run \`claude-link-config set <random>\` to enable peer connections.`;
		process.stderr.write(note + "\n");
	}

	const cols = process.stdout.columns || 80;
	const rows = process.stdout.rows || 24;

	const spawnOpts = {
		name: process.env.TERM || "xterm-256color",
		cols,
		rows,
		cwd,
		env,
	};
	let term;
	try {
		term = pty.spawn(claudeBin, args, spawnOpts);
	} catch (err) {
		// On POSIX, node-pty's direct posix_spawnp fails for some shebang/permission
		// quirks even when the file is otherwise executable. Re-try via /bin/sh -c
		// which has more forgiving exec semantics. On Windows, just surface the error.
		if (process.platform === "win32") {
			process.stderr.write(`claude-link: failed to spawn ${claudeBin}: ${err && err.message}\n`);
			process.exit(1);
		}
		try {
			const cmd = [claudeBin, ...args]
				.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`)
				.join(" ");
			term = pty.spawn("/bin/sh", ["-c", cmd], spawnOpts);
			process.stderr.write(
				`claude-link: direct spawn of ${claudeBin} failed (${err && err.message}); ` +
					`fell back to /bin/sh -c. If this happens every time, set CLAUDE_LINK_CLAUDE_BIN to a known-good claude path.\n`,
			);
		} catch (err2) {
			process.stderr.write(
				`claude-link: failed to spawn ${claudeBin}: ${err && err.message}\n` +
					`  shell fallback also failed: ${err2 && err2.message}\n` +
					`  Try:  ls -la ${claudeBin}\n` +
					`        head -1 ${claudeBin}\n` +
					`        file ${claudeBin}\n` +
					`  Or set CLAUDE_LINK_CLAUDE_BIN=/full/path/to/claude\n`,
			);
			process.exit(1);
		}
	}

	// Chunk + drain pacing: Windows ConPTY's input pipe drops oldest bytes when
	// the consumer (claude) can't drain fast enough. A single term.write() of a
	// large body silently truncates from the front. Split the body into smaller
	// writes with a brief delay so the consumer has time to keep up. Also pace
	// the trailing Enter so it never races the body.
	const INJECT_CHUNK_BYTES = parseInt(process.env.CLAUDE_LINK_INJECT_CHUNK || "", 10) || 128;
	const INJECT_CHUNK_DELAY_MS = parseInt(process.env.CLAUDE_LINK_INJECT_DELAY_MS || "", 10) || 10;
	const INJECT_SUBMIT_DELAY_MS = parseInt(process.env.CLAUDE_LINK_INJECT_SUBMIT_DELAY_MS || "", 10) || 60;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	// ---- WIP-protect: capture/erase/restore the user's in-progress typing ----
	// We mirror the user's input field by tracking every keystroke that flows
	// through stdin. When a peer message arrives mid-typing, we erase the
	// claude input field via N backspaces (matching mirrored length), inject
	// the peer message + Enter, then restore the WIP text plus anything the
	// user typed during the inject window.
	let userBuffer = "";
	let injectActive = false;
	let queuedDuringInject = "";

	// Update userBuffer to reflect a chunk that's about to be (or was just)
	// forwarded to the PTY. Best-effort: handles printable chars, Backspace,
	// Ctrl+U, Ctrl+W, Enter (clears as submit). Skips escape sequences and
	// other control chars (cursor moves, mouse, etc.) so cursor-edited text
	// won't restore byte-perfectly — but the bytes will be there.
	function trackUserBuffer(buf) {
		if (!buf || buf.length === 0) return;
		if (buf[0] === 0x1b) return; // skip escape sequences entirely
		const s = buf.toString("utf8");
		for (const ch of s) {
			const code = ch.codePointAt(0);
			if (ch === "\r" || ch === "\n") {
				userBuffer = ""; // submitted (\r) or newline-as-submit
			} else if (code === 0x7f || code === 0x08) {
				userBuffer = userBuffer.slice(0, -1); // backspace
			} else if (code === 0x15) {
				userBuffer = ""; // Ctrl+U: kill line
			} else if (code === 0x17) {
				userBuffer = userBuffer.replace(/\s*\S+\s*$/, ""); // Ctrl+W: kill word
			} else if (code < 0x20 || code === 0x7f) {
				// Other controls: leave buffer as-is (best-effort).
			} else {
				userBuffer += ch;
			}
		}
	}

	// Write a (possibly large) string to the PTY using the same chunk+pace
	// logic as inject — used for both the peer message and the WIP restore.
	async function writePaced(s) {
		if (!s) return;
		if (s.length <= INJECT_CHUNK_BYTES) {
			term.write(s);
			return;
		}
		for (let i = 0; i < s.length; i += INJECT_CHUNK_BYTES) {
			term.write(s.slice(i, i + INJECT_CHUNK_BYTES));
			if (i + INJECT_CHUNK_BYTES < s.length) {
				await sleep(INJECT_CHUNK_DELAY_MS);
			}
		}
	}

	async function injectPaced(bytes) {
		// Inject simulates the user typing the message and then pressing Enter.
		// claude's TUI treats a single chunk like `text\r` as a pasted block
		// with a literal newline, NOT as "typed text followed by Enter" — so
		// the message lands in the input box without submitting. Split it: write
		// the body in paced chunks, brief pause, then write the Enter keystroke.
		const m = /^([\s\S]*?)([\r\n]+)$/.exec(bytes);
		const body = m ? m[1] : bytes;
		const hasSubmit = !!m;

		// 1. Save WIP and pause user-stdin forwarding.
		injectActive = true;
		const saved = userBuffer;
		queuedDuringInject = "";

		try {
			// 2. Erase claude's input field by sending one backspace per
			//    mirrored character. Using \x7f (DEL) which is what claude's
			//    TUI treats as plain Backspace.
			if (saved.length > 0) {
				await writePaced("\x7f".repeat([...saved].length));
				await sleep(20);
			}

			// 3. Write peer body in paced chunks.
			if (body) await writePaced(body);

			// 4. Submit if the inject ended with \r or \n.
			if (hasSubmit) {
				await sleep(INJECT_SUBMIT_DELAY_MS);
				term.write("\r");
				// Brief settle so claude finishes processing the submit before
				// we re-write the WIP into the now-empty input.
				await sleep(80);
			}

			// 5. Restore: saved WIP + anything the user typed during inject.
			const restored = saved + queuedDuringInject;
			if (restored) {
				await writePaced(restored);
			}

			// 6. Recompute userBuffer to reflect the restore. Replay what the
			//    user typed during inject through the same tracker so things
			//    like a Backspace they pressed get applied.
			userBuffer = saved;
			if (queuedDuringInject) {
				trackUserBuffer(Buffer.from(queuedDuringInject, "utf8"));
			}
		} finally {
			queuedDuringInject = "";
			injectActive = false;
		}
	}

	const ipcServer = await startIpcServer({
		addr: ipc.addr,
		token: ipc.token,
		onInject: (bytes /*, interrupt */) => injectPaced(bytes),
	});

	if (process.stdin.isTTY) {
		try {
			process.stdin.setRawMode(true);
		} catch {}
	}
	process.stdin.resume();
	const debugInput = process.env.CLAUDE_LINK_DEBUG_INPUT === "1";
	const isWin = process.platform === "win32";
	// On Windows + mintty (Git Bash), the Backspace key sends 0x08 (BS / Ctrl+H)
	// instead of the 0x7f (DEL) byte that claude's TUI expects for plain
	// Backspace. Result: every Backspace is parsed as Ctrl+Backspace (delete
	// word). Translate any unaccompanied 0x08 to 0x7f on the way through.
	function fixBackspace(chunk) {
		if (!isWin) return chunk;
		// Skip the translation if the chunk is part of an escape sequence
		// (starts with 0x1b) — 0x08 inside escape sequences shouldn't be
		// rewritten. In practice mintty never sends 0x08 inside an escape
		// sequence, but be defensive.
		if (chunk[0] === 0x1b) return chunk;
		let needsCopy = false;
		for (let i = 0; i < chunk.length; i++) {
			if (chunk[i] === 0x08) {
				needsCopy = true;
				break;
			}
		}
		if (!needsCopy) return chunk;
		const out = Buffer.from(chunk);
		for (let i = 0; i < out.length; i++) if (out[i] === 0x08) out[i] = 0x7f;
		return out;
	}
	process.stdin.on("data", (chunk) => {
		const fixed = fixBackspace(chunk);
		if (debugInput) {
			const hex = Array.from(fixed)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(" ");
			process.stderr.write(`[stdin] ${hex}\n`);
		}
		// During an active inject, hold the user's keystrokes so they don't
		// interleave with the peer message body. They'll be replayed after the
		// inject and WIP-restore complete.
		if (injectActive) {
			queuedDuringInject += fixed.toString("utf8");
			return;
		}
		trackUserBuffer(fixed);
		try {
			term.write(fixed);
		} catch {}
	});

	// Strip terminal mode-enables that produce wonky input on mintty (Git Bash):
	//   \x1b[?9001h — win32-input-mode on. mintty's win32 sequence for
	//                Backspace is parsed by claude's TUI as Ctrl+Backspace
	//                (delete-word). Stripping this keeps the terminal in legacy
	//                mode where Backspace is just 0x7f and works correctly.
	//   \x1b[?1004h — focus events on. Not strictly needed and produces
	//                stray escape sequences when the terminal gains/loses focus.
	const STRIP = /\x1b\[\?(?:9001|1004)h/g;
	const debugOutput = process.env.CLAUDE_LINK_DEBUG_OUTPUT === "1";
	term.onData((data) => {
		// .replace handles repeat occurrences and resets lastIndex correctly.
		const cleaned = data.replace(STRIP, "");
		if (debugOutput && cleaned !== data) {
			process.stderr.write(`[stripped mode-enable from PTY output]\n`);
		}
		try {
			process.stdout.write(cleaned);
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

			// For `claude-link --version`: tack our own version line on after
			// claude's. Only on success — if claude failed, don't muddy its
			// error output with our line.
			if (isVersionMode && exitCode === 0) {
				try {
					process.stdout.write(`claude-link ${pkg.version}\n`);
				} catch {}
			}

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
