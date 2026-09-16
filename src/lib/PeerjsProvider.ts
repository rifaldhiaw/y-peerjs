import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { ObservableV2 } from 'lib0/observable'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'

// Internal wire protocol message types.
const messageSync = 0
const messageAwareness = 1
const messageQueryAwareness = 2
const messageCustom = 3
const messagePing = 4
const messagePong = 5
/**
 * Internal extension channel: opaque payloads carried hop-to-hop for
 * provider add-ons (e.g. TopologyTracker). Never surfaced to application
 * code and never relayed by the provider itself — an add-on decides whether
 * to forward what it receives. See {@link sendInternal} / `internalMessage`.
 */
const messageInternal = 6

// Peer error types that mean the provider can never become ready — anything
// else ('peer-unavailable', 'network', 'disconnected', …) is transient and
// only surfaces as a 'peer-error' event while the provider keeps working.
const FATAL_PEER_ERRORS = new Set(['browser-incompatible', 'invalid-id', 'unavailable-id', 'ssl-unavailable'])

// Bound on how many recently-seen fingerprints we remember to stop gossip
// relay from growing unbounded.
const MAX_SEEN_UPDATES = 2000

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

/**
 * Decode just the clientIDs from an awareness update payload (varUint len,
 * then per client: varUint clientID, varUint clock, varString JSON state)
 * without applying it. Used to remember which awareness states each
 * connection delivered, so they can be cleaned up when it closes.
 */
function awarenessClientIds (payload: Uint8Array): number[] {
  const clients: number[] = []
  try {
    const decoder = decoding.createDecoder(payload)
    const len = decoding.readVarUint(decoder)
    for (let i = 0; i < len; i++) {
      clients.push(decoding.readVarUint(decoder))
      decoding.readVarUint(decoder) // clock
      decoding.readVarString(decoder) // JSON state
    }
  } catch {
    // Malformed payload — applyAwarenessUpdate in _handleMessage surfaces
    // the error via 'message-error'; nothing to clean up here.
  }
  return clients
}

export interface ConnState {
  conn: DataConnection
  synced: boolean
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
  /** How often to send liveness pings to connected peers (ms). 0 disables liveness detection. Default 5000. */
  heartbeatInterval?: number
  /** How long a connection may stay completely silent before it is considered dead and closed (ms). Default 15000. */
  heartbeatTimeout?: number
  /**
   * How long after a peer's connection closes before the awareness states
   * that peer delivered (their cursor, presence…) are removed from the
   * shared Awareness instance (ms). 0 removes them immediately. The delay
   * absorbs quick reconnects; states still delivered by another connection
   * are never removed. Default 30000.
   */
  awarenessCleanupDelay?: number
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

/**
 * Typed event map for {@link PeerjsProvider}, consumed by lib0's
 * ObservableV2. Gives compile-time checking of event names and listener
 * signatures on `provider.on(...)` / `provider.off(...)`.
 */
export interface PeerjsProviderEvents {
  status: (event: StatusEvent) => void
  peers: (event: PeersEvent) => void
  synced: (event: { peerId: string }) => void
  'peer-error': (err: Error) => void
  'connection-error': (err: Error, peerId: string) => void
  'connection-failed': (err: Error, peerId: string) => void
  'message-error': (err: unknown, peerId: string) => void
  message: (event: { peerId: string, data: Uint8Array }) => void
  'internal-message': (event: { peerId: string, data: Uint8Array }) => void
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
 *  - 'connection-failed' [error, peerId]                        a connect() attempt definitively failed (peer not registered with the broker, or timed out) — the widget uses this to stop showing 'connecting…'
 *  - 'message-error'     [error, peerId]                        malformed/unhandled message from a peer
 *  - 'message'           [{ peerId, data }]                     raw custom messages sent via provider.send()
 *  - 'internal-message'  [{ peerId, data }]                     opaque payloads from provider add-ons (sendInternal); apps can ignore these
 * @extends {ObservableV2<PeerjsProviderEvents>}
 *
 * Note: the provider deliberately knows nothing about the wider network
 * beyond its direct connections — sync works over any graph via relaying.
 * If you need to *visualize* or discover the reachable topology (indirect
 * peers and their routes), attach a TopologyTracker (see ./widget/), which
 * runs an opt-in discovery protocol over the generic send()/message channel.
 */
export class PeerjsProvider extends ObservableV2<PeerjsProviderEvents> {
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  peer: Peer
  maxConns: number
  connectionTimeout: number
  heartbeatInterval: number
  heartbeatTimeout: number
  awarenessCleanupDelay: number
  connections: Map<string, ConnState>
  /** Resolves with our own registered PeerJS id once the broker confirms it. */
  whenReady: Promise<string>

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
    connectionTimeout = 10000,
    heartbeatInterval = 5000,
    heartbeatTimeout = 15000,
    awarenessCleanupDelay = 30000
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
    this.heartbeatInterval = heartbeatInterval
    this.heartbeatTimeout = heartbeatTimeout
    this.awarenessCleanupDelay = awarenessCleanupDelay

