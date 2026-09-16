import type { PeerjsProvider } from '../PeerjsProvider.js'

/** How a peer is displayed on a node: initials avatar + optional full name. */
export interface PeerAvatar {
  /** Display name, from awareness state `user.name` if present. */
  name: string
  /** Two-letter initials derived from the name (or 'PE' fallback for peer id). */
  initials: string
  /** Node fill color, from awareness state `user.color` if present. */
  color: string
}

/** A peer shown in the graph: directly connected, or reachable via the mesh. */
export interface GraphPeer {
  peerId: string
  /** 'direct' = open DataConnection; 'indirect' = known via mesh protocol. */
  kind: 'direct' | 'indirect'
  /** Only for direct peers. */
  direction?: 'outgoing' | 'incoming'
  /** Only for direct peers. */
  synced?: boolean
  /** Only for indirect peers: our next hop (one of our direct peers). */
  via?: string
  /** Only for indirect peers: intermediates between our next hop and the peer. */
  path?: string[]
}

/**
 * Snapshot of the full connection topology: direct links plus the complete
 * reachable mesh learned via the provider's mesh protocol.
 */
export interface TopologySnapshot {
  /** Our own registered PeerJS id, or null before the broker assigns one. */
  selfId: string | null
  /** Our current connection state: connecting / connected / broker-disconnected. */
  status: string
  /** Ids of peers we are currently trying to connect to. */
  connecting: string[]
  /** Every known peer, direct and indirect. */
  peers: GraphPeer[]
  /** Avatar for ourselves, if we have a local awareness state. */
  selfAvatar: PeerAvatar | null
  /** Avatars for connected peers, keyed by peer id (empty when unknown). */
  avatars: Map<string, PeerAvatar>
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
  /** Fallback color for nodes/avatars when a peer has no `user.color`. Default '#a6e3a1'. */
  fallbackColor?: string
}

/** Small inline icon set (stroke-based, 24x24 viewBox). */
const ICONS: Record<string, string> = {
  plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8zM12 17v5"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h5a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h5"/><circle cx="18" cy="5" r="3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  dot: '<circle cx="12" cy="12" r="4"/>'
}

function icon (name: string, size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">${ICONS[name] ?? ''}</svg>`
}

/**
 * A floating, draggable widget that visualizes the provider's FULL mesh —
 * both directly-connected peers and indirect peers learned through the mesh
 * protocol (including via whom they are reachable) — and lets the user
 * connect to or disconnect from any of them.
 *
 * Features:
 *  - full-mesh graph: solid directed edges for direct connections (arrow =
 *    initiator → accepter), dashed edges for indirect peers
 *  - awareness avatars: initials overlaid on each node (`user` field)
 *  - clickable nodes: opens an inspect panel with peer details and actions
 *    (connect if not directly connected, disconnect if directly connected)
 *  - draggable header with a collapse/expand toggle; collapsible to a pill
 *  - connect (via input + button) and per-peer disconnect controls
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
  /** The peer id currently open in the inspect panel, or null. */
  getInspected(): string | null
  /** Open the inspect panel for a peer id (or close it with null). */
  inspect(peerId: string | null): void
  /** Remove the panel from the DOM and detach all listeners. */
  destroy(): void
}

