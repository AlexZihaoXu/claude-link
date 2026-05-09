#!/usr/bin/env bun
import { loadSalt } from "../config/salt";
import { discoverSessionId } from "../config/session";
import { deriveAgentId, derivePeerId } from "../peer/id";

const args = process.argv.slice(2);
let sessionId: string | undefined = args[0];

async function run() {
	const salt = await loadSalt();

	if (!sessionId) {
		const found = await discoverSessionId(process.cwd(), 1_000);
		if (!found) {
			process.stderr.write(
				`claude-link-id: no session-id given and no recent JSONL in this project's claude dir.\n` +
					`  Pass one explicitly:  claude-link-id <uuid>\n`,
			);
			process.exit(2);
		}
		sessionId = found.sessionId;
		process.stderr.write(`claude-link-id: using newest session ${sessionId}\n`);
	}

	const agentId = deriveAgentId(sessionId);
	console.log(`agent-id: ${agentId}`);
	if (salt.value) {
		console.log(`peer-id : ${derivePeerId(agentId, salt.value)}`);
	} else {
		console.log("peer-id : (no salt configured — set one to derive)");
	}
}

await run();
