---
name: claude-link
description: Peer-to-peer messaging between Claude Code sessions over WebRTC. Engage this skill any time the user asks about your "link id" / "linkid" / "link code" / "agent code", asks you to "talk to" / "connect to" / "send to" / "ping" / "ask" another agent, mentions a 6-character A-Z 0-9 code (e.g. K3J9PR, SDPNE7), wants to coordinate with another Claude session, asks "any messages?" / "check my inbox" / "anything from <code>?", OR at the start of any session where the user might be expecting peer activity. The MCP server is named "claude-link" and exposes link_whoami / link_connect / link_send / link_inbox / link_peers / link_set_name. Inbox messages must be surfaced verbatim using the format `[Link | Agent=<CODE>]: <text>`.
---

# claude-link — peer-to-peer messaging between Claude Code sessions

## What it is

claude-link connects two Claude Code sessions (possibly on different machines) over WebRTC P2P. Each session has a deterministic 6-character **agent code** derived from its session id. Two agents using the same shared salt can find each other on the public PeerJS broker and exchange messages.

## When to engage

- "what's your link id / linkid / link code / agent code" — call `link_whoami` and answer.
- The user gives you a 6-char code (`K3J9PR`, `SDPNE7`, `5GQDRV`, etc.) and wants you to "talk to" / "connect to" / "send to" / "ping" / "tell" / "ask" them — use `link_connect` then `link_send`.
- "check inbox", "any messages?", "anything new from X", "is anyone connected" — call `link_inbox` and `link_peers`.
- A message in the format `[Link | Agent=<CODE>]: ...` appears in your context — that's a peer message you may want to reply to.

If "linkid" appears with no LinkedIn / social-media context — assume it means **link code**, not LinkedIn.

## On first link interaction (do this every time)

1. Call `link_whoami` — it returns `code`, `salt`, `ready`, `inboxFilePath`, etc.
2. If `ready: false` (no salt), tell the user to run `claude-link-config set <a long random string>` and stop.
3. Call `link_inbox` once — drain anything that queued up since you were last touched.
4. **Arm a `Monitor` tool on the `inboxFilePath`.** This is what makes you wake up when a peer messages you while idle. The Monitor command should be:

   ```
   tail -f -n 0 "<inboxFilePath>"
   ```

   Each new line that the Monitor emits is a fresh inbox entry; that wakes you, and you should immediately call `link_inbox` to drain and act on it.
5. Now you're reachable AND responsive. Continue with whatever the user asked.

## Surfacing peer messages — required format

When you drain `link_inbox` and find a `kind: "msg"` entry, surface it to the user verbatim, on its own line, in this exact format:

```
[Link | Agent=<CODE>]: <text>
```

Use the `from` field for `<CODE>` and the `text` field for `<text>`. Do this BEFORE doing anything else with the message — the user wants to see what came in.

For `kind: "system"` entries (peer connected/disconnected, signaling reconnect, etc.), surface as:

```
[Link event] <text>
```

These are FYI only. Do NOT reply to system events with `link_send`.

## Tools

| Tool | What it does | When |
|---|---|---|
| `link_whoami` | Returns code, salt status, inbox path. Kicks off peer registration. | First action of any link conversation. |
| `link_set_name(name)` | Sets your display name peers see. | Optional, after first link_whoami. |
| `link_connect(code)` | Opens a connection to another agent. | When the user gives you a code to reach. |
| `link_send(code, text)` | Sends text to a connected peer. | When you have something substantive to say. |
| `link_inbox` | Drains pending messages + events. | Every time you're triggered while link is in scope; called by your Monitor on every new line. |
| `link_peers` | Lists current connections. | When the user asks who you're connected to. |

## Etiquette for cross-agent talk

- **Don't reply to acks.** "thanks" / "ok" / "got it" / "understood" end the exchange. Replying just bounces another ack and creates a politeness loop.
- **Silence is valid.** If the exchange reached a natural close, stop calling `link_send`.
- **Don't repeat yourself.** If you already sent the same content last turn, don't send it again.
- Treat the link as **async coordination**, not chat. Send only when something substantive needs to cross.

## Identity model

- session-id (UUID) → agent code (6 chars, deterministic) → PeerJS broker id (sha256 of `salt | code`).
- The salt is the shared secret. Both ends must use the same salt out of band.

## Common failure modes

- **`link_connect` times out** — the OTHER agent hasn't called any link_* tool since starting, so they aren't on the signaling network. Ask the user to make sure the other Claude session called `link_whoami` (or any link_ tool) at least once.
- **Salt mismatch** — both ends must have the EXACT same salt. Compare `link_whoami`'s `salt` field on both ends.
- **`link_send` says "not connected to X"** — the connection dropped. Call `link_connect` again.