    this.connections = new Map()
    this.connecting = new Set<string>()
    /** conn objects already wired with lifecycle/message handlers */
    this._wiredConns = new WeakSet<DataConnection>()
    /** peerId -> timestamp of last inbound traffic (any message), for liveness */
    this._lastSeen = new Map()
    /** fingerprint -> true, insertion-ordered for LRU eviction */
    this._seenUpdateHashes = new Map<string, true>()
    /** connections we initiated via connect() (incoming ones are absent) */
    this._ownDials = new WeakSet<DataConnection>()
    /**
     * targetId -> attempt token for the current connect() attempt. A token
     * is a fresh object per attempt; disconnect() (or a newer connect())
     * removes/replaces it, and the in-flight attempt detects it's stale by
     * identity comparison. This makes cancellation work even while the
     * broker registration (whenReady) is still pending.
     */
    this._attemptTokens = new Map<string, object>()
    /** targetId -> rejector of the in-flight connect() promise */
    this._pendingRejects = new Map<string, (err: Error, emitFailed: boolean) => void>()
    /** targetId -> outgoing DataConnection of the in-flight connect() attempt */
    this._pendingConns = new Map()
    /** peerId -> awareness clientIDs that connection last delivered to us */
    this._peerClients = new Map<string, Set<number>>()
    /** peerId -> timeout id for deferred removal of that peer's awareness states */
    this._awarenessCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

    this._destroyed = false
    this._resyncInterval = null
    this._pendingConnects = new Map()
    this._heartbeatTimer = null
    if (heartbeatInterval > 0) {
      this._heartbeatTimer = setInterval(() => this._heartbeatTick(), heartbeatInterval)
    }

    this.peer = new Peer(peerId as string, peerOptions as never)

    this.whenReady = new Promise<string>((resolve, reject) => {
      this.peer.on('open', (id) => {
        this.emit('status', [{ status: 'peer-open', id }])
        resolve(id)
      })
      this.peer.on('error', (err) => {
        this.emit('peer-error', [err])
        // Only truly fatal broker problems reject whenReady. Transient ones
        // ('peer-unavailable', 'network', …) surface as events only — the
        // provider keeps working, and whenReady must not be poisoned by them.
        if (FATAL_PEER_ERRORS.has((err as { type?: string }).type ?? '')) {
          reject(err)
        }
      })
    })
    // Prevent unhandled-rejection noise if nobody awaits whenReady.
    this.whenReady.catch(() => {})

    this.peer.on('connection', (conn) => this._acceptIncoming(conn))
    this.peer.on('disconnected', () => this.emit('status', [{ status: 'broker-disconnected' }]))
    this.peer.on('close', () => this.emit('status', [{ status: 'peer-closed' }]))

