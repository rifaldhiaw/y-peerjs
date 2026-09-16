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

// Floating panel: live topology graph + connect/disconnect controls.
const widget = createTopologyWidget({ provider, position: { x: 16, y: 16 } })
window.addEventListener('beforeunload', () => widget.destroy())

provider.whenReady.then((id) => {
  document.getElementById('myId')!.textContent = id
  log('registered as', id)
})

provider.on('status', (event: [StatusEvent]) => log('status:', event[0]))
provider.on('peers', (event: [PeersEvent]) => log('peers:', event[0]))
provider.on('synced', ([{ peerId }]: [{ peerId: string }]) => log('synced with', peerId))
provider.on('connection-error', ([err, peerId]: [Error, string]) => log('connection-error with', peerId, err.message))

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
