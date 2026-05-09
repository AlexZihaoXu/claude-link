import { connect, type Socket } from "node:net";
import {
	IPC_ENV_ADDR,
	IPC_ENV_TOKEN,
	type IpcRequest,
	type IpcResponse,
} from "../util/ipc-protocol";

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
}

/**
 * MCP-side counterpart to wrapper/ipc-server. Connects to the launcher over
 * the named pipe / unix socket whose address was passed via env, performs auth
 * once, and then exposes `inject(bytes, interrupt?)` for the link tools.
 *
 * Calling `getOrInit()` returns the same client across invocations; if the
 * launcher's address isn't set in env, returns null and tools should fall back
 * to the inbox-poll path.
 */
export class IpcClient {
	private socket: Socket | null = null;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private buf = "";
	private authPromise: Promise<void> | null = null;

	constructor(private readonly addr: string, private readonly token: string) {}

	async connect(): Promise<void> {
		if (this.authPromise) return this.authPromise;
		this.authPromise = (async () => {
			await new Promise<void>((resolve, reject) => {
				const sock = connect(this.addr);
				const cleanup = () => {
					sock.off("connect", onConnect);
					sock.off("error", onError);
				};
				const onConnect = () => {
					cleanup();
					this.socket = sock;
					this.attach(sock);
					resolve();
				};
				const onError = (err: Error) => {
					cleanup();
					reject(err);
				};
				sock.once("connect", onConnect);
				sock.once("error", onError);
			});
			await this.request({ op: "auth", token: this.token } as Omit<IpcRequest, "id">);
		})().catch((err) => {
			this.authPromise = null;
			throw err;
		});
		return this.authPromise;
	}

	private attach(sock: Socket): void {
		sock.setEncoding("utf8");
		sock.on("data", (chunk: string) => {
			this.buf += chunk;
			while (true) {
				const nl = this.buf.indexOf("\n");
				if (nl < 0) return;
				const line = this.buf.slice(0, nl).trim();
				this.buf = this.buf.slice(nl + 1);
				if (!line) continue;
				let resp: IpcResponse;
				try {
					resp = JSON.parse(line);
				} catch {
					continue;
				}
				const p = this.pending.get(resp.id);
				if (!p) continue;
				this.pending.delete(resp.id);
				if (resp.ok) p.resolve(resp.result);
				else p.reject(new Error(`${resp.error.code}: ${resp.error.msg}`));
			}
		});
		sock.on("close", () => {
			for (const p of this.pending.values()) {
				p.reject(new Error("ipc connection closed"));
			}
			this.pending.clear();
			this.socket = null;
		});
		sock.on("error", () => {});
	}

	private request(req: Omit<IpcRequest, "id">): Promise<unknown> {
		if (!this.socket) return Promise.reject(new Error("ipc not connected"));
		const id = this.nextId++;
		const body = JSON.stringify({ ...req, id });
		this.socket.write(body + "\n");
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`ipc ${req.op} timed out after 5s`));
				}
			}, 5_000);
		});
	}

	async inject(bytes: string, interrupt = false): Promise<void> {
		await this.request({ op: "inject", bytes, interrupt } as Omit<IpcRequest, "id">);
	}
}

let cached: IpcClient | null = null;

/**
 * Lazy IPC connection. Returns null if the launcher didn't pass an address —
 * MCP tools then fall back to inbox-poll behavior.
 */
export async function getIpcClient(): Promise<IpcClient | null> {
	if (cached) return cached;
	const addr = process.env[IPC_ENV_ADDR];
	const token = process.env[IPC_ENV_TOKEN];
	if (!addr || !token) return null;
	const c = new IpcClient(addr, token);
	try {
		await c.connect();
		cached = c;
		return c;
	} catch {
		return null;
	}
}
