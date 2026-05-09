# claude-link

Peer-to-peer messaging between two Claude Code sessions over WebRTC. Each session
gets a deterministic 6-character agent code derived from its session id; a
configurable shared salt is hashed in to produce the actual PeerJS broker id, so
the agent code alone is not enough for a stranger to find you.

## Install

```sh
# POSIX (macOS / Linux):
curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/claude-link/main/install.sh | bash

# Windows (PowerShell):
irm https://raw.githubusercontent.com/AlexZihaoXu/claude-link/main/install.ps1 | iex
```

The installer:
1. `bun install -g github:AlexZihaoXu/claude-link` — installs the package.
2. Drops a `claude-link` shell wrapper in Bun's global bin that runs the
   launcher under Node (Bun + node-pty + Windows ConPTY is unstable, so the
   launcher specifically uses Node).
3. `claude mcp add --scope user claude-link -- claude-link-mcp` — registers the
   MCP server with Claude Code at user scope.
4. Copies the agent skill to `~/.claude/skills/claude-link/`.
5. Pre-allows `mcp__claude-link__*` tools in `~/.claude/settings.json` so the
   agent isn't prompted on every send.
6. Auto-generates a random salt at the salt file if none exists, so single-machine
   testing works out of the box.

You need [bun](https://bun.sh), [Node.js](https://nodejs.org) (≥18), and
[Claude Code](https://claude.com/code) installed first.

## Quick start

```sh
# (Optional) replace the auto-generated salt with one you'll share across machines.
# Both ends must use the SAME salt — share it out of band.
claude-link-config set "$(openssl rand -hex 32)"

# Launch Claude Code through claude-link from now on.
claude-link              # instead of `claude`
claude-link --resume     # all claude args still work
```

Inside Claude, ask: *"what's my link code?"* — it will call `link_whoami` and
print a 6-character code like `K3J9PR`. Share that with the other agent's user.

When a peer sends you a message, it auto-injects into your terminal as if the
user typed `[link from <name>] <text>` and pressed Enter. No polling needed.

## Tools the agent gets

- `link_whoami` — your code, name, salt status. **Call this early — it makes you reachable.**
- `link_set_name(name)` — set a display name peers see.
- `link_connect(code)` — connect to another agent by their 6-char code.
- `link_send(code, text)` — send a text message to a connected peer.
- `link_peers` — list current connections.
- `link_inbox` — fallback drain (rarely needed; peer messages auto-inject).

## Helper commands

- `claude-link-config get|set|path` — manage the salt.
- `claude-link-id [<session-uuid>]` — print the agent code derived from a session.
- `claude-link-mcp` — MCP stdio server. Claude spawns this; you don't run it.

## How it works

```
session-id (UUID, from ~/.claude/projects/<dir>/<id>.jsonl)
    │  sha256 → first 30 bits → Crockford base32
    ▼
agent code (6 chars, e.g. K3J9PR)  — share this
    │  sha256(salt | code)
    ▼
PeerJS broker id (cl-<32 hex>)    — what the broker actually sees
```

- The **agent code** is deterministic per session — same Claude session always
  gets the same code.
- The **salt** is the network-isolation secret; only agents with matching salts
  can possibly produce matching peer ids and connect.
- Signaling uses the public PeerJS broker (`0.peerjs.com`); data goes
  peer-to-peer via WebRTC.

## Architecture

- **`claude-link`** — Node-based PTY launcher. Spawns `claude` in a PTY,
  proxies user keyboard ↔ PTY transparently, and hosts a local IPC server
  the MCP server uses to inject incoming peer messages as user-typed input.
- **`claude-link-mcp`** — MCP stdio server (Bun). Discovers the session id
  from the most-recently-modified JSONL in `~/.claude/projects/<dir>/`,
  derives the agent code, registers on the PeerJS broker. Refuses every tool
  with a clear error if the user started Claude directly instead of via the
  launcher (so the salt and IPC env vars wouldn't be set up).

## Development

```sh
bun install
bun run typecheck
bun run e2e:mcp     # full MCP stdio loop (two child processes, real broker)
bun run e2e:inject  # peer-message → IPC inject roundtrip
```

## License

MIT. Includes vendored PeerJS code (also MIT) under `src/vendor/peerjs/`.
