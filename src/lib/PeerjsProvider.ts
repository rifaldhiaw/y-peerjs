import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { Observable } from 'lib0/observable'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'

// Internal wire protocol message types.
const messageSync = 0
const messageAwareness = 1
const messageQueryAwareness = 2
const messageCustom = 3
const messageMesh = 4

// Bound on how many recently-seen fingerprints we remember to stop gossip
// relay (updates + mesh announcements) from growing unbounded.
const MAX_SEEN_UPDATES = 2000
// How often each peer re-announces its routing table (ms). Changes also
// trigger immediate announcements, so this is just a convergence safety net.
const MESH_ANNOUNCE_INTERVAL = 10000

/**
 * Cheap 32-bit FNV-1a hash of a byte array, used only to fingerprint Yjs
 * update payloads for relay-loop prevention — not for anything
 * security-sensitive, so collisions are an acceptable (and rare) cost: a
 * collision just means one update is skipped on one relay hop, and any
 * peer directly connected to the origin still received it directly.
 */
function fingerprint (bytes: Uint8Array, kind = 'u'): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 0x01000193)
  }
  return kind + ':' + (hash >>> 0).toString(36) + ':' + bytes.length
}

/** How a connection was initiated: we called connect(), or the peer did. */
export type ConnectionDirection = 'outgoing' | 'incoming'

export interface ConnState {
  conn: DataConnection
  synced: boolean
  /** Whether we initiated this connection (outgoing) or the peer did (incoming). */
  direction: ConnectionDirection
}

export interface PeerjsProviderOptions {
  /** Fixed id to register with the PeerJS broker. Omit to let PeerJS assign a random id. */
  peerId?: string
  /** Passed straight through to `new Peer(id, peerOptions)` (host, port, path, config for a custom PeerServer/TURN, etc). */
  peerOptions?: Record<string, unknown>
  /** Provide your own Awareness instance to share it across providers. If omitted, the provider creates and owns one (and will call its `.destroy()` when the provider itself is destroyed). */
  awareness?: awarenessProtocol.Awareness
  /** Peer ids to connect to automatically once our own id is registered. */
  autoConnectTo?: string[]
  /** Maximum number of simultaneous peer connections. Default 20. */
  maxConns?: number
  /** If > 0, periodically re-send sync step 1 to all peers (ms). Useful for long-lived flaky connections. Default -1 (disabled). */
  resyncInterval?: number
  /** Milliseconds to wait for a connect() attempt to open before giving up. Default 10000. */
  connectionTimeout?: number
}

export interface PeersEvent {
  added: string[]
  removed: string[]
  webrtcPeers: string[]
  bcPeers: string[]
}

export interface StatusEvent {
  status: string
  id?: string
}

/** One destination entry in a peer's advertised routing table. */
export interface MeshTableEntry {
  /** The destination peer id this path leads to (may be the announcer itself). */
  dest: string
  /** Full route from the ANNOUNCER to `dest`: next-hop first, dest last. */
  path: string[]
}

/**
 * What we know about a peer in the mesh that we are NOT directly connected
 * to: how we'd reach it. `path` lists the intermediates between us and the
 * peer (exclusive on both ends); `via` is simply its first element — the
 * directly-connected peer that is our next hop.
 */
export interface MeshPeerInfo {
  /** The remote peer id. */
  peerId: string
  /** Our next hop: the directly-connected peer to route through. */
  via: string
  /** Intermediates between us and the peer, exclusive on both ends. */
  path: string[]
  /** When we last (re)computed this entry (ms epoch). */
  lastSeen: number
}

