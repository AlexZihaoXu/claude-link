#!/usr/bin/env bash
# claude-link installer (POSIX).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/claude-link/main/install.sh | bash
#
# Or with a fork / branch:
#   CLAUDE_LINK_REPO=foo/claude-link CLAUDE_LINK_REF=dev \
#     curl -fsSL https://raw.githubusercontent.com/foo/claude-link/dev/install.sh | bash

set -euo pipefail

REPO="${CLAUDE_LINK_REPO:-AlexZihaoXu/claude-link}"
REF="${CLAUDE_LINK_REF:-main}"

err() { echo "✗ $*" >&2; }
say() { echo "→ $*"; }
ok()  { echo "✓ $*"; }

if ! command -v bun >/dev/null 2>&1; then
  err "bun not found on PATH. Install it from https://bun.sh first."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  err "claude not found on PATH. Install Claude Code first: https://claude.com/code"
  exit 1
fi

say "installing claude-link from github:$REPO#$REF (global)…"
bun install -g "github:$REPO#$REF"

# Make sure the bun global bin is on PATH for THIS shell so we can verify.
BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
if [ -d "$BUN_BIN" ] && [[ ":$PATH:" != *":$BUN_BIN:"* ]]; then
  export PATH="$BUN_BIN:$PATH"
fi

if ! command -v claude-link >/dev/null 2>&1; then
  err "\`claude-link\` not on PATH after install."
  err "Bun's global bin is usually at $BUN_BIN. Add it to your shell rc:"
  err "  export PATH=\"$BUN_BIN:\$PATH\""
  exit 1
fi

# Native binary: node-datachannel needs its prebuilt .node. Bun's trusted-deps
# resolution from a github install is finicky — fall back to the official
# prebuild-install if the binary is missing.
ND_DIR="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules/node-datachannel"
if [ -d "$ND_DIR" ] && [ ! -f "$ND_DIR/build/Release/node_datachannel.node" ]; then
  say "fetching node-datachannel native binary…"
  ( cd "$ND_DIR" && bunx prebuild-install -r napi >/dev/null 2>&1 ) || {
    err "prebuild-install failed. Try manually: cd \"$ND_DIR\" && npm install --build-from-source"
    exit 1
  }
fi
ok "claude-link installed: $(command -v claude-link)"

# Register the MCP server with Claude Code (user-scope = available everywhere).
# Idempotent: `claude mcp remove` then `claude mcp add` so re-running is safe.
say "registering claude-link MCP server with Claude Code (user scope)…"
claude mcp remove --scope user claude-link >/dev/null 2>&1 || true
claude mcp add --scope user claude-link -- claude-link mcp
ok "MCP server registered."

echo
echo "Next steps:"
echo "  1. Set your salt (the shared secret that pairs you with another agent):"
echo "       claude-link config set <a long random string>"
echo "     (Both ends of any link must use the SAME salt — share it out of band.)"
echo "     Tip: \`openssl rand -hex 32\` is a good way to generate one."
echo
echo "  2. Launch Claude through claude-link from now on:"
echo "       claude-link            # instead of \`claude\`"
echo "       claude-link --resume   # all claude args still work"
echo
echo "  3. To uninstall:"
echo "       claude mcp remove --scope user claude-link"
echo "       bun remove -g claude-link"
