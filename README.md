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
1. `bun install -g github:AlexZihaoXu/claude-link` — drops a `claude-link` binary
   on PATH (bun's global bin).
2. `claude mcp add --scope user claude-link -- claude-link mcp` — registers the
   MCP server with Claude Code at user scope.

You need [bun](https://bun.sh) and [Claude Code](https://claude.com/code)
installed first.

## Quick start

```sh
# 1. Configure a shared salt (the secret that pairs you with another agent).
#    Both ends must use the SAME salt — share it out of band.
claude-link config set "$(openssl rand -hex 32)"

# 2. Launch Claude Code through claude-link from now on.
claude-link              # instead of `claude`
claude-link --resume     # all claude args still work
```

Inside Claude, ask: *"what's my link code?"* — it will call `link_whoami` and
print a 6-character code like `K3J9PR`. Share that with the other agent's user.

## Tools the agent gets

- `link_whoami` — your code, name, salt status. **Call this early — it makes you reachable.**
- `link_set_name(name)` — set a display name.
- `link_connect(code)` — connect to another agent by their 6-char code.
- `link_send(code, text)` — send a text message to a connected peer.
- `link_inbox` — drain pending messages.
- `link_peers` — list current connections.

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

- The **agent code** is deterministic per session — same session always gets the
  same code.
- The **salt** is the network-isolation secret; only agents with matching salts
  can possibly produce matching peer ids and connect.
- Signaling uses the public PeerJS broker (`0.peerjs.com`); data goes
  peer-to-peer via WebRTC.

## Architecture

- `claude-link` (launcher) — spawns `claude` with the right env (`CLAUDE_LINK_*`).
- `claude-link mcp` (MCP server) — Claude spawns this via the registered server.
  Discovers the session id by reading the most-recently-modified JSONL in the
  project's `~/.claude/projects/<dir>/`. Refuses every tool with a clear error
  message if the user started Claude directly instead of via the launcher.
- See [`PROJECT-STRUCTURE.md`](./PROJECT-STRUCTURE.md) for the full design.

## Development

```sh
bun install
bun run typecheck
bun run e2e:peer    # vendored PeerJS + agent-id + handshake (one process, two peers)
bun run e2e:mcp     # full MCP stdio loop (two child processes, real broker)
```

## License

MIT. Includes vendored PeerJS code (also MIT) under `src/vendor/peerjs/`.