/**
 * PeerjsProvider — a Yjs connection provider built on top of PeerJS.
 *
 * Unlike y-webrtc, there is no signaling-server "room" that auto-discovers
 * peers. Instead, YOU decide who to connect to by calling `connect(targetId)`
 * with a known PeerJS id (yours or a shared one), and you can drop any single
 * peer at any time with `disconnect(targetId)`. This is useful for direct
 * 1:1 or small mesh collaboration where peer ids are exchanged out-of-band
 * (a shared link, a lobby, a QR code, etc).
 *
 * Because you control the topology directly, it doesn't have to be a full
 * mesh — a star (one hub connected to several spokes that aren't connected
 * to each other), a chain, or any other graph works too: every peer relays
 * Yjs updates it receives on to its other connections (excluding whichever
 * connection the update came from), so changes propagate to everyone
 * reachable through the graph, not just directly-connected peers. A small
 * fingerprint cache (see `fingerprint()`) stops the same update from being
 * relayed more than once if your topology has cycles.
 *
 * Fires the following events (via `.on(name, cb)`):
 *  - 'status'            [{ status, id? }]                     connection/peer lifecycle
 *  - 'peers'             [{ added, removed, webrtcPeers, bcPeers }]  mirrors y-webrtc's 'peers' event shape
 *  - 'synced'            [{ peerId }]                           fired once per peer after first sync completes
 *  - 'peer-error'        [error]                                fatal error from the underlying Peer object
 *  - 'connection-error'  [error, peerId]                        error on a specific DataConnection
 *  - 'message-error'     [error, peerId]                        malformed/unhandled message from a peer
 *  - 'message'           [{ peerId, data }]                     raw custom messages sent via provider.send()
 *  - 'mesh'              [{ added, removed, mesh }]             remote-mesh view changed (see the mesh property)
 * @extends {Observable<string>}
 */
export class PeerjsProvider extends Observable<string> {
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  peer: Peer
  maxConns: number
  connectionTimeout: number
  connections: Map<string, ConnState>
  /** Resolves with our own registered PeerJS id once the broker confirms it. */
  whenReady: Promise<string>

  /**
   * Indirect peers we know about from the mesh protocol, keyed by peer id.
   * Each peer advertises its full routing table (destination -> full path)
   * to its neighbors and recomputes its own table from what it hears, so
   * every member learns the full reachable topology — including which of
   * its direct connections leads to any given indirect peer, and the exact
   * intermediate hops. Directly-connected peers never appear here.
   */
  mesh: Map<string, MeshPeerInfo>
  /**
   * Most recent routing table heard FROM each directly-connected peer:
   * peerId -> (dest -> path from that peer to dest, next-hop first).
   */
  neighborTables: Map<string, Map<string, string[]>>

  /**
   * Compute our full routing view: every reachable peer (including
   * ourselves) mapped to the complete path from us to it, next-hop first.
   * Direct connections contribute 1-hop paths; each neighbor's advertised
   * table contributes longer paths prefixed with that neighbor. Loop check:
   * paths that would traverse us are dropped.
   */
  _computeTable (): Map<string, string[]> {
    const next = new Map<string, string[]>()
    const self = this.id
    if (self === undefined) return next
    // We can always reach ourselves, and our direct connections are the
    // best (1-hop) paths to their endpoints.
    next.set(self, [self])
    this.connections.forEach((_, peerId) => next.set(peerId, [peerId]))
    this.neighborTables.forEach((table, neighbor) => {
      if (!this.connections.has(neighbor)) return // stale table
      table.forEach((remotePath, dest) => {
        if (next.has(dest)) return
        const viaPath = [neighbor, ...remotePath]
        if (viaPath.includes(self)) return // would loop through us
        // Sanity: a well-formed path ends at its destination.
        if (viaPath[viaPath.length - 1] !== dest) return
        next.set(dest, viaPath)
      })
    })
    return next
  }

