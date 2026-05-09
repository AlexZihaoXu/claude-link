import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { platform } from "node:os";
import {
	type IpcRequest,
	type IpcResponse,
} from "../util/ipc-protocol";

export interface IpcServerHandlers {
	/** Called when an authenticated client requests bytes injected into the PTY. */
	onInject: (bytes: string, interrupt: boolean) => void;
}

/**
 * Tiny line-delimited-JSON IPC server living inside the launcher. It accepts
 * one privileged op (`auth`) followed by inject/ping. Any unauthenticated op
 * is rejected and the connection closed.
 *
 * Designed for one client (the MCP server) but tolerates multiple — each is
 * authenticated independently.
 */
export class IpcServer {
	private server: Server | null = null;
	private clients = new Set<Socket>();

	constructor(
		private readonly addr: string,
		private readonly token: string,
		private readonly handlers: IpcServerHandlers,
	) {}

	async start(): Promise<void> {
		// On POSIX, an old socket file may linger from a prior run.
		if (platform() !== "win32") {
			await unlink(this.addr).catch(() => {});
		}

		this.server = createServer((socket) => this.attach(socket));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.addr, () => {
				this.server!.off("error", reject);
				resolve();
			});
		});
	}

	private attach(socket: Socket): void {
		let buf = "";
		let authed = false;
		this.clients.add(socket);
		socket.setEncoding("utf8");

		const reply = (msg: IpcResponse) => {
			try {
				socket.write(JSON.stringify(msg) + "\n");
			} catch {}
		};

		socket.on("data", (chunk: string) => {
			buf += chunk;
			while (true) {
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;

				let req: IpcRequest;
				try {
					req = JSON.parse(line);
				} catch {
					reply({ id: 0, ok: false, error: { code: "bad-json", msg: "expected one JSON object per line" } });
					continue;
				}

				switch (req.op) {
					case "auth":
						if (req.token === this.token) {
							authed = true;
							reply({ id: req.id, ok: true });
						} else {
							reply({ id: req.id, ok: false, error: { code: "bad-token", msg: "auth failed" } });
							socket.end();
						}
						break;
					case "ping":
						if (!authed) {
							reply({ id: req.id, ok: false, error: { code: "unauth", msg: "auth required" } });
							socket.end();
						} else {
							reply({ id: req.id, ok: true });
						}
						break;
					case "inject":
						if (!authed) {
							reply({ id: req.id, ok: false, error: { code: "unauth", msg: "auth required" } });
							socket.end();
							break;
						}
						try {
							this.handlers.onInject(req.bytes, !!req.interrupt);
							reply({ id: req.id, ok: true });
						} catch (err) {
							reply({
								id: req.id,
								ok: false,
								error: { code: "inject-failed", msg: (err as Error).message },
							});
						}
						break;
					default:
						reply({
							id: (req as any).id ?? 0,
							ok: false,
							error: { code: "unknown-op", msg: `unknown op: ${(req as any).op}` },
						});
				}
			}
		});

		socket.on("close", () => {
			this.clients.delete(socket);
		});
		socket.on("error", () => {
			this.clients.delete(socket);
		});
	}

	async stop(): Promise<void> {
		for (const c of this.clients) {
			try {
				c.destroy();
			} catch {}
		}
		this.clients.clear();
		await new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
		});
		this.server = null;
		if (platform() !== "win32") {
			await unlink(this.addr).catch(() => {});
		}
	}
}
