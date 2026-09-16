import type { PeerjsProvider } from '../PeerjsProvider.js'
import { TopologyTracker, type RemotePeerInfo } from './TopologyTracker.js'

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
  /** 'direct' = open DataConnection; 'indirect' = known via the topology tracker. */
  kind: 'direct' | 'indirect'
  /** Only for direct peers. */
  direction?: 'outgoing' | 'incoming'
  /** Only for direct peers. */
  synced?: boolean
  /** Only for indirect peers: full route from us to the peer (intermediates only, next hop first). */
  path?: string[]
}

/** A peer remembered after it left the mesh, so the UI can offer reconnect. */
export interface RecentPeerInfo {
  peerId: string
  /** Last known display name from awareness, if any. */
  name?: string
  /** Last known avatar color from awareness, if any. */
  color?: string
  /** When we last saw this peer connected (ms epoch). */
  lastSeen: number
}

/**
 * Snapshot of the full connection topology: direct links plus the complete
 * reachable topology learned via the TopologyTracker's discovery protocol.
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
  /**
   * Recently-seen peers that are no longer in the mesh, most recent first.
   * The graph only shows live/connecting peers; these appear in the list's
   * "recent" section with a one-click reconnect button.
   */
  recent: RecentPeerInfo[]
}

export interface TopologyWidgetOptions {
  /** The provider whose topology is visualized. */
  provider: PeerjsProvider
  /**
   * Provide your own TopologyTracker to share it across widgets/consumers.
   * If omitted, the widget creates and owns one (and destroys it when the
   * widget is destroyed). The remote end needs a tracker too for discovery
   * to work.
   */
  tracker?: TopologyTracker
  /** Element to attach the floating panel to. Defaults to document.body. */
  container?: HTMLElement
  /** Initial panel position in px from the top-left corner. */
  position?: { x: number, y: number }
  /** Whether the panel starts collapsed to just the sticky launcher button. Default true. */
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
  /** How long a disconnected peer stays in the "recent" list (ms). Default 300000 (5 min). */
  recentTimeoutMs?: number
  /** Maximum number of peers kept in the "recent" list. Default 10. */
  maxRecentPeers?: number
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
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  reset: '<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/>'
}

function icon (name: string, size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex-shrink:0">${ICONS[name] ?? ''}</svg>`
}

