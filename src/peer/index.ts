import { EventEmitter } from "node:events";
import {
	Peer as RawPeer,
	type DataConnection,
	installNodeDataChannel,
	LogLevel,
} from "../vendor/peerjs";
import {
	type Envelope,
	DedupeWindow,
	isEnvelope,
	makeAck,
	makeMsg,
} from "./codec";
import { derivePeerId } from "./id";

let polyfillInstalled = false;
function ensurePolyfill() {
	if (!polyfillInstalled) {
		installNodeDataChannel();
		polyfillInstalled = true;
	}
}

export interface LinkOptions {
	agentId: string;
	salt: string;
	debug?: number;
	host?: string;
	port?: number;
	path?: string;
	secure?: boolean;
}

export interface PeerLinkEvents {
	open: (peerId: string, agentId: string) => void;
	connection: (remoteAgentId: string, remotePeerId: string) => void;
	message: (remoteAgentId: string, body: string, env: Envelope) => void;
	error: (err: Error) => void;
	close: () => void;
	disconnected: () => void;
}

interface ActiveConn {
	conn: DataConnection;
	remotePeerId: string;
	remoteAgentId?: string;
	dedupe: DedupeWindow;
	pendingAcks: Map<string, NodeJS.Timeout>;
}

/**
 * High-level peer link: wraps the vendored PeerJS Peer with our envelope codec,
 * dedupe window, agent-id mapping, and an EventEmitter API friendly to the
 * wrapper/MCP layer above.
 */
export class PeerLink extends EventEmitter {
	private peer: RawPeer | null = null;
	private readonly opts: LinkOptions;
	readonly agentId: string;
	readonly peerId: string;
	private conns = new Map<string, ActiveConn>(); // remotePeerId -> conn
	private agentToPeer = new Map<string, string>(); // remoteAgentId -> remotePeerId

	constructor(opts: LinkOptions) {
		super();
		this.opts = opts;
		this.agentId = opts.agentId;
		this.peerId = derivePeerId(opts.agentId, opts.salt);
	}

	override on<K extends keyof PeerLinkEvents>(
		event: K,
		listener: PeerLinkEvents[K],
	): this {
		return super.on(event, listener as any);
	}
	override emit<K extends keyof PeerLinkEvents>(
		event: K,
		...args: Parameters<PeerLinkEvents[K]>
	): boolean {
		return super.emit(event, ...(args as any));
	}

	async start(): Promise<void> {
		ensurePolyfill();

		const peerOpts: Record<string, unknown> = {
			debug: (this.opts.debug ?? 0) as LogLevel,
		};
		if (this.opts.host !== undefined) peerOpts.host = this.opts.host;
		if (this.opts.port !== undefined) peerOpts.port = this.opts.port;
		if (this.opts.path !== undefined) peerOpts.path = this.opts.path;
		if (this.opts.secure !== undefined) peerOpts.secure = this.opts.secure;
		const peer = new RawPeer(this.peerId, peerOpts as any);
		this.peer = peer;

		await new Promise<void>((resolve, reject) => {
			const onOpen = (id: string) => {
				peer.off("open", onOpen);
				peer.off("error", onError);
				this.emit("open", id, this.agentId);
				resolve();
			};
			const onError = (err: any) => {
				peer.off("open", onOpen);
				peer.off("error", onError);
				reject(err instanceof Error ? err : new Error(String(err)));
			};
			peer.on("open", onOpen);
			peer.on("error", onError);
		});

		this.peer.on("connection", (conn) => {
			this.attach(conn, /* outbound */ false);
		});

		this.peer.on("error", (err: any) => {
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		});

		this.peer.on("disconnected", () => {
			this.emit("disconnected");
		});

		this.peer.on("close", () => {
			this.emit("close");
		});
	}

