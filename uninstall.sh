#!/usr/bin/env bash
# claude-link uninstaller (POSIX — macOS / Linux).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/claude-link/main/uninstall.sh | bash
#
# Env overrides:
#   KEEP_SALT=1                    don't remove the salt file (default: removed)
#   KEEP_INBOX=1                   don't remove inbox files (default: removed)
#   BUN_INSTALL                    override bun's install root (default: ~/.bun)
#   CLAUDE_HOME                    override Claude Code dir (default: ~/.claude)
#   CLAUDE_LINK_SALT_FILE          override salt file path

set -uo pipefail

if [ -t 2 ]; then
	C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_BLU=$'\033[36m'; C_OFF=$'\033[0m'
else
	C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_OFF=''
fi
err()  { echo "${C_RED}✗${C_OFF} $*" >&2; }
say()  { echo "${C_BLU}→${C_OFF} $*"; }
ok()   { echo "${C_GRN}✓${C_OFF} $*"; }
warn() { echo "${C_YEL}!${C_OFF} $*"; }

removed_count=0
note_removed() {
	removed_count=$((removed_count + 1))
	ok "$1"
}

# ----- 1. MCP registration -----
if command -v claude >/dev/null 2>&1; then
	if claude mcp remove --scope user claude-link >/dev/null 2>&1; then
		note_removed "MCP registration removed"
	fi
fi

# ----- 2. launcher wrapper at $BUN_BIN/claude-link -----
BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
for f in claude-link claude-link.cmd; do
	if [ -e "$BUN_BIN/$f" ]; then
		rm -f "$BUN_BIN/$f"
		note_removed "launcher wrapper: $BUN_BIN/$f"
	fi
done

# ----- 3. global bun package -----
if command -v bun >/dev/null 2>&1; then
	if bun remove -g claude-link >/dev/null 2>&1; then
		note_removed "global package: claude-link"
	fi
fi

# ----- 4. skill -----
SKILL_DST="${CLAUDE_HOME:-$HOME/.claude}/skills/claude-link"
if [ -d "$SKILL_DST" ]; then
	rm -rf "$SKILL_DST"
	note_removed "skill: $SKILL_DST"
fi

# ----- 5. permissions in ~/.claude/settings.json -----
if command -v node >/dev/null 2>&1; then
	# Self-contained inline script (uninstall may run before/after package
	# removal; don't rely on the install tree being present).
	if node -e "
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		const p = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
		let s; try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { process.exit(2); }
		if (!s.permissions || !Array.isArray(s.permissions.allow)) process.exit(2);
		const before = s.permissions.allow.length;
		s.permissions.allow = s.permissions.allow.filter(e => typeof e !== 'string' || !e.startsWith('mcp__claude-link__'));
		if (s.permissions.allow.length === 0) delete s.permissions.allow;
		if (Object.keys(s.permissions).length === 0) delete s.permissions;
		const removed = before - (s.permissions?.allow?.length ?? 0);
		if (removed > 0) {
			fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
			console.log('removed', removed, 'permissions.allow entries');
			process.exit(0);
		}
		process.exit(2);
	" 2>/dev/null; then
		note_removed "MCP tool allow-list cleaned from ~/.claude/settings.json"
	fi
fi

# ----- 6. inbox files -----
SALT_PATH="${CLAUDE_LINK_SALT_FILE:-$HOME/.config/claude-link/salt}"
INBOX_DIR="$(dirname "$SALT_PATH")/inbox"
if [ -d "$INBOX_DIR" ]; then
	if [ "${KEEP_INBOX:-0}" = "1" ]; then
		warn "inbox kept: $INBOX_DIR (KEEP_INBOX=1)"
	else
		rm -rf "$INBOX_DIR"
		note_removed "inbox dir: $INBOX_DIR"
	fi
fi

# ----- 7. salt file (last, since it's the only thing the user might want kept) -----
if [ -f "$SALT_PATH" ]; then
	if [ "${KEEP_SALT:-0}" = "1" ]; then
		warn "salt kept: $SALT_PATH (KEEP_SALT=1)"
	else
		rm -f "$SALT_PATH"
		note_removed "salt: $SALT_PATH"
	fi
fi

# ----- 8. config dir if empty -----
CONFIG_DIR="$(dirname "$SALT_PATH")"
if [ -d "$CONFIG_DIR" ]; then
	rmdir "$CONFIG_DIR" 2>/dev/null && note_removed "empty config dir: $CONFIG_DIR" || true
fi

echo
if [ "$removed_count" -gt 0 ]; then
	ok "claude-link uninstalled — $removed_count thing(s) removed."
else
	warn "nothing was removed (claude-link may not have been installed)"
fi
