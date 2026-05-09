import { statSync } from "node:fs";
import { join, isAbsolute, sep } from "node:path";
import { platform } from "node:os";
import { delimiter } from "node:path";

/**
 * Resolve an executable name on PATH. Windows-aware: tries every PATHEXT
 * suffix (`.EXE`, `.CMD`, etc.) so e.g. `claude` finds `claude.exe`.
 *
 * Returns null if nothing is found. Returns the input as-is if it already
 * looks like an absolute path or contains a path separator.
 */
export function which(name: string): string | null {
	if (!name) return null;
	if (isAbsolute(name) || name.includes(sep) || name.includes("/")) {
		return existsAsFile(name) ? name : null;
	}

	const pathEnv = process.env.PATH || "";
	const dirs = pathEnv.split(delimiter).filter(Boolean);

	const exts =
		platform() === "win32"
			? // Windows uses PATHEXT to know which extensions to try. Always include
				// "" first so an explicit name like "node.exe" still works without
				// double-extensioning. Default list mirrors a typical PATHEXT.
				["", ...((process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase()))]
			: [""];

	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = join(dir, name + ext);
			if (existsAsFile(candidate)) return candidate;
		}
	}
	return null;
}

function existsAsFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}
