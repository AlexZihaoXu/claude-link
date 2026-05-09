---
name: claude-link
description: Peer-to-peer messaging between Claude Code sessions over WebRTC. Engage this skill any time the user asks about your "link id" / "linkid" / "link code" / "agent code", asks you to "talk to" / "connect to" / "send to" / "ping" / "ask" another agent, mentions a 6-character A-Z 0-9 code (e.g. K3J9PR, SDPNE7, MMPXEE), or wants to coordinate with another Claude session. The MCP server is named "claude-link" and exposes link_whoami / link_connect / link_send / link_peers / link_set_name. Peer messages auto-inject as user prompts in the format `[link from <name>] <text>` — when you see one, it's a peer talking to you, reply via link_send if substantive.
---

# claude-link — peer-to-peer messaging between Claude Code sessions

claude-link connects two Claude Code sessions (possibly on different machines) over WebRTC P2P. Each session has a deterministic 6-character **agent code** derived from its session id. Two agents using the same shared salt can find each other on the public PeerJS broker and exchange messages.

## When to engage

- "what's your link id / linkid / link code / agent code" — call `link_whoami` and answer.
- The user gives you a 6-char code (`K3J9PR`, `MMPXEE`, etc.) and wants you to "talk to" / "connect to" / "send to" / "ping" / "ask" them — use `link_connect` then `link_send`.
- The user asks "who's connected" / "who's online" — call `link_peers`.
- A line `[link from <CODE>] <text>` appears as user input — that's a peer message. Treat it the same way you'd treat any user prompt; reply via `link_send` if substantive.
- A line `[link event] <text>` appears — link-internal notification (peer connected, signaling reconnected, etc.). FYI only — do NOT reply via link_send.

If "linkid" appears with no LinkedIn / social-media context — assume it means **link code**, not LinkedIn.

## On the first link interaction

1. Call `link_whoami` — returns `code`, `salt`, `ready`, etc. This also kicks off peer registration so you become reachable.
2. If `ready: false` (no salt), tell the user to run `claude-link-config set <a long random string>` and stop.

That's it. **Do NOT arm a Monitor**, do NOT poll `link_inbox`, do not set up any extra plumbing. claude-link automatically injects peer messages as user prompts in your terminal — they appear formatted like `[link from <CODE>] <text>` and you respond to them like any other user input.

## Tools

| Tool | What it does | When |
|---|---|---|
| `link_whoami` | Returns your code, salt status. Kicks off peer registration. | Once at the start of any link conversation. |
| `link_set_name(name)` | Sets your display name peers see. | Optional, after first link_whoami. |
| `link_connect(code)` | Opens a connection to another agent. | When the user gives you a code to reach. |
| `link_send(code, text)` | Sends text to a connected peer. | When you have something substantive to say. |
| `link_peers` | Lists current connections. | When the user asks who you're connected to. |
| `link_inbox` | (Fallback) drain pending messages explicitly. | Rarely needed — only if you suspect auto-injection lost something. |

## Etiquette for cross-agent talk

- **Don't reply to acks.** "thanks" / "ok" / "got it" / "understood" end the exchange. Replying just bounces another ack and creates a politeness loop.
- **Silence is valid.** If the exchange reached a natural close, stop calling `link_send`.
- **Don't repeat yourself.** If you already sent the same content last turn, don't send it again.
- Treat the link as **async coordination**, not chat. Send only when something substantive needs to cross.

## Identity model

- session-id (UUID) → agent code (6 chars, deterministic) → PeerJS broker id (sha256 of `salt | code`).
- The salt is the shared secret. Both ends must use the same salt out of band.

## Common failure modes

- **`link_connect` times out** — the OTHER agent hasn't called any link_* tool since starting. Ask the user to make sure the other Claude session called `link_whoami` (or any link_ tool) at least once.
- **Salt mismatch** — both ends must have the EXACT same salt. Compare `link_whoami`'s `salt` field on both ends.
- **`link_send` says "not connected to X"** — the connection dropped. Call `link_connect` again.
