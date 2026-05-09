# claude-link — Project Structure

A Bun + TypeScript CLI that lets two Claude Code sessions on different machines talk to each other over WebRTC P2P. Each session has a deterministic 6-char **agent-id** derived from its Claude Code session id, hashed with a configurable global **salt** to produce the actual PeerJS peer id.

This is intended to be a **standalone, publicly distributable** project — it has no dependency on any private package. The PeerJS Node integration code is **vendored** under `src/vendor/peerjs/` (see [Vendoring](#vendoring) below) so the repo is self-contained.

## High-level architecture

```
┌─────────────────────────────────────────────────────────────┐
│  claude-link (wrapper, Bun)                                 │
│                                                             │
│   stdin  ←──── user keyboard                                │
│                                                             │
│   ┌──────────────┐    PTY    ┌─────────────────────────┐    │
│   │ input-router │ ────────→ │ claude (child process)  │    │
│   └──────┬───────┘ ←──────── │   ┌─────────────────┐   │    │
│          │  user kb / pty io │   │ mcp-server      │   │    │
│          │                   │   │ (Bun, child of  │   │    │
│          │                   │   │  claude)        │   │    │
│          │                   │   └────┬────────────┘   │    │
│          │                   └────────┼────────────────┘    │
│          │                            │                     │
│          │  ▲                         │ unix-socket /        │
│          │  │   incoming peer msgs    │ named-pipe IPC       │
│          │  │                         ▼                      │
│   ┌──────┴──┴─────────────────────────────────┐              │
│   │ peer (PeerJS over @lobbify/peerjs-node)   │              │
│   │   ─ agent-id derivation                    │             │
│   │   ─ salted peerjs id                       │             │
│   │   ─ connection lifecycle                   │             │
│   └────────────────────┬───────────────────────┘             │
│                        ▼                                     │
└─────────────────────── peerjs broker (public or self-host) ─┘
                          │
                       (signaling)
                          │
                    ┌─────┴─────┐
                    │  peer B   │   (mirror image of above)
                    └───────────┘
```

Two processes inside the wrapper world:
- **wrapper** — owns the PTY for `claude`, owns the PeerJS connection, exposes a local IPC server.
- **mcp-server** — child of `claude`, gives Claude tools (`send`, `peers`, `status`, `disconnect`); forwards every call to the wrapper via IPC.

One binary, dispatched by subcommand: `claude-link run` boots the wrapper; `claude-link mcp` boots the MCP server (this is what Claude itself spawns based on its MCP config). Single artifact, single dependency tree.

## Folder layout

```
claude-link/
├── package.json
├── tsconfig.json
├── bun.lock
├── README.md
├── PROJECT-STRUCTURE.md          ← this file
├── token-usage-report-*.md       ← unrelated, will move/clean up
├── test-inbox.txt                ← scratch from wake-up test, can delete
│
├── src/
│   ├── cli.ts                    ← entry; subcommand dispatch (run | mcp | id)
│   │
│   ├── wrapper/                  ← `claude-link run`
│   │   ├── index.ts              ← orchestrator: spawn pty, peer, ipc; wire them
│   │   ├── pty.ts                ← node-pty wrapper, resize, EOF handling
│   │   ├── input-router.ts       ← merges stdin + injected peer msgs into pty
│   │   ├── interrupt.ts          ← writes ESC keycode to pty for mid-turn break
│   │   ├── ipc-server.ts         ← local socket / named pipe; commands from mcp
│   │   └── render.ts             ← optional decorations (peer-msg banner, etc.)
│   │
│   ├── mcp/                      ← `claude-link mcp`
│   │   ├── index.ts              ← MCP stdio server boot
│   │   ├── ipc-client.ts         ← connects back to wrapper via env-passed addr
│   │   └── tools/
│   │       ├── send.ts           ← send a message to a connected peer
│   │       ├── peers.ts          ← list connected peers + their agent-ids
│   │       ├── status.ts         ← own agent-id, broker, connection state
│   │       └── disconnect.ts     ← close a peer connection
│   │
│   ├── peer/                     ← our thin layer over the vendored PeerJS
│   │   ├── index.ts              ← Peer wrapper, lifecycle, reconnect
│   │   ├── id.ts                 ← session-id → 6-char agent-id → salted peer-id
│   │   ├── connection.ts         ← per-peer Connection: send, on(data), close
│   │   └── codec.ts              ← message envelope (json), version, msg-id, ack
│   │
│   ├── vendor/                   ← third-party code copied in (see Vendoring)
│   │   └── peerjs/               ← @lobbify/peerjs-node lib/, MIT, attributed
│   │       ├── LICENSE           ← original MIT, Michelle Bu / Eric Zhang
│   │       ├── README.md         ← what was copied, from where, what was changed
│   │       ├── peer.ts
│   │       ├── socket.ts
│   │       ├── negotiator.ts
│   │       ├── nodeDataChannel.ts
│   │       ├── dataconnection/
│   │       │   ├── DataConnection.ts
│   │       │   └── BufferedConnection/
│   │       │       ├── BufferedConnection.ts
│   │       │       └── Json.ts        ← we only need JSON serialization
│   │       └── ...                    ← see vendoring doc for full list
│   │
│   ├── config/
│   │   ├── index.ts              ← load + merge env, file, defaults
│   │   ├── schema.ts             ← zod schema for config validation
│   │   └── paths.ts              ← OS-specific paths (~/.claude-link/, %APPDATA%)
│   │
│   └── util/
│       ├── log.ts                ← stderr logger, pino or similar
│       ├── session.ts            ← detect current Claude Code session id
│       └── ipc-protocol.ts       ← wire format shared by ipc-server/client
│
├── docs/                         ← created later
│   ├── design-decisions.md
│   └── plugin-distribution.md    ← future: shipping as Claude Code plugin
│
├── tests/                        ← deferred; manual smoke first
│   └── .gitkeep
│
└── plugin/                       ← optional; future Claude Code plugin bundle
    └── (deferred)
```

## Subcommands

```
claude-link run [-- <args-to-claude>]    # spawn claude in pty, link to peer net
claude-link mcp                          # MCP stdio server (used by Claude config)
claude-link id [--session <id>]          # print derived agent-id (debugging)
claude-link config <get|set>             # manage salt + broker config
```

## Agent-id derivation

```
session-id (UUID, from ~/.claude/sessions/<id>.jsonl filename)
    │
    │ sha256(session-id)
    ▼
first 30 bits → base32-crockford → 6-char agent-id  (e.g. "K3J9PR")
    │
    │ sha256(agent-id ":" global-salt)
    ▼
hex/base32 → peerjs-id  (e.g. "cl-7f3a...")
```

- agent-id is shareable, human-friendly, low-entropy by design (6 chars, ~30 bits).
- salt provides the network-isolation secret. Two peers with different salts can never produce matching peer-ids. Without salt, agent-ids would be world-guessable.
- peerjs-id is what shows on the broker. Optional `cl-` prefix to namespace.

`src/peer/id.ts` exposes:

```ts
deriveAgentId(sessionId: string): string         // 6-char
derivePeerId(agentId: string, salt: string): string
```

## Wire protocol (peer ↔ peer)

Every PeerJS DataChannel message is a JSON envelope:

```ts
type Envelope = {
  v: 1;                  // protocol version
  id: string;            // ulid; for dedupe + ack
  ts: number;            // sender unix ms
  kind: "msg" | "ack" | "ping";
  body?: string;         // for kind=msg, the text injected into the peer's pty
};
```

- Receiver dedupes by `id`, sends `ack`. Idempotent.
- Disconnects clear pending acks; sender retries on reconnect (configurable cap).
- v1 keeps it text-only. Tool-call RPC, file transfer, etc. are out of scope for v1.

## IPC (mcp ↔ wrapper)

Local-only. Wrapper spawns claude with env vars:

```
CLAUDE_LINK_IPC_ADDR=\\.\pipe\claude-link-<pid>     (Windows)
CLAUDE_LINK_IPC_ADDR=/tmp/claude-link-<pid>.sock    (POSIX)
CLAUDE_LINK_IPC_TOKEN=<random>                      (per-spawn)
```

`src/util/ipc-protocol.ts` defines a small length-prefixed JSON-line protocol:

```ts
// mcp → wrapper
{ op: "send",       to: "K3J9PR", body: "..." }
{ op: "peers" }
{ op: "status" }
{ op: "disconnect", to: "K3J9PR" }

// wrapper → mcp (response, same id)
{ ok: true,  result: ... }
{ ok: false, error: { code: "...", msg: "..." } }
```

Token check on every connection — protects against unrelated processes on the same machine talking to the wrapper.

## Config

Resolution order (later wins):
1. defaults
2. `~/.claude-link/config.json` (or `%APPDATA%\claude-link\config.json`)
3. environment variables (`CLAUDE_LINK_SALT`, `CLAUDE_LINK_BROKER_HOST`, ...)
4. CLI flags

Schema (zod, in `src/config/schema.ts`):

```ts
{
  salt: string,                   // required for non-trivial use
  broker: { host, port, path, secure } | "default",
  claudeBin: string,              // default: "claude"
  injectTag: boolean,             // prepend "[from <agent-id>] " to peer msgs
  reconnect: { maxAttempts: number, backoffMs: number },
  log: { level: "debug"|"info"|"warn"|"error", file?: string }
}
```

## How a peer message becomes Claude input

1. Peer A's daemon `peer.connection.send(envelope)`.
2. PeerJS broker relays signaling; data goes peer-to-peer.
3. Peer B's `src/peer/index.ts` receives `data`, decodes envelope, dedupes.
4. Hands body to `wrapper/input-router.ts`.
5. Router writes to `wrapper/pty.ts`:
   - Optional `0x1b` (ESC) first if config.interruptOnInbound and Claude is mid-turn
   - `[from K3J9PR] <body>\r`  — `\r` submits the prompt
6. Claude wakes (because PTY stdin received data), processes the line as a normal user prompt.
7. If Claude wants to reply, it calls the MCP `send` tool → IPC → wrapper → PeerJS → peer A.

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Bun | requested; fast TS; one binary via `bun build` |
| Lang | TypeScript strict | self-doc'd; matches user's other tools |
| WebRTC | vendored PeerJS (MIT) under `src/vendor/peerjs/` | self-contained; no private dep; runs on Bun via `node-datachannel` |
| Native WebRTC | `node-datachannel` (npm, public) | the only runtime npm dep needed for WebRTC; provides `RTCPeerConnection` for Node/Bun |
| PTY | `node-pty` | mature ConPTY/forkpty handling; Bun-compatible |
| MCP | `@modelcontextprotocol/sdk` | official client/server SDK |
| Config validation | `zod` | tiny, lives well in TS |
| Logger | `pino` (stderr only) | won't pollute the PTY pass-through |
| IDs | `ulid` for msg-id, `crypto.subtle` for sha256 | stdlib + one tiny dep |

## Vendoring

The PeerJS Node integration is vendored from `@lobbify/peerjs-node` (private) into `src/vendor/peerjs/`. Both that fork and upstream PeerJS are MIT-licensed, so this is permitted with attribution.

**What we copy:**
- `lib/peer.ts`, `socket.ts`, `negotiator.ts`, `baseconnection.ts`, `servermessage.ts`, `enums.ts`, `logger.ts`, `util.ts`, `peerError.ts`, `api.ts`, `optionInterfaces.ts`, `version.ts`, `supports.ts`, `nodeDataChannel.ts`, `encodingQueue.ts`
- `lib/dataconnection/DataConnection.ts`
- `lib/dataconnection/BufferedConnection/{BufferedConnection,Json,Raw}.ts`
- `lib/utils/{randomToken,validateId}.ts`
- `LICENSE` (preserved verbatim) and a short `README.md` describing the source commit, what was copied, and what (if anything) was modified.

**What we drop** (not needed for our use case):
- `mediaconnection.ts` — no audio/video
- `msgPackPeer.ts`, `dataconnection/StreamConnection/MsgPack.ts`, `dataconnection/BufferedConnection/BinaryPack.ts`, `binaryPackChunker.ts` — we use JSON only; trimming reduces deps and surface area
- `global.ts`, `exports.ts` — replaced by our own `src/vendor/peerjs/index.ts`

**What we touch:**
- Fix any imports broken by the trim (e.g., remove `MediaConnection` exports)
- Re-route `peerjs-js-binarypack` and `@msgpack/msgpack` imports to dead-code paths or remove

**Attribution:**
- `src/vendor/peerjs/LICENSE` keeps the original MIT notice (Michelle Bu / Eric Zhang)
- Top-level `LICENSE` is also MIT
- `README.md` and `NOTICE` credit upstream PeerJS and the lobbify fork

**Update policy:** vendored code is forked, not auto-synced. If upstream PeerJS or the lobbify fork lands an important fix, we cherry-pick it manually with a note in `src/vendor/peerjs/README.md`.

## Build & run

```bash
bun install
bun run src/cli.ts run -- <claude args>     # dev
bun build src/cli.ts --outfile dist/claude-link --compile --target=bun  # release
```

Claude Code MCP config snippet (lives in user's settings.json or per-project `.mcp.json`):

```json
{
  "mcpServers": {
    "claude-link": {
      "command": "claude-link",
      "args": ["mcp"]
    }
  }
}
```

## Out of scope for v1

- File transfer between peers
- Multi-peer mesh (v1 is 1:1; multi-peer is a config-only extension later)
- Tool-call RPC (calling peer's tools)
- Voice/video
- Encryption beyond the salt-as-secret + WebRTC's built-in DTLS
- Persistent message history (each session is ephemeral; logs are debug-only)
- Authority/ACL beyond salted peer-id matching
- Auto-reconnect across `claude` restarts (PTY death = wrapper exit; user re-runs)

## Open questions

1. **Broker default.** Use the public PeerJS broker (`0.peerjs.com`) for v1, or require user to set one? Public is friction-free but leaks metadata. Lean: public by default, document the privacy boundary.
2. **Session id detection.** Claude Code's running session id isn't exposed in env (TBD). Options: spawn `claude` with `--session-id <ours>`, derive from `~/.claude/sessions/<latest>` mtime, or have the MCP server report it back. Lean: have the wrapper generate an id and pass `--session-id`.
3. **Mid-turn interrupt UX.** Inbound peer message during a tool call: drop on the floor, queue until idle, or ESC + inject? Lean: config-driven, default queue-until-idle (less destructive).
4. **Multiple claude instances per machine.** Each wrapper picks its own IPC socket name (per-pid). No collision concern.
5. **Plugin distribution.** Ship as a Claude Code plugin later for one-step install + auto MCP registration. Out of v1.

## Status

- [x] Wake-up mechanism research (Monitor confirmed for hook path; PTY chosen for cleanliness)
- [x] Project structure (this doc)
- [ ] Scaffold (package.json, tsconfig, src tree)
- [ ] `peer/id.ts` + unit-style demo for derivation
- [ ] `peer/index.ts` minimal connect/send/recv against `@lobbify/peerjs-node`
- [ ] `wrapper/pty.ts` + manual smoke (spawn `bash`, type, observe)
- [ ] IPC server/client roundtrip
- [ ] MCP server with `send` tool
- [ ] End-to-end: two terminals, two `claude-link run`, exchange a message
