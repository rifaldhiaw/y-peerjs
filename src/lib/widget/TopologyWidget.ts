import type { PeerjsProvider } from '../PeerjsProvider.js'

/** How a peer is displayed on a node: initials avatar + optional full name. */
export interface PeerAvatar {
  /** Display name, from awareness state `user.name` if present. */
  name: string
  /** Two-letter initials derived from the name (or id fallback). */
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
  /**
   * How many characters of a peer id to show before/after the ellipsis in
   * compact contexts (graph labels, list rows). Default 6. The full id is
   * always available in the detail view (with a copy button).
   */
  shortIdLength?: number
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
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>'
}

function icon (name: string, size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex-shrink:0">${ICONS[name] ?? ''}</svg>`
}

/**
 * A floating widget that visualizes the provider's FULL mesh — directly
 * connected peers plus indirect peers learned through the mesh protocol —
 * in a two-panel layout: graph on the left, list/detail on the right.
 *
 * Features:
 *  - full-mesh graph: solid directed edges for direct connections (arrow =
 *    initiator → accepter), dashed edges for indirect peers ("via" label)
 *  - compact ids: graph/list show name-first labels and truncated ids;
 *    the full id lives in the detail view with a copy button
 *  - clicking a node or list row opens the detail view in the right panel
 *    (identity, route, hop count, actions); clicking yourself shows your
 *    own identity with editable name/color (written to awareness)
 *  - awareness avatars on nodes; per-panel scrollbars styled to match
 *  - draggable header with collapse/expand toggle
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
  /** The peer id currently shown in the detail view, or null (list view). */
  getInspected(): string | null
  /** Show a peer's detail view ('self' for yourself), or null for the list. */
  inspect(peerId: string | null): void
  /** Remove the panel from the DOM and detach all listeners. */
  destroy(): void
}

/** Inject the widget's scoped stylesheet once per document. */
function ensureStyles (doc: Document): void {
  if (doc.getElementById('ypw-styles')) return
  const style = document.createElement('style')
  style.id = 'ypw-styles'
  style.textContent = `
    .ypw-scroll {
      scrollbar-width: thin;
      scrollbar-color: #585b70 transparent;
    }
    .ypw-scroll::-webkit-scrollbar {
      width: 8px;
    }
    .ypw-scroll::-webkit-scrollbar-track {
      background: transparent;
    }
    .ypw-scroll::-webkit-scrollbar-thumb {
      background: #45475a;
      border-radius: 8px;
      border: 2px solid transparent;
      background-clip: padding-box;
    }
    .ypw-scroll::-webkit-scrollbar-thumb:hover {
      background: #585b70;
      border: 2px solid transparent;
      background-clip: padding-box;
    }
    .ypw-row:hover {
      background: #262637;
    }
    .ypw-row.selected {
      background: #313244;
    }
    .ypw-btn:hover {
      filter: brightness(1.2);
    }
    .ypw-input:focus {
      border-color: #89b4fa !important;
    }
  `
  doc.head.appendChild(style)
}

