import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Link, type Identity, type InboxEntry } from "./link";
import { loadSalt } from "../config/salt";
import { saltFilePath } from "../config/paths";
import { discoverSessionId } from "../config/session";
import { deriveAgentId } from "../peer/id";
import { getIpcClient } from "./ipc-client";

interface BootError {
	kind: "no-launcher" | "no-session" | "no-salt";
	message: string;
}

interface BootOk {
	identity: Identity;
	link: Link;
	sessionId: string;
}

type BootResult = { ok: true; data: BootOk } | { ok: false; err: BootError };

async function boot(): Promise<BootResult> {
	if (process.env.CLAUDE_LINK_LAUNCHER !== "1") {
		return {
			ok: false,
			err: {
				kind: "no-launcher",
				message:
					"claude-link MCP server is loaded, but Claude was not launched via the `claude-link` command. " +
					"Tell the user to exit Claude Code and restart it with `claude-link` instead of `claude`. " +
					"Without the launcher, the salt and session-id discovery cannot be set up correctly.",
			},
		};
	}

	const cwd = process.env.CLAUDE_LINK_LAUNCHER_CWD || process.cwd();
	const found = await discoverSessionId(cwd, 5_000);
	if (!found) {
		return {
			ok: false,
			err: {
				kind: "no-session",
				message:
					`could not find a session JSONL in this project's directory (encoded path under ~/.claude/projects/). ` +
					`Either Claude hasn't written its first message yet (try sending one) or the cwd→project encoding doesn't match. ` +
					`cwd was: ${cwd}`,
			},
		};
	}

	const salt = await loadSalt();
	const identity: Identity = {
		code: deriveAgentId(found.sessionId),
		name: process.env.CLAUDE_LINK_NAME || "",
	};

	const link = new Link(identity, salt);

	if (!salt.value) {
		// Boot in unconfigured mode — tools still load and return helpful errors.
		return { ok: true, data: { identity, link, sessionId: found.sessionId } };
	}

	// Eager peer registration so this side is reachable as soon as MCP starts.
	void link.start().catch(() => {
		// Swallowed — link.start() failure surfaces from explicit tool calls.
	});

	// Wire inbox-update events to inject as user-typed input via the launcher's
	// PTY. If IPC isn't available (i.e., not started via claude-link), this
	// falls back silently and the agent has to call link_inbox to see messages.
	link.on("inbox-update", () => {
		void deliverPendingInbox(link).catch(() => {});
	});

	return { ok: true, data: { identity, link, sessionId: found.sessionId } };
}

let injectInFlight = false;
async function deliverPendingInbox(link: Link): Promise<void> {
	if (injectInFlight) return;
	const client = await getIpcClient();
	if (!client) return; // no PTY to inject into; agent must poll link_inbox
	injectInFlight = true;
	try {
		// Loop so that anything enqueued *while* we were awaiting an inject also
		// gets drained. Without this, a second event landing mid-inject would
		// hit `injectInFlight === true` and silently get stuck.
		while (true) {
			const entries = link.drainInbox();
			if (!entries.length) break;
			for (const e of entries) {
				const tag = e.kind === "msg" ? `[link from ${e.fromName}]` : `[link event]`;
				// Carriage return at the end is what Claude Code's TUI treats as
				// Enter (submitting the prompt). \n alone leaves the line in the
				// input box unsubmitted.
				await client.inject(`${tag} ${e.text}\r`);
			}
		}
	} finally {
		injectInFlight = false;
	}
}

