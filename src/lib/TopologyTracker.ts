import { Observable } from 'lib0/observable'
import type { PeerjsProvider } from './PeerjsProvider.js'

/**
 * Wire tag for topology announcements carried on the provider's internal
 * extension channel (`sendInternal` / the 'internal-message' event). The
 * version suffix lets the protocol evolve without old peers mis-parsing
 * new payloads. Applications never see this traffic, so the tag only
 * guards against cross-version confusion, not app-message collisions.
 */
const WIRE_TAG = 'y-peerjs-topo2:'

/**
 * How often each peer re-announces its routing table (ms). Changes also
 * trigger immediate announcements, so this is just a convergence safety net
 * for peers that joined late or missed an announcement/retraction.
 */
const DEFAULT_ANNOUNCE_INTERVAL = 10000

/**
 * A remote (indirect) peer we know how to reach. `path` is the full route
 * from us to the peer — intermediates only, exclusive on both ends, next
 * hop first. E.g. for the chain A—B—C—D, A's entry for D is
 * `{ peerId: 'D', path: ['B', 'C'] }`. The next hop (`path[0]`) is always
 * one of our directly-connected peers; the last element is the hop right
 * before the destination.
 */
export interface RemotePeerInfo {
  peerId: string
  path: string[]
}

export interface TopologyTrackerOptions {
  /** Override the periodic re-announce interval (ms). Default 10000. */
  announceInterval?: number
}

interface PeersEventLike {
  added: string[]
  removed: string[]
}

interface InternalMessageEventLike {
  peerId: string
  data: Uint8Array
}

/**
 * TopologyTracker — opt-in peer discovery for {@link PeerjsProvider}.
 *
 * The provider itself deliberately knows nothing about the wider network:
 * sync correctness comes purely from relaying + dedup, which works over any
 * connection graph. This tracker layers *visibility* on top: it runs a
 * small path-vector routing protocol (BGP-style) over the provider's
 * internal extension channel (`sendInternal` / 'internal-message') so every
 * participant learns the full reachable topology — which direct connection
 * leads to any indirect peer, and the exact intermediate hops. Application
 * messages (`send`/`broadcast`/'message') are completely untouched.
 *
 * How it works:
 *  - Each peer computes a routing view: direct connections contribute
 *    1-hop routes; each neighbor's advertised table contributes longer
 *    routes prefixed with that neighbor. Shorter routes win.
 *  - Each peer advertises its full table to every neighbor (split horizon:
 *    routes that already go through a neighbor are filtered out of that
 *    neighbor's copy). Full-table replacement is what makes retraction
 *    work: a destination missing from an announcement is one the announcer
 *    can no longer reach.
 *  - Loops are impossible by construction: a route containing ourselves is
 *    dropped when it's learned.
 *  - Retraction of a *dead* neighbor's routes relies on the provider
 *    eventually reporting the connection as closed ('peers' removed) —
 *    via the close event, ICE failure, or liveness timeout.
 *
 * Attach one to a provider (both ends need one for discovery to work):
 *
 *   const tracker = new TopologyTracker(provider)
 *   tracker.on('changed', (remotePeers) => { ...render... })
 *
 * `createTopologyWidget` creates one automatically unless you pass your own.
 *
 * Fires:
 *  - 'changed'  [RemotePeerInfo[]]  the set of known indirect peers (or any
 *    of their routes) changed
 */
export class TopologyTracker extends Observable<string> {
  provider: PeerjsProvider
  /**
   * Most recent routing table heard FROM each directly-connected peer:
   * neighborId -> (dest -> route from that neighbor to dest, intermediates
   * only, exclusive on both ends). Empty route = the neighbor's own direct
   * connection.
   */
  _neighborTables: Map<string, Map<string, string[]>>
  /**
   * Our computed routing view: dest -> route from us to dest (intermediates
   * only, exclusive on both ends). Includes direct connections as empty
   * routes; see {@link getRemotePeers} for the public, indirect-only view.
   */
  _routes: Map<string, string[]>
  _announceInterval: ReturnType<typeof setInterval>
  _destroyed: boolean

  constructor (provider: PeerjsProvider, { announceInterval = DEFAULT_ANNOUNCE_INTERVAL }: TopologyTrackerOptions = {}) {
    super()
    this.provider = provider
    this._neighborTables = new Map()
    this._routes = new Map()
    this._destroyed = false

    this._onPeers = ({ added, removed }: PeersEventLike) => {
      removed.forEach((peerId) => this._neighborTables.delete(peerId))
      this._applyRoutes() // retracts lost routes (and announces if changed)
      if (added.length > 0) {
        // Prime the exchange: the new neighbor needs our table even if our
        // own view didn't change.
        this._announce()
      }
    }
    this._onMessage = ({ peerId, data }: InternalMessageEventLike) => this._handleMessage(peerId, data)

    provider.on('peers', this._onPeers)
    provider.on('internal-message', this._onMessage)

    // Compute once our own id exists — covers trackers attached after
    // connections were already established.
    provider.whenReady.then(() => {
      this._applyRoutes()
    }).catch(() => {})

    this._announceInterval = setInterval(() => {
      this._announce()
    }, announceInterval)
  }

  _onPeers: (event: PeersEventLike) => void
  _onMessage: (event: InternalMessageEventLike) => void