  /**
   * Rebuild our routing view from our direct connections plus the tables
   * they've advertised, then emit 'mesh' if anything changed. Returns the
   * new table (dest -> full path from us, next-hop first, dest last).
   */
  _recomputeMesh (): Map<string, string[]> {
    const self = this.id
    const next = this._computeTable()

    // Diff against the public mesh map (which only holds indirect peers).
    const added: string[] = []
    const removed: string[] = []
    const now = Date.now()
    next.forEach((path, dest) => {
      if (dest === self || this.connections.has(dest)) return // not indirect
      const prev = this.mesh.get(dest)
      const info: MeshPeerInfo = {
        peerId: dest,
        via: path[0],
        path: path.slice(1, -1),
        lastSeen: now
      }
      this.mesh.set(dest, info)
      if (!prev || prev.via !== info.via || prev.path.join(',') !== info.path.join(',')) added.push(dest)
    })
    this.mesh.forEach((_, dest) => {
      if (!next.has(dest)) {
        this.mesh.delete(dest)
        removed.push(dest)
      }
    })
    if (added.length > 0 || removed.length > 0) {
      this.emit('mesh', [{ added, removed, mesh: new Map(this.mesh) }])
    }
    return next
  }

  /** Advertise our full routing table to every directly-connected peer. */
  _announceMesh (): void {
    if (this._destroyed || this.connections.size === 0) return
    const table = this._recomputeMesh()
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageMesh)
    encoding.writeVarUint(encoder, table.size)
    table.forEach((path, dest) => {
      encoding.writeVarString(encoder, dest)
      encoding.writeVarUint(encoder, path.length)
      path.forEach((hop) => encoding.writeVarString(encoder, hop))
    })
    this._broadcast(encoding.toUint8Array(encoder))
  }

  /**
   * Apply a routing table received from `fromPeerId` (one of our direct
   * connections), then recompute and re-announce if our own view changed.
   * Full-table replacement is what makes retraction work: a destination
   * missing from the new table is one the neighbor can no longer reach.
   */
  _handleMeshTable (fromPeerId: string, entries: MeshTableEntry[]): void {
    if (!this.connections.has(fromPeerId)) return
    const table = new Map<string, string[]>()
    entries.forEach(({ dest, path }) => {
      if (path.length > 0 && path[path.length - 1] === dest) table.set(dest, path)
    })
    const before = this._tableKey()
    this.neighborTables.set(fromPeerId, table)
    if (this._tableKey() !== before) {
      // Our view changed — propagate the news.
      this._announceMesh()
    }
  }

  /** Stable fingerprint of our current routing view, for change detection. */
  _tableKey (): string {
    return Array.from(this._computeTable().entries())
      .map(([dest, path]) => dest + ':' + path.join('>'))
      .sort()
      .join('|')
  }

  /** Forget everything learned from a now-closed connection, recompute. */
  _pruneMeshVia (closedPeerId: string): void {
    this.neighborTables.delete(closedPeerId)
    this._announceMesh() // recomputes internally and re-announces
  }

  /** ids of currently fully-open peer connections */
  get connectedPeers (): string[] {
    return Array.from(this.connections.keys())
  }

  /** our own registered PeerJS id, if already assigned */
  get id (): string | undefined {
    return this.peer.id || undefined
  }

  constructor (doc: Y.Doc, {
    peerId,
    peerOptions = {},
    awareness,
    autoConnectTo = [],
    maxConns = 20,
    resyncInterval = -1,
    connectionTimeout = 10000
  }: PeerjsProviderOptions = {}) {
    super()

    this.doc = doc
    // Track whether we created the Awareness instance ourselves, so we know
    // whether it's ours to `.destroy()` (which clears its internal outdated-
    // client interval timer) versus one the caller owns and may still be
    // using elsewhere.
    this._ownsAwareness = !awareness
    this.awareness = awareness || new awarenessProtocol.Awareness(doc)
    this.maxConns = maxConns
    this.connectionTimeout = connectionTimeout

    this.connections = new Map()
    this.connecting = new Set<string>()
    this.mesh = new Map()
    this.neighborTables = new Map()
    /** fingerprint -> true, insertion-ordered for LRU eviction */
    this._seenUpdateHashes = new Map<string, true>()

    // Periodically re-announce our routing table so peers that joined late
    // or missed an announcement (or a retraction) converge. With full-table
    // replacement, staleness fixes itself; no TTL eviction needed.
    this._meshAnnounceInterval = setInterval(() => {
      this._announceMesh()
    }, MESH_ANNOUNCE_INTERVAL)

    this._destroyed = false
    this._resyncInterval = null
    this._pendingConnects = new Map()
    this._meshAnnounceInterval = null

    this.peer = new Peer(peerId as string, peerOptions as never)

    this.whenReady = new Promise<string>((resolve, reject) => {
      this.peer.on('open', (id) => {
        this.emit('status', [{ status: 'peer-open', id }])
        resolve(id)
      })
      this.peer.on('error', (err) => {
        this.emit('peer-error', [err])
        reject(err)
      })
    })
    // Prevent unhandled-rejection noise if nobody awaits whenReady.
    this.whenReady.catch(() => {})

    this.peer.on('connection', (conn) => this._acceptIncoming(conn, 'incoming'))
    this.peer.on('disconnected', () => this.emit('status', [{ status: 'broker-disconnected' }]))
    this.peer.on('close', () => this.emit('status', [{ status: 'peer-closed' }]))

    this._docUpdateHandler = (update: Uint8Array, origin: unknown) => {
      // Updates we applied ourselves after receiving them from a peer are
      // tagged with origin === this; their propagation onward is handled
      // explicitly by _relayUpdate (see _handleMessage) so they aren't
      // double-broadcast here.
      if (origin === this) return
      // Register so that if this exact update ever bounces back to us
      // through a cycle in the connection graph, relay logic recognizes it
      // as already-seen and doesn't forward it further.
      this._markSeen(update, 'u')
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeUpdate(encoder, update)
      this._broadcast(encoding.toUint8Array(encoder))
    }
    doc.on('update', this._docUpdateHandler)

    this._awarenessUpdateHandler = ({ added, updated, removed }: { added: number[], updated: number[], removed: number[] }, origin: unknown) => {
      if (origin === this) return
      const changedClients = added.concat(updated).concat(removed)
      const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      this._markSeen(payload, 'a')
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, payload)
      this._broadcast(encoding.toUint8Array(encoder))
    }
    this.awareness.on('update', this._awarenessUpdateHandler)

    this._beforeUnloadHandler = () => {
      awarenessProtocol.removeAwarenessStates(this.awareness, [doc.clientID], 'window unload')
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('beforeunload', this._beforeUnloadHandler)
    }

    if (autoConnectTo.length > 0) {
      this.whenReady.then(() => {
        autoConnectTo.forEach((id) => this.connect(id).catch((err) => this.emit('connection-error', [err, id])))
      }).catch(() => {})
    }

    if (resyncInterval > 0) {
      this._resyncInterval = setInterval(() => {
        this.connections.forEach(({ conn }) => this._sendSyncStep1(conn))
      }, resyncInterval)
    }
  }

  _ownsAwareness: boolean
  connecting: Set<string>
  _seenUpdateHashes: Map<string, true>
  _destroyed: boolean
  _resyncInterval: ReturnType<typeof setInterval> | null
  _pendingConnects: Map<string, Promise<DataConnection>>
  _meshAnnounceInterval: ReturnType<typeof setInterval> | null
  _docUpdateHandler: (update: Uint8Array, origin: unknown) => void
  _awarenessUpdateHandler: (changes: { added: number[], updated: number[], removed: number[] }, origin: unknown) => void
  _beforeUnloadHandler: () => void

  /**
   * Open a data connection to a specific peer id and start the Yjs sync
   * handshake. Safe to call multiple times with the same id — a no-op if
   * already connected or currently connecting.
   */
  connect (targetId: string): Promise<DataConnection> {
    if (this._destroyed) return Promise.reject(new Error('provider has been destroyed'))
    if (!targetId) return Promise.reject(new Error('connect() requires a target peer id'))

    const existing = this.connections.get(targetId)
    if (existing) return Promise.resolve(existing.conn)
    if (this.connecting.has(targetId)) {
      return this._pendingConnects.get(targetId)!
    }
    if (this.connections.size >= this.maxConns) {
      return Promise.reject(new Error(`max connections (${this.maxConns}) reached`))
    }

    const promise = this.whenReady.then((ownId) => {
      if (targetId === ownId) throw new Error('cannot connect to self')
      this.connecting.add(targetId)
      const conn = this.peer.connect(targetId, {
        reliable: true,
        metadata: { from: ownId }
      })
      return new Promise<DataConnection>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.connecting.delete(targetId)
          conn.close()
          reject(new Error(`timed out connecting to ${targetId}`))
        }, this.connectionTimeout)

        conn.on('open', () => {
          clearTimeout(timer)
          resolve(conn)
        })
        conn.on('error', (err) => {
          clearTimeout(timer)
          this.connecting.delete(targetId)
          reject(err)
        })
        this._acceptIncoming(conn, 'outgoing')
      })
    })

    this._pendingConnects.set(targetId, promise)
    promise.finally(() => { this._pendingConnects.delete(targetId) })
    return promise
  }

  /**
   * Close the connection to a single peer, if any. Does not affect other
   * connections.
   */
  disconnect (targetId: string): void {
    const state = this.connections.get(targetId)
    if (state) {
      state.conn.close()
      this.connections.delete(targetId)
      this.emit('peers', [{ added: [], removed: [targetId], webrtcPeers: this.connectedPeers, bcPeers: [] }])
      this.emit('status', [{ status: 'peer-disconnected', id: targetId }])
      this._pruneMeshVia(targetId)
    }
    this.connecting.delete(targetId)
  }

  /** Close every current peer connection (the provider itself stays alive). */
  disconnectAll (): void {
    Array.from(this.connections.keys()).forEach((id) => this.disconnect(id))
  }

  /**
   * Send an arbitrary application-defined payload to one specific connected
   * peer, outside of the Yjs sync/awareness protocol. Useful for cursor
   * hints, presence pings, chat, etc. that you don't want going through
   * Yjs's Awareness state.
   * @returns whether the message was sent (false if not connected)
   */
  send (targetId: string, data: Uint8Array | string): boolean {
    const state = this.connections.get(targetId)
    if (!state || !state.conn.open) return false
    const payload = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageCustom)
    encoding.writeVarUint8Array(encoder, payload)
    state.conn.send(encoding.toUint8Array(encoder))
    return true
  }

  /** Broadcast an arbitrary payload to every connected peer. See {@link send}. */
  broadcast (data: Uint8Array | string): void {
    this.connections.forEach((_, id) => this.send(id, data))
  }

  _broadcast (data: Uint8Array): void {
    this.connections.forEach(({ conn }) => {
      if (conn.open) conn.send(data)
    })
  }

  _sendSyncStep1 (conn: DataConnection): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    conn.send(encoding.toUint8Array(encoder))
  }

  /**
   * Records that we've now handled this exact payload, so a later call
   * with the same bytes and kind is recognized as a repeat (e.g. bouncing
   * back around a cycle in the connection graph) and skipped.
   * @returns whether this payload had already been seen before this call
   */
  _markSeen (payload: Uint8Array, kind = 'u'): boolean {
    const key = fingerprint(payload, kind)
    const alreadySeen = this._seenUpdateHashes.has(key)
    this._seenUpdateHashes.set(key, true) // re-set to bump to most-recently-used position
    if (this._seenUpdateHashes.size > MAX_SEEN_UPDATES) {
      const oldest = this._seenUpdateHashes.keys().next().value
      if (oldest !== undefined) this._seenUpdateHashes.delete(oldest)
    }
    return alreadySeen
  }

  /**
   * Forwards a Yjs update we just received from `fromPeerId` on to every
   * *other* currently-connected peer, so document changes propagate through
   * non-fully-meshed topologies (star, chain, arbitrary graphs) rather than
   * stopping at the peer that happened to relay it to us. Deduplicated via
   * `_markSeen` so cycles in the connection graph can't cause the same
   * update to circulate indefinitely.
   */
  _relayUpdate (update: Uint8Array, fromPeerId: string): void {
    if (this._markSeen(update, 'u')) return // already relayed this exact update once before
    if (this.connections.size <= 1) return // no "other" peers to relay to
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeUpdate(encoder, update)
    const bytes = encoding.toUint8Array(encoder)
    this.connections.forEach(({ conn }, peerId) => {
      if (peerId !== fromPeerId && conn.open) conn.send(bytes)
    })
  }

  /**
   * Same idea as `_relayUpdate`, for awareness payloads: forwards a
   * received awareness update on to every other connected peer so presence
   * info also propagates through star/chain/arbitrary topologies.
   */
  _relayAwareness (payload: Uint8Array, fromPeerId: string): void {
    if (this._markSeen(payload, 'a')) return
    if (this.connections.size <= 1) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(encoder, payload)
    const bytes = encoding.toUint8Array(encoder)
    this.connections.forEach(({ conn }, peerId) => {
      if (peerId !== fromPeerId && conn.open) conn.send(bytes)
    })
  }

  /**
   * Wires up lifecycle + message handlers for a DataConnection, whether it
   * was initiated by us (connect()) or received from the peer (incoming
   * 'connection' event on the underlying Peer).
   * @param direction 'outgoing' when called from connect(), 'incoming' for
   * connections the peer initiated.
   */
  _acceptIncoming (conn: DataConnection, direction: ConnectionDirection = 'incoming'): void {
    const peerId = conn.peer
    // Avoid double-wiring the same conn object.
    const wired = (conn as unknown as { __yPeerjsWired?: boolean }).__yPeerjsWired
    if (wired) return
    ;(conn as unknown as { __yPeerjsWired?: boolean }).__yPeerjsWired = true

    this.connecting.add(peerId)

    const onOpen = () => {
      this.connecting.delete(peerId)

      if (this.connections.has(peerId)) {
        // Already have a connection to this peer (e.g. simultaneous mutual
        // connect). Keep the existing one, close this duplicate.
        if (this.connections.get(peerId)!.conn !== conn) {
          conn.close()
          return
        }
      }

      this.connections.set(peerId, { conn, synced: false, direction })
      this.emit('peers', [{ added: [peerId], removed: [], webrtcPeers: this.connectedPeers, bcPeers: [] }])
      this.emit('status', [{ status: 'peer-connected', id: peerId }])

      // Our neighborhood changed: tell everyone, and ask the new peer to
      // tell us about theirs (an announce right back primes the exchange).
      this._announceMesh()
      this._sendSyncStep1(conn)

      if (this.awareness.getStates().size > 0) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageAwareness)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys()))
        )
        conn.send(encoding.toUint8Array(encoder))
      }
    }

    if (conn.open) {
      onOpen()
    } else {
      conn.on('open', onOpen)
    }

    conn.on('data', (data: unknown) => this._handleMessage(conn, peerId, data as Uint8Array | ArrayBuffer))

    conn.on('close', () => {
      this.connecting.delete(peerId)
      const wasConnected = this.connections.has(peerId) && this.connections.get(peerId)!.conn === conn
      if (wasConnected) {
        this.connections.delete(peerId)
        this.emit('peers', [{ added: [], removed: [peerId], webrtcPeers: this.connectedPeers, bcPeers: [] }])
        this.emit('status', [{ status: 'peer-disconnected', id: peerId }])
        this._pruneMeshVia(peerId)
      }
    })

    conn.on('error', (err: Error) => {
      this.connecting.delete(peerId)
      this.emit('connection-error', [err, peerId])
    })
  }

  _handleMessage (conn: DataConnection, peerId: string, data: Uint8Array | ArrayBuffer): void {
    try {
      const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
      const decoder = decoding.createDecoder(buf)
      const messageType = decoding.readVarUint(decoder)

      switch (messageType) {
        case messageSync: {
          const syncMessageType = decoding.readVarUint(decoder)
          switch (syncMessageType) {
            case syncProtocol.messageYjsSyncStep1: {
              // Carries only a state vector (no document content) — reply
              // directly to the requester with our diff. Nothing to relay.
              const responseEncoder = encoding.createEncoder()
              encoding.writeVarUint(responseEncoder, messageSync)
              syncProtocol.readSyncStep1(decoder, responseEncoder, this.doc)
              conn.send(encoding.toUint8Array(responseEncoder))
              break
            }
            case syncProtocol.messageYjsSyncStep2:
            case syncProtocol.messageYjsUpdate: {
              // Both carry real document content (a syncStep2 handshake
              // reply, or a live update broadcast) — apply locally, then
              // relay to our other peers so it reaches anyone connected
              // through us but not directly to the sender (star/chain/etc
              // topologies), unless we've already seen this exact update.
              const update = decoding.readVarUint8Array(decoder)
              try {
                Y.applyUpdate(this.doc, update, this)
              } catch (err) {
                this.emit('message-error', [err, peerId])
                break
              }
              if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
                const state = this.connections.get(peerId)
                if (state && !state.synced) {
                  state.synced = true
                  this.emit('synced', [{ peerId }])
                }
              }
              this._relayUpdate(update, peerId)
              break
            }
            default:
              this.emit('message-error', [new Error(`unknown sync message subtype ${syncMessageType}`), peerId])
          }
          break
        }
        case messageAwareness: {
          const payload = decoding.readVarUint8Array(decoder)
          awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, this)
          this._relayAwareness(payload, peerId)
          break
        }
        case messageQueryAwareness: {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, messageAwareness)
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys()))
          )
          conn.send(encoding.toUint8Array(encoder))
          break
        }
        case messageCustom: {
          const payload = decoding.readVarUint8Array(decoder)
          this.emit('message', [{ peerId, data: payload }])
          break
        }
        case messageMesh: {
          const count = decoding.readVarUint(decoder)
          const entries: MeshTableEntry[] = []
          for (let i = 0; i < count; i++) {
            const dest = decoding.readVarString(decoder)
            const pathLen = decoding.readVarUint(decoder)
            const path: string[] = []
            for (let j = 0; j < pathLen; j++) {
              path.push(decoding.readVarString(decoder))
            }
            entries.push({ dest, path })
          }
          this._handleMeshTable(peerId, entries)
          break
        }
        default:
          this.emit('message-error', [new Error(`unknown message type ${messageType}`), peerId])
      }
    } catch (err) {
      this.emit('message-error', [err, peerId])
    }
  }

  /** Ask every connected peer to resend their current awareness state. */
  queryAwareness (): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageQueryAwareness)
    this._broadcast(encoding.toUint8Array(encoder))
  }

  /** Tear down all connections and the underlying Peer, and unregister doc/awareness listeners. */
  destroy (): void {
    if (this._destroyed) return
    this._destroyed = true

    if (this._resyncInterval) clearInterval(this._resyncInterval)
    if (this._meshAnnounceInterval) clearInterval(this._meshAnnounceInterval)

    this.doc.off('update', this._docUpdateHandler)
    this.awareness.off('update', this._awarenessUpdateHandler)

    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler)
    }

    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'provider destroyed')
    if (this._ownsAwareness) {
      this.awareness.destroy()
    }

    this.disconnectAll()
    this.peer.destroy()

    super.destroy()
  }
}

export default PeerjsProvider