	/**
	 * Connect to a remote agent. Returns once the data channel is open and the
	 * initial agent-id handshake has completed.
	 */
	async connectTo(remoteAgentId: string, remoteSalt?: string): Promise<void> {
		if (!this.peer) throw new Error("PeerLink not started");
		const remotePeerId = derivePeerId(remoteAgentId, remoteSalt ?? this.opts.salt);

		const conn = this.peer.connect(remotePeerId, { serialization: "json", reliable: true });
		if (!conn) throw new Error("connect() returned no connection");

		// Pre-register the expected agent-id so send() works as soon as the channel opens.
		this.agentToPeer.set(remoteAgentId, remotePeerId);
		this.attach(conn, true, remoteAgentId);

		// Phase 1: data channel open.
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`timed out opening data channel to ${remoteAgentId} (${remotePeerId})`));
			}, 30_000);
			const cleanup = () => {
				clearTimeout(timer);
				conn.off("open", onOpen);
				conn.off("error", onError);
				conn.off("close", onClose);
			};
			const onOpen = () => {
				cleanup();
				const env = makeMsg("__hello__");
				(env as any).hello = { agentId: this.agentId };
				conn.send(env);
				resolve();
			};
			const onError = (err: any) => {
				cleanup();
				reject(err instanceof Error ? err : new Error(String(err)));
			};
			const onClose = () => {
				cleanup();
				reject(new Error("connection closed before open"));
			};
			conn.on("open", onOpen);
			conn.on("error", onError);
			conn.on("close", onClose);
		});

		// Phase 2: peer's hello (so we've confirmed identity).
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => {
				this.off("connection", onConn);
				reject(new Error(`timed out waiting for hello from ${remoteAgentId}`));
			}, 10_000);
			const onConn = (incoming: string) => {
				if (incoming === remoteAgentId) {
					clearTimeout(t);
					this.off("connection", onConn);
					resolve();
				}
			};
			this.on("connection", onConn);
		});
	}

	private attach(
		conn: DataConnection,
		outbound: boolean,
		hintedRemoteAgent?: string,
	): void {
		const remotePeerId = conn.peer;
		const active: ActiveConn = {
			conn,
			remotePeerId,
			remoteAgentId: hintedRemoteAgent,
			dedupe: new DedupeWindow(),
			pendingAcks: new Map(),
		};
		this.conns.set(remotePeerId, active);

		if (!outbound) {
			conn.on("open", () => {
				const env = makeMsg("__hello__");
				(env as any).hello = { agentId: this.agentId };
				conn.send(env);
			});
		}

		conn.on("data", (raw) => {
			if (!isEnvelope(raw)) return;
			const env = raw;

			// Hello message — the body is "__hello__" and an extra `hello.agentId` is attached.
			if (env.kind === "msg" && env.body === "__hello__" && (raw as any).hello?.agentId) {
				const incomingAgent = String((raw as any).hello.agentId);
				active.remoteAgentId = incomingAgent;
				this.agentToPeer.set(incomingAgent, remotePeerId);
				this.emit("connection", incomingAgent, remotePeerId);
				return;
			}

			if (!active.dedupe.check(env.id)) return;

			if (env.kind === "msg") {
				if (active.remoteAgentId) {
					this.emit("message", active.remoteAgentId, env.body ?? "", env);
				}
				conn.send(makeAck(env.id));
			} else if (env.kind === "ack" && env.ackId) {
				const t = active.pendingAcks.get(env.ackId);
				if (t) {
					clearTimeout(t);
					active.pendingAcks.delete(env.ackId);
				}
			}
		});

		conn.on("close", () => {
			this.conns.delete(remotePeerId);
			if (active.remoteAgentId) this.agentToPeer.delete(active.remoteAgentId);
		});
	}

	/**
	 * Send a text message to a connected peer (by agent-id). Resolves when an
	 * ack is received or rejects on timeout.
	 */
	async send(remoteAgentId: string, body: string, ackTimeoutMs = 5_000): Promise<void> {
		const remotePeerId = this.agentToPeer.get(remoteAgentId);
		if (!remotePeerId) throw new Error(`no live connection to agent ${remoteAgentId}`);
		const active = this.conns.get(remotePeerId);
		if (!active) throw new Error(`no live connection to peer ${remotePeerId}`);

		const env = makeMsg(body);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				active.pendingAcks.delete(env.id);
				reject(new Error(`ack timeout for ${env.id}`));
			}, ackTimeoutMs);
			active.pendingAcks.set(env.id, timer);
			active.conn.send(env);

			// Resolve when ack arrives — handled in attach() by deleting the pending entry.
			const checkInterval = setInterval(() => {
				if (!active.pendingAcks.has(env.id)) {
					clearInterval(checkInterval);
					clearTimeout(timer);
					resolve();
				}
			}, 25);
		});
	}

	listConnections(): { agentId: string; peerId: string }[] {
		return [...this.conns.values()]
			.filter((c) => c.remoteAgentId)
			.map((c) => ({ agentId: c.remoteAgentId!, peerId: c.remotePeerId }));
	}

	destroy(): void {
		for (const c of this.conns.values()) {
			for (const t of c.pendingAcks.values()) clearTimeout(t);
			try {
				c.conn.close();
			} catch {}
		}
		this.conns.clear();
		this.agentToPeer.clear();
		this.peer?.destroy();
		this.peer = null;
	}
}