    // PeerJS surfaces "peer id not registered with the broker" as a Peer
    // error (type 'peer-unavailable'), not per-connection. Connect attempts
    // to ids that no longer exist (tab closed, broker restart…) would
    // otherwise hang until the connect() timeout — map them to a definitive
    // failure now.
    this._peerErrorHandler = (err: Error & { type?: string }): void => {
      const match = /Could not connect to peer ([^ ]+)/.exec(err?.message ?? '')
      const targetId = match?.[1]
      if (targetId !== undefined && this._pendingConnects.has(targetId)) {
        this._pendingRejects.get(targetId)?.(err, true)
      }
    }
    this.peer.on('error', this._peerErrorHandler)

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
  _wiredConns: WeakSet<DataConnection>
  _seenUpdateHashes: Map<string, true>
  _destroyed: boolean
  _resyncInterval: ReturnType<typeof setInterval> | null
  _pendingConnects: Map<string, Promise<DataConnection>>
  _ownDials: WeakSet<DataConnection>
  _attemptTokens: Map<string, object>
  _pendingRejects: Map<string, (err: Error, emitFailed: boolean) => void>
  _pendingConns: Map<string, DataConnection>
  _peerClients: Map<string, Set<number>>
  _awarenessCleanupTimers: Map<string, ReturnType<typeof setTimeout>>
  _lastSeen: Map<string, number>
  _heartbeatTimer: ReturnType<typeof setInterval> | null
  _docUpdateHandler: (update: Uint8Array, origin: unknown) => void
  _awarenessUpdateHandler: (changes: { added: number[], updated: number[], removed: number[] }, origin: unknown) => void
  _beforeUnloadHandler: () => void
  _peerErrorHandler: (err: Error & { type?: string }) => void

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

    // Mark the attempt synchronously, BEFORE broker registration resolves:
    // this dedups concurrent connect() calls and lets disconnect() cancel
    // the attempt even while whenReady is still pending (a stale token is
    // how the in-flight attempt recognizes it was canceled).
    this.connecting.add(targetId)
    const token: object = {}
    this._attemptTokens.set(targetId, token)

    const promise = this.whenReady.then((ownId) => {
      if (this._attemptTokens.get(targetId) !== token) {
        throw new Error(`connect to ${targetId} canceled by disconnect()`)
      }
      if (this._destroyed) throw new Error('provider has been destroyed')
      if (this.connections.size >= this.maxConns) {
        throw new Error(`max connections (${this.maxConns}) reached`)
      }
      if (targetId === ownId) throw new Error('cannot connect to self')

      const conn = this.peer.connect(targetId, {
        reliable: true,
        metadata: { from: ownId }
      })
      this._ownDials.add(conn)
      this._pendingConns.set(targetId, conn)
      return new Promise<DataConnection>((resolve, reject) => {
        let settled = false
        const cleanupPending = (): void => {
          this._pendingConns.delete(targetId)
          this._pendingRejects.delete(targetId)
        }
        const fail = (err: Error, emitFailed: boolean): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          cleanupPending()
          this.connecting.delete(targetId)
          conn.close()
          if (emitFailed) this.emit('connection-failed', [err, targetId])
          reject(err)
        }
        const timer = setTimeout(() => {
          fail(new Error(`timed out connecting to ${targetId}`), true)
        }, this.connectionTimeout)
        this._pendingRejects.set(targetId, fail)
        conn.on('open', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          cleanupPending()
          resolve(conn)
        })
        conn.on('error', (err: Error) => { fail(err, false) })
        this._acceptIncoming(conn)
      })
    })

