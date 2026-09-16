# y-peerjs

A [Yjs](https://github.com/yjs/yjs) connection provider built on top of
[PeerJS](https://peerjs.com/), inspired by
[y-webrtc](https://github.com/yjs/y-webrtc) — but instead of joining a
"room" discovered via a signaling server, **you explicitly connect to (and
disconnect from) individual peer ids**.

This trade-off makes sense when:

- You already have a way to hand two clients each other's id (a shared
  link, invite code, QR code, lobby list, your own backend, etc).
- You want fine-grained control over the mesh — e.g. connect to exactly
  one peer for a 1:1 session, or add/drop specific participants at will.
- You'd rather lean on PeerJS's free cloud broker (or your own
  [PeerServer](https://github.com/peers/peerjs-server)) for signaling
  instead of running a y-webrtc signaling server.

Under the hood it speaks the same wire protocols as y-webrtc
(`y-protocols/sync` and `y-protocols/awareness`), so the sync logic is
battle-tested — only the transport and connection-management layer differ.

## Install

```bash
npm install y-peerjs yjs y-protocols peerjs
```

`yjs`, `y-protocols`, and `peerjs` are peer dependencies — bring your own
versions.

## Quick start

```js
import * as Y from 'yjs'
import { PeerjsProvider } from 'y-peerjs'

const doc = new Y.Doc()
const ytext = doc.getText('shared')

const provider = new PeerjsProvider(doc, {
  // peerId: 'my-fixed-id',   // omit to let PeerJS assign a random id
})

// Wait for our own id to be registered with the broker, then share it
// with whoever you want to collaborate with (out of band).
provider.whenReady.then((myId) => console.log('my id:', myId))

// When you know who to talk to:
await provider.connect('the-other-persons-peer-id')

// ...later, drop just that connection without destroying the doc/provider:
provider.disconnect('the-other-persons-peer-id')
```

`ytext` (or any other shared type on `doc`) now syncs automatically with
every peer you're connected to — edits flow both ways, and reconnecting
later resyncs cleanly via Yjs's state-vector diffing.

## Topology: not just full mesh

Every peer relays sync/awareness messages it receives on to its *other*
connections (excluding whichever connection the message came from), so you
don't need a full mesh for everyone to stay in sync. A star works fine:

```
spoke1 ── hub ── spoke2
```

`spoke1` and `spoke2` never connect to each other directly — `spoke1`
edits reach `spoke2` by relaying through `hub`, and vice versa. Chains,
trees, or any other connected graph work the same way. If your graph has a
cycle (e.g. a triangle), a small fingerprint cache stops the same update
from being relayed back and forth indefinitely — each update is forwarded
at most once per connection.

Keep in mind a star's hub is a single point of failure for anyone not
directly connected to each other: if the hub goes down, `spoke1` and
`spoke2` stop syncing with each other until one of them connects directly
or to a new common hub.

The provider itself deliberately knows nothing about that wider network —
it only sees its direct connections and relays blindly. If you want to
*discover and visualize* the reachable topology (indirect peers and the
exact route to them), attach the opt-in `TopologyTracker` (see below).

Tracker announcements travel on a provider-internal message channel —
they never appear on the application `'message'` event and cannot collide
with your own `send()` payloads.

## API

### `new PeerjsProvider(doc, options?)`

| Option              | Type       | Default            | Description |
|---------------------|------------|---------------------|-------------|
| `peerId`             | `string`   | *(random)*          | Fixed id to register with the PeerJS broker. |
| `peerOptions`        | `object`   | `{}`                | Passed straight to `new Peer(id, peerOptions)` — set `host`/`port`/`path` to use your own PeerServer, or `config` to supply custom STUN/TURN servers. |
| `awareness`          | `Awareness`| new instance        | Pass a shared `y-protocols/awareness` instance if you're composing with another provider. |
| `autoConnectTo`      | `string[]` | `[]`                | Peer ids to connect to automatically as soon as our own id is ready. |
| `maxConns`           | `number`   | `20`                | Cap on simultaneous peer connections. |
| `resyncInterval`     | `number`   | `-1` (disabled)     | If `> 0`, periodically re-sends sync step 1 to all peers (ms). Cheap insurance against missed updates on flaky connections. |
| `connectionTimeout`  | `number`   | `10000`             | Milliseconds `connect()` waits for the connection to open before rejecting. |
| `heartbeatInterval`  | `number`   | `5000`              | How often to send liveness pings to connected peers (ms). `0` disables liveness detection. |
| `heartbeatTimeout`   | `number`   | `15000`             | How long a connection may stay completely silent (no pongs, data, or sync traffic) before it is considered dead and closed. Catches crashes, killed tabs, and network drops that never produce a `close` event. |
| `awarenessCleanupDelay` | `number` | `30000`            | How long after a peer's connection closes before the awareness states that peer delivered (their cursor, presence…) are removed from the shared `Awareness` instance. `0` removes them immediately. States still delivered by another connection (relay) are kept. |
| `awarenessCleanupDelay` | `number` | `30000`            | How long after a peer's connection closes before the awareness states that peer delivered (their cursor, presence…) are removed from the shared `Awareness` instance. `0` removes them immediately. States still delivered by another connection (relay) are kept. |

### Instance methods

- **`provider.connect(targetId): Promise<DataConnection>`** — opens a
  connection to `targetId` and performs the Yjs sync handshake. Resolves
  once the connection is open (not necessarily once synced — listen for
  `'synced'` for that). Idempotent: calling it again for an id you're
  already connected/connecting to returns the existing promise/connection.

- **`provider.disconnect(targetId): void`** — closes the connection to one
  specific peer. Everything else keeps running.

- **`provider.disconnectAll(): void`** — closes every current connection;
  the provider itself (and your own registered peer id) stays alive so you
  can `connect()` again later.

- **`provider.send(targetId, data): boolean`** — send an arbitrary
  `Uint8Array` or string to one peer outside of the Yjs protocol (e.g. a
  chat message or a cursor ping). Returns `false` if not connected.

- **`provider.broadcast(data): void`** — same as `send`, to every
  connected peer.

- **`provider.sendInternal(targetId, data): boolean`** — send an opaque
  payload on the internal extension channel (surfaced via the
  `'internal-message'` event, never on `'message'`). Used by provider
  add-ons such as `TopologyTracker`; application code normally has no
  reason to touch this.

- **`provider.queryAwareness(): void`** — ask all connected peers to
  resend their current awareness state (handy right after you `connect()`
  to a peer that joined earlier via someone else).

- **`provider.destroy(): void`** — closes all connections, destroys the
  underlying `Peer`, and unsubscribes from the Yjs doc/awareness.

### `new TopologyTracker(provider, options?)` — opt-in topology discovery

An `Observable`-based helper (exported from the package root, `'y-peerjs'`)
that runs a small path-vector discovery protocol over the provider's
*internal* message channel, so every participant learns the full reachable
topology — which direct connection leads to any indirect peer, and the
exact intermediate hops. The provider core stays clean; attach a tracker
only if you need remote-peer visibility (the topology widget does, and
creates one automatically).

```js
import { TopologyTracker } from 'y-peerjs'

const tracker = new TopologyTracker(provider)
tracker.on('changed', (remotePeers) => {
  // remotePeers: [{ peerId, path: [...intermediates, next-hop-first] }]
  console.log('indirect peers:', remotePeers)
})
tracker.getPath('some-remote-peer-id') // e.g. ['hub', 'bridge'] or undefined
tracker.nextHop('some-remote-peer-id') // e.g. 'hub' — where to send via

// ...later:
tracker.destroy()
```

Both ends need a tracker for discovery to work. Tracker traffic uses the
provider's internal extension channel (`sendInternal` / `'internal-message'`)
and is invisible to application `'message'` handlers. It is still exported
from `'y-peerjs/widget'` for backwards compatibility.

### Properties

- **`provider.id: string | undefined`** — our own registered PeerJS id,
  once assigned.
- **`provider.whenReady: Promise<string>`** — resolves with our own id.
- **`provider.connectedPeers: string[]`** — ids of currently open peer
  connections.
- **`provider.connections: Map<string, { conn, synced }> |`** — raw access
  to each `peerjs.DataConnection` plus whether initial sync completed.

### Events (`provider.on(name, cb)`)

| Event | Payload | When |
|---|---|---|
| `status` | `[{ status, id? }]` | broker/peer/connection lifecycle changes |
| `peers` | `[{ added, removed, webrtcPeers, bcPeers }]` | connection set changes (shape matches y-webrtc's `peers` event; `bcPeers` is always `[]` since there's no BroadcastChannel fallback here) |
| `synced` | `[{ peerId }]` | fired once per peer, the first time sync step 2 is processed for them |
| `peer-error` | `[Error]` | fatal error from the underlying `Peer` object |
| `connection-error` | `[Error, peerId]` | error on a specific connection (including `connect()` timeouts) |
| `connection-failed` | `[Error, peerId]` | a `connect()` attempt definitively failed — the peer id is not registered with the broker (`peer-unavailable`) or the attempt timed out |
| `message-error` | `[Error, peerId]` | malformed/unrecognized message from a peer |
| `message` | `[{ peerId, data }]` | custom payload received via the peer's `send`/`broadcast` |
| `internal-message` | `[{ peerId, data }]` | payload from provider add-ons (e.g. the topology tracker); apps can ignore these |

## How it differs from y-webrtc

| | y-webrtc | y-peerjs |
|---|---|---|
| Signaling | Custom WebSocket signaling server(s), room-based | PeerJS cloud broker (or your own PeerServer) |
| Discovery | Automatic — anyone in the same room id finds each other | Manual — you call `connect(targetId)` |
| Topology | Roughly full mesh (everyone in the room connects to everyone, up to `maxConns`) | Whatever graph you build — star, chain, mesh; non-fully-connected peers are reached via relay (see "Topology" above) |
| Local peers | Falls back to BroadcastChannel in the same browser | Not implemented (all traffic goes through PeerJS `DataConnection`s) |
| Transport | `simple-peer` | `peerjs` |
| Sync/Awareness protocol | `y-protocols/sync` + `y-protocols/awareness` | same |

## Notes & tips

- **Node.js**: PeerJS's `Peer` targets browsers (it depends on
  the browser's WebRTC APIs). To use this provider from Node, supply a
  WebRTC polyfill such as [`wrtc`](https://www.npmjs.com/package/wrtc) or
  [`node-datachannel`](https://www.npmjs.com/package/node-datachannel) via
  `peerOptions`, or run it in Electron.
- **Reconnecting after a page reload**: `peerId` lets you re-register the
  same id (subject to the broker's grace period after disconnect), so
  storing your own id and any peers you were talking to (e.g. in
  `localStorage`) plus `autoConnectTo` gives you automatic session
  resumption.
- **NAT traversal**: PeerJS's default cloud broker uses public STUN
  servers only; if either side is behind a symmetric NAT you'll likely
  need to supply your own TURN server via `peerOptions.config.iceServers`.
- **Awareness cleanup**: when a peer's connection closes, this provider
  automatically removes the awareness states that peer delivered (cursor,
  presence) after `awarenessCleanupDelay` (default 30s) — provided no other
  still-connected peer also delivers them (relay). Set the delay to `0` for
  instant removal, or call `awarenessProtocol.removeAwarenessStates` yourself
  from a `peers`-removed handler if you want fully custom behavior.

## Example

A runnable two-tab demo page is planned; for now, import the library and
wire it up directly:

```js
import * as Y from 'yjs'
import { PeerjsProvider } from 'y-peerjs'
import { createTopologyWidget, TopologyTracker } from 'y-peerjs/widget'

const doc = new Y.Doc()
const provider = new PeerjsProvider(doc, { peerId: 'my-peer-id' })
await provider.whenReady

// Optional: pass your own tracker to share discovery state with your app.
// Omit it and the widget creates (and destroys) one for you. TopologyTracker
// is exported from the package root; the widget re-exports it for compat.
const tracker = new TopologyTracker(provider)

// Floating panel showing the live connection graph,
// with connect/disconnect controls:
const widget = createTopologyWidget({ provider, tracker })

// The widget collapses to a sticky launcher button pinned to a window edge
// (drag it along the edge; click to expand). Expanded, it is a two-panel
// layout: graph on the left (solid edges for direct connections, dashed
// route edges for indirect peers, draggable nodes), list/detail on the
// right with `N direct · M indirect` stats. Peer ids are
// shown truncated (`abcdef…uvwxyz`) — click a node or list row to open the
// detail view with the full id (copy button), name, color, route, hop count
// and connect/disconnect actions. Clicking yourself shows your identity
// with an editable name/color that syncs to all peers via awareness.
// Programmatic control:
// widget.setCollapsed(true)
// widget.isCollapsed()
// widget.inspect('some-peer-id')
// widget.getInspected()

// ...later:
// widget.destroy()
```

## Development

```bash
bun install         # installs yjs/y-protocols/lib0 as devDependencies
bun run test        # runs the functional test suite (vitest) against the in-process mock transport
bun run typecheck   # tsc --noEmit
bun run build       # library build (dist/index.js + dist/widget.js)
```

`test/functional.test.ts` spins up multiple `PeerjsProvider`s in one Node
process against `test/mock-peerjs` (a tiny in-memory stand-in for the real
PeerJS broker/WebRTC transport, aliased in via vitest) and asserts: initial sync in both
directions, live update propagation, awareness propagation, that
`disconnect()` actually halts sync, that reconnecting resyncs missed
edits, that a third peer can join and catch up through one `connect()`
call, that `send()`/`'message'` works, that a star topology relays both
Yjs updates and awareness through the hub to spokes with no direct
connection to each other, that a cyclic (triangle) topology converges
without an infinite relay loop, and that the `TopologyTracker` learns
correct multi-hop routes (and retracts them when links drop). Real PeerJS
(and real WebRTC) only make sense in a browser, so this is what stands in
for an integration test here — if you want to be extra sure, wire the provider up in a small page
and open it in two browser tabs, which uses the real thing.

## License

MIT
