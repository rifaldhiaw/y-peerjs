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
  /** Whether the panel starts collapsed to just its header bar. Default false. */
  startCollapsed?: boolean
  /** Called with the new collapsed state whenever the panel is collapsed/expanded. */
  onToggleCollapsed?: (collapsed: boolean) => void
}

/**
 * A floating, draggable widget that visualizes the provider's connection
 * graph and offers connect/disconnect controls.
 *
 * Features:
 *  - live topology snapshots extracted from the provider (`getSnapshot`)
 *  - a render loop fed by the provider's 'peers'/'status'/'synced' events
 *  - directed edges: arrows point from the initiator of the connection to
 *    the peer that accepted it (outgoing = we called connect())
 *  - draggable header with a collapse/expand toggle; when collapsed only
 *    the title bar remains (dragging still works)
 *  - connect (via input + button) and per-peer disconnect controls
 *
 * TODO future features:
 *  - awareness avatars/cursors overlaid on each node
 *  - theming, touch dragging
 */
export interface TopologyWidget {
  /** Current topology snapshot, recomputed on every provider event. */
  getSnapshot(): TopologySnapshot
  /** Force a re-render (usually unnecessary; events already trigger it). */
  refresh(): void
  /** Whether the panel is currently collapsed to its header bar. */
  isCollapsed(): boolean
  /** Collapse or expand the panel programmatically. */
  setCollapsed(collapsed: boolean): void
  /** Remove the panel from the DOM and detach all listeners. */
  destroy(): void
}

export function createTopologyWidget ({
  provider,
  container = typeof document !== 'undefined' ? document.body : undefined,
  position = { x: 16, y: 16 },
  startCollapsed = false,
  onToggleCollapsed
}: TopologyWidgetOptions): TopologyWidget {
  if (!container) throw new Error('TopologyWidget requires a DOM container')

  let collapsed = startCollapsed

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
    'user-select:none',
    'overflow:hidden'
  ].join(';')
  container.appendChild(root)

  root.innerHTML = `
    <div class="ypw-header" style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;cursor:grab;border-bottom:1px solid #45475a;gap:6px">
      <span class="ypw-title" style="flex-shrink:0">topology</span>
      <span class="ypw-self" style="opacity:.7;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">…</span>
      <button class="ypw-collapse" title="collapse" style="flex-shrink:0;cursor:pointer;background:none;border:none;color:#cdd6f4;font:inherit;padding:0 2px;line-height:1">▾</button>
    </div>
    <div class="ypw-body">
      <svg class="ypw-graph" width="100%" height="140"></svg>
      <div class="ypw-controls" style="display:flex;gap:6px;padding:6px 10px">
        <input class="ypw-target" placeholder="peer id" style="flex:1;min-width:0;background:#313244;border:1px solid #45475a;color:#cdd6f4;border-radius:6px;padding:3px 6px" />
        <button class="ypw-connect" style="cursor:pointer">connect</button>
      </div>
      <ul class="ypw-peers" style="list-style:none;margin:0;padding:4px 10px 8px"></ul>
    </div>
  `

  const headerEl = root.querySelector<HTMLElement>('.ypw-header')!
  const selfEl = root.querySelector<HTMLElement>('.ypw-self')!
  const collapseBtn = root.querySelector<HTMLButtonElement>('.ypw-collapse')!
  const bodyEl = root.querySelector<HTMLElement>('.ypw-body')!
  const graphEl = root.querySelector<SVGSVGElement>('.ypw-graph')!
  const targetInput = root.querySelector<HTMLInputElement>('.ypw-target')!
  const connectBtn = root.querySelector<HTMLButtonElement>('.ypw-connect')!
  const peersEl = root.querySelector<HTMLUListElement>('.ypw-peers')!

  // --- collapsing ---------------------------------------------------------
  function applyCollapsed (): void {
    bodyEl.style.display = collapsed ? 'none' : ''
    collapseBtn.textContent = collapsed ? '▸' : '▾'
    collapseBtn.title = collapsed ? 'expand' : 'collapse'
    root.style.borderRadius = collapsed ? '999px' : '10px'
  }

  function setCollapsed (next: boolean): void {
    if (collapsed === next) return
    collapsed = next
    applyCollapsed()
    onToggleCollapsed?.(collapsed)
  }

  // Toggle on the button; dragging stays on the header itself.
  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    setCollapsed(!collapsed)
  })

  // --- dragging -----------------------------------------------------------
  let dragOffset: { dx: number, dy: number } | null = null
  headerEl.addEventListener('pointerdown', (e) => {
    // Don't start a drag when the click was on the collapse toggle.
    if (e.target === collapseBtn) return
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
      ? Array.from(provider.connections.entries()).map(([peerId, { synced, direction }]) => ({
          peerId,
          direction,
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
    // directed layout can replace this later.
    const w = graphEl.clientWidth || 220
    const cx = w / 2
    const cy = 70
    const r = Math.min(w, 240) * 0.33
    const ns = 'http://www.w3.org/2000/svg'

    const svg = document.createElementNS(ns, 'svg')
    // Arrowheads for directed edges: outgoing (we initiated) points at the
    // peer; incoming points at us. Two markers keep both colors available.
    svg.innerHTML =
      `<defs>
        <marker id="ypw-arrow-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#a6e3a1"/>
        </marker>
        <marker id="ypw-arrow-pending" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#f9e2af"/>
        </marker>
      </defs>`

    snapshot.links.forEach((link, i) => {
      const angle = (2 * Math.PI * i) / Math.max(snapshot.links.length, 1) - Math.PI / 2
      const px = cx + r * Math.cos(angle)
      const py = cy + r * Math.sin(angle)

      // Edge runs from initiator -> accepter: outgoing draws self->peer,
      // incoming draws peer->self, so the arrowhead always lands on the
      // side that *accepted* the connection.
      const [x1, y1, x2, y2] = link.direction === 'outgoing'
        ? [cx, cy, px, py]
        : [px, py, cx, cy]
      const color = link.synced ? '#a6e3a1' : '#f9e2af'

      const edge = document.createElementNS(ns, 'line')
      edge.setAttribute('x1', String(x1))
      edge.setAttribute('y1', String(y1))
      edge.setAttribute('x2', String(x2))
      edge.setAttribute('y2', String(y2))
      edge.setAttribute('stroke', color)
      edge.setAttribute('stroke-width', '1.5')
      edge.setAttribute('marker-end', `url(#ypw-arrow-${link.synced ? 'ok' : 'pending'})`)
      svg.appendChild(edge)

      const node = document.createElementNS(ns, 'circle')
      node.setAttribute('cx', String(px))
      node.setAttribute('cy', String(py))
      node.setAttribute('r', '8')
      node.setAttribute('fill', color)
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
        const arrow = link.direction === 'outgoing' ? '→' : '←'
        name.textContent = `${arrow} ${link.peerId}${link.synced ? '' : ' (syncing…)'}`
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
        li.textContent = `⋯ ${peerId} (connecting…)`
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
  applyCollapsed()
  render()

  return {
    getSnapshot: () => snapshot,
    refresh: render,
    isCollapsed: () => collapsed,
    setCollapsed,
    destroy () {
      events.forEach((name) => provider.off(name, render as (...args: unknown[]) => void))
      root.remove()
    }
  }
}