/**
 * A topology inspector fronted by a sticky launcher button pinned to a
 * window edge (drag it along the edge; cross the midline to flip sides).
 * Click the button to expand the full two-panel inspector; click ✕ to
 * collapse back to the button.
 *
 * Features:
 *  - topology graph: solid edges for direct connections, dashed route
 *    edges between indirect peers and their previous hop; edges are
 *    undirected (P2P connections are bidirectional)
 *  - draggable nodes (positions persist until the reset button)
 *  - compact ids: graph/list show name-first labels and truncated ids;
 *    the full id lives in the detail view with a copy button
 *  - clicking a node or list row opens the detail view in the right panel
 *    (identity, route, hop count, actions); clicking yourself shows your
 *    own identity with editable name/color (written to awareness)
 *  - awareness avatars on nodes; per-panel scrollbars styled to match
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
  tracker: providedTracker,
  container = typeof document !== 'undefined' ? document.body : undefined,
  position = { x: 16, y: 16 },
  startCollapsed = true,
  onToggleCollapsed,
  fallbackColor = '#a6e3a1',
  shortIdLength = 6,
  recentTimeoutMs = 5 * 60 * 1000,
  maxRecentPeers = 10
}: TopologyWidgetOptions): TopologyWidget {
  if (!container) throw new Error('TopologyWidget requires a DOM container')
  ensureStyles(container.ownerDocument ?? document)

  const ownsTracker = !providedTracker
  const tracker = providedTracker ?? new TopologyTracker(provider)

  // --- graph layout state --------------------------------------------------
  // Manual node positions (from dragging) persist across re-renders and peer
  // churn; nodes without a saved position fall back to the automatic
  // route-aware layout. Cleared by the reset-layout button.
  const savedPositions = new Map<string, { x: number, y: number }>()
  let justDragged = false

  let inspected: string | null = null

  // --- recent peers: remember who left so reconnect is one click ----------
  // Disconnected peers disappear from the graph immediately (dead nodes
  // clutter the topology and read as "still connected"). Instead they land
  // in a small "recent" section at the bottom of the list — with their last
  // known name/color — until recentTimeoutMs passes, then they expire.
  const recent = new Map<string, RecentPeerInfo>() // peerId -> info
  /**
   * Why a connect attempt failed, by peer id. Rendered in the list/detail so
   * "connecting…" never hangs silently — peer-unavailable and timeouts both
   * surface a concrete message.
   */
  const lastFailure = new Map<string, string>() // peerId -> message

  const cleanFailureMessage = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err)
    return raw
      .replace(/^Could not connect to peer\s+/i, '')
      .replace(/^Could not connect to peer\s+\S+\s*/i, '')
      .trim() || raw
  }

  function rememberPeer (peerId: string): void {
    if (provider.connections.has(peerId) || provider.connecting.has(peerId)) return
    const av = avatarFor(peerId)
    recent.set(peerId, {
      peerId,
      name: av && av.name !== peerId ? av.name : undefined,
      color: av?.color,
      lastSeen: Date.now()
    })
    while (recent.size > maxRecentPeers) {
      const oldest = [...recent.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]
      if (oldest === undefined) break
      recent.delete(oldest.peerId)
      if (inspected === oldest.peerId) widgetApi.inspect(null)
    }
  }

  // Expire stale entries lazily on each snapshot — no timer needed.
  function pruneRecent (): void {
    const now = Date.now()
    recent.forEach((info, peerId) => {
      if (now - info.lastSeen > recentTimeoutMs) {
        recent.delete(peerId)
        lastFailure.delete(peerId)
        savedPositions.delete(peerId)
      }
    })
  }

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
  const host: HTMLElement = container
  const ownerDoc = host.ownerDocument ?? document
  const view = ownerDoc.defaultView
  const PANEL_W = 460
  const PANEL_MARGIN = 12

  // Panel — hidden until the launcher expands it.
  const root = document.createElement('div')
  root.className = 'ypw-root'
  root.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    `width:${PANEL_W}px`,
    'background:#181825f2',
    'backdrop-filter:blur(8px)',
    'color:#cdd6f4',
    'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
    'border:1px solid #45475a',
    'border-radius:12px',
    'box-shadow:0 8px 32px #000a',
    'user-select:none',
    'overflow:hidden',
    'display:none'
  ].join(';')
  // The panel renders BELOW the launcher tab so it can slide out from the
  // window edge underneath it.
  root.style.zIndex = '2147483646'
  container.appendChild(root)

  // Sticky launcher button — the drawer's handle tab. Lives on a window
  // edge (left/right) flush to it; the panel docks flush against its inner
  // side and slides out from the edge UNDER the tab, so button + panel read
  // as one continuous drawer. Dragging it vertically moves the whole thing.
  const launcher = ownerDoc.createElement('button')
  launcher.type = 'button'
  launcher.className = 'ypw-launcher'
  launcher.title = 'topology'
  launcher.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'display:inline-flex',
    'align-items:center',
    'gap:6px',
    'padding:8px 10px',
    'background:#181825f2',
    'backdrop-filter:blur(8px)',
    'color:#cdd6f4',
    'font:12px ui-monospace,SFMono-Regular,Menlo,monospace',
    'border:1px solid #45475a',
    'cursor:grab',
    'touch-action:none',
    'user-select:none',
    'box-shadow:0 4px 16px #000a'
  ].join(';')
  launcher.innerHTML = `${icon('globe', 15)}<span class="ypw-launcher-badge" style="display:none;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:#89b4fa;color:#1e1e2e;font-size:9.5px;font-weight:bold;align-items:center;justify-content:center;flex-shrink:0"></span>`
  container.appendChild(launcher)

  const BTN = 'ypw-btn display:inline-flex;align-items:center;gap:4px;cursor:pointer;background:#313244;border:1px solid #585b70;color:#cdd6f4;border-radius:8px;padding:4px 8px;font:11px ui-monospace,monospace'
  const BTN_DANGER = 'ypw-btn display:inline-flex;align-items:center;gap:4px;cursor:pointer;background:#45243a;border:1px solid #f38ba8;color:#f38ba8;border-radius:8px;padding:4px 8px;font:11px ui-monospace,monospace'
  const BTN_OK = 'ypw-btn display:inline-flex;align-items:center;gap:4px;cursor:pointer;background:#1e3328;border:1px solid #a6e3a1;color:#a6e3a1;border-radius:8px;padding:4px 8px;font:11px ui-monospace,monospace'

  root.innerHTML = `
    <div class="ypw-header" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid #45475a;gap:8px">
      <span class="ypw-title" style="flex-shrink:0;font-weight:bold;display:inline-flex;align-items:center;gap:5px">${icon('globe', 13)} topology</span>
      <span class="ypw-selfchip" style="flex:1;display:inline-flex;align-items:center;gap:6px;justify-content:flex-end;min-width:0;cursor:pointer" title="inspect yourself"></span>
    </div>
    <div class="ypw-body" style="display:flex;flex-direction:column">
      <div class="ypw-left" style="display:flex;flex-direction:column;border-bottom:1px solid #313244">
        <svg class="ypw-graph" width="100%" height="220" style="display:block;flex-shrink:0"></svg>
        <div class="ypw-controls" style="display:flex;gap:6px;padding:8px 10px;border-top:1px solid #313244">
          <input class="ypw-target ypw-input" placeholder="peer id…" style="flex:1;min-width:0;background:#313244;border:1px solid #45475a;color:#cdd6f4;border-radius:8px;padding:5px 8px;outline:none" />
          <button class="ypw-connect ypw-btn" title="connect to peer" style="${BTN}">${icon('plug', 12)}</button>
          <button class="ypw-reset ypw-btn" title="reset node positions" style="${BTN}">${icon('reset', 12)}</button>
        </div>
      </div>
      <div class="ypw-right" style="display:flex;flex-direction:column">
        <div class="ypw-right-head" style="padding:6px 10px;display:flex;flex-direction:column;gap:2px"></div>
        <div class="ypw-right-body ypw-scroll" style="max-height:190px;overflow-y:auto;padding:4px 6px"></div>
      </div>
    </div>
  `

  const selfChip = root.querySelector<HTMLElement>('.ypw-selfchip')!
  const graphEl = root.querySelector<SVGSVGElement>('.ypw-graph')!
  const targetInput = root.querySelector<HTMLInputElement>('.ypw-target')!
  const connectBtn = root.querySelector<HTMLButtonElement>('.ypw-connect')!
  const resetBtn = root.querySelector<HTMLButtonElement>('.ypw-reset')!
  const rightHead = root.querySelector<HTMLElement>('.ypw-right-head')!
  const rightBody = root.querySelector<HTMLElement>('.ypw-right-body')!
  const launcherBadge = launcher.querySelector<HTMLElement>('.ypw-launcher-badge')!

  // --- hover tooltip (shared by all nodes, created once) ------------------
  const tip = host.ownerDocument.createElement('div')
  tip.className = 'ypw-tip'
  tip.style.cssText = [
    'position:fixed',
    'display:none',
    'pointer-events:none',
    'z-index:2147483647',
    'background:#11111bf5',
    'border:1px solid #585b70',
    'border-radius:8px',
    'padding:5px 8px',
    'font:10.5px/1.4 ui-monospace,monospace',
    'color:#cdd6f4',
    'white-space:nowrap',
    'box-shadow:0 4px 16px #000a'
  ].join(';')
  host.ownerDocument.body.appendChild(tip)

  // --- sticky launcher + panel positioning ---------------------------------
  // The launcher sticks to a window edge (left or right) at a draggable
  // vertical position; the panel opens adjacent to it, clamped to the
  // viewport. Click = toggle panel, drag = move along the edge, crossing
  // the viewport midline flips sides.
  let expanded = !startCollapsed
  let side: 'left' | 'right' = 'right'
  let stickY = position.y

  const vw = (): number => view?.innerWidth ?? 1200
  const vh = (): number => view?.innerHeight ?? 800

  function placeLauncher (): void {
    const h = launcher.offsetHeight || 34
    const max = Math.max(0, vh() - h - PANEL_MARGIN)
    stickY = Math.max(PANEL_MARGIN, Math.min(stickY, max))
    launcher.style.top = `${stickY}px`
    if (side === 'left') {
      launcher.style.left = '0px'
      launcher.style.right = ''
      launcher.style.borderRadius = '0 10px 10px 0'
      launcher.style.borderLeftColor = 'transparent'
    } else {
      launcher.style.right = '0px'
      launcher.style.left = ''
      launcher.style.borderRadius = '10px 0 0 10px'
      launcher.style.borderRightColor = 'transparent'
    }
    launcher.style.boxShadow = '0 4px 16px #000a'
  }

  // Floating panel model: the launcher button stays visible and the panel
  // opens as a floating window anchored next to it (on the button's inner
  // side). The panel is clamped to the viewport so it can never end up
  // partially (or fully) off-screen, even on tiny windows or after resizes.
  function placePanel (): void {
    if (!expanded) return
    const ph = root.offsetHeight || 340
    const pw = root.offsetWidth || PANEL_W
    // Anchor: on the side of the button facing into the viewport.
    const lr = launcher.getBoundingClientRect()
    const rawLeft = side === 'right' ? lr.left - pw - PANEL_MARGIN : lr.right + PANEL_MARGIN
    const left = Math.max(PANEL_MARGIN, Math.min(rawLeft, vw() - pw - PANEL_MARGIN))
    const top = Math.max(PANEL_MARGIN, Math.min(lr.top, vh() - ph - PANEL_MARGIN))
    root.style.left = `${left}px`
    root.style.top = `${top}px`
    root.style.right = ''
  }

  function applyExpanded (): void {
    root.style.display = expanded ? '' : 'none'
    // The launcher stays visible: it becomes the toggle for the floating
    // panel (click again to close), so there is no modal/backdrop step.
    if (expanded) {
      placePanel()
      // Open animation: the panel pops out of the button — quick scale-up
      // + fade from the button's corner.
      if (typeof root.animate === 'function') {
        root.animate(
          [
            { opacity: '0', transform: 'scale(0.85) translateY(8px)' },
            { opacity: '1', transform: 'scale(1) translateY(0)' }
          ],
          { duration: 180, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' }
        )
      }
    }
  }

  function setExpanded (next: boolean): void {
    if (expanded === next) return
    expanded = next
    applyExpanded()
    onToggleCollapsed?.(!expanded)
  }

  launcher.addEventListener('click', () => {
    if (launcherJustDragged) {
      launcherJustDragged = false
      return
    }
    setExpanded(!expanded)
  })

  // Escape closes the floating panel (convenience).
  const onKeyClose = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && expanded) setExpanded(false)
  }
  view?.addEventListener('keydown', onKeyClose)

  // Click outside closes the floating panel: any pointerdown outside the
  // panel (and not on the launcher — the launcher toggles via its own click
  // handler) collapses it. Uses pointerdown so it also fires when the click
  // lands on other widgets/canvas; inside clicks (graph dragging, inputs)
  // are ignored via the composed-path check.
  const onPointerDownClose = (e: PointerEvent): void => {
    if (!expanded) return
    const target = e.target as Node | null
    if (!target) return
    if (root.contains(target) || launcher.contains(target)) return
    setExpanded(false)
  }
  ownerDoc.addEventListener('pointerdown', onPointerDownClose, true)

  // Launcher dragging along the window edge.
  let launcherDrag: { startY: number, startStickY: number, moved: boolean } | null = null
  let launcherJustDragged = false
  launcher.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    launcherDrag = { startY: e.clientY, startStickY: stickY, moved: false }
    launcher.setPointerCapture(e.pointerId)
    e.preventDefault()
  })
  launcher.addEventListener('pointermove', (e) => {
    if (!launcherDrag) return
    const dy = e.clientY - launcherDrag.startY
    if (!launcherDrag.moved && Math.abs(dy) < 4) return
    launcherDrag.moved = true
    stickY = launcherDrag.startStickY + dy
    // Crossing the viewport midline flips the sticky side.
    const rect = launcher.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const nextSide: 'left' | 'right' = cx < vw() / 2 ? 'left' : 'right'
    if (nextSide !== side) {
      side = nextSide
      placeLauncher()
      placePanel()
    } else {
      placeLauncher()
    }
  })
  const endLauncherDrag = (): void => {
    if (!launcherDrag) return
    if (launcherDrag.moved) launcherJustDragged = true
    launcherDrag = null
  }
  launcher.addEventListener('pointerup', endLauncherDrag)
  launcher.addEventListener('pointercancel', endLauncherDrag)

  // Keep everything inside the viewport on resize.
  view?.addEventListener('resize', () => {
    placeLauncher()
    placePanel()
  })

  // --- topology snapshot --------------------------------------------------
  let snapshot: TopologySnapshot = { selfId: null, status: 'idle', connecting: [], peers: [], selfAvatar: null, avatars: new Map(), recent: [] }

  function extractSnapshot (): TopologySnapshot {
    pruneRecent()
    const peers: GraphPeer[] = []
    const avatars = new Map<string, PeerAvatar>()
    provider.connections.forEach(({ synced, direction }, peerId) => {
      peers.push({ peerId, kind: 'direct', direction, synced })
      const av = avatarFor(peerId)
      if (av) avatars.set(peerId, av)
    })
    tracker.getRemotePeers().forEach(({ peerId, path }) => {
      peers.push({ peerId, kind: 'indirect', path })
      const av = avatarFor(peerId)
      if (av) avatars.set(peerId, av)
    })
    // Anything live or connecting is not "recent" — covers both directions
    // of churn (we connected to them / they connected to us).
    peers.forEach((p) => {
      recent.delete(p.peerId)
      lastFailure.delete(p.peerId)
    })
    provider.connecting.forEach((peerId) => {
      recent.delete(peerId)
      lastFailure.delete(peerId)
    })
    const recentPeers = [...recent.values()].sort((a, b) => b.lastSeen - a.lastSeen)
    return {
      selfId: provider.id ?? null,
      status: provider.peer.open ? 'peer-open' : 'idle',
      connecting: Array.from(provider.connecting),
      peers,
      selfAvatar: avatarFor(provider.id ?? '') ?? null,
      avatars,
      recent: recentPeers
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
    const nIndirect = snapshot.peers.filter((p) => p.kind === 'indirect').length

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
      const via = p.kind === 'indirect' ? `<span style="opacity:.55;font-size:10px">via ${displayNameFor(p.path![0])}</span>` : ''
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
        <button class="ypw-row-cancel" title="cancel connect" style="cursor:pointer;background:none;border:none;color:#f38ba8;padding:2px;display:inline-flex">${icon('x', 12)}</button>
      </div>
    `).join('')

    const recentRows = snapshot.recent.map((r) => {
      const failure = lastFailure.get(r.peerId)
      const chip = `<span style="display:inline-flex;width:22px;height:22px;border-radius:50%;background:${r.color ?? fallbackColor};opacity:.45;color:#1e1e2e;align-items:center;justify-content:center;font-weight:bold;font-size:9px;flex-shrink:0">${r.name ? r.name.slice(0, 2).toUpperCase() : r.peerId.slice(0, 2).toUpperCase()}</span>`
      const label = r.name ? `<strong style="opacity:.75">${r.name}</strong> <span style="opacity:.45;font-size:10.5px">${shorten(r.peerId)}</span>` : `<span style="opacity:.75">${shorten(r.peerId)}</span>`
      const meta = failure
        ? `<span style="color:#f38ba8;font-size:10px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${failure}">${failure}</span>`
        : `<span style="opacity:.45;font-size:10px">${Math.round((Date.now() - r.lastSeen) / 1000)}s ago</span>`
      return `
        <div class="ypw-row ypw-row-recent" data-peer="${r.peerId}" style="display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:8px;cursor:pointer;opacity:.85">
          <span style="opacity:.5">${icon('clock', 11)}</span>
          ${chip}
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>
          ${meta}
          <button class="ypw-row-reconnect" title="connect again" style="cursor:pointer;background:none;border:none;color:#a6e3a1;padding:2px;display:inline-flex">${icon('plug', 12)}</button>
        </div>
      `
    }).join('')

    const recentHeader = recentRows
      ? `<div style="padding:8px 6px 2px;font-size:10px;opacity:.5;text-transform:uppercase;letter-spacing:.05em;display:flex;align-items:center;gap:5px">${icon('clock', 10)} recent — offline / unreachable</div>`
      : ''

    rightBody.innerHTML = snapshot.peers.map(row).join('') + connectingRows + recentHeader + recentRows

    rightBody.querySelectorAll<HTMLElement>('.ypw-row[data-peer]').forEach((el) => {
      const peerId = el.dataset.peer!
      const p = snapshot.peers.find((q) => q.peerId === peerId)
      el.addEventListener('click', () => widgetApi.inspect(inspected === peerId ? null : peerId))
      el.querySelector('.ypw-row-action')?.addEventListener('click', (e) => {
        e.stopPropagation()
        if (p?.kind === 'direct') provider.disconnect(peerId)
        else provider.connect(peerId).catch(() => {}) // failures surface via 'connection-failed'
      })
      el.querySelector('.ypw-row-reconnect')?.addEventListener('click', (e) => {
        e.stopPropagation()
        lastFailure.delete(peerId)
        provider.connect(peerId).catch(() => {}) // failures surface via 'connection-failed'
      })
      el.querySelector('.ypw-row-cancel')?.addEventListener('click', (e) => {
        e.stopPropagation()
        provider.disconnect(peerId) // clears the pending connect attempt
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
        <span style="font-size:10.5px;opacity:.75">${provider.connections.size} direct · ${snapshot.peers.filter((p) => p.kind === 'indirect').length} indirect</span>
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
        const route = [...indirect.path!, peerId].join(' → ')
        body += row('route', 'route', route)
        const hops = (indirect.path?.length ?? 0) + 1
        body += row('globe', 'status', `${hops} hop${hops === 1 ? '' : 's'} away`)
      } else if (connecting) {
        body += row('clock', 'status', 'connecting…')
      } else {
        const recentInfo = snapshot.recent.find((r) => r.peerId === peerId)
        const failure = lastFailure.get(peerId)
        body += row('user', 'role', recentInfo ? 'recent · offline / unreachable' : 'unknown peer')
        if (failure) body += row('x', 'last try', `<span style="color:#f38ba8">${failure}</span>`)
        else body += row('globe', 'status', 'not in mesh — connect to reach it')
      }
    }

    // Actions.
    let actions = ''
    if (!isSelf) {
      if (direct) {
        actions = `<button class="ypw-act-dc" style="${BTN_DANGER}">${icon('scissors', 12)} disconnect</button>`
      } else if (connecting) {
        actions = `<button class="ypw-act-cancel" style="${BTN_DANGER}">${icon('x', 12)} cancel</button>`
      } else {
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
      rememberPeer(peerId)
      widgetApi.inspect(peerId) // stay on the peer — now in its recent state
      render()
    })
    rightBody.querySelector('.ypw-act-cancel')?.addEventListener('click', () => {
      provider.disconnect(peerId) // cancels the in-flight connect attempt
      rememberPeer(peerId)
      render()
    })
    rightBody.querySelector('.ypw-act-connect')?.addEventListener('click', () => {
      lastFailure.delete(peerId)
      provider.connect(peerId).catch(() => {}) // failures surface via 'connection-failed'
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

  // --- rendering: rAF coalescing + focused-input guard ---------------------
  // Provider/tracker events can burst (awareness updates especially — one
  // per cursor move per peer). Coalesce everything into one render per
  // animation frame, and skip awareness-driven renders entirely when the
  // avatar-relevant fields (peerId/user.name/user.color per client) didn't
  // actually change.
  let renderScheduled = false
  let lastAwarenessKey = ''
  let lastRenderedInspected: string | null = null
  let deferringEditRerender = false

  function scheduleRender (): void {
    if (renderScheduled) return
    renderScheduled = true
    const view = host.ownerDocument.defaultView
    if (typeof view?.requestAnimationFrame === 'function') {
      view.requestAnimationFrame(() => {
        renderScheduled = false
        renderNow()
      })
    } else {
      renderScheduled = false
      renderNow()
    }
  }

  /** Cheap fingerprint of the awareness state that affects rendering. */
  function awarenessKey (): string {
    const parts: string[] = []
    provider.awareness.getStates().forEach((state, clientId) => {
      const s = state as Record<string, unknown>
      const user = s.user as { name?: unknown, color?: unknown } | undefined
      parts.push(`${clientId}:${String(s.peerId)}:${String(user?.name)}:${String(user?.color)}`)
    })
    return parts.sort().join('|')
  }

  function render (): void {
    scheduleRender()
  }

  function renderNow (): void {
    snapshot = extractSnapshot()

    // Header self chip.
    const selfAv = snapshot.selfAvatar
    selfChip.innerHTML = selfAv
      ? `${avatarChip(selfAv, snapshot.selfId ?? '', 18)} <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${selfAv.name}</span><span style="opacity:.5;font-size:10px">${shorten(snapshot.selfId ?? '')}</span>`
      : `<span style="opacity:.6;font-size:10.5px">${snapshot.selfId ? shorten(snapshot.selfId) : 'connecting…'}</span>`
    selfChip.onclick = () => widgetApi.inspect(inspected === 'self' ? null : 'self')

    // Launcher badge: peer count when the panel is closed.
    const nPeers = snapshot.peers.length + snapshot.connecting.length
    if (!expanded && nPeers > 0) {
      launcherBadge.textContent = String(nPeers)
      launcherBadge.style.display = 'inline-flex'
    } else {
      launcherBadge.style.display = 'none'
    }

    // --- left: graph ---
    const ns = 'http://www.w3.org/2000/svg'
    const W = graphEl.clientWidth || 250
    const H = 200
    const cx = W / 2
    const cy = H / 2

    const innerR = Math.min(W, H) * 0.27
    const positions = new Map<string, { x: number, y: number }>()

    const directs = snapshot.peers.filter((p) => p.kind === 'direct')
    const indirects = snapshot.peers.filter((p) => p.kind === 'indirect')

    // Route-aware automatic layout: direct peers sit evenly on the inner
    // ring; each indirect peer is placed on a ring one level beyond its
    // previous hop, along that hop's outgoing direction. A chain A—B—C—D
    // then renders as an actual chain radiating outward (A—B, B—C, C—D)
    // instead of C and D floating at arbitrary angles on the outer ring.
    // It also preserves the *shape* under this widget's "everything I know
    // is reachable through my direct neighbors" viewing perspective.
    directs.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / Math.max(directs.length, 1) - Math.PI / 2
      positions.set(p.peerId, { x: cx + innerR * Math.cos(angle), y: cy + innerR * Math.sin(angle) })
    })
    // Indirects, deepest route last so shallower hops are placed first and
    // deeper nodes can anchor to them.
    const sortedIndirects = [...indirects].sort((a, b) => a.path!.length - b.path!.length)
    const ringSlot = new Map<string, number>() // peerId -> next free angle slot per anchor
    sortedIndirects.forEach((p) => {
      const prevHop = p.path![p.path!.length - 1]
      const anchor = positions.get(prevHop) ?? positions.get(p.path![0]) ?? { x: cx, y: cy }
      const dist = Math.max(innerR + 16, Math.hypot(anchor.x - cx, anchor.y - cy) + 16)
      // Spread siblings around the anchor: each anchor gets its own slot
      // counter so two children of B fan out instead of overlapping.
      const slot = ringSlot.get(prevHop) ?? 0
      ringSlot.set(prevHop, slot + 1)
      const siblings = ringSlot.get(prevHop)!
      const base = Math.atan2(anchor.y - cy, anchor.x - cx)
      const spread = siblings > 1 ? (slot - (siblings - 1) / 2) * (Math.PI / 6) : 0
      const angle = base + spread
      positions.set(p.peerId, {
        x: Math.max(14, Math.min(W - 14, anchor.x + dist * Math.cos(angle))),
        y: Math.max(14, Math.min(H - 14, anchor.y + dist * Math.sin(angle)))
      })
    })
    snapshot.connecting.forEach((peerId, idx) => {
      const angle = Math.PI / 2 + (idx - (snapshot.connecting.length - 1) / 2) * 0.5
      positions.set(peerId, { x: cx + (innerR + 14) * Math.cos(angle), y: cy + (innerR + 14) * Math.sin(angle) })
    })

    // Manual drags override the automatic layout (until reset).
    savedPositions.forEach((pos, peerId) => {
      if (positions.has(peerId)) positions.set(peerId, pos)
    })

    /**
     * Route highlight: when an indirect peer is inspected, the edge chain
     * from us to it (… → via → … → dest) is emphasized and everything not
     * on that route dims — the "how do I actually reach this node" view.
     */
    const routeEdges = new Set<string>() // "from>to" pairs on the inspected route
    let routeDest: string | null = null
    if (inspected && inspected !== 'self') {
      const indirect = snapshot.peers.find((p) => p.peerId === inspected && p.kind === 'indirect')
      if (indirect) {
        routeDest = inspected
        const route = [...indirect.path!, inspected]
        let from = snapshot.selfId ?? ''
        route.forEach((to) => {
          routeEdges.add(`${from}>${to}`)
          from = to
        })
      }
    }
    const edgeKey = (from: string, to: string): string => `${from}>${to}`
    const onRoute = (p: GraphPeer): boolean => {
      if (routeDest === null) return true // no route focus — everything visible
      if (p.kind === 'direct') return routeEdges.has(edgeKey(snapshot.selfId ?? '', p.peerId)) || routeEdges.has(edgeKey(p.peerId, snapshot.selfId ?? ''))
      const prev = p.path!.length > 1 ? p.path![p.path!.length - 2] : (snapshot.selfId ?? '')
      return routeEdges.has(edgeKey(prev, p.peerId))
    }

    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)

    // Edges.
    snapshot.peers.forEach((p) => {
      const pos = positions.get(p.peerId)
      if (!pos) return
      const edge = document.createElementNS(ns, 'line')
      const [x1, y1, x2, y2] = p.kind === 'direct'
        ? (p.direction === 'outgoing' ? [cx, cy, pos.x, pos.y] : [pos.x, pos.y, cx, cy])
        : (() => {
            // Draw the dashed edge from the hop right before the destination
            // (the last intermediate on the route), so a chain A—B—C—D
            // renders as A—B, B—C, C—D instead of collapsing C and D both
            // onto B. Falls back to the next hop if it isn't rendered.
            const prevHop = p.path!.length > 0 ? p.path![p.path!.length - 1] : p.path![0]
            const prevPos = positions.get(prevHop) ?? positions.get(p.path![0]) ?? { x: cx, y: cy }
            return [prevPos.x, prevPos.y, pos.x, pos.y]
          })()
      edge.setAttribute('x1', String(x1))
      edge.setAttribute('y1', String(y1))
      edge.setAttribute('x2', String(x2))
      edge.setAttribute('y2', String(y2))
      const visible = onRoute(p)
      const highlight = inspected === p.peerId || inspected === 'self' || (routeDest !== null && visible)
      edge.setAttribute('stroke', p.kind === 'direct' ? (p.synced ? '#a6e3a1' : '#f9e2af') : (routeDest !== null && visible ? '#89b4fa' : '#6c7086'))
      edge.setAttribute('stroke-width', highlight ? '2.5' : '1.5')
      edge.setAttribute('opacity', routeDest !== null && !visible ? '0.15' : inspected && !highlight ? '0.35' : '1')
      if (p.kind === 'indirect') {
        edge.setAttribute('stroke-dasharray', '4 3')
      }
      svg.appendChild(edge)
    })

    // Nodes: avatar circles only — no text labels, so the topology shape
    // stays readable. Identity (name, id, status) appears on hover via the
    // shared tooltip, and in full in the detail view on click. Nodes are
    // draggable (pointer events, click-vs-drag threshold) to untangle the
    // automatic layout; positions persist until the reset button is used.
    const nodeFor = (peerId: string, pos: { x: number, y: number }, opts: { color: string, r: number, tooltip: string, dashed?: boolean, ring?: string, cursor?: string }) => {
      const g = document.createElementNS(ns, 'g')
      const offRoute = routeDest !== null && !onRoute(snapshot.peers.find((p) => p.peerId === peerId) ?? ({ peerId, kind: 'direct' } as GraphPeer))
      g.style.cursor = opts.cursor ?? (offRoute ? 'pointer' : 'grab')
      if (offRoute) g.setAttribute('opacity', '0.3')

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
      } else if (opts.ring) {
        circle.setAttribute('stroke', opts.ring)
        circle.setAttribute('stroke-width', '2')
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

      // Hover tooltip instead of permanent labels.
      g.addEventListener('pointerenter', () => {
        tip.innerHTML = opts.tooltip
        tip.style.display = 'block'
      })
      g.addEventListener('pointermove', (e) => {
        const x = e.clientX + 12
        const y = e.clientY + 12
        tip.style.left = Math.min(x, (host.ownerDocument.defaultView?.innerWidth ?? x) - 190) + 'px'
        tip.style.top = y + 'px'
      })
      g.addEventListener('pointerleave', () => {
        tip.style.display = 'none'
      })

      // Drag handling: pointerdown starts a potential drag; movement beyond
      // a few px converts it into a real drag (edges and avatar follow the
      // pointer via transform), a clean pointerup without movement is a
      // click (inspect). Suppressed while the widget is collapsed or the
      // node's position is being animated elsewhere.
      let dragging: { startX: number, startY: number, moved: boolean } | null = null
      g.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        const rect = graphEl.getBoundingClientRect()
        const scaleX = rect.width > 0 ? W / rect.width : 1
        const scaleY = rect.height > 0 ? H / rect.height : 1
        dragging = { startX: e.clientX * scaleX, startY: e.clientY * scaleY, moved: false }
        g.setPointerCapture(e.pointerId)
        e.stopPropagation()
      })
      g.addEventListener('pointermove', (e) => {
        if (!dragging) return
        const rect = graphEl.getBoundingClientRect()
        const scaleX = rect.width > 0 ? W / rect.width : 1
        const scaleY = rect.height > 0 ? H / rect.height : 1
        const nx = e.clientX * scaleX
        const ny = e.clientY * scaleY
        const dx = nx - dragging.startX
        const dy = ny - dragging.startY
        if (!dragging.moved && Math.hypot(dx, dy) < 4) return // click threshold
        dragging.moved = true
        const clampedX = Math.max(14, Math.min(W - 14, pos.x + dx))
        const clampedY = Math.max(14, Math.min(H - 14, pos.y + dy))
        g.setAttribute('transform', `translate(${clampedX - pos.x},${clampedY - pos.y})`)
      })
      const endDrag = (e: PointerEvent) => {
        if (!dragging) return
        const wasDrag = dragging.moved
        dragging = null
        if (!wasDrag) return // plain click — let the click handler run
        g.releasePointerCapture?.(e.pointerId)
        // Persist the dragged position (already in viewBox coords — the
        // translate values were computed against them during pointermove).
        const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '')
        if (m) {
          const nx = Math.max(14, Math.min(W - 14, pos.x + parseFloat(m[1])))
          const ny = Math.max(14, Math.min(H - 14, pos.y + parseFloat(m[2])))
          savedPositions.set(peerId, { x: nx, y: ny })
          justDragged = true
          scheduleRender() // snap everything to the saved position cleanly
        }
      }
      g.addEventListener('pointerup', endDrag)
      g.addEventListener('pointercancel', endDrag)

      g.addEventListener('click', (e) => {
        e.stopPropagation()
        if (justDragged) {
          justDragged = false // swallow the click that follows a drag
          return
        }
        widgetApi.inspect(inspected === peerId ? null : peerId)
      })
      svg.appendChild(g)
    }

    const tooltipFor = (p: GraphPeer): string => {
      const av = snapshot.avatars.get(p.peerId)
      const name = av && av.name !== p.peerId ? av.name : null
      const status = p.kind === 'direct'
        ? (p.synced ? 'direct · synced' : 'direct · syncing…')
        : `indirect · via ${displayNameFor(p.path![0])}`
      const who = name ? `${name} <span style="opacity:.6">${shorten(p.peerId)}</span>` : shorten(p.peerId)
      return `<div>${who}</div><div style="opacity:.7">${status}</div>`
    }

    indirects.forEach((p) => {
      const pos = positions.get(p.peerId)!
      nodeFor(p.peerId, pos, {
        color: fallbackColor,
        r: 9,
        tooltip: tooltipFor(p),
        dashed: true
      })
    })
    snapshot.connecting.forEach((peerId) => {
      const pos = positions.get(peerId)!
      nodeFor(peerId, pos, { color: '#f9e2af', r: 8, tooltip: `${shorten(peerId)} · connecting…`, cursor: 'wait' })
    })
    directs.forEach((p) => {
      const pos = positions.get(p.peerId)!
      nodeFor(p.peerId, pos, {
        color: p.synced ? (snapshot.avatars.get(p.peerId)?.color ?? '#a6e3a1') : '#f9e2af',
        r: 12,
        tooltip: tooltipFor(p),
        ring: p.synced ? undefined : '#f9e2af'
      })
    })
    const selfTooltip = selfAv
      ? `<div>${selfAv.name} <span style="opacity:.6">${shorten(snapshot.selfId ?? '')}</span></div><div style="opacity:.7">you · ${provider.connections.size} direct · ${snapshot.peers.filter((p) => p.kind === 'indirect').length} indirect</div>`
      : '<div>you · connecting…</div>'
    nodeFor(snapshot.selfId ?? 'self', { x: cx, y: cy }, {
      color: selfAv?.color ?? '#89b4fa',
      r: 14,
      tooltip: selfTooltip
    })

    svg.addEventListener('click', () => widgetApi.inspect(null))
    graphEl.replaceChildren(svg)

    // --- right: list or detail ---
    // Focused-input guard: while the user is editing an input in the right
    // panel (name, color picker…), don't wipe its innerHTML — that would
    // destroy the element mid-keystroke and lose focus + input. Defer the
    // panel re-render until focus leaves the input. The graph/header still
    // update above; a real view change (different inspected peer) forces
    // the render through anyway.
    const active = host.ownerDocument.activeElement as HTMLElement | null
    const editing = !!active && (rightBody.contains(active) || rightHead.contains(active)) &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')
    if (editing && inspected === lastRenderedInspected) {
      if (!deferringEditRerender) {
        deferringEditRerender = true
        active.addEventListener('focusout', () => {
          deferringEditRerender = false
          scheduleRender()
        }, { once: true })
      }
    } else {
      deferringEditRerender = false
      renderRight()
    }
    lastRenderedInspected = inspected
    lastAwarenessKey = awarenessKey()
  }

  // --- controls -----------------------------------------------------------
  resetBtn.addEventListener('click', () => {
    savedPositions.clear()
    render()
  })
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

  // Remember peers the moment they leave the mesh (either direction) so they
  // show up in the list's "recent" section for quick reconnecting.
  const onPeersEvent = ({ removed }: { added: string[], removed: string[] }): void => {
    removed.forEach((peerId) => rememberPeer(peerId))
  }
  provider.on('peers', onPeersEvent)
  // Surface connect failures concretely: 'connection-failed' is the definitive
  // "this will not succeed" signal (peer-unavailable, timeout) vs generic
  // connection errors which may still recover.
  const onConnectionFailed = (err: unknown, peerId: string): void => {
    lastFailure.set(peerId, cleanFailureMessage(err))
    provider.connecting.delete(peerId)
    render()
  }
  provider.on('connection-failed', onConnectionFailed as (...args: unknown[]) => void)

  const onTrackerChanged = (_remotePeers: RemotePeerInfo[]) => render()
  tracker.on('changed', onTrackerChanged)
  const onAwarenessUpdate = () => {
    // Only re-render when avatar-relevant awareness changed — cursor/presence
    // noise is ignored, and bursts within one frame collapse via scheduleRender.
    if (awarenessKey() !== lastAwarenessKey) render()
  }
  provider.awareness.on('update', onAwarenessUpdate)
  applyExpanded()
  placeLauncher()
  render()

  const widgetApi: TopologyWidget = {
    getSnapshot: () => snapshot,
    refresh: render,
    isCollapsed: () => !expanded,
    setCollapsed (next: boolean) {
      setExpanded(!next)
    },
    getInspected: () => inspected,
    inspect (peerId) {
      inspected = peerId
      if (peerId && !expanded) setExpanded(true)
      render()
    },
    destroy () {
      events.forEach((name) => provider.off(name, render as (...args: unknown[]) => void))
      provider.off('peers', onPeersEvent)
      provider.off('connection-failed', onConnectionFailed as (...args: unknown[]) => void)
      tracker.off('changed', onTrackerChanged)
      if (ownsTracker) tracker.destroy()
      provider.awareness.off('update', onAwarenessUpdate)
      view?.removeEventListener('keydown', onKeyClose)
      ownerDoc.removeEventListener('pointerdown', onPointerDownClose, true)
      tip.remove()
      launcher.remove()
      root.remove()
    }
  }
  return widgetApi
}
