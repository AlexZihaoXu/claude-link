import { randomBytes } from "node:crypto";

export type EnvelopeKind = "msg" | "ack" | "ping";

export interface Envelope {
	v: 1;
	id: string;
	ts: number;
	kind: EnvelopeKind;
	body?: string;
	ackId?: string;
}

const newId = (): string => randomBytes(8).toString("hex");

export function makeMsg(body: string): Envelope {
	return { v: 1, id: newId(), ts: Date.now(), kind: "msg", body };
}

export function makeAck(forId: string): Envelope {
	return { v: 1, id: newId(), ts: Date.now(), kind: "ack", ackId: forId };
}

export function makePing(): Envelope {
	return { v: 1, id: newId(), ts: Date.now(), kind: "ping" };
}

export function isEnvelope(x: unknown): x is Envelope {
	return (
		!!x &&
		typeof x === "object" &&
		(x as any).v === 1 &&
		typeof (x as any).id === "string" &&
		typeof (x as any).ts === "number" &&
		typeof (x as any).kind === "string"
	);
}

/**
 * Tracks recently-seen envelope ids so we can dedupe redelivered messages.
 * Bounded LRU-ish: drop the oldest half when we hit `max`.
 */
export class DedupeWindow {
	private seen = new Set<string>();
	private order: string[] = [];

	constructor(private max = 1024) {}

	check(id: string): boolean {
		if (this.seen.has(id)) return false;
		this.seen.add(id);
		this.order.push(id);
		if (this.order.length > this.max) {
			const half = this.order.splice(0, Math.floor(this.max / 2));
			for (const old of half) this.seen.delete(old);
		}
		return true;
	}
}
