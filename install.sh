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
if ! command -v node >/dev/null 2>&1; then
  err "node not found on PATH. Install Node.js (>=18) first: https://nodejs.org"
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

if ! command -v claude-link-mcp >/dev/null 2>&1; then
  err "\`claude-link-mcp\` not on PATH after install."
  err "Bun's global bin is usually at $BUN_BIN. Add it to your shell rc:"
  err "  export PATH=\"$BUN_BIN:\$PATH\""
  exit 1
fi

# The launcher itself is NOT a Bun bin — it has to run on Node (Bun + node-pty
# is unstable on Windows). Drop a wrapper script that calls Node directly.
LAUNCHER_CJS="$GLOBAL_NM/claude-link/dist/launcher.cjs"
if [ ! -f "$LAUNCHER_CJS" ]; then
  err "missing launcher at $LAUNCHER_CJS — install is broken."
  exit 1
fi
say "creating claude-link launcher wrapper at $BUN_BIN/claude-link…"
cat > "$BUN_BIN/claude-link" <<EOF
#!/usr/bin/env bash
exec node "$LAUNCHER_CJS" "\$@"
EOF
chmod +x "$BUN_BIN/claude-link"

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

# Install the skill so the agent knows what claude-link is and when to use it.
SKILL_SRC="$GLOBAL_NM/claude-link/skills/claude-link"
SKILL_DST="${CLAUDE_HOME:-$HOME/.claude}/skills/claude-link"
if [ -d "$SKILL_SRC" ]; then
  say "installing claude-link skill at $SKILL_DST…"
  mkdir -p "$(dirname "$SKILL_DST")"
  rm -rf "$SKILL_DST"
  cp -r "$SKILL_SRC" "$SKILL_DST"
  ok "skill installed."
else
  err "skill source not found at $SKILL_SRC — agent guidance won't be available, but tools will still work."
fi

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
