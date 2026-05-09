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

# Make sure the bun global bin is on PATH for THIS shell.
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

# Native binary fallback for node-datachannel and node-pty: bun's trustedDependencies
# isn't always honored on github installs. Run prebuild-install if any binary is missing.
GLOBAL_NM="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules"
for pkg in node-datachannel node-pty; do
  pkg_dir="$GLOBAL_NM/$pkg"
  if [ -d "$pkg_dir" ]; then
    if ! find "$pkg_dir/build" -name '*.node' 2>/dev/null | grep -q .; then
      say "fetching prebuilt binary for $pkg…"
      ( cd "$pkg_dir" && bunx prebuild-install -r napi >/dev/null 2>&1 ) || \
      ( cd "$pkg_dir" && npx --yes prebuild-install -r napi >/dev/null 2>&1 ) || true
    fi
  fi
done
ok "claude-link installed: $(command -v claude-link)"

# Register the MCP server.
say "registering claude-link MCP server with Claude Code (user scope)…"
claude mcp remove --scope user claude-link >/dev/null 2>&1 || true
claude mcp add --scope user claude-link -- claude-link-mcp
ok "MCP server registered."

# Auto-generate a salt if none exists. The salt is required for any peer
# connection; bootstrapping with one means the install is genuinely
# zero-config. To link with someone on another machine, replace this with a
# salt you both share — but for solo use / same-machine testing, this is fine.
SALT_FILE="$(claude-link-config path)"
if [ ! -s "$SALT_FILE" ] && [ -z "${CLAUDE_LINK_SALT:-}" ]; then
  say "generating a random salt at $SALT_FILE…"
  if command -v openssl >/dev/null 2>&1; then
    SALT_VAL="$(openssl rand -hex 32)"
  else
    SALT_VAL="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  claude-link-config set "$SALT_VAL" >/dev/null
  ok "salt written. Share it (\`cat $SALT_FILE\`) with anyone you want to link with."
else
  ok "existing salt detected — kept as-is."
fi

echo
ok "claude-link is ready. Launch Claude through it from now on:"
echo "    claude-link            # instead of \`claude\`"
echo "    claude-link --resume   # all claude args still work"
echo
echo "Helper commands:"
echo "    claude-link-config get|set|path"
echo "    claude-link-id [<session-uuid>]"
echo
echo "Uninstall:"
echo "    claude mcp remove --scope user claude-link"
echo "    bun remove -g claude-link"
