#!/usr/bin/env bash
# claude-link installer (POSIX — macOS / Linux).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/claude-link/main/install.sh | bash
#
# Env overrides:
#   CLAUDE_LINK_REPO     fork (default: AlexZihaoXu/claude-link)
#   CLAUDE_LINK_REF      git ref (default: main)
#   BUN_INSTALL          override bun's install root (default: ~/.bun)
#   CLAUDE_HOME          override Claude Code dir (default: ~/.claude)

set -euo pipefail

REPO="${CLAUDE_LINK_REPO:-AlexZihaoXu/claude-link}"
REF="${CLAUDE_LINK_REF:-main}"

# Colors only when stderr is a TTY.
if [ -t 2 ]; then
	C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_BLU=$'\033[36m'; C_OFF=$'\033[0m'
else
	C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_OFF=''
fi
err()  { echo "${C_RED}✗${C_OFF} $*" >&2; }
say()  { echo "${C_BLU}→${C_OFF} $*"; }
ok()   { echo "${C_GRN}✓${C_OFF} $*"; }
warn() { echo "${C_YEL}!${C_OFF} $*"; }

# Pick the right shell rc file for PATH guidance.
shell_rc() {
	case "${SHELL:-}" in
		*/zsh) echo "$HOME/.zshrc" ;;
		*/bash)
			if   [ -f "$HOME/.bash_profile" ]; then echo "$HOME/.bash_profile"
			elif [ -f "$HOME/.bashrc"       ]; then echo "$HOME/.bashrc"
			else                                    echo "$HOME/.bash_profile"
			fi
			;;
		*/fish) echo "$HOME/.config/fish/config.fish" ;;
		*)      echo "$HOME/.profile" ;;
	esac
}

# ----- requirements -----

missing=0
for cmd in bun node claude; do
	if ! command -v "$cmd" >/dev/null 2>&1; then
		case "$cmd" in
			bun)    err "bun not found — install from https://bun.sh first" ;;
			node)   err "node not found — install Node.js (>=18) from https://nodejs.org first" ;;
			claude) err "claude not found — install Claude Code from https://claude.com/code first" ;;
		esac
		missing=1
	fi
done
[ "$missing" = "1" ] && exit 1

bun_v="$(bun --version 2>&1 | head -1)"
node_v="$(node --version 2>&1 | head -1)"
claude_v="$(claude --version 2>&1 | head -1)"
say "tools: bun=$bun_v  node=$node_v  claude=$claude_v"

# ----- install package -----

say "installing claude-link from github:$REPO#$REF"
bun install -g "github:$REPO#$REF" >/dev/null

BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
GLOBAL_NM="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules"

# Make BUN_BIN available in this shell so the post-install steps that call
# `claude-link-config`/etc. find them.
if [ -d "$BUN_BIN" ] && [[ ":$PATH:" != *":$BUN_BIN:"* ]]; then
	export PATH="$BUN_BIN:$PATH"
fi

if ! command -v claude-link-mcp >/dev/null 2>&1; then
	err "\`claude-link-mcp\` not on PATH after install"
	err "  bun's global bin is at: $BUN_BIN"
	err "  add this to $(shell_rc):"
	err "      export PATH=\"$BUN_BIN:\$PATH\""
	exit 1
fi

# ----- launcher wrapper (runs under Node, not Bun) -----

LAUNCHER_CJS="$GLOBAL_NM/claude-link/dist/launcher.cjs"
if [ ! -f "$LAUNCHER_CJS" ]; then
	err "missing launcher at $LAUNCHER_CJS — install is broken"
	exit 1
fi
cat > "$BUN_BIN/claude-link" <<EOF
#!/usr/bin/env bash
exec node "$LAUNCHER_CJS" "\$@"
EOF
chmod +x "$BUN_BIN/claude-link"
ok "launcher: $BUN_BIN/claude-link"

# ----- native binary fallback (node-datachannel, node-pty) -----
# bun's trustedDependencies isn't always honored on github installs; if the
# .node binary is missing, fetch the prebuilt one. On macOS, clear the
# Gatekeeper quarantine attribute so it can be loaded.

for pkg in node-datachannel node-pty; do
	pkg_dir="$GLOBAL_NM/$pkg"
	[ -d "$pkg_dir" ] || continue
	if ! find "$pkg_dir/build" -name '*.node' 2>/dev/null | grep -q .; then
		say "fetching prebuilt binary for $pkg"
		( cd "$pkg_dir" && bunx prebuild-install -r napi >/dev/null 2>&1 ) || \
		( cd "$pkg_dir" && npx --yes prebuild-install -r napi >/dev/null 2>&1 ) || true
	fi
	if [ "$(uname -s)" = "Darwin" ]; then
		find "$pkg_dir" -name '*.node' -exec xattr -d com.apple.quarantine {} \; 2>/dev/null || true
	fi
done

# ----- MCP registration -----

say "registering claude-link MCP server with Claude Code (user scope)"
claude mcp remove --scope user claude-link >/dev/null 2>&1 || true
claude mcp add --scope user claude-link -- claude-link-mcp >/dev/null
ok "MCP registered"

# ----- skill -----

SKILL_SRC="$GLOBAL_NM/claude-link/skills/claude-link"
SKILL_DST="${CLAUDE_HOME:-$HOME/.claude}/skills/claude-link"
if [ -d "$SKILL_SRC" ]; then
	mkdir -p "$(dirname "$SKILL_DST")"
	rm -rf "$SKILL_DST"
	cp -r "$SKILL_SRC" "$SKILL_DST"
	ok "skill: $SKILL_DST"
else
	warn "skill source missing at $SKILL_SRC — agent guidance won't be available"
fi

# ----- permissions -----

PERM_SCRIPT="$GLOBAL_NM/claude-link/scripts/install-permissions.cjs"
if [ -f "$PERM_SCRIPT" ]; then
	if node "$PERM_SCRIPT" >/dev/null 2>&1; then
		ok "MCP tools auto-allowed in user settings"
	else
		warn "could not update settings.json — you may see permission prompts"
	fi
fi

# ----- auto salt -----

SALT_FILE="$(claude-link-config path 2>/dev/null || echo "$HOME/.config/claude-link/salt")"
if [ ! -s "$SALT_FILE" ] && [ -z "${CLAUDE_LINK_SALT:-}" ]; then
	if command -v openssl >/dev/null 2>&1; then
		SALT_VAL="$(openssl rand -hex 32)"
	else
		SALT_VAL="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
	fi
	claude-link-config set "$SALT_VAL" >/dev/null
	ok "salt generated: $SALT_FILE"
else
	ok "salt: $SALT_FILE (kept)"
fi

# ----- PATH advice -----

# Open a fresh-shell PATH check by inspecting the rc file. If $BUN_BIN isn't
# referenced anywhere likely to be sourced, recommend the user add it.
RC="$(shell_rc)"
if ! grep -Fqs "$BUN_BIN" "$RC" 2>/dev/null; then
	warn "$BUN_BIN may not be on your PATH in new shells"
	warn "  add this line to $RC:"
	echo "      export PATH=\"$BUN_BIN:\$PATH\""
fi

echo
ok "claude-link is ready."
echo
echo "  Launch Claude through it (drop-in replacement for \`claude\`):"
echo "      claude-link"
echo "      claude-link --resume"
echo
echo "  Helpers:"
echo "      claude-link-config get|set|path"
echo "      claude-link-id [<session-uuid>]"
echo
echo "  Uninstall (one-liner):"
echo "      curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/uninstall.sh | bash"
