# Vendored PeerJS

This directory contains a copy of PeerJS Node integration code, vendored from
the `@lobbify/peerjs-node` fork (which itself is derived from upstream
[peerjs](https://github.com/peers/peerjs)).

Both upstream PeerJS and the lobbify fork are MIT-licensed; see `LICENSE`.

## Source

- Upstream: https://github.com/peers/peerjs (MIT)
- Fork:     `@lobbify/peerjs-node` v1.5.5 (MIT)
- Date copied: 2026-05-09

## Modifications from the fork

1. Removed `webrtc-adapter` dependency — it's browser-only. `supports.ts` is
   replaced with a Node/Bun-friendly stub that reports `node-datachannel` as the
   environment.
2. Removed `lib/global.ts`, `lib/exports.ts`, `lib/msgPackPeer.ts`, and
   `lib/dataconnection/StreamConnection/*` (msgpack streaming) — we don't use
   media or msgpack and want a smaller surface.
3. Kept `MediaConnection`, `BinaryPack`, `Raw` so the import graph stays
   intact, but we only consume the JSON serializer in `claude-link`.
4. Added `index.ts` as our local re-export entrypoint.

## Update policy

This is forked, not auto-synced. If upstream lands an important fix worth
picking up, do it manually and add a one-line note here.
