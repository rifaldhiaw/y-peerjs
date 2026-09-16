import type { PeerjsProvider } from '../PeerjsProvider.js'

/**
 * Snapshot of the connection topology, derived from the provider's public
 * state. `links` is one entry per open connection, with the direction in
 * which the connection was initiated (`outgoing` = we called connect(),
 * `incoming` = the peer called connect() on us).
 */
export interface TopologySnapshot {
  /** Our own registered PeerJS id, or null before the broker assigns one. */
  selfId: string | null
  /** Our current connection state: connecting / connected / broker-disconnected. */
  status: string
  /** Ids of peers we are currently trying to connect to. */
  connecting: string[]
  /** One entry per open peer connection. */
  links: Array<{ peerId: string, direction: 'outgoing' | 'incoming', synced: boolean }>
}

export interface TopologyWidgetOptions {
  /** The provider whose topology is visualized. */
  provider: PeerjsProvider
  /** Element to attach the floating panel to. Defaults to document.body. */
  container?: HTMLElement
  /** Initial panel position in px from the top-left corner. */
  position?: { x: number, y: number }
}

/**
 * A floating, draggable widget that visualizes the provider's connection
 * graph and offers connect/disconnect controls.
 *
 * SCAFFOLD — the visual layout and interaction details are intentionally
 * minimal so they can be fleshed out later. The important parts already in
 * place are:
 *  - live topology snapshots extracted from the provider (`getSnapshot`)
 *  - a render loop fed by the provider's 'peers'/'status'/'synced' events
 *  - connect (via input + button) and per-peer disconnect controls
 *
 * TODO future features:
 *  - directed edges (arrowheads) once direction is exposed by the provider
 *  - awareness avatars/cursors overlaid on each node
 *  - collapse/expand, theming, touch dragging
 */
export interface TopologyWidget {
  /** Current topology snapshot, recomputed on every provider event. */
  getSnapshot(): TopologySnapshot
  /** Force a re-render (usually unnecessary; events already trigger it). */
  refresh(): void
  /** Remove the panel from the DOM and detach all listeners. */
  destroy(): void
}

