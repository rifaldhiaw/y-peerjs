import './style.css'
import * as Y from 'yjs'
import { PeerjsProvider, type PeersEvent, type StatusEvent } from '../lib/index.js'
import { createTopologyWidget } from '../lib/widget/index.js'

const log = (...args: unknown[]) => {
  const el = document.getElementById('log')!
  el.textContent += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'
  el.scrollTop = el.scrollHeight
}

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1>y-peerjs demo</h1>
  <p>Your peer id: <code id="myId">connecting…</code></p>

  <div>
    <input id="targetId" placeholder="paste the other tab's peer id" size="30" />
    <button id="connectBtn">Connect</button>
    <button id="disconnectBtn">Disconnect</button>
  </div>

  <h3>Shared text (Yjs Y.Text, synced over the connection above)</h3>
  <textarea id="editor"></textarea>

  <h3>Log</h3>
  <div id="log"></div>
`

const doc = new Y.Doc()
const ytext = doc.getText('shared')

const provider = new PeerjsProvider(doc, {
  // omit peerId to let PeerJS's cloud broker assign a random one
  autoConnectTo: [] // or: ['known-peer-id'] to reconnect automatically on load
})

// Presence info: the widget reads `user` (name + color) for the avatar
// overlay on the topology nodes. Change the seed to try different looks.
const USERS = [
  { name: 'Alice', color: '#f38ba8' },
  { name: 'Bob', color: '#89b4fa' },
  { name: 'Carol', color: '#a6e3a1' }
]
const me = USERS[Math.floor(Math.random() * USERS.length)]
provider.awareness.setLocalStateField('user', me)

// Floating panel: live topology graph (directed edges) + connect/disconnect
// controls. Press the ▸/▾ button in its header to collapse/expand it.
const widget = createTopologyWidget({
  provider,
  position: { x: 16, y: 16 },
  onToggleCollapsed: (collapsed) => log('widget', collapsed ? 'collapsed' : 'expanded')
})
window.addEventListener('beforeunload', () => widget.destroy())

provider.whenReady.then((id) => {
  document.getElementById('myId')!.textContent = id
  log('registered as', id)
})

provider.on('status', (event: [StatusEvent]) => log('status:', event[0]))
provider.on('peers', (event: [PeersEvent]) => log('peers:', event[0]))
provider.on('synced', ([{ peerId }]: [{ peerId: string }]) => log('synced with', peerId))
provider.on('connection-error', ([err, peerId]: [Error, string]) => log('connection-error with', peerId, err.message))
provider.on('mesh', ([{ added, removed }]: [{ added: string[], removed: string[] }]) => {
  if (added.length > 0) log('mesh: now reachable via relay →', added.join(', '))
  if (removed.length > 0) log('mesh: lost relay path →', removed.join(', '))
})

// Tip for trying the full-mesh view: open a third tab, connect it to only
// ONE of the first two tabs, and watch the widget show the other tab as an
// indirect (dashed) node "via" your direct peer. Click any node to inspect
// it — the panel shows role, route, and hop count, with connect/disconnect
// actions.

document.getElementById('connectBtn')!.addEventListener('click', () => {
  const target = document.getElementById('targetId') as HTMLInputElement
  const id = target.value.trim()
  if (!id) return
  provider.connect(id)
    .then(() => log('connected to', id))
    .catch((err) => log('failed to connect to', id, err.message))
})

document.getElementById('disconnectBtn')!.addEventListener('click', () => {
  const target = document.getElementById('targetId') as HTMLInputElement
  const id = target.value.trim()
  if (!id) return
  provider.disconnect(id)
  log('disconnected from', id)
})

// --- wire the textarea to the Yjs text type (naive, no cursor preservation) ---
const editor = document.getElementById('editor') as HTMLTextAreaElement
editor.value = ytext.toString()

ytext.observe(() => {
  if (editor.value !== ytext.toString()) {
    editor.value = ytext.toString()
  }
})

editor.addEventListener('input', () => {
  doc.transact(() => {
    ytext.delete(0, ytext.length)
    ytext.insert(0, editor.value)
  })
})