export function createTopologyWidget ({
  provider,
  container = typeof document !== 'undefined' ? document.body : undefined,
  position = { x: 16, y: 16 },
  startCollapsed = false,
  onToggleCollapsed,
  fallbackColor = '#a6e3a1'
}: TopologyWidgetOptions): TopologyWidget {
  if (!container) throw new Error('TopologyWidget requires a DOM container')

  let collapsed = startCollapsed
  let inspected: string | null = null

  // --- awareness: map Yjs clientIDs to PeerJS ids -------------------------
  // Awareness states are keyed by Yjs clientID, which has no inherent
  // relation to PeerJS peer ids. We publish our own peer id inside our
  // awareness state under a dedicated field and read it back from remote
  // states to match avatars to graph nodes.
  const AWARENESS_PEER_ID_FIELD = 'peerId'

  function publishOwnPeerId (): void {
    const id = provider.id
    if (!id) return
    const local = provider.awareness.getLocalState()
    if (local?.[AWARENESS_PEER_ID_FIELD] === id) return
    provider.awareness.setLocalStateField(AWARENESS_PEER_ID_FIELD, id)
  }
  provider.on('status', () => publishOwnPeerId())
  provider.on('peers', () => publishOwnPeerId())
  provider.whenReady.then(publishOwnPeerId).catch(() => {})

  function initialsFor (name: string, peerId: string): string {
    const trimmed = name.trim()
    if (trimmed.length === 0) return peerId.slice(0, 2).toUpperCase()
    const words = trimmed.split(/\s+/)
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
    return trimmed.slice(0, 2).toUpperCase()
  }

  function avatarFor (peerId: string): PeerAvatar | undefined {
    const states = provider.awareness.getStates()
    let found: PeerAvatar | undefined
    states.forEach((state) => {
      if (found) return
      if ((state as Record<string, unknown>)[AWARENESS_PEER_ID_FIELD] !== peerId) return
      const user = (state as Record<string, unknown>).user as { name?: unknown, color?: unknown } | undefined
      const name = typeof user?.name === 'string' && user.name.trim().length > 0 ? user.name : peerId
      found = {
        name,
        initials: initialsFor(name, peerId),
        color: typeof user?.color === 'string' ? user.color : fallbackColor
      }
    })
    return found
  }

  // --- DOM scaffold -------------------------------------------------------
  const root = document.createElement('div')
  root.className = 'ypw-root'
  root.style.cssText = [
    'position:fixed',
    `left:${position.x}px`,
    `top:${position.y}px`,
    'z-index:2147483647',
    'width:260px',
    'background:#181825f2',
    'backdrop-filter:blur(8px)',
    'color:#cdd6f4',
    'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
    'border:1px solid #45475a',
    'border-radius:12px',
    'box-shadow:0 8px 32px #000a',
    'user-select:none',
    'overflow:hidden'
  ].join(';')
  container.appendChild(root)

  const BTN = 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;background:#313244;border:1px solid #585b70;color:#cdd6f4;border-radius:8px;padding:4px 8px;font:11px ui-monospace,monospace'
  const BTN_DANGER = 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;background:#45243a;border:1px solid #f38ba8;color:#f38ba8;border-radius:8px;padding:4px 8px;font:11px ui-monospace,monospace'

  root.innerHTML = `
    <div class="ypw-header" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;cursor:grab;border-bottom:1px solid #45475a;gap:8px">
      <span class="ypw-title" style="flex-shrink:0;font-weight:bold">${icon('globe', 13)} topology</span>
      <span class="ypw-stats" style="opacity:.75;font-size:11px;flex:1;text-align:right"></span>
      <button class="ypw-collapse" title="collapse" style="flex-shrink:0;cursor:pointer;background:none;border:none;color:#cdd6f4;font:inherit;padding:0 2px;line-height:1">▾</button>
    </div>
    <div class="ypw-body">
      <svg class="ypw-graph" width="100%" height="170" style="display:block;cursor:default"></svg>
      <div class="ypw-controls" style="display:flex;gap:6px;padding:8px 10px;border-top:1px solid #313244">
        <input class="ypw-target" placeholder="peer id…" style="flex:1;min-width:0;background:#313244;border:1px solid #45475a;color:#cdd6f4;border-radius:8px;padding:5px 8px;outline:none" />
        <button class="ypw-connect" title="connect to peer" style="${BTN}">${icon('plug', 12)}</button>
      </div>
      <ul class="ypw-peers" style="list-style:none;margin:0;padding:2px 10px 8px;max-height:140px;overflow-y:auto"></ul>
    </div>
  `

  const headerEl = root.querySelector<HTMLElement>('.ypw-header')!
  const statsEl = root.querySelector<HTMLElement>('.ypw-stats')!
  const collapseBtn = root.querySelector<HTMLButtonElement>('.ypw-collapse')!
  const bodyEl = root.querySelector<HTMLElement>('.ypw-body')!
  const graphEl = root.querySelector<SVGSVGElement>('.ypw-graph')!
  const targetInput = root.querySelector<HTMLInputElement>('.ypw-target')!
  const connectBtn = root.querySelector<HTMLButtonElement>('.ypw-connect')!
  const peersEl = root.querySelector<HTMLUListElement>('.ypw-peers')!

  // --- inspect panel (mounted to the right of the graph) ------------------
  const panel = document.createElement('div')
  panel.className = 'ypw-inspect'
  panel.style.cssText = [
    'display:none',
    'position:absolute',
    'left:100%',
    'top:0',
    'margin-left:8px',
    'width:240px',
    'background:#11111bf5',
    'border:1px solid #585b70',
    'border-radius:12px',
    'box-shadow:0 8px 32px #000a',
    'padding:10px 12px',
    'text-align:left'
  ].join(';')
  root.appendChild(panel)

  // --- collapsing ---------------------------------------------------------
  function applyCollapsed (): void {
    bodyEl.style.display = collapsed ? 'none' : ''
    panel.style.display = collapsed || !inspected ? 'none' : 'block'
    collapseBtn.textContent = collapsed ? '▸' : '▾'
    collapseBtn.title = collapsed ? 'expand' : 'collapse'
    root.style.borderRadius = collapsed ? '999px' : '12px'
  }

  function setCollapsed (next: boolean): void {
    if (collapsed === next) return
    collapsed = next
    applyCollapsed()
    onToggleCollapsed?.(collapsed)
  }

  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    setCollapsed(!collapsed)
  })

  // --- dragging -----------------------------------------------------------
  let dragOffset: { dx: number, dy: number } | null = null
  headerEl.addEventListener('pointerdown', (e) => {
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
  let snapshot: TopologySnapshot = { selfId: null, status: 'idle', connecting: [], peers: [], selfAvatar: null, avatars: new Map() }

  function extractSnapshot (): TopologySnapshot {
    const peers: GraphPeer[] = []
    const avatars = new Map<string, PeerAvatar>()
    provider.connections.forEach(({ synced, direction }, peerId) => {
      peers.push({ peerId, kind: 'direct', direction, synced })
      const av = avatarFor(peerId)
      if (av) avatars.set(peerId, av)
    })
    provider.mesh.forEach((info, peerId) => {
      if (provider.connections.has(peerId)) return // became direct
      peers.push({ peerId, kind: 'indirect', via: info.via, path: info.path })
      const av = avatarFor(peerId)
      if (av) avatars.set(peerId, av)
    })
    return {
      selfId: provider.id ?? null,
      status: provider.peer.open ? 'peer-open' : 'idle',
      connecting: Array.from(provider.connecting),
      peers,
      selfAvatar: avatarFor(provider.id ?? '') ?? null,
      avatars
    }
  }

  // --- inspect panel ------------------------------------------------------
  function renderInspect (): void {
    if (!inspected || collapsed) {
      panel.style.display = 'none'
      return
    }
    const isSelf = inspected === snapshot.selfId
    const direct = snapshot.peers.find((p) => p.peerId === inspected && p.kind === 'direct')
    const indirect = snapshot.peers.find((p) => p.peerId === inspected && p.kind === 'indirect')
    const avatar = inspected === snapshot.selfId ? snapshot.selfAvatar : snapshot.avatars.get(inspected)
    const title = avatar ? `${avatar.name} (${inspected})` : inspected

    const rows: string[] = []
    const row = (iconName: string, label: string, value: string) =>
      `<div style="display:flex;gap:6px;align-items:baseline;margin:3px 0"><span style="width:16px;flex-shrink:0;opacity:.6">${icon(iconName, 12)}</span><span style="opacity:.6;width:64px;flex-shrink:0">${label}</span><span style="word-break:break-all">${value}</span></div>`

    if (isSelf) {
      rows.push(row('user', 'role', 'you (this browser)'))
      rows.push(row('globe', 'status', snapshot.status))
      rows.push(row('hash', 'direct', String(provider.connections.size)))
      rows.push(row('route', 'indirect', String(provider.mesh.size)))
    } else if (direct) {
      rows.push(row('user', 'role', direct.direction === 'outgoing' ? 'direct · you connected' : 'direct · connected you'))
      rows.push(row('check', 'synced', direct.synced ? 'yes' : 'syncing…'))
      rows.push(row('globe', 'status', '1 hop away'))
    } else if (indirect) {
      rows.push(row('user', 'role', 'indirect · not connected to you'))
      // Route from our next hop through intermediates to the peer.
      const route = [indirect.via, ...indirect.path!, inspected].join(' → ')
      rows.push(row('route', 'route', route))
      rows.push(row('globe', 'status', `${(indirect.path?.length ?? 0) + 1} hop${(indirect.path?.length ?? 0) === 1 ? '' : 's'} away`))
    } else if (snapshot.connecting.includes(inspected)) {
      rows.push(row('clock', 'status', 'connecting…'))
    } else {
      rows.push(row('user', 'role', 'unknown peer'))
      rows.push(row('globe', 'status', 'not in mesh — connect to reach it'))
    }

    // Actions.
    let actions = ''
    if (isSelf) {
      actions = ''
    } else if (direct) {
      actions = `<button class="ypw-act-dc" style="${BTN_DANGER}">${icon('scissors', 12)} disconnect</button>`
    } else if (!snapshot.connecting.includes(inspected)) {
      actions = `<button class="ypw-act-connect" style="${BTN}">${icon('plug', 12)} connect</button>`
    }

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px">
        <strong style="word-break:break-all">${title}</strong>
        <button class="ypw-act-close" title="close" style="cursor:pointer;background:none;border:none;color:#cdd6f4;font:inherit">✕</button>
      </div>
      ${avatar ? `<div style="margin-bottom:6px"><span style="display:inline-flex;width:28px;height:28px;border-radius:50%;background:${avatar.color};color:#1e1e2e;align-items:center;justify-content:center;font-weight:bold;font-size:11px">${avatar.initials}</span></div>` : ''}
      ${rows.join('')}
      ${actions ? `<div style="margin-top:8px;display:flex;gap:6px">${actions}</div>` : ''}
    `

    panel.querySelector('.ypw-act-close')!.addEventListener('click', () => widgetApi.inspect(null))
    panel.querySelector('.ypw-act-dc')?.addEventListener('click', () => {
      provider.disconnect(inspected!)
      widgetApi.inspect(null)
    })
    panel.querySelector('.ypw-act-connect')?.addEventListener('click', () => {
      provider.connect(inspected!).catch(() => {}) // errors surface via 'connection-error'
    })

    panel.style.display = 'block'
  }

  // --- rendering ----------------------------------------------------------
  function render (): void {
    snapshot = extractSnapshot()

    statsEl.textContent = `${provider.connections.size} direct · ${provider.mesh.size} indirect`
    const ns = 'http://www.w3.org/2000/svg'

    const W = graphEl.clientWidth || 240
    const H = 170
    const cx = W / 2
    const cy = H / 2

    // Ring layout: direct peers on the inner ring, indirect on the outer.
    const innerR = Math.min(W, H) * 0.26
    const outerR = Math.min(W, H) * 0.42
    const positions = new Map<string, { x: number, y: number }>()

    let d = 0
    snapshot.peers.forEach((p) => {
      if (p.kind !== 'direct') return
      const angle = (2 * Math.PI * d) / Math.max(snapshot.peers.filter((q) => q.kind === 'direct').length, 1) - Math.PI / 2
      positions.set(p.peerId, { x: cx + innerR * Math.cos(angle), y: cy + innerR * Math.sin(angle) })
      d++
    })
    let i = 0
    snapshot.peers.forEach((p) => {
      if (p.kind !== 'indirect') return
      const count = snapshot.peers.filter((q) => q.kind === 'indirect').length
      const angle = (2 * Math.PI * i) / Math.max(count, 1) - Math.PI / 2 + Math.PI / Math.max(count, 1)
      positions.set(p.peerId, { x: cx + outerR * Math.cos(angle), y: cy + outerR * Math.sin(angle) })
      i++
    })
    snapshot.connecting.forEach((peerId, idx) => {
      const angle = Math.PI / 2 + (idx - (snapshot.connecting.length - 1) / 2) * 0.5
      positions.set(peerId, { x: cx + (innerR + 12) * Math.cos(angle), y: cy + (innerR + 12) * Math.sin(angle) })
    })

    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.innerHTML =
      `<defs>
        <marker id="ypw-arrow-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#a6e3a1"/>
        </marker>
        <marker id="ypw-arrow-pending" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#f9e2af"/>
        </marker>
      </defs>`

    // Edges.
    snapshot.peers.forEach((p) => {
      const pos = positions.get(p.peerId)
      if (!pos) return
      const edge = document.createElementNS(ns, 'line')
      const [x1, y1, x2, y2] = p.kind === 'direct'
        ? (p.direction === 'outgoing' ? [cx, cy, pos.x, pos.y] : [pos.x, pos.y, cx, cy])
        : (() => {
            // Indirect: dashed edge from its next hop (via) to the peer.
            const viaPos = positions.get(p.via!) ?? { x: cx, y: cy }
            return [viaPos.x, viaPos.y, pos.x, pos.y]
          })()
      edge.setAttribute('x1', String(x1))
      edge.setAttribute('y1', String(y1))
      edge.setAttribute('x2', String(x2))
      edge.setAttribute('y2', String(y2))
      edge.setAttribute('stroke', p.kind === 'direct' ? (p.synced ? '#a6e3a1' : '#f9e2af') : '#6c7086')
      edge.setAttribute('stroke-width', '1.5')
      if (p.kind === 'indirect') {
        edge.setAttribute('stroke-dasharray', '4 3')
      } else {
        edge.setAttribute('marker-end', `url(#ypw-arrow-${p.synced ? 'ok' : 'pending'})`)
      }
      svg.appendChild(edge)
    })

    // Nodes.
    const nodeFor = (peerId: string, pos: { x: number, y: number }, opts: { color: string, r: number, label: string, sub?: string, dashed?: boolean, cursor?: string }) => {
      const g = document.createElementNS(ns, 'g')
      g.style.cursor = opts.cursor ?? 'pointer'

      const circle = document.createElementNS(ns, 'circle')
      circle.setAttribute('cx', String(pos.x))
      circle.setAttribute('cy', String(pos.y))
      circle.setAttribute('r', String(opts.r))
      circle.setAttribute('fill', opts.color)
      if (opts.dashed) {
        circle.setAttribute('stroke', '#9399b2')
        circle.setAttribute('stroke-dasharray', '3 2')
        circle.setAttribute('fill', '#181825')
      }
      g.appendChild(circle)

      const avatar = peerId === snapshot.selfId ? snapshot.selfAvatar : snapshot.avatars.get(peerId)
      if (avatar && !opts.dashed) {
        const initials = document.createElementNS(ns, 'text')
        initials.setAttribute('x', String(pos.x))
        initials.setAttribute('y', String(pos.y))
        initials.setAttribute('dy', '0.35em')
        initials.setAttribute('text-anchor', 'middle')
        initials.setAttribute('fill', '#1e1e2e')
        initials.setAttribute('font-size', String(opts.r * 0.9))
        initials.setAttribute('font-weight', 'bold')
        initials.textContent = avatar.initials
        g.appendChild(initials)
      }

      const label = document.createElementNS(ns, 'text')
      label.setAttribute('x', String(pos.x))
      label.setAttribute('y', String(pos.y - opts.r - 6))
      label.setAttribute('text-anchor', 'middle')
      label.setAttribute('fill', inspected === peerId ? '#89b4fa' : '#cdd6f4')
      label.setAttribute('font-size', '9.5')
      label.textContent = opts.label
      g.appendChild(label)

      if (opts.sub) {
        const sub = document.createElementNS(ns, 'text')
        sub.setAttribute('x', String(pos.x))
        sub.setAttribute('y', String(pos.y + opts.r + 12))
        sub.setAttribute('text-anchor', 'middle')
        sub.setAttribute('fill', '#6c7086')
        sub.setAttribute('font-size', '8.5')
        sub.textContent = opts.sub
        g.appendChild(sub)
      }

      g.addEventListener('click', (e) => {
        e.stopPropagation()
        widgetApi.inspect(inspected === peerId ? null : peerId)
      })
      svg.appendChild(g)
      return g
    }

    // Indirect peers (outer ring, hollow dashed nodes).
    snapshot.peers.forEach((p) => {
      if (p.kind !== 'indirect') return
      const pos = positions.get(p.peerId)!
      nodeFor(p.peerId, pos, {
        color: fallbackColor,
        r: 9,
        label: snapshot.avatars.get(p.peerId)?.name ?? p.peerId,
        sub: `via ${p.via}`,
        dashed: true
      })
    })

    // Connecting peers.
    snapshot.connecting.forEach((peerId) => {
      const pos = positions.get(peerId)!
      nodeFor(peerId, pos, { color: '#f9e2af', r: 8, label: peerId, sub: 'connecting…', cursor: 'wait' })
    })

    // Direct peers (inner ring, avatar nodes).
    snapshot.peers.forEach((p) => {
      if (p.kind !== 'direct') return
      const pos = positions.get(p.peerId)!
      nodeFor(p.peerId, pos, {
        color: p.synced ? (snapshot.avatars.get(p.peerId)?.color ?? '#a6e3a1') : '#f9e2af',
        r: 11,
        label: snapshot.avatars.get(p.peerId)?.name ?? p.peerId,
        sub: p.synced ? undefined : 'syncing…'
      })
    })

    // Self node.
    const selfAv = snapshot.selfAvatar
    nodeFor(snapshot.selfId ?? 'self', { x: cx, y: cy }, {
      color: selfAv?.color ?? '#89b4fa',
      r: 13,
      label: selfAv ? selfAv.name : (snapshot.selfId ?? 'connecting…')
    })

    // Click empty graph space to deselect.
    svg.addEventListener('click', () => widgetApi.inspect(null))

    graphEl.replaceChildren(svg)

    // Peer list.
    peersEl.replaceChildren(
      ...snapshot.peers.map((p) => {
        const li = document.createElement('li')
        li.style.cssText = `display:flex;justify-content:space-between;align-items:center;padding:3px 4px;border-radius:6px;cursor:pointer;${inspected === p.peerId ? 'background:#313244;' : ''}`
        const name = document.createElement('span')
        const av = snapshot.avatars.get(p.peerId)
        const badge = p.kind === 'direct' ? '' : ' <span style="opacity:.6">(via ' + p.via + ')</span>'
        name.innerHTML = `${p.kind === 'direct' ? (p.direction === 'outgoing' ? '→' : '←') : '⇢'} ${av ? av.name + ' ' : ''}<span style="opacity:.7">${p.peerId}</span>${p.kind === 'direct' && !p.synced ? ' <span style="color:#f9e2af">(syncing…)</span>' : ''}${badge}`
        li.appendChild(name)
        const btn = document.createElement('button')
        btn.innerHTML = p.kind === 'direct' ? icon('scissors', 11) : icon('plug', 11)
        btn.title = p.kind === 'direct' ? `disconnect ${p.peerId}` : `connect ${p.peerId}`
        btn.style.cssText = 'cursor:pointer;background:none;border:none;color:' + (p.kind === 'direct' ? '#f38ba8' : '#a6e3a1') + ';padding:2px'
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          if (p.kind === 'direct') provider.disconnect(p.peerId)
          else provider.connect(p.peerId).catch(() => {})
        })
        li.appendChild(btn)
        li.addEventListener('click', () => widgetApi.inspect(inspected === p.peerId ? null : p.peerId))
        return li
      }),
      ...snapshot.connecting.map((peerId) => {
        const li = document.createElement('li')
        li.style.cssText = 'opacity:.6;padding:3px 4px'
        li.innerHTML = `${icon('clock', 11)} ${peerId} (connecting…)`
        return li
      })
    )

    renderInspect()
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
  const events = ['peers', 'status', 'synced', 'connection-error', 'mesh'] as const
  events.forEach((name) => provider.on(name, render as () => void))
  provider.awareness.on('update', render as () => void)
  applyCollapsed()
  render()

  const widgetApi: TopologyWidget = {
    getSnapshot: () => snapshot,
    refresh: render,
    isCollapsed: () => collapsed,
    setCollapsed,
    getInspected: () => inspected,
    inspect (peerId) {
      inspected = peerId
      if (peerId && collapsed) setCollapsed(false)
      render()
    },
    destroy () {
      events.forEach((name) => provider.off(name, render as (...args: unknown[]) => void))
      provider.awareness.off('update', render as (...args: unknown[]) => void)
      root.remove()
    }
  }
  return widgetApi
}