export function createTopologyWidget ({
  provider,
  container = typeof document !== 'undefined' ? document.body : undefined,
  position = { x: 16, y: 16 }
}: TopologyWidgetOptions): TopologyWidget {
  if (!container) throw new Error('TopologyWidget requires a DOM container')

  // --- DOM scaffold -------------------------------------------------------
  const root = document.createElement('div')
  root.className = 'ypw-root'
  root.style.cssText = [
    'position:fixed',
    `left:${position.x}px`,
    `top:${position.y}px`,
    'z-index:2147483647',
    'width:240px',
    'background:#1e1e2ecc',
    'backdrop-filter:blur(6px)',
    'color:#cdd6f4',
    'font:12px/1.4 ui-monospace,monospace',
    'border:1px solid #45475a',
    'border-radius:10px',
    'box-shadow:0 4px 16px #0006',
    'user-select:none'
  ].join(';')
  container.appendChild(root)

  root.innerHTML = `
    <div class="ypw-header" style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;cursor:grab;border-bottom:1px solid #45475a">
      <span class="ypw-title">topology</span>
      <span class="ypw-self" style="opacity:.7">…</span>
    </div>
    <svg class="ypw-graph" width="100%" height="140"></svg>
    <div class="ypw-controls" style="display:flex;gap:6px;padding:6px 10px">
      <input class="ypw-target" placeholder="peer id" style="flex:1;min-width:0;background:#313244;border:1px solid #45475a;color:#cdd6f4;border-radius:6px;padding:3px 6px" />
      <button class="ypw-connect" style="cursor:pointer">connect</button>
    </div>
    <ul class="ypw-peers" style="list-style:none;margin:0;padding:4px 10px 8px"></ul>
  `

  const headerEl = root.querySelector<HTMLElement>('.ypw-header')!
  const selfEl = root.querySelector<HTMLElement>('.ypw-self')!
  const graphEl = root.querySelector<SVGSVGElement>('.ypw-graph')!
  const targetInput = root.querySelector<HTMLInputElement>('.ypw-target')!
  const connectBtn = root.querySelector<HTMLButtonElement>('.ypw-connect')!
  const peersEl = root.querySelector<HTMLUListElement>('.ypw-peers')!

  // --- dragging -----------------------------------------------------------
  let dragOffset: { dx: number, dy: number } | null = null
  headerEl.addEventListener('pointerdown', (e) => {
    const rect = root.getBoundingClientRect()
    dragOffset = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    headerEl.setPointerCapture(e.pointerId)
  })
  headerEl.addEventListener('pointermove', (e) => {
    if (!dragOffset) return
    root.style.left = `${e.clientX - dragOffset.dx}px`
    root.style.top = `${e.clientY - dragOffset.dy}px`
  })
  headerEl.addEventListener('pointerup', () => { dragOffset = null })

  // --- topology snapshot --------------------------------------------------
  let snapshot: TopologySnapshot = { selfId: null, status: 'idle', connecting: [], links: [] }

  function extractSnapshot (): TopologySnapshot {
    const links = provider.connections.size > 0
      ? Array.from(provider.connections.entries()).map(([peerId, { synced }]) => ({
          peerId,
          // The provider currently does not expose initiation direction;
          // default to 'outgoing' until it does (see TODO above).
          direction: 'outgoing' as const,
          synced
        }))
      : []
    return {
      selfId: provider.id ?? null,
      status: provider.peer.open ? 'peer-open' : 'idle',
      connecting: Array.from(provider.connecting),
      links
    }
  }

  // --- rendering ----------------------------------------------------------
  function render (): void {
    snapshot = extractSnapshot()

    selfEl.textContent = snapshot.selfId ?? 'unregistered'

    // Graph: self node centered, one edge + node per link. A proper force-
    // directed layout can replace this later; this keeps the scaffold honest.
    const w = graphEl.clientWidth || 220
    const cx = w / 2
    const cy = 70
    const r = Math.min(w, 240) * 0.33
    const ns = 'http://www.w3.org/2000/svg'

    const svg = document.createElementNS(ns, 'svg')
    snapshot.links.forEach((link, i) => {
      const angle = (2 * Math.PI * i) / Math.max(snapshot.links.length, 1) - Math.PI / 2
      const px = cx + r * Math.cos(angle)
      const py = cy + r * Math.sin(angle)

      const edge = document.createElementNS(ns, 'line')
      edge.setAttribute('x1', String(cx))
      edge.setAttribute('y1', String(cy))
      edge.setAttribute('x2', String(px))
      edge.setAttribute('y2', String(py))
      edge.setAttribute('stroke', link.synced ? '#a6e3a1' : '#f9e2af')
      svg.appendChild(edge)

      const node = document.createElementNS(ns, 'circle')
      node.setAttribute('cx', String(px))
      node.setAttribute('cy', String(py))
      node.setAttribute('r', '8')
      node.setAttribute('fill', link.synced ? '#a6e3a1' : '#f9e2af')
      svg.appendChild(node)

      const label = document.createElementNS(ns, 'text')
      label.setAttribute('x', String(px))
      label.setAttribute('y', String(py - 12))
      label.setAttribute('text-anchor', 'middle')
      label.setAttribute('fill', '#cdd6f4')
      label.setAttribute('font-size', '10')
      label.textContent = link.peerId
      svg.appendChild(label)
    })

    const selfNode = document.createElementNS(ns, 'circle')
    selfNode.setAttribute('cx', String(cx))
    selfNode.setAttribute('cy', String(cy))
    selfNode.setAttribute('r', '10')
    selfNode.setAttribute('fill', '#89b4fa')
    svg.appendChild(selfNode)

    graphEl.replaceChildren(svg)

    // Peer list with per-peer disconnect buttons.
    peersEl.replaceChildren(
      ...snapshot.links.map((link) => {
        const li = document.createElement('li')
        li.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:2px 0'
        const name = document.createElement('span')
        name.textContent = `${link.peerId}${link.synced ? '' : ' (syncing…)'}`
        const btn = document.createElement('button')
        btn.textContent = '✕'
        btn.title = `disconnect ${link.peerId}`
        btn.style.cssText = 'cursor:pointer;background:none;border:none;color:#f38ba8'
        btn.addEventListener('click', () => provider.disconnect(link.peerId))
        li.append(name, btn)
        return li
      }),
      ...snapshot.connecting.map((peerId) => {
        const li = document.createElement('li')
        li.style.opacity = '0.6'
        li.textContent = `${peerId} (connecting…)`
        return li
      })
    )
  }

  // --- controls -----------------------------------------------------------
  connectBtn.addEventListener('click', () => {
    const target = targetInput.value.trim()
    if (!target) return
    targetInput.value = ''
    provider.connect(target).catch(() => {}) // errors surface via 'connection-error'
  })
  targetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectBtn.click()
  })

  // --- provider wiring ----------------------------------------------------
  const events = ['peers', 'status', 'synced', 'connection-error'] as const
  events.forEach((name) => provider.on(name, render as () => void))
  render()

  return {
    getSnapshot: () => snapshot,
    refresh: render,
    destroy () {
      events.forEach((name) => provider.off(name, render as (...args: unknown[]) => void))
      root.remove()
    }
  }
}
