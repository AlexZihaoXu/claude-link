// End-to-end smoke test for the peer layer.
// Spins up two PeerLink instances (Alice + Bob) in this process, has them
// connect via the public PeerJS broker, exchange messages, verify dedupe.
//
// Run:  bun run scripts/e2e-peer.ts

import { PeerLink } from "../src/peer";
import { deriveAgentId } from "../src/peer/id";

const SALT = "claude-link-e2e-test-salt";

const aliceSession = `e2e-alice-${Date.now()}`;
const bobSession = `e2e-bob-${Date.now()}`;
const aliceAgent = deriveAgentId(aliceSession);
const bobAgent = deriveAgentId(bobSession);

console.log("alice session :", aliceSession, "→ agent", aliceAgent);
console.log("bob   session :", bobSession, "→ agent", bobAgent);

const alice = new PeerLink({ agentId: aliceAgent, salt: SALT, debug: 0 });
const bob = new PeerLink({ agentId: bobAgent, salt: SALT, debug: 0 });

const received: { side: string; from: string; body: string }[] = [];

alice.on("open", (id) => console.log("[alice] open:", id));
bob.on("open", (id) => console.log("[bob]   open:", id));
alice.on("connection", (a) => console.log("[alice] connection from agent:", a));
bob.on("connection", (a) => console.log("[bob]   connection from agent:", a));
alice.on("error", (e) => console.error("[alice] error:", e?.message ?? e));
bob.on("error", (e) => console.error("[bob]   error:", e?.message ?? e));

alice.on("message", (from, body) => {
	console.log(`[alice] <- ${from}: ${body}`);
	received.push({ side: "alice", from, body });
});
bob.on("message", (from, body) => {
	console.log(`[bob]   <- ${from}: ${body}`);
	received.push({ side: "bob", from, body });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let exitCode = 0;
try {
	console.log("\n[1] Starting Alice + Bob (registering with broker)…");
	await Promise.all([alice.start(), bob.start()]);

	console.log("\n[2] Alice → Bob connect()…");
	const bobReady = new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("bob never saw alice's connection")), 30_000);
		bob.once("connection", () => {
			clearTimeout(t);
			resolve();
		});
	});
	await alice.connectTo(bobAgent);
	await bobReady;
	console.log("    handshake done.");

	console.log("\n[3] Alice → Bob send 'hello bob'…");
	await alice.send(bobAgent, "hello bob");

	console.log("\n[4] Bob → Alice send 'hi alice'…");
	await bob.send(aliceAgent, "hi alice");

	// Give event loop a tick so receive handlers run
	await sleep(200);

	console.log("\n[5] Verify…");
	const aliceGotIt = received.find(
		(r) => r.side === "alice" && r.from === bobAgent && r.body === "hi alice",
	);
	const bobGotIt = received.find(
		(r) => r.side === "bob" && r.from === aliceAgent && r.body === "hello bob",
	);
	console.log("    alice received from bob?", !!aliceGotIt);
	console.log("    bob received from alice?", !!bobGotIt);

	if (!aliceGotIt || !bobGotIt) throw new Error("missing message(s)");
	console.log("\nE2E PASS ✔");
} catch (e: any) {
	console.error("\nE2E FAIL ✘:", e?.message ?? e);
	exitCode = 1;
} finally {
	alice.destroy();
	bob.destroy();
	// give socket close handlers time
	await sleep(500);
	process.exit(exitCode);
}
