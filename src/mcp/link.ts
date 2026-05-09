import { EventEmitter } from "node:events";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	Peer as RawPeer,
	type DataConnection,
	installNodeDataChannel,
	LogLevel,
} from "../vendor/peerjs";
import { deriveAgentId, derivePeerId } from "../peer/id";
import type { SaltSource } from "../config/salt";
import { configDir } from "../config/paths";

let polyfillInstalled = false;
function ensurePolyfill() {
	if (!polyfillInstalled) {
		installNodeDataChannel();
		polyfillInstalled = true;
	}
}

export interface InboxEntry {
	from: string; // 6-char remote agent code (or "" for system events)
	fromName: string;
	text: string;
	ts: number;
	kind: "msg" | "system";
}

type WireMessage =
	| { type: "hello"; code: string; name: string }
	| { type: "rename"; name: string }
	| { type: "msg"; text: string };

interface ConnSlot {
	conn: DataConnection;
	code: string; // populated after we receive the peer's hello
	name: string;
	connectedAt: number;
}

export interface Identity {
	code: string; // 6-char agent-id
	name: string;
}

const INBOX_MAX = 1024;

export class Link extends EventEmitter {
	private peer: RawPeer | null = null;
	private connections = new Map<string, ConnSlot>(); // remotePeerId → slot
	private inboxQueue: InboxEntry[] = [];
	private ready: Promise<void> | null = null;
	readonly identity: Identity;
	readonly salt: SaltSource;
	/**
	 * Append-only mirror of inbox entries (one JSON line each). The agent can
	 * arm a `Monitor` tool on this path so peer messages wake the session
	 * while it's idle. We never read this back — it's purely a wake signal +
	 * audit trail.
	 */
	readonly inboxFilePath: string;

	constructor(identity: Identity, salt: SaltSource) {
		super();
		this.identity = identity;
		this.salt = salt;
		this.inboxFilePath = join(configDir(), "inbox", `${identity.code}.log`);
		// Touch the file so an agent's `Monitor`/`tail -f` doesn't fail with
		// "no such file" before the first peer message arrives.
		try {
			mkdirSync(dirname(this.inboxFilePath), { recursive: true });
			closeSync(openSync(this.inboxFilePath, "a"));
		} catch {}
	}

	private mirrorToFile(entry: InboxEntry): void {
		try {
			appendFileSync(this.inboxFilePath, JSON.stringify(entry) + "\n", "utf8");
		} catch {
			// Mirror failures shouldn't break message delivery — the in-memory
			// queue is still authoritative.
		}
	}

	private noSaltError(): Error {
		return new Error(
			`claude-link has no salt configured. Run \`claude-link config set <a long random string>\` (or set CLAUDE_LINK_SALT env var). Both ends of any link must use the SAME salt.`,
		);
	}

	async start(): Promise<void> {
		if (!this.salt.value) throw this.noSaltError();
		if (this.ready) return this.ready;
		this.ready = this.bootWithRetry().catch((err) => {
			this.ready = null;
			throw err;
		});
		return this.ready;
	}

	/**
	 * Boot the peer, retrying on UnavailableID (the broker still has our slot
	 * registered from a prior session that didn't clean up). The PeerJS public
	 * cloud usually frees the slot within ~30s of the WebSocket dying, so a
	 * handful of retries with backoff covers the common case.
	 */
	private async bootWithRetry(): Promise<void> {
		const delays = [3_000, 5_000, 10_000, 15_000, 20_000];
		let lastErr: Error | null = null;
		for (let attempt = 0; attempt <= delays.length; attempt++) {
			try {
				await this.bootPeer();
				return;
			} catch (err: any) {
				const msg = err?.message ?? String(err);
				const isTaken =
					(err as any)?.type === "unavailable-id" ||
					/unavailable[- ]id|is taken|ID["' ].*taken/i.test(msg);
				lastErr = err instanceof Error ? err : new Error(String(err));
				if (!isTaken || attempt === delays.length) throw lastErr;
				// Tear down the half-booted peer before retrying so we get a clean
				// WebSocket on the next attempt.
				try {
					this.peer?.destroy();
				} catch {}
				this.peer = null;
				const wait = delays[attempt];
				await new Promise((r) => setTimeout(r, wait));
			}
		}
		throw lastErr ?? new Error("bootWithRetry exhausted");
	}

	private async bootPeer(): Promise<void> {
		if (!this.salt.value) throw this.noSaltError();
		ensurePolyfill();

		const myPeerId = derivePeerId(this.identity.code, this.salt.value);
		const myPeer = new RawPeer(myPeerId, { debug: 0 as LogLevel });
		this.peer = myPeer;

		const isCurrent = () => this.peer === myPeer && !myPeer.destroyed;

		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(
				() =>
					reject(
						new Error(
							"peer signaling did not open within 20s. Possible causes: PeerJS public cloud unreachable, " +
								"firewall blocking wss://0.peerjs.com, or transient outage.",
						),
					),
				20_000,
			);
			myPeer.once("open" as any, () => {
				clearTimeout(t);
				resolve();
			});
			myPeer.once("error" as any, (err: any) => {
				clearTimeout(t);
				reject(err);
			});
		});

