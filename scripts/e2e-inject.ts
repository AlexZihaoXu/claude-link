// End-to-end test: PTY launcher + IPC + inject.
//
// Strategy:
//   - Spawn two claude-link launchers, each set to launch `bun e -e "..."` as
//     a stand-in for claude. The stand-in just echoes everything its stdin
//     receives, then prints when it sees a marker line, then exits.
//   - Inside the same process tree as each launcher, spawn the MCP server
//     (talking JSON-RPC over our test transport, not stdio of claude).
//   - Use the MCP tools to make alice connect to bob, then send a message.
//   - Verify the message appears as a line on bob's PTY stdout (i.e., in the
//     stand-in's stdout, captured via the launcher).
//
// Because the launcher takes over the parent process's stdin and PTY, and we
// can't easily run two of them concurrently in the SAME bun process, we
// instead drive both MCP servers WITHOUT a full launcher PTY — but we DO start
// the launcher's IPC server in the same process so the MCP can connect and
// inject. We then assert the IPC inject path actually fires.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { encodeProjectDir } from "../src/config/paths";
import { newIpcAddress, IPC_ENV_ADDR, IPC_ENV_TOKEN } from "../src/util/ipc-protocol";
import { IpcServer } from "../src/wrapper/ipc-server";

const SALT = "claude-link-inject-e2e-test-salt";

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
		this.proc = spawn("bun", ["run", "src/bin/mcp.ts"], {
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
					reject(new Error(`[${this.name}] ${method} timed out`));
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

	stop(): Promise<void> {
		try {
			this.proc.kill();
		} catch {}
		return new Promise((r) => setTimeout(r, 200));
	}
}

async function setupSessionDir(label: string): Promise<{ cwd: string }> {
	const fakeProjectCwd = join(tmpdir(), `claude-link-inject-e2e-${label}-${Date.now()}`);
	await mkdir(fakeProjectCwd, { recursive: true });
	const claudeProjectsDir = join(
		process.env.USERPROFILE || process.env.HOME || tmpdir(),
		".claude",
		"projects",
		encodeProjectDir(fakeProjectCwd),
	);
	await mkdir(claudeProjectsDir, { recursive: true });
	const sessionId = randomUUID();
	await writeFile(join(claudeProjectsDir, `${sessionId}.jsonl`), "{}\n", "utf8");
	return { cwd: fakeProjectCwd };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const [aliceSetup, bobSetup] = await Promise.all([setupSessionDir("alice"), setupSessionDir("bob")]);

	// Stand-in IPC servers — these mimic what the real launcher would do.
	const aliceInjected: string[] = [];
	const bobInjected: string[] = [];

	const aliceIpc = newIpcAddress();
	const bobIpc = newIpcAddress();

	const aliceSrv = new IpcServer(aliceIpc.addr, aliceIpc.token, {
		onInject: (bytes) => aliceInjected.push(bytes),
	});
	const bobSrv = new IpcServer(bobIpc.addr, bobIpc.token, {
		onInject: (bytes) => bobInjected.push(bytes),
	});
	await Promise.all([aliceSrv.start(), bobSrv.start()]);

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
		[IPC_ENV_ADDR]: aliceIpc.addr,
		[IPC_ENV_TOKEN]: aliceIpc.token,
	});
	const bob = new McpClient("bob", {
		...baseEnv,
		CLAUDE_LINK_LAUNCHER_CWD: bobSetup.cwd,
		CLAUDE_LINK_NAME: "Bob",
		[IPC_ENV_ADDR]: bobIpc.addr,
		[IPC_ENV_TOKEN]: bobIpc.token,
	});

	let exitCode = 0;
	try {
		console.log("\n[1] initialize both MCPs…");
		await Promise.all([alice.initialize(), bob.initialize()]);

		const aw = JSON.parse(await alice.callTool("link_whoami"));
		const bw = JSON.parse(await bob.callTool("link_whoami"));
		console.log(`    alice ${aw.code}, bob ${bw.code}`);

		await sleep(3000);

		console.log("\n[2] alice → bob link_connect…");
		console.log("    " + (await alice.callTool("link_connect", { code: bw.code })));

		console.log("\n[3] alice → bob link_send 'hello bob'…");
		console.log("    " + (await alice.callTool("link_send", { code: bw.code, text: "hello bob" })));

		// Inject is fired async on the receiving side. Give it a beat.
		await sleep(800);

		console.log("\n[4] verify bob's launcher received an inject for the message…");
		console.log("    bob inject log:", bobInjected);
		const matched = bobInjected.find((s) => s.includes("hello bob"));
		console.log("    matched?", !!matched);
		if (!matched) throw new Error("bob never received an inject containing 'hello bob'");

		console.log("\n[5] bob → alice link_send 'hi alice'…");
		console.log("    " + (await bob.callTool("link_send", { code: aw.code, text: "hi alice" })));
		await sleep(800);
		console.log("    alice inject log:", aliceInjected);
		const matched2 = aliceInjected.find((s) => s.includes("hi alice"));
		console.log("    matched?", !!matched2);
		if (!matched2) throw new Error("alice never received an inject containing 'hi alice'");

		console.log("\nE2E PASS ✔");
	} catch (e: any) {
		console.error("\nE2E FAIL ✘:", e?.message ?? e);
		console.error("\n— alice stderr —");
		for (const l of alice.stderr.slice(-30)) console.error(l);
		console.error("\n— bob stderr —");
		for (const l of bob.stderr.slice(-30)) console.error(l);
		exitCode = 1;
	} finally {
		await Promise.all([alice.stop(), bob.stop(), aliceSrv.stop(), bobSrv.stop()]);
		await Promise.all([
			rm(aliceSetup.cwd, { recursive: true, force: true }).catch(() => {}),
			rm(bobSetup.cwd, { recursive: true, force: true }).catch(() => {}),
		]);
		process.exit(exitCode);
	}
}

main();