    this._pendingConnects.set(targetId, promise)
    // Cleanup once the attempt settles for any reason. Passing both handlers
    // (instead of .finally) also marks rejections as handled here, so an
    // ignored connect() result never becomes an unhandled rejection; callers
    // who do await still observe the rejection normally.
    const finish = (): void => {
      this._pendingConnects.delete(targetId)
      this.connecting.delete(targetId)
    }
    promise.then(finish, finish)
    return promise
  }

  /**
   * Close the connection to a single peer, if any. If called while a
   * connect() attempt to this peer is still in flight — even before broker
   * registration has completed — the attempt is canceled: no timeout error,
   * no 'connection-failed' event, and the connection is not adopted even if
   * it opens later.
   */
  disconnect (targetId: string): void {
    const state = this.connections.get(targetId)
    if (state) {
      state.conn.close()
      this.connections.delete(targetId)
      this.emit('peers', [{ added: [], removed: [targetId], webrtcPeers: this.connectedPeers, bcPeers: [] }])
      this.emit('status', [{ status: 'peer-disconnected', id: targetId }])
    }
    if (this.connecting.has(targetId)) {
      // Cancel the pending connect() attempt. Invalidating the token is the
      // authoritative cancel signal; the promise rejector (if the attempt
      // already reached the dialing stage) stops negotiation immediately.
      this._attemptTokens.delete(targetId)
      this.connecting.delete(targetId)
      this._pendingRejects.get(targetId)?.(new Error(`connect to ${targetId} canceled by disconnect()`), false)
      this._pendingRejects.delete(targetId)
      this._pendingConns.get(targetId)?.close()
      this._pendingConns.delete(targetId)
    }
  }

  /** Close every current peer connection (the provider itself stays alive). */
  disconnectAll (): void {
    Array.from(this.connections.keys()).forEach((id) => this.disconnect(id))
  }

  /**
   * Liveness: send a ping on every connection that has been silent for
   * heartbeatInterval, and close connections that have been silent for
   * heartbeatTimeout. Any inbound message (data, pong, sync reply) refreshes
   * the peer's last-seen timestamp — see _handleMessage.
   */
  _heartbeatTick (): void {
    if (this._destroyed) return
    const now = Date.now()
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messagePing)
    const ping = encoding.toUint8Array(encoder)
    this.connections.forEach(({ conn }, peerId) => {
      if (!conn.open) return
      const last = this._lastSeen.get(peerId) ?? now
      const silentFor = now - last
      if (silentFor >= this.heartbeatTimeout) {
        // Half-open connection (crash, kill, network drop, tab closed without
        // a clean close): the transport never told us. Close it ourselves —
        // the normal 'close' path then removes the peer and notifies the UI.
        conn.close()
        return
      }
      if (silentFor >= this.heartbeatInterval) conn.send(ping)
    })
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

  /**
   * Send an opaque add-on payload to one specific connected peer on the
   * internal extension channel. Unlike {@link send}, these payloads never
   * reach the application 'message' event — they are surfaced only via the
   * 'internal-message' event, which is how provider add-ons (e.g. the
   * TopologyTracker) communicate without polluting the app's channel.
   * @returns whether the message was sent (false if not connected)
   */
  sendInternal (targetId: string, data: Uint8Array | string): boolean {
    const state = this.connections.get(targetId)
    if (!state || !state.conn.open) return false
    const payload = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageInternal)
    encoding.writeVarUint8Array(encoder, payload)
    state.conn.send(encoding.toUint8Array(encoder))
    return true
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
   */
  _acceptIncoming (conn: DataConnection): void {
    const peerId = conn.peer
    // Avoid double-wiring the same conn object (an outgoing dial is wired
    // synchronously inside connect(); the broker never re-delivers it as an
    // incoming connection, but double events on the same object must not
    // stack duplicate handlers).
    if (this._isWired(conn)) return
    this._wire(conn)

    this.connecting.add(peerId)

    const onOpen = () => {
      this.connecting.delete(peerId)

      const existingState = this.connections.get(peerId)
      if (existingState !== undefined && existingState.conn === conn) {
        // 'open' fired twice for the same transport (e.g. onOpen invoked
        // synchronously and again via the event) — nothing to do.
        return
      }
      if (existingState !== undefined) {
        // Simultaneous mutual connect (both sides called connect() on each
        // other) produced two parallel transports. Both sides must converge
        // on keeping the SAME one, or each side ends up holding a transport
        // the other just closed. Deterministic tiebreak: keep the transport
        // initiated by the lexicographically smaller peer id — a rule both
        // sides evaluate identically. We know who initiated each conn
        // because connect() marks its dials in _ownDials; anything else is
        // incoming, i.e. initiated by `peerId`.
        const weInitiatedNew = this._ownDials.has(conn)
        const initiatorNew = weInitiatedNew ? (this.id ?? peerId) : peerId
        const initiatorExisting = weInitiatedNew ? peerId : (this.id ?? peerId)
        if (initiatorNew < initiatorExisting) {
          // Adopt the new transport, carrying over the old one's sync
          // progress, and cheaply re-verify sync on it.
          existingState.conn.close()
          this.connections.set(peerId, { conn, synced: existingState.synced })
          this._sendSyncStep1(conn)
        }
        // Otherwise the new transport loses: drop it, keep the existing one.
        conn.close()
        return
      }

      // Enforce maxConns on the incoming side too: connect() checks before
      // dialing, but a peer can still dial us while we're at capacity.
      if (existingState === undefined && this.connections.size >= this.maxConns) {
        conn.close()
        return
      }

      this._lastSeen.set(peerId, Date.now())
      this._cancelAwarenessCleanup(peerId) // a returning peer is not "gone"
      this.connections.set(peerId, { conn, synced: false })
      this.emit('peers', [{ added: [peerId], removed: [], webrtcPeers: this.connectedPeers, bcPeers: [] }])
      this.emit('status', [{ status: 'peer-connected', id: peerId }])

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

    conn.on('data', (data: unknown) => {
      this._lastSeen.set(peerId, Date.now())
      this._handleMessage(conn, peerId, data as Uint8Array | ArrayBuffer)
    })

    // ICE 'failed' means the transport is beyond recovery (unlike
    // 'disconnected', which usually self-heals after a Wi-Fi blip). Closing
    // here gives much faster removal than waiting for the heartbeat timeout.
    conn.on('iceStateChanged', (state: string) => {
      if (state === 'failed') {
        this._lastSeen.delete(peerId)
        conn.close()
      }
    })

    conn.on('close', () => {
      this.connecting.delete(peerId)
      this._lastSeen.delete(peerId)
      const wasConnected = this.connections.has(peerId) && this.connections.get(peerId)!.conn === conn
      if (wasConnected) {
        this.connections.delete(peerId)
        this.emit('peers', [{ added: [], removed: [peerId], webrtcPeers: this.connectedPeers, bcPeers: [] }])
        this.emit('status', [{ status: 'peer-disconnected', id: peerId }])
        // Clean up the awareness states this connection was the source of
        // (after a grace period, and only if no other connection still
        // delivers them) so departed peers' cursors don't linger forever.
        const claimed = this._peerClients.get(peerId)
        this._peerClients.delete(peerId)
        this._scheduleAwarenessCleanup(peerId, claimed)
      }
    })

    conn.on('error', (err: Error) => {
      this.connecting.delete(peerId)
      this.emit('connection-error', [err, peerId])
    })
  }

  _isWired (conn: DataConnection): boolean {
    return this._wiredConns.has(conn)
  }
  _wire (conn: DataConnection): void {
    this._wiredConns.add(conn)
  }

  _handleMessage (conn: DataConnection, peerId: string, data: Uint8Array | ArrayBuffer): void {
    try {
      const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
      const decoder = decoding.createDecoder(buf)
      const messageType = decoding.readVarUint(decoder)

      switch (messageType) {
        case messagePing: {
          // Liveness probe — answer immediately so the sender's last-seen
          // timestamp refreshes even when nothing else is flowing.
          const pongEncoder = encoding.createEncoder()
          encoding.writeVarUint(pongEncoder, messagePong)
          conn.send(encoding.toUint8Array(pongEncoder))
          break
        }
        case messagePong: // just traffic — the data handler already stamped last-seen
          break
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
          // Remember which awareness clientIDs this connection delivered, so
          // they can be removed exactly (and only) when this connection is
          // the last one still delivering them.
          const clientIds = awarenessClientIds(payload)
          if (clientIds.length > 0) {
            let claimed = this._peerClients.get(peerId)
            if (claimed === undefined) {
              claimed = new Set()
              this._peerClients.set(peerId, claimed)
            }
            clientIds.forEach((c) => claimed.add(c))
          }
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
        case messageInternal: {
          const payload = decoding.readVarUint8Array(decoder)
          this.emit('internal-message', [{ peerId, data: payload }])
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

  /**
   * Remove the awareness states a departed peer delivered from the shared
   * Awareness instance, after `awarenessCleanupDelay`. Without this, a peer
   * that vanishes ungracefully (crash, killed tab, network drop) leaves its
   * cursor/presence behind until y-protocols/awareness's own 30s timeout —
   * and that timeout only advances while this tab keeps running. States
   * that another still-connected connection also delivers (relay) are kept:
   * the client is still reachable through the mesh.
   */
  _scheduleAwarenessCleanup (peerId: string, claimedClientIds: Set<number> | undefined): void {
    this._cancelAwarenessCleanup(peerId)
    if (this._destroyed) return
    if (claimedClientIds === undefined || claimedClientIds.size === 0) return
    const removeStates = (): void => {
      this._awarenessCleanupTimers.delete(peerId)
      const stillClaimed = new Set<number>()
      this._peerClients.forEach((set) => { set.forEach((c) => stillClaimed.add(c)) })
      const gone: number[] = []
      claimedClientIds.forEach((c) => { if (!stillClaimed.has(c)) gone.push(c) })
      if (gone.length > 0) {
        // Removing with a non-`this` origin makes our awareness 'update'
        // handler broadcast the removal to the remaining peers.
        awarenessProtocol.removeAwarenessStates(this.awareness, gone, 'peer disconnected')
      }
    }
    if (this.awarenessCleanupDelay === 0) {
      removeStates()
      return
    }
    this._awarenessCleanupTimers.set(peerId, setTimeout(removeStates, this.awarenessCleanupDelay))
  }

  _cancelAwarenessCleanup (peerId: string): void {
    const timer = this._awarenessCleanupTimers.get(peerId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this._awarenessCleanupTimers.delete(peerId)
    }
  }

  /** Tear down all connections and the underlying Peer, and unregister doc/awareness listeners. */
  destroy (): void {
    if (this._destroyed) return
    this._destroyed = true

    if (this._resyncInterval) clearInterval(this._resyncInterval)
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer)
    this._awarenessCleanupTimers.forEach((timer) => clearTimeout(timer))
    this._awarenessCleanupTimers.clear()
    this._peerClients.clear()

    this.doc.off('update', this._docUpdateHandler)
    this.awareness.off('update', this._awarenessUpdateHandler)
    this.peer.off('error', this._peerErrorHandler)

    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler)
    }

    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'provider destroyed')
    if (this._ownsAwareness) {
      this.awareness.destroy()
    }

    // Close in-flight connect() attempts too — disconnectAll only covers
    // established connections. Rejecting via _pendingRejects also clears
    // each attempt's timeout, so nothing fires after destroy().
    this._pendingRejects.forEach((reject) => reject(new Error('provider destroyed'), false))
    this._pendingRejects.clear()
    this._pendingConns.forEach((conn) => conn.close())
    this._pendingConns.clear()
    this.disconnectAll()
    this.peer.destroy()

    super.destroy()
  }
}

export default PeerjsProvider