		myPeer.on("connection" as any, (conn: DataConnection) => {
			if (!isCurrent()) return;
			this.attach(conn);
		});

		let reconnectingAnnounced = false;
		myPeer.on("disconnected" as any, () => {
			if (!isCurrent()) return;
			reconnectingAnnounced = true;
			this.pushEvent("signaling disconnected — attempting reconnect");
			try {
				myPeer.reconnect();
			} catch {}
		});
		myPeer.on("open" as any, () => {
			if (!isCurrent()) return;
			if (reconnectingAnnounced) {
				this.pushEvent("signaling reconnected");
				reconnectingAnnounced = false;
			}
		});
	}

	private attach(conn: DataConnection): void {
		conn.on("open" as any, () => {
			this.connections.set(conn.peer, {
				conn,
				code: "",
				name: "",
				connectedAt: Date.now(),
			});
			this.sendWire(conn, { type: "hello", code: this.identity.code, name: this.identity.name });
		});

		const labelFor = (s: ConnSlot | undefined) =>
			s?.name || s?.code || conn.peer.slice(0, 8);
		const enqueue = (e: InboxEntry) => {
			this.inboxQueue.push(e);
			this.mirrorToFile(e);
			if (this.inboxQueue.length > INBOX_MAX) {
				this.inboxQueue.splice(0, this.inboxQueue.length - INBOX_MAX);
			}
		};

		conn.on("data" as any, (raw: unknown) => {
			const msg = this.parse(raw);
			if (!msg) return;
			const slot = this.connections.get(conn.peer);
			switch (msg.type) {
				case "hello": {
					if (slot) {
						slot.code = msg.code;
						slot.name = msg.name;
					}
					this.pushEvent(`peer ${msg.name || msg.code} (${msg.code}) connected`, {
						code: msg.code,
						name: msg.name || msg.code,
					});
					break;
				}
				case "rename": {
					const oldLabel = labelFor(slot);
					if (slot) slot.name = msg.name;
					this.pushEvent(
						`peer ${oldLabel} renamed to ${msg.name || labelFor(slot)}`,
						{ code: slot?.code, name: msg.name || labelFor(slot) },
					);
					break;
				}
				case "msg": {
					enqueue({
						from: slot?.code ?? "",
						fromName: labelFor(slot),
						text: msg.text,
						ts: Date.now(),
						kind: "msg",
					});
					this.emit("inbox-update");
					break;
				}
			}
		});

		conn.on("close" as any, () => {
			const slot = this.connections.get(conn.peer);
			const label = slot?.name || slot?.code || conn.peer.slice(0, 8);
			this.connections.delete(conn.peer);
			if (slot?.code) {
				this.pushEvent(`peer ${label} (${slot.code}) disconnected`, {
					code: slot.code,
					name: label,
				});
			}
		});

		conn.on("error" as any, () => {
			this.connections.delete(conn.peer);
		});
	}

	private parse(raw: unknown): WireMessage | null {
		if (typeof raw === "string") {
			try {
				return JSON.parse(raw) as WireMessage;
			} catch {
				return null;
			}
		}
		if (raw && typeof raw === "object" && "type" in (raw as any)) {
			return raw as WireMessage;
		}
		return null;
	}

	private sendWire(conn: DataConnection, msg: WireMessage): void {
		conn.send(JSON.stringify(msg));
	}

	private pushEvent(text: string, peer?: { code?: string; name?: string }): void {
		const entry: InboxEntry = {
			from: peer?.code ?? "",
			fromName: peer?.name || peer?.code || "link",
			text,
			ts: Date.now(),
			kind: "system",
		};
		this.inboxQueue.push(entry);
		this.mirrorToFile(entry);
		if (this.inboxQueue.length > INBOX_MAX) {
			this.inboxQueue.splice(0, this.inboxQueue.length - INBOX_MAX);
		}
		this.emit("inbox-update");
	}

	private slotByCode(code: string): ConnSlot | null {
		if (!this.salt.value) return null;
		const peerId = derivePeerId(code, this.salt.value);
		return this.connections.get(peerId) ?? null;
	}

	private async ensureSignalingOpen(): Promise<void> {
		if (!this.peer || (this.peer as any).destroyed) return;
		if ((this.peer as any).open && !(this.peer as any).disconnected) return;
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(
				() => reject(new Error("signaling reconnect timed out — try again or restart")),
				5_000,
			);
			this.peer!.once("open" as any, () => {
				clearTimeout(t);
				resolve();
			});
			this.peer!.once("error" as any, (err: any) => {
				clearTimeout(t);
				reject(err);
			});
			if ((this.peer as any).disconnected) {
				try {
					this.peer!.reconnect();
				} catch {}
			}
		});
	}

	async connectTo(rawCode: string): Promise<void> {
		if (!this.salt.value) throw this.noSaltError();
		const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
		if (code.length !== 6)
			throw new Error(`invalid code "${rawCode}" — expected 6 chars of A-Z and 0-9`);
		if (code === this.identity.code) throw new Error("cannot connect to your own code");
		await this.start();
		await this.ensureSignalingOpen();
		const peerId = derivePeerId(code, this.salt.value);
		if (this.connections.has(peerId)) return;
		const conn = this.peer!.connect(peerId, { reliable: true });
		if (!conn) {
			throw new Error(
				`peer.connect returned undefined for ${code}. Signaling channel is unavailable; restart claude-link if this persists.`,
			);
		}
		this.attach(conn);
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(
				() =>
					reject(
						new Error(
							`connect to ${code} timed out after 15s. Most common cause: the OTHER agent has not registered on signaling yet — ` +
								`they must have called any link_* tool (link_whoami is enough) AT LEAST ONCE since starting. ` +
								`Other causes: salt mismatch (both ends must use the EXACT same salt — origin on this side: ${this.salt.origin}), ` +
								`or the other agent ran link_rotate after sharing the code.`,
						),
					),
				15_000,
			);
			conn.on("open" as any, () => {
				clearTimeout(t);
				resolve();
			});
			conn.on("error" as any, (err: any) => {
				clearTimeout(t);
				reject(err);
			});
		});
	}

	async send(rawCode: string, text: string): Promise<void> {
		if (!this.salt.value) throw this.noSaltError();
		const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
		const slot = this.slotByCode(code);
		if (!slot) throw new Error(`not connected to ${code} — call link_connect first`);
		this.sendWire(slot.conn, { type: "msg", text });
	}

	drainInbox(): InboxEntry[] {
		const out = this.inboxQueue;
		this.inboxQueue = [];
		return out;
	}

	peers(): { code: string; name: string; connectedAt: number }[] {
		return [...this.connections.values()]
			.filter((s) => s.code)
			.map((s) => ({ code: s.code, name: s.name, connectedAt: s.connectedAt }));
	}

	setName(name: string): void {
		this.identity.name = name;
		for (const slot of this.connections.values()) {
			this.sendWire(slot.conn, { type: "rename", name });
		}
	}

	async stop(): Promise<void> {
		for (const slot of this.connections.values()) {
			try {
				slot.conn.close();
			} catch {}
		}
		this.connections.clear();
		if (this.peer) {
			try {
				this.peer.destroy();
			} catch {}
			this.peer = null;
		}
		this.ready = null;
	}
}
