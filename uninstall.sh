#!/usr/bin/env bash
set -euo pipefail
say() { echo "→ $*"; }
ok()  { echo "✓ $*"; }
err() { echo "✗ $*" >&2; }

if command -v claude >/dev/null 2>&1; then
  say "removing claude-link MCP registration…"
  claude mcp remove --scope user claude-link >/dev/null 2>&1 || true
fi

if command -v bun >/dev/null 2>&1; then
  say "removing global package…"
  bun remove -g claude-link 2>/dev/null || true
fi

ok "claude-link uninstalled."
echo "Salt file (kept; remove manually if you want): \$(claude-link config path 2>/dev/null || echo '~/.config/claude-link/salt')"