export function createTopologyWidget ({
  provider,
  container = typeof document !== 'undefined' ? document.body : undefined,
  position = { x: 16, y: 16 },
  startCollapsed = false,
  onToggleCollapsed,
  fallbackColor = '#a6e3a1',
  shortIdLength = 6
}: TopologyWidgetOptions): TopologyWidget {
  if (!container) throw new Error('TopologyWidget requires a DOM container')
  ensureStyles(container.ownerDocument ?? document)

  let collapsed = startCollapsed
  let inspected: string | null = null

  const shorten = (id: string): string =>
    id.length <= shortIdLength * 2 + 1 ? id : `${id.slice(0, shortIdLength)}…${id.slice(-shortIdLength)}`

  // --- awareness: map Yjs clientIDs to PeerJS ids -------------------------
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

  /** Best short display label for a peer: name if known, else short id. */
  function displayNameFor (peerId: string): string {
    const av = avatarFor(peerId)
    return av && av.name !== peerId ? av.name : shorten(peerId)
  }

  // --- DOM scaffold -------------------------------------------------------
  const root = document.createElement('div')
  root.className = 'ypw-root'
  root.style.cssText = [
    'position:fixed',
    `left:${position.x}px`,
    `top:${position.y}px`,
    'z-index:2147483647',
    'width:460px',
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

  const BTN = 'ypw-btn display:inline-flex;align-items:center;gap:4px;cursor:pointer;background:#313244;border:1px solid #585b70;color:#cdd6f4;border-radius:8px;padding:4px 8px;font:11px ui-monospace,monospace'
  const BTN_DANGER = 'ypw-btn display:inline-flex;align-items:center;gap:4px;cursor:pointer;background:#45243a;border:1px solid #f38ba8;color:#f38ba8;border-radius:8px;padding:4px 8px;font:11px ui-monospace,monospace'
  const BTN_OK = 'ypw-btn display:inline-flex;align-items:center;gap:4px;cursor:pointer;background:#1e3328;border:1px solid #a6e3a1;color:#a6e3a1;border-radius:8px;padding:4px 8px;font:11px ui-monospace,monospace'

  root.innerHTML = `
    <div class="ypw-header" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;cursor:grab;border-bottom:1px solid #45475a;gap:8px">
      <span class="ypw-title" style="flex-shrink:0;font-weight:bold;display:inline-flex;align-items:center;gap:5px">${icon('globe', 13)} topology</span>
      <span class="ypw-selfchip" style="flex:1;display:inline-flex;align-items:center;gap:6px;justify-content:flex-end;min-width:0;cursor:pointer" title="inspect yourself"></span>
      <button class="ypw-collapse" title="collapse" style="flex-shrink:0;cursor:pointer;background:none;border:none;color:#cdd6f4;font:inherit;padding:0 2px;line-height:1">▾</button>
    </div>
    <div class="ypw-body" style="display:flex;min-height:240px">
      <div class="ypw-left" style="flex:1.2;min-width:0;display:flex;flex-direction:column;border-right:1px solid #313244">
        <svg class="ypw-graph" width="100%" height="200" style="display:block;flex-shrink:0"></svg>
        <div class="ypw-controls" style="display:flex;gap:6px;padding:8px 10px;border-top:1px solid #313244;margin-top:auto">
          <input class="ypw-target ypw-input" placeholder="peer id…" style="flex:1;min-width:0;background:#313244;border:1px solid #45475a;color:#cdd6f4;border-radius:8px;padding:5px 8px;outline:none" />
          <button class="ypw-connect ypw-btn" title="connect to peer" style="${BTN}">${icon('plug', 12)}</button>
        </div>
      </div>
      <div class="ypw-right" style="flex:1;min-width:0;display:flex;flex-direction:column">
        <div class="ypw-right-head" style="padding:6px 10px;border-bottom:1px solid #313244;display:flex;flex-direction:column;gap:2px"></div>
        <div class="ypw-right-body ypw-scroll" style="flex:1;overflow-y:auto;padding:4px 6px"></div>
      </div>
    </div>
  `

  const headerEl = root.querySelector<HTMLElement>('.ypw-header')!
  const selfChip = root.querySelector<HTMLElement>('.ypw-selfchip')!
  const collapseBtn = root.querySelector<HTMLButtonElement>('.ypw-collapse')!
  const bodyEl = root.querySelector<HTMLElement>('.ypw-body')!
  const graphEl = root.querySelector<SVGSVGElement>('.ypw-graph')!
  const targetInput = root.querySelector<HTMLInputElement>('.ypw-target')!
  const connectBtn = root.querySelector<HTMLButtonElement>('.ypw-connect')!
  const rightHead = root.querySelector<HTMLElement>('.ypw-right-head')!
  const rightBody = root.querySelector<HTMLElement>('.ypw-right-body')!

  // --- collapsing ---------------------------------------------------------
  function applyCollapsed (): void {
    bodyEl.style.display = collapsed ? 'none' : ''
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
      if (provider.connections.has(peerId)) return
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

  // --- avatar chip --------------------------------------------------------
  function avatarChip (av: PeerAvatar | undefined, fallbackId: string, size: number): string {
    const color = av?.color ?? fallbackColor
    const text = av?.initials ?? fallbackId.slice(0, 2).toUpperCase()
    const fs = Math.round(size * 0.42)
    return `<span style="display:inline-flex;width:${size}px;height:${size}px;border-radius:50%;background:${color};color:#1e1e2e;align-items:center;justify-content:center;font-weight:bold;font-size:${fs}px;flex-shrink:0">${text}</span>`
  }

  // --- right panel: list view --------------------------------------------
  function renderList (): void {
    const nDirect = provider.connections.size
    const nIndirect = provider.mesh.size

    rightHead.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-weight:bold;font-size:11px">${icon('users', 12)} peers</span>
        <span style="flex:1"></span>
        <span style="font-size:10.5px;opacity:.75">${nDirect} direct · ${nIndirect} indirect</span>
      </div>
    `

    if (snapshot.peers.length === 0 && snapshot.connecting.length === 0) {
      rightBody.innerHTML = `<div style="opacity:.5;padding:14px 6px;text-align:center">no peers yet —<br/>share your id or connect to someone</div>`
      return
    }

    const row = (p: GraphPeer) => {
      const av = snapshot.avatars.get(p.peerId)
      const selected = inspected === p.peerId ? ' selected' : ''
      const statusIcon = p.kind === 'direct'
        ? (p.synced ? `<span style="color:#a6e3a1">${icon('check', 11)}</span>` : `<span style="color:#f9e2af">${icon('clock', 11)}</span>`)
        : `<span style="opacity:.6">${icon('route', 11)}</span>`
      const via = p.kind === 'indirect' ? `<span style="opacity:.55;font-size:10px">via ${displayNameFor(p.via!)}</span>` : ''
      return `
        <div class="ypw-row${selected}" data-peer="${p.peerId}" style="display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:8px;cursor:pointer">
          ${statusIcon}
          ${avatarChip(av, p.peerId, 22)}
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${av && av.name !== p.peerId ? `<strong>${av.name}</strong> <span style="opacity:.55;font-size:10.5px">${shorten(p.peerId)}</span>` : shorten(p.peerId)}</span>
          ${via}
          <button class="ypw-row-action" title="${p.kind === 'direct' ? 'disconnect' : 'connect'}" style="cursor:pointer;background:none;border:none;color:${p.kind === 'direct' ? '#f38ba8' : '#a6e3a1'};padding:2px;display:inline-flex">${icon(p.kind === 'direct' ? 'scissors' : 'plug', 12)}</button>
        </div>
      `
    }

    const connectingRows = snapshot.connecting.map((peerId) => `
      <div class="ypw-row" style="display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:8px;opacity:.6">
        <span style="color:#f9e2af">${icon('clock', 11)}</span>
        ${avatarChip(undefined, peerId, 22)}
        <span style="flex:1">${shorten(peerId)}</span>
        <span style="font-size:10.5px">connecting…</span>
      </div>
    `).join('')

    rightBody.innerHTML = snapshot.peers.map(row).join('') + connectingRows

    rightBody.querySelectorAll<HTMLElement>('.ypw-row[data-peer]').forEach((el) => {
      const peerId = el.dataset.peer!
      const p = snapshot.peers.find((q) => q.peerId === peerId)
      el.addEventListener('click', () => widgetApi.inspect(inspected === peerId ? null : peerId))
      el.querySelector('.ypw-row-action')?.addEventListener('click', (e) => {
        e.stopPropagation()
        if (p?.kind === 'direct') provider.disconnect(peerId)
        else provider.connect(peerId).catch(() => {}) // errors surface via 'connection-error'
      })
    })
  }

  // --- right panel: detail view ------------------------------------------
  function renderDetail (): void {
    const peerId = inspected!
    const isSelf = peerId === 'self' || peerId === snapshot.selfId
    const direct = snapshot.peers.find((p) => p.peerId === peerId && p.kind === 'direct')
    const indirect = snapshot.peers.find((p) => p.peerId === peerId && p.kind === 'indirect')
    const connecting = snapshot.connecting.includes(peerId)
    const av = isSelf ? snapshot.selfAvatar : snapshot.avatars.get(peerId)

    const name = isSelf ? (av?.name ?? 'You') : (av?.name ?? shorten(peerId))
    const fullId = isSelf ? (snapshot.selfId ?? '') : peerId

    rightHead.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px">
        <button class="ypw-back ypw-btn" title="back to list" style="cursor:pointer;background:none;border:none;color:#89b4fa;padding:0;display:inline-flex;align-items:center;font:11px ui-monospace,monospace">← peers</button>
        <span style="flex:1"></span>
        <span style="font-size:10.5px;opacity:.75">${provider.connections.size} direct · ${provider.mesh.size} indirect</span>
      </div>
    `

    const row = (iconName: string, label: string, valueHtml: string) =>
      `<div style="display:flex;gap:8px;align-items:baseline;margin:6px 0"><span style="width:14px;flex-shrink:0;opacity:.6;display:inline-flex">${icon(iconName, 12)}</span><span style="opacity:.6;width:58px;flex-shrink:0;font-size:10.5px">${label}</span><span style="min-width:0;word-break:break-all">${valueHtml}</span></div>`

    let body = `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 4px 2px">
        ${avatarChip(av ?? undefined, fullId, 40)}
        <div style="min-width:0">
          <div style="font-weight:bold;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${av ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${av.color};margin-right:5px;vertical-align:1px"></span>${av.name}` : name}</div>
          ${av ? `<div style="opacity:.55;font-size:10.5px">${shorten(fullId)}</div>` : ''}
        </div>
      </div>
      <div style="border-top:1px solid #313244;margin:8px 0"></div>
    `

    // Identity rows.
    const idRow = `<span style="display:inline-flex;align-items:center;gap:6px;min-width:0"><span style="word-break:break-all">${fullId}</span><button class="ypw-copy ypw-btn" title="copy full id" style="cursor:pointer;background:none;border:none;color:#89b4fa;padding:2px;display:inline-flex">${icon('copy', 12)}</button></span>`
    if (isSelf) {
      body += row('user', 'role', 'you (this browser)')
      body += row('hash', 'id', idRow)
      body += row('globe', 'status', snapshot.status)
      // Editable name/color -> written to awareness so all peers see it.
      body += `
        <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
          <span style="width:14px;flex-shrink:0;opacity:.6;display:inline-flex">${icon('user', 12)}</span>
          <input class="ypw-edit-name ypw-input" value="${av?.name ?? ''}" placeholder="your name" style="flex:1;min-width:0;background:#313244;border:1px solid #45475a;color:#cdd6f4;border-radius:8px;padding:4px 8px;outline:none" />
          <input class="ypw-edit-color" type="color" value="${av?.color ?? fallbackColor}" title="your color" style="width:30px;height:26px;border:1px solid #45475a;border-radius:8px;background:#313244;cursor:pointer;padding:2px" />
        </div>
      `
    } else {
      body += row('hash', 'id', idRow)
      if (direct) {
        body += row('user', 'role', direct.direction === 'outgoing' ? 'direct · you connected' : 'direct · connected you')
        body += row('check', 'synced', direct.synced ? 'yes' : 'syncing…')
        body += row('globe', 'status', '1 hop away')
      } else if (indirect) {
        body += row('user', 'role', 'indirect · not directly connected')
        const route = [indirect.via, ...indirect.path!, peerId].join(' → ')
        body += row('route', 'route', route)
        const hops = (indirect.path?.length ?? 0) + 1
        body += row('globe', 'status', `${hops} hop${hops === 1 ? '' : 's'} away`)
      } else if (connecting) {
        body += row('clock', 'status', 'connecting…')
      } else {
        body += row('user', 'role', 'unknown peer')
        body += row('globe', 'status', 'not in mesh — connect to reach it')
      }
    }

    // Actions.
    let actions = ''
    if (!isSelf) {
      if (direct) {
        actions = `<button class="ypw-act-dc" style="${BTN_DANGER}">${icon('scissors', 12)} disconnect</button>`
      } else if (!connecting) {
        actions = `<button class="ypw-act-connect" style="${BTN_OK}">${icon('plug', 12)} connect</button>`
      }
    }
    if (actions) body += `<div style="margin-top:10px;display:flex;gap:6px">${actions}</div>`

    rightBody.innerHTML = body
    rightBody.classList.add('ypw-scroll')

    rightHead.querySelector('.ypw-back')!.addEventListener('click', () => widgetApi.inspect(null))
    rightBody.querySelector('.ypw-copy')?.addEventListener('click', () => {
      const doc = container!.ownerDocument ?? document
      void doc.defaultView?.navigator.clipboard?.writeText(fullId).catch(() => {})
    })
    rightBody.querySelector('.ypw-act-dc')?.addEventListener('click', () => {
      provider.disconnect(peerId)
      widgetApi.inspect(null)
    })
    rightBody.querySelector('.ypw-act-connect')?.addEventListener('click', () => {
      provider.connect(peerId).catch(() => {}) // errors surface via 'connection-error'
    })

    // Self-edit: persist name/color into awareness.
    const nameInput = rightBody.querySelector<HTMLInputElement>('.ypw-edit-name')
    const colorInput = rightBody.querySelector<HTMLInputElement>('.ypw-edit-color')
    const commitSelf = () => {
      const user = {
        name: nameInput?.value.trim() || 'anonymous',
        color: colorInput?.value ?? fallbackColor
      }
      provider.awareness.setLocalStateField('user', user)
    }
    nameInput?.addEventListener('change', commitSelf)
    nameInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() })
    colorInput?.addEventListener('input', commitSelf)
  }

  function renderRight (): void {
    if (inspected) renderDetail()
    else renderList()
  }

  // --- rendering ----------------------------------------------------------
  function render (): void {
    snapshot = extractSnapshot()

    // Header self chip.
    const selfAv = snapshot.selfAvatar
    selfChip.innerHTML = selfAv
      ? `${avatarChip(selfAv, snapshot.selfId ?? '', 18)} <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${selfAv.name}</span><span style="opacity:.5;font-size:10px">${shorten(snapshot.selfId ?? '')}</span>`
      : `<span style="opacity:.6;font-size:10.5px">${snapshot.selfId ? shorten(snapshot.selfId) : 'connecting…'}</span>`
    selfChip.onclick = () => widgetApi.inspect(inspected === 'self' ? null : 'self')

    // --- left: graph ---
    const ns = 'http://www.w3.org/2000/svg'
    const W = graphEl.clientWidth || 250
    const H = 200
    const cx = W / 2
    const cy = H / 2

    const innerR = Math.min(W, H) * 0.27
    const outerR = Math.min(W, H) * 0.43
    const positions = new Map<string, { x: number, y: number }>()

    const directs = snapshot.peers.filter((p) => p.kind === 'direct')
    const indirects = snapshot.peers.filter((p) => p.kind === 'indirect')
    directs.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / Math.max(directs.length, 1) - Math.PI / 2
      positions.set(p.peerId, { x: cx + innerR * Math.cos(angle), y: cy + innerR * Math.sin(angle) })
    })
    indirects.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / Math.max(indirects.length, 1) - Math.PI / 2 + Math.PI / Math.max(indirects.length, 1)
      positions.set(p.peerId, { x: cx + outerR * Math.cos(angle), y: cy + outerR * Math.sin(angle) })
    })
    snapshot.connecting.forEach((peerId, idx) => {
      const angle = Math.PI / 2 + (idx - (snapshot.connecting.length - 1) / 2) * 0.5
      positions.set(peerId, { x: cx + (innerR + 14) * Math.cos(angle), y: cy + (innerR + 14) * Math.sin(angle) })
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
            const viaPos = positions.get(p.via!) ?? { x: cx, y: cy }
            return [viaPos.x, viaPos.y, pos.x, pos.y]
          })()
      edge.setAttribute('x1', String(x1))
      edge.setAttribute('y1', String(y1))
      edge.setAttribute('x2', String(x2))
      edge.setAttribute('y2', String(y2))
      const highlight = inspected === p.peerId || inspected === 'self' || (p.kind === 'indirect' && p.via === inspected)
      edge.setAttribute('stroke', p.kind === 'direct' ? (p.synced ? '#a6e3a1' : '#f9e2af') : '#6c7086')
      edge.setAttribute('stroke-width', highlight ? '2.5' : '1.5')
      edge.setAttribute('opacity', inspected && !highlight ? '0.35' : '1')
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
        circle.setAttribute('fill', '#181825')
        circle.setAttribute('stroke', '#9399b2')
        circle.setAttribute('stroke-dasharray', '3 2')
        circle.setAttribute('stroke-width', '1.5')
      }
      if (inspected === peerId) {
        circle.setAttribute('stroke', '#89b4fa')
        circle.setAttribute('stroke-width', '2.5')
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
      label.setAttribute('font-size', '10')
      label.textContent = opts.label
      g.appendChild(label)

      if (opts.sub) {
        const sub = document.createElementNS(ns, 'text')
        sub.setAttribute('x', String(pos.x))
        sub.setAttribute('y', String(pos.y + opts.r + 13))
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
    }

    indirects.forEach((p) => {
      const pos = positions.get(p.peerId)!
      nodeFor(p.peerId, pos, {
        color: fallbackColor,
        r: 9,
        label: displayNameFor(p.peerId),
        sub: `via ${displayNameFor(p.via!)}`,
        dashed: true
      })
    })
    snapshot.connecting.forEach((peerId) => {
      const pos = positions.get(peerId)!
      nodeFor(peerId, pos, { color: '#f9e2af', r: 8, label: shorten(peerId), sub: 'connecting…', cursor: 'wait' })
    })
    directs.forEach((p) => {
      const pos = positions.get(p.peerId)!
      nodeFor(p.peerId, pos, {
        color: p.synced ? (snapshot.avatars.get(p.peerId)?.color ?? '#a6e3a1') : '#f9e2af',
        r: 12,
        label: displayNameFor(p.peerId),
        sub: p.synced ? undefined : 'syncing…'
      })
    })
    nodeFor(snapshot.selfId ?? 'self', { x: cx, y: cy }, {
      color: selfAv?.color ?? '#89b4fa',
      r: 14,
      label: selfAv ? selfAv.name : 'me'
    })

    svg.addEventListener('click', () => widgetApi.inspect(null))
    graphEl.replaceChildren(svg)

    // --- right: list or detail ---
    renderRight()
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