function systemPromptFor(link: Link, sessionId: string): string {
	if (!link.salt.value) {
		return [
			"claude-link is INSTALLED but NOT YET CONFIGURED — no shared salt is set.",
			"",
			"The salt is the shared secret that namespaces a peer group: only agents whose configured salt matches yours can reach each other. Without it, no peer-to-peer connection can be established.",
			"",
			"If the user asks you to talk to another Claude session, OR runs any link_* tool, FIRST tell them this:",
			"",
			'  "I can\'t connect to other sessions until a shared salt is configured. Pick one of:',
			"    1. Run `claude-link config set <a long random string>` (writes to the salt file).",
			"    2. Set env var CLAUDE_LINK_SALT=<the same string> before starting `claude-link`.",
			"  Whichever you pick, anyone you want to talk to must use the SAME salt — share it with them out of band.",
			"  Good salt: `openssl rand -hex 32` produces a 64-char value with plenty of entropy.",
			'  The env var wins over the file."',
			"",
			"Tools (all will error with a clear message until a salt is configured):",
			"  link_whoami, link_set_name(name), link_connect(code), link_send(code, text), link_inbox, link_peers.",
		].join("\n");
	}

	const lines = [
		"You have access to claude-link, a peer-to-peer messaging tool that connects you with other Claude Code sessions over WebRTC.",
		"Use it when the user asks you to talk to or coordinate with another agent.",
		"",
		"Your identity:",
		`- Agent code (deterministic from this session's id, share with others so they can reach you): ${link.identity.code}`,
	];
	if (link.identity.name) {
		lines.push(`- Display name: ${link.identity.name}`);
	} else {
		lines.push(
			"- Display name: NOT SET. Pick a short fun name and call link_set_name once at the start of any link conversation.",
		);
	}
	lines.push(
		`- Namespace salt: configured (from ${link.salt.origin === "env" ? "env var CLAUDE_LINK_SALT" : "salt file"}). You can only reach agents whose salt matches.`,
		`- Session: ${sessionId}`,
		"",
		"IMPORTANT — making yourself reachable: call link_whoami EARLY (e.g. on the first turn the user mentions linking). This kicks off peer registration on signaling so others can connect to you. Until you call ANY link_* tool, your code is just a string — nobody can reach you. Sharing your code without first calling link_whoami is the most common cause of `link_connect` timing out on the other side.",
		"",
		"Tools: link_whoami, link_set_name(name), link_connect(code), link_send(code, text), link_inbox, link_peers.",
		"Codes are 6 characters of A-Z and 0-9 (e.g. `K3J9PR`). Anything else is invalid.",
		"",
		"Receiving messages: peer messages and link events queue in an inbox you must drain with the `link_inbox` tool. To stay responsive while idle, run a `Monitor` tool watching the inbox file (you can find its path via link_whoami) — each peer message wakes you up, then call link_inbox to read it.",
		"",
		"link_inbox returns entries in two flavors:",
		"- `kind: 'msg'` — a peer agent sent you a message. Reply via link_send if appropriate.",
		"- `kind: 'system'` — a notification from the link itself (peer connected/disconnected, signaling reconnected, etc.). DO NOT reply via link_send — these are FYI for you to mention to the user if relevant.",
		"",
		"When to reply via link_send (and only link_send — plain output is not routed back):",
		"- Reply when you have a real answer, question, status update, or new information.",
		"- Do NOT reply to acknowledgments, 'thanks', 'ok', or other purely social/closing messages. They end the exchange.",
		"- Silence is a valid response.",
		"",
		"Treat the link as async coordination, not chat. Send only when something substantive needs to cross.",
	);
	return lines.join("\n");
}

