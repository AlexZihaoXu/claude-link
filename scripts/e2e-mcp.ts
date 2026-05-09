// End-to-end test for the MCP layer.
//
// Spawns two `claude-link mcp` instances via Bun, fakes the launcher env so
// they both pass the launcher guard, drives them via JSON-RPC stdin to:
//   1. read agent codes (link_whoami)
//   2. connect alice → bob (link_connect)
//   3. send a message both ways (link_send)
//   4. drain inboxes on both sides (link_inbox) and verify
//
// Each MCP needs a unique session id, so we point them at temp project dirs
// containing a single fake JSONL apiece.
//
// Run:  bun run scripts/e2e-mcp.ts

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { encodeProjectDir } from "../src/config/paths";

const SALT = "claude-link-mcp-e2e-test-salt";

interface PendingReq {
	resolve: (v: any) => void;
	reject: (e: any) => void;
}

class McpClient {
	private pending = new Map<number, PendingReq>();
	private nextId = 1;
	private buf = "";
	readonly proc: ChildProcess;
	readonly stderr: string[] = [];

	constructor(public name: string, env: NodeJS.ProcessEnv) {
		this.proc = spawn("bun", ["run", "src/cli.ts", "mcp"], {
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});

		this.proc.stdout!.setEncoding("utf8");
		this.proc.stderr!.setEncoding("utf8");
		this.proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
		this.proc.stderr!.on("data", (chunk: string) => {
			for (const line of chunk.split(/\r?\n/)) {
				if (line) this.stderr.push(`[${this.name} err] ${line}`);
			}
		});
	}

	private onStdout(chunk: string): void {
		this.buf += chunk;
		while (true) {
			const nl = this.buf.indexOf("\n");
			if (nl < 0) return;
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (!line) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				console.error(`[${this.name} parse-fail]`, line);
				continue;
			}
			if (msg.id !== undefined && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
				else p.resolve(msg.result);
			}
		}
	}

	request(method: string, params: unknown): Promise<any> {
		const id = this.nextId++;
		const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		this.proc.stdin!.write(body + "\n");
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`[${this.name}] ${method} timed out after 30s`));
				}
			}, 30_000);
		});
	}

	async initialize(): Promise<void> {
		await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "e2e", version: "0.0.0" },
		});
		this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
	}

	async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
		const r = await this.request("tools/call", { name, arguments: args });
		const block = r.content?.[0];
		if (!block) throw new Error(`[${this.name}] tool ${name}: empty content`);
		if (r.isError) throw new Error(`[${this.name}] tool ${name} error: ${block.text}`);
		return String(block.text);
	}

	async stop(): Promise<void> {
		try {
			this.proc.kill();
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
}

async function setupSessionDir(label: string): Promise<{ cwd: string; sessionId: string }> {
	const sessionId = randomUUID();
	const fakeProjectCwd = join(tmpdir(), `claude-link-e2e-${label}-${Date.now()}`);
	await mkdir(fakeProjectCwd, { recursive: true });

	const claudeProjectsDir = join(
		process.env.USERPROFILE || process.env.HOME || tmpdir(),
		".claude",
		"projects",
		encodeProjectDir(fakeProjectCwd),
	);
	await mkdir(claudeProjectsDir, { recursive: true });
	await writeFile(join(claudeProjectsDir, `${sessionId}.jsonl`), "{}\n", "utf8");

	return { cwd: fakeProjectCwd, sessionId };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const [aliceSetup, bobSetup] = await Promise.all([
		setupSessionDir("alice"),
		setupSessionDir("bob"),
	]);

	const baseEnv: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_LINK_LAUNCHER: "1",
		CLAUDE_LINK_SALT: SALT,
		CLAUDE_LINK_SALT_ORIGIN: "env",
	};

	const alice = new McpClient("alice", {
		...baseEnv,
		CLAUDE_LINK_LAUNCHER_CWD: aliceSetup.cwd,
		CLAUDE_LINK_NAME: "Alice",
	});
	const bob = new McpClient("bob", {
		...baseEnv,
		CLAUDE_LINK_LAUNCHER_CWD: bobSetup.cwd,
		CLAUDE_LINK_NAME: "Bob",
	});

	let exitCode = 0;
	try {
		console.log("\n[1] initialize both…");
		await Promise.all([alice.initialize(), bob.initialize()]);

		console.log("\n[2] link_whoami — kicks off peer registration on both sides…");
		const aw = JSON.parse(await alice.callTool("link_whoami"));
		const bw = JSON.parse(await bob.callTool("link_whoami"));
		console.log("    alice:", aw);
		console.log("    bob  :", bw);
		if (!aw.ready) throw new Error("alice not ready");
		if (!bw.ready) throw new Error("bob not ready");
		if (aw.code === bw.code) throw new Error("alice and bob ended up with the same code (session-id collision?)");

		// Give the eager peer.start() a moment to actually open signaling.
		console.log("\n    waiting 3s for both peers to register on signaling…");
		await sleep(3000);

		console.log("\n[3] alice → bob link_connect…");
		console.log("    " + (await alice.callTool("link_connect", { code: bw.code })));

		console.log("\n[4] alice → bob link_send 'hello bob'…");
		console.log("    " + (await alice.callTool("link_send", { code: bw.code, text: "hello bob" })));

		console.log("\n[5] bob → alice link_send 'hi alice'…");
		// Give a moment for bob to receive alice's hello so bob has the connection
		await sleep(500);
		console.log("    " + (await bob.callTool("link_send", { code: aw.code, text: "hi alice" })));

		await sleep(500);

		console.log("\n[6] drain inboxes…");
		const aliceInbox = JSON.parse(await alice.callTool("link_inbox"));
		const bobInbox = JSON.parse(await bob.callTool("link_inbox"));
		console.log("    alice inbox:", aliceInbox);
		console.log("    bob   inbox:", bobInbox);

		const aliceGotIt = aliceInbox.find(
			(e: any) => e.kind === "msg" && e.from === bw.code && e.text === "hi alice",
		);
		const bobGotIt = bobInbox.find(
			(e: any) => e.kind === "msg" && e.from === aw.code && e.text === "hello bob",
		);
		console.log("    alice received from bob?", !!aliceGotIt);
		console.log("    bob received from alice?", !!bobGotIt);

		if (!aliceGotIt || !bobGotIt) throw new Error("missing message(s)");
		console.log("\nE2E PASS ✔");
	} catch (e: any) {
		console.error("\nE2E FAIL ✘:", e?.message ?? e);
		console.error("\n— alice stderr —");
		for (const l of alice.stderr.slice(-30)) console.error(l);
		console.error("\n— bob stderr —");
		for (const l of bob.stderr.slice(-30)) console.error(l);
		exitCode = 1;
	} finally {
		await Promise.all([alice.stop(), bob.stop()]);
		// Best-effort cleanup of the fake project dirs.
		await Promise.all([rm(aliceSetup.cwd, { recursive: true, force: true }).catch(() => {}), rm(bobSetup.cwd, { recursive: true, force: true }).catch(() => {})]);
		process.exit(exitCode);
	}
}

main();
