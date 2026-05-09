---
name: claude-link
description: Peer-to-peer messaging between Claude Code sessions. Use whenever the user asks about your "link id" / "link code" / "agent code", asks you to talk to / connect to / send a message to another agent (typically referenced by a 6-character A-Z 0-9 code like K3J9PR), wants to coordinate with another Claude session, or any time a peer might have just sent you something. The MCP server is named "claude-link" and exposes link_whoami / link_connect / link_send / link_inbox / link_peers / link_set_name.
---

# claude-link — peer-to-peer messaging between Claude Code sessions

claude-link connects two Claude Code sessions (possibly on different machines) over WebRTC P2P. Each session has a deterministic 6-character **agent code** (also called "link code" or "link id") derived from its Claude Code session id.

## When to engage this skill

- The user asks "what's your link id / link code / agent code".
- The user asks you to "connect to", "talk to", "ping", or "send to" another agent — often handing you a 6-character code like `K3J9PR`.
- A peer message has arrived (a `[link from <name>]` line, or you suspect `link_inbox` may have something queued).
- The user wants to coordinate work with another Claude session.

If the user mentions "linkid" or "link id" with no other context — they almost certainly mean your link code, NOT LinkedIn. Call `link_whoami`.

## Tools (provided by the `claude-link` MCP server)

| Tool | What it does | When to call |
|---|---|---|
| `link_whoami` | Returns your code, name, salt status, inbox file path. Also kicks off peer registration on the signaling network. | **First** — always call this once at the start of any link conversation. Until any link_* tool runs, your code is unreachable from the outside. |
| `link_set_name(name)` | Set a friendly display name peers see. | After `link_whoami` if no name is set; pick a short fun name. |
| `link_connect(code)` | Open a P2P connection to another agent by their 6-char code. | When the user gives you a code to reach. |
| `link_send(code, text)` | Send text to a connected peer. | When you have something substantive to say and there's an active connection. |
| `link_inbox` | Drain pending messages + system events. | At the start of any link-related turn; whenever the user asks you to check for messages; right after you call `link_whoami` if you've been away. |
| `link_peers` | List current connections. | When the user asks who you're connected to. |

## How to receive messages

Messages from peers don't auto-inject into your turn. There are two ways to surface them:

1. **Polling (always works)** — call `link_inbox` at the start of any link conversation, or whenever the user mentions checking for new traffic.
2. **Idle wake-up (recommended for active conversations)** — `link_whoami` returns an `inboxFilePath`. Arm a `Monitor` tool watching that path; each new line wakes you, then call `link_inbox` to drain. Use this when the user wants you to be responsive to a peer mid-session.

Inbox entries come in two flavors. Both are JSON objects with `{from, fromName, text, ts, kind}`:

- `kind: "msg"` — a peer agent sent you a message. Reply via `link_send` if substantive.
- `kind: "system"` — a notification from the link itself (peer connected/disconnected, signaling reconnected, etc.). **Do NOT reply via link_send** to system events — they're FYI for you to mention to the user if relevant.

## Etiquette when talking to other agents

- **Don't reply to acks** ("thanks", "ok", "got it", "understood"). They end the exchange; replying just bounces another ack and creates a politeness loop.
- **Silence is valid.** If the exchange reached a natural close, stop calling `link_send`.
- **Don't repeat yourself.** If you already sent the same content in your previous turn, don't send it again.
- Treat the link as **async coordination, not chat**. Send only when something substantive needs to cross.

## Identity model

- **session-id** (UUID) → **agent code** (6 chars, deterministic) → **PeerJS broker id** (sha256 of `salt | code`).
- The salt is the shared secret that namespaces a peer group. Both ends must use the same salt; otherwise their broker ids won't match and they can't reach each other.
- If `link_whoami` reports `salt: "none"` or `ready: false`, no salt is configured. Tell the user to run `claude-link-config set <a long random string>` (or set env var `CLAUDE_LINK_SALT`) and to share that salt with their peer out of band.

## Common failure modes

- **`link_connect` times out** — most likely the OTHER agent hasn't called any link_* tool since starting, so they aren't on the signaling network. Ask the user to make sure the other Claude session ran `link_whoami` (or any other link tool) at least once.
- **Salt mismatch** — both ends must have the EXACT same salt. Check `link_whoami` `salt: "env" | "file"` on both ends.
- **`link_send` says "not connected to X"** — the connection dropped. Call `link_connect` again first.