function toolErrorString(message: string): { content: [{ type: "text"; text: string }]; isError?: boolean } {
	return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

function toolResultString(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

export async function run(): Promise<void> {
	const result = await boot();

	const server = new McpServer({ name: "claude-link", version: "0.0.1" });

	// Build a generic guard that fronts every tool. If boot failed (no launcher,
	// no session detected) every tool returns the failure message.
	function guarded<TArgs extends z.ZodRawShape>(
		args: TArgs,
		handler: (data: BootOk, args: z.infer<z.ZodObject<TArgs>>) => Promise<string>,
	) {
		return async (callArgs: z.infer<z.ZodObject<TArgs>>) => {
			if (!result.ok) return toolErrorString(result.err.message);
			try {
				return toolResultString(await handler(result.data, callArgs));
			} catch (err) {
				return toolErrorString((err as Error).message ?? String(err));
			}
		};
	}

	function requireSalt(handler: (data: BootOk, args: any) => Promise<string>) {
		return async (data: BootOk, args: any) => {
			if (!data.link.salt.value) {
				throw new Error(
					`claude-link has no salt configured. Run \`claude-link config set <a long random string>\` (or set env var CLAUDE_LINK_SALT). Salt file path: ${saltFilePath()}. Both ends must use the SAME salt.`,
				);
			}
			return handler(data, args);
		};
	}

	server.registerTool(
		"link_whoami",
		{
			title: "Identify yourself on the link",
			description:
				"Return this session's agent code, display name, salt status, and the path to the inbox file. Calling this also kicks off peer registration on signaling, so call it early — until any link_* tool runs, your code is unreachable. Recommended at the very start of any link-related conversation.",
			inputSchema: {} as const,
		},
		guarded({}, async (data) => {
			// Eagerly start the peer if salt is set and we haven't yet (idempotent).
			if (data.link.salt.value) {
				void data.link.start().catch(() => {});
			}
			const out = {
				code: data.link.identity.code,
				name: data.link.identity.name,
				salt: data.link.salt.origin,
				ready: data.link.salt.value !== null,
				session: data.sessionId,
				inboxFilePath: data.link.inboxFilePath,
				inboxFileHint:
					"Arm a `Monitor` tool on inboxFilePath if you want peer messages to wake you up while you're waiting for user input. Each new line in the file is a new inbox entry.",
				warning:
					data.link.salt.value === null
						? "NO SHARED SALT IS CONFIGURED. Tell the user to run `claude-link-config set <salt>` (or set CLAUDE_LINK_SALT env var). Both you and your peer must use the SAME salt."
						: undefined,
			};
			return JSON.stringify(out);
		}),
	);

	server.registerTool(
		"link_set_name",
		{
			title: "Set your display name on the link",
			description:
				"Set or change this agent's display name. Persists for the session and broadcasts to currently connected peers. Works even before a salt is configured.",
			inputSchema: { name: z.string().min(1).max(64) } as const,
		},
		guarded({ name: z.string().min(1).max(64) } as const, async (data, args) => {
			data.link.setName(args.name);
			return `name set to ${args.name}`;
		}),
	);

	server.registerTool(
		"link_connect",
		{
			title: "Connect to another agent",
			description:
				"Open a peer-to-peer connection to another Claude session by their 6-char agent code (e.g. `K3J9PR`). Requires a shared salt. The other side must have called any link_* tool at least once since starting, otherwise this will time out.",
			inputSchema: { code: z.string().describe("the other agent's 6-char code (case-insensitive)") } as const,
		},
		guarded({ code: z.string() } as const, requireSalt(async (data, args: { code: string }) => {
			await data.link.connectTo(args.code);
			return `connected to ${args.code.toUpperCase()}`;
		})),
	);

	server.registerTool(
		"link_send",
		{
			title: "Send a message to a connected peer",
			description:
				"Send text to a connected peer (identified by their 6-char code). Requires an active connection — call link_connect first.",
			inputSchema: { code: z.string(), text: z.string() } as const,
		},
		guarded({ code: z.string(), text: z.string() } as const, requireSalt(async (data, args: { code: string; text: string }) => {
			await data.link.send(args.code, args.text);
			return `sent ${args.text.length} chars to ${args.code.toUpperCase()}`;
		})),
	);

	server.registerTool(
		"link_inbox",
		{
			title: "Drain pending peer messages",
			description:
				"Drain and return all pending inbox entries since the last call. Each entry has { from, fromName, text, ts, kind }. kind='msg' = a peer message you may want to reply to via link_send. kind='system' = link-internal notification (FYI only, do NOT reply).",
			inputSchema: {} as const,
		},
		guarded({}, async (data) => {
			const entries: InboxEntry[] = data.link.drainInbox();
			return JSON.stringify(entries);
		}),
	);

	server.registerTool(
		"link_peers",
		{
			title: "List connected peers",
			description:
				"Return the list of currently connected peers, each with their code, display name, and connection time.",
			inputSchema: {} as const,
		},
		guarded({}, async (data) => {
			return JSON.stringify(data.link.peers());
		}),
	);

	// Inject the system prompt as an initial resource the host model reads.
	if (result.ok) {
		const prompt = systemPromptFor(result.data.link, result.data.sessionId);
		server.registerResource(
			"system-guidance",
			"claude-link://system",
			{ description: "claude-link usage guidance", mimeType: "text/markdown" },
			async () => ({
				contents: [{ uri: "claude-link://system", text: prompt, mimeType: "text/markdown" }],
			}),
		);
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
}
