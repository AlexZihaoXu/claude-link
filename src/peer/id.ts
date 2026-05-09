import { createHash } from "node:crypto";

// Crockford base32 alphabet — drops I, L, O, U so 6 chars are easy to read aloud
// and not confused with 1/0. ~30 bits → ~10^9 possible agent-ids; salt is what
// stops random people from finding you.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const sha256 = (input: string): Buffer => createHash("sha256").update(input).digest();

const base32Crockford = (bytes: Buffer, length: number): string => {
	let out = "";
	let bits = 0;
	let value = 0;
	for (let i = 0; i < bytes.length && out.length < length; i++) {
		value = (value << 8) | bytes[i]!;
		bits += 8;
		while (bits >= 5 && out.length < length) {
			out += CROCKFORD[(value >>> (bits - 5)) & 0x1f];
			bits -= 5;
		}
	}
	return out;
};

/**
 * Derive a 6-character agent-id from a Claude Code session id.
 * Deterministic — same session id always yields the same agent-id.
 * Only depends on the session id; the salt is applied later (see `derivePeerId`).
 */
export function deriveAgentId(sessionId: string): string {
	if (!sessionId || typeof sessionId !== "string") {
		throw new Error("deriveAgentId: sessionId must be a non-empty string");
	}
	const digest = sha256(`claude-link/agent-id/v1\n${sessionId}`);
	return base32Crockford(digest, 6);
}

/**
 * Derive the actual PeerJS broker id from a 6-char agent-id and a network-wide
 * shared salt. The salt is what makes the peer-id unguessable — without it the
 * agent-id has only ~30 bits of entropy.
 *
 * Output format: `cl-<32 lowercase hex chars>` so it's a valid peerjs id
 * (alphanumerics + dashes) and is namespace-prefixed.
 */
export function derivePeerId(agentId: string, salt: string): string {
	if (!agentId) throw new Error("derivePeerId: agentId required");
	if (!salt) throw new Error("derivePeerId: salt required (set CLAUDE_LINK_SALT or config)");
	const digest = sha256(`claude-link/peer-id/v1\n${agentId}\n${salt}`);
	return `cl-${digest.toString("hex").slice(0, 32)}`;
}
