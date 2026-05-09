#!/usr/bin/env bash
set -euo pipefail
say() { echo "→ $*"; }
ok()  { echo "✓ $*"; }
err() { echo "✗ $*" >&2; }

if command -v claude >/dev/null 2>&1; then
  say "removing claude-link MCP registration…"
  claude mcp remove --scope user claude-link >/dev/null 2>&1 || true
fi

BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
if [ -f "$BUN_BIN/claude-link" ]; then
  say "removing claude-link launcher wrapper…"
  rm -f "$BUN_BIN/claude-link"
fi

if command -v bun >/dev/null 2>&1; then
  say "removing global package…"
  bun remove -g claude-link 2>/dev/null || true
fi

SKILL_DST="${CLAUDE_HOME:-$HOME/.claude}/skills/claude-link"
if [ -d "$SKILL_DST" ]; then
  say "removing skill at $SKILL_DST…"
  rm -rf "$SKILL_DST"
fi

# Best-effort: clean the permissions.allow entries we added at install time.
# Run from the source repo if we still have it, otherwise inline.
if command -v node >/dev/null 2>&1; then
  node -e "
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const p = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
    let s; try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { process.exit(0); }
    if (!s.permissions || !Array.isArray(s.permissions.allow)) process.exit(0);
    const before = s.permissions.allow.length;
    s.permissions.allow = s.permissions.allow.filter(e => typeof e !== 'string' || !e.startsWith('mcp__claude-link__'));
    if (s.permissions.allow.length === 0) delete s.permissions.allow;
    if (Object.keys(s.permissions).length === 0) delete s.permissions;
    if (before !== s.permissions?.allow?.length) fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  " 2>/dev/null || true
fi

SALT_PATH="${CLAUDE_LINK_SALT_FILE:-${HOME}/.config/claude-link/salt}"
ok "claude-link uninstalled."
echo "Salt file (kept; remove manually if you want): $SALT_PATH"
