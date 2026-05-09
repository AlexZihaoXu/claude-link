import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

/** Claude Code's `~/.claude/projects/` directory. */
export function claudeProjectsDir(): string {
	return join(homedir(), ".claude", "projects");
}

/** claude-link's config dir (`~/.config/claude-link` on POSIX, `%APPDATA%\claude-link` on Windows). */
export function configDir(): string {
	if (platform() === "win32" && process.env.APPDATA) {
		return join(process.env.APPDATA, "claude-link");
	}
	return join(homedir(), ".config", "claude-link");
}

export function saltFilePath(): string {
	return process.env.CLAUDE_LINK_SALT_FILE || join(configDir(), "salt");
}

/**
 * Translate a working directory into Claude Code's project-dir encoding.
 *
 * Examples:
 *   D:\Tools\claude-link  →  D--Tools-claude-link
 *   /Users/me/foo         →  -Users-me-foo
 *   C:\Users\Alex          →  C--Users-Alex
 *
 * Claude Code's encoder drops the colon after the drive letter and replaces
 * every separator (\ or /) with `-`.
 */
export function encodeProjectDir(cwd: string): string {
	const normalized = resolve(cwd);
	// Windows drive: "D:\foo\bar" → "D--foo-bar"
	const winMatch = /^([A-Za-z]):[\\/](.*)$/.exec(normalized);
	if (winMatch) {
		const drive = winMatch[1]!;
		const rest = winMatch[2]!.replace(/[\\/]/g, "-");
		return `${drive}--${rest}`;
	}
	// POSIX absolute: "/Users/me/foo" → "-Users-me-foo"
	return normalized.replace(/[\\/]/g, "-");
}

export function projectSessionsDir(cwd = process.cwd()): string {
	return join(claudeProjectsDir(), encodeProjectDir(cwd));
}
