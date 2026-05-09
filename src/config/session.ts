import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectSessionsDir } from "./paths";

const UUID_JSONL = /^[0-9a-fA-F-]{32,}\.jsonl$/;

/**
 * Find the current Claude Code session id by looking at the project's
 * sessions dir and picking the most-recently-modified `<uuid>.jsonl`.
 *
 * Polls for up to `timeoutMs` since Claude may not have written its first
 * line by the time we boot. Works for both fresh sessions and `--resume`
 * (resumed sessions keep updating their existing JSONL).
 *
 * Returns null if nothing matching shows up in time.
 */
export async function discoverSessionId(
	cwd: string = process.cwd(),
	timeoutMs = 5_000,
	pollIntervalMs = 200,
): Promise<{ sessionId: string; jsonlPath: string } | null> {
	const dir = projectSessionsDir(cwd);
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const hit = await pickNewest(dir);
		if (hit) return hit;
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
	return null;
}

async function pickNewest(
	dir: string,
): Promise<{ sessionId: string; jsonlPath: string } | null> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return null;
	}
	const candidates = entries.filter((n) => UUID_JSONL.test(n));
	if (!candidates.length) return null;

	let best: { name: string; mtime: number } | null = null;
	for (const name of candidates) {
		try {
			const s = await stat(join(dir, name));
			const m = s.mtimeMs;
			if (!best || m > best.mtime) best = { name, mtime: m };
		} catch {}
	}
	if (!best) return null;
	return {
		sessionId: best.name.replace(/\.jsonl$/, ""),
		jsonlPath: join(dir, best.name),
	};
}
