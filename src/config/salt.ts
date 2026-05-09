import { readFile } from "node:fs/promises";
import { saltFilePath } from "./paths";

export interface SaltSource {
	value: string | null;
	origin: "env" | "file" | "none";
}

/**
 * Resolve the network-wide salt. Env `CLAUDE_LINK_SALT` wins if set and
 * non-empty; else read the salt file at `saltFilePath()`. No default — both
 * peers must agree on a salt out of band.
 */
export async function loadSalt(): Promise<SaltSource> {
	const env = process.env.CLAUDE_LINK_SALT;
	if (env && env.trim()) return { value: env.trim(), origin: "env" };

	try {
		const raw = await readFile(saltFilePath(), "utf8");
		const trimmed = raw.trim();
		if (trimmed) return { value: trimmed, origin: "file" };
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	return { value: null, origin: "none" };
}

/** Short fingerprint for logging — never reveal the full salt. */
export function saltPreview(salt: string | null): string {
	if (!salt) return "(none)";
	if (salt.length <= 6) return "***";
	return `${salt.slice(0, 3)}…${salt.slice(-3)}`;
}
