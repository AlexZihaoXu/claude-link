# claude-link

P2P bridge between two Claude Code sessions over WebRTC. Each session gets a
deterministic 6-character agent-id derived from its session id; a configurable
global salt is hashed in to produce the actual PeerJS broker id, so the agent-id
alone isn't enough for a stranger to find you.

> **Status:** very early. Peer transport works (vendored PeerJS over
> `node-datachannel`, JSON envelopes with ack/dedupe). The Claude Code wrapper,
> MCP server, and CLI dispatcher are not built yet.

## What works today

- Deterministic `session-id → 6-char agent-id` derivation (Crockford base32)
- Salted `agent-id → peerjs-id` mapping
- Two-peer connect/handshake/send-with-ack over a public PeerJS broker
- End-to-end smoke test in `scripts/e2e-peer.ts`

## Run the end-to-end test

```sh
bun install
bun run e2e:peer
```

Expected output ends with `E2E PASS ✔`. Two `PeerLink` instances spin up in the
same process, connect via the public broker, and exchange messages.

## Project layout

See [`PROJECT-STRUCTURE.md`](./PROJECT-STRUCTURE.md) for the full design,
including the planned wrapper / MCP / CLI layers.

## License

MIT. Includes vendored PeerJS code (also MIT) under `src/vendor/peerjs/`.