  /**
   * Peers we are NOT directly connected to but know a route to, sorted by
   * peer id for stable rendering.
   */
  getRemotePeers (): RemotePeerInfo[] {
    const out: RemotePeerInfo[] = []
    this._routes.forEach((path, peerId) => {
      if (path.length === 0) return // directly connected
      if (this.provider.connections.has(peerId)) return // defensive: direct wins
      out.push({ peerId, path: [...path] })
    })
    return out.sort((a, b) => a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0)
  }

  /**
   * The full route to an indirect peer (intermediates only, next hop
   * first), or undefined if unknown/direct.
   */
  getPath (peerId: string): string[] | undefined {
    const path = this._routes.get(peerId)
    return path !== undefined && path.length > 0 ? [...path] : undefined
  }

  /**
   * The directly-connected peer to send traffic through in order to reach
   * an indirect peer — the one thing every consumer actually needs. Returns
   * undefined if the peer is unknown or directly connected (no relay
   * needed: send to the peer itself).
   */
  nextHop (peerId: string): string | undefined {
    const path = this._routes.get(peerId)
    return path !== undefined && path.length > 0 ? path[0] : undefined
  }

  /**
   * Recompute our routing view from direct connections plus advertised
   * tables; announce + emit 'changed' if anything changed.
   */
  _applyRoutes (): void {
    const next = this._computeRoutes()
    if (this._sameRoutes(this._routes, next)) return
    this._routes = next
    this._announce()
    this.emit('changed', [this.getRemotePeers()])
  }

  /**
   * Compute the full routing view: every reachable peer (including direct
   * connections, stored as empty routes) mapped to the intermediates on the
   * route from us to it. Direct connections always win (0 hops); among
   * learned routes, the shortest wins. Routes that would loop through us
   * are dropped.
   */
  _computeRoutes (): Map<string, string[]> {
    const next = new Map<string, string[]>()
    const self = this.provider.id
    if (self === undefined) return next
    this.provider.connections.forEach((_, peerId) => next.set(peerId, []))
    this._neighborTables.forEach((table, neighbor) => {
      if (!this.provider.connections.has(neighbor)) return // stale table
      table.forEach((theirPath, dest) => {
        if (dest === self || dest === neighbor) return
        const route = [neighbor, ...theirPath]
        if (route.includes(self)) return // would loop through us
        if (route.includes(dest)) return // malformed: dest on its own path
        const prev = next.get(dest)
        if (prev !== undefined && prev.length <= route.length) return // keep shorter/first
        next.set(dest, route)
      })
    })
    return next
  }

  /**
   * Advertise our routing table to every directly-connected peer, split
   * horizon style: routes whose next hop IS the receiving neighbor are
   * filtered out of that neighbor's copy (it told us about them — sending
   * them back is waste and slows convergence).
   */
  _announce (): void {
    if (this._destroyed) return
    const peers = this.provider.connectedPeers
    if (peers.length === 0) return
    peers.forEach((neighbor) => {
      const entries: Array<[string, string[]]> = []
      this._routes.forEach((path, dest) => {
        if (dest === neighbor) return
        if (path.length > 0 && path[0] === neighbor) return // split horizon
        entries.push([dest, path])
      })
      this.provider.sendInternal(neighbor, WIRE_TAG + JSON.stringify(entries))
    })
  }

  /**
   * Apply a routing table received from one of our direct connections.
   * Full-table replacement: whatever the neighbor previously advertised is
   * discarded, so destinations missing from the new table retract.
   */
  _handleMessage (fromPeerId: string, data: Uint8Array): void {
    if (this._destroyed) return
    if (!this.provider.connections.has(fromPeerId)) return
    let text: string
    try {
      // fatal: invalid UTF-8 must throw so malformed payloads are ignored —
      // a non-fatal decoder would silently substitute U+FFFD and could
      // produce garbage route entries.
      text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    } catch {
      return
    }
    if (!text.startsWith(WIRE_TAG)) return // foreign version or junk — ignore
    let entries: unknown
    try {
      entries = JSON.parse(text.slice(WIRE_TAG.length))
    } catch {
      return // malformed — ignore
    }
    if (!Array.isArray(entries)) return
    const self = this.provider.id
    if (self === undefined) return
    const table = new Map<string, string[]>()
    entries.forEach((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) return
      const [dest, path] = entry as unknown[]
      if (typeof dest !== 'string' || !Array.isArray(path)) return
      if (path.some((hop) => typeof hop !== 'string')) return
      if (dest === self || path.includes(self) || path.includes(dest)) return
      table.set(dest, path as string[])
    })
    this._neighborTables.set(fromPeerId, table)
    this._applyRoutes()
  }

  _sameRoutes (a: Map<string, string[]>, b: Map<string, string[]>): boolean {
    if (a.size !== b.size) return false
    for (const [dest, path] of a) {
      const other = b.get(dest)
      if (other === undefined || other.length !== path.length) return false
      for (let i = 0; i < path.length; i++) {
        if (path[i] !== other[i]) return false
      }
    }
    return true
  }

  /** Detach from the provider and stop announcing. */
  destroy (): void {
    if (this._destroyed) return
    this._destroyed = true
    clearInterval(this._announceInterval)
    this.provider.off('peers', this._onPeers)
    this.provider.off('internal-message', this._onMessage)
    super.destroy()
  }
}
