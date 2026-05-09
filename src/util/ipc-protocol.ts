import { randomBytes } from "node:crypto";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

export const IPC_ENV_ADDR = "CLAUDE_LINK_IPC_ADDR";
export const IPC_ENV_TOKEN = "CLAUDE_LINK_IPC_TOKEN";

/**
 * Generate a per-process IPC address (named pipe on Windows, unix socket on
 * POSIX). The launcher sets these in the env so the MCP server (Claude's
 * grandchild) can connect back to inject input.
 */
export function newIpcAddress(): { addr: string; token: string } {
	const id = randomBytes(8).toString("hex");
	const token = randomBytes(16).toString("hex");
	if (platform() === "win32") {
		return { addr: `\\\\.\\pipe\\claude-link-${process.pid}-${id}`, token };
	}
	return { addr: join(tmpdir(), `claude-link-${process.pid}-${id}.sock`), token };
}

/**
 * Wire format: line-delimited JSON. Each request has an id; each response
 * mirrors the id and either has `ok: true` + result or `ok: false` + error.
 */
export type IpcRequest =
	| { id: number; op: "auth"; token: string }
	| { id: number; op: "inject"; bytes: string; interrupt?: boolean }
	| { id: number; op: "ping" };

export type IpcResponse =
	| { id: number; ok: true; result?: unknown }
	| { id: number; ok: false; error: { code: string; msg: string } };

export const ESC = "\x1b";
