import { EventEmitter } from 'node:events'

// Simulates a shared PeerJS cloud broker in-memory so two Peer instances in
// the same process can "connect" to each other by id. This exists purely so
// PeerjsProvider's sync/awareness logic can be exercised in plain Node,
// without a browser or real WebRTC/network stack.
const registry = new Map()

let counter = 0
const randomId = () => `mock-${++counter}-${Math.random().toString(36).slice(2, 8)}`

class DataConnection extends EventEmitter {
  constructor (peerId, metadata) {
    super()
    this.peer = peerId
    this.metadata = metadata
    this.open = false
    this._other = null // paired DataConnection
  }

  _link (other) {
    this._other = other
  }

  _markOpen () {
    this.open = true
    this.emit('open')
  }

  send (data) {
    if (!this.open || !this._other) return
    // Simulate async network delivery.
    setTimeout(() => this._other.emit('data', data), 0)
  }

  close () {
    if (!this.open && !this._other) return
    this.open = false
    const other = this._other
    this._other = null
    this.emit('close')
    if (other && other.open) {
      other.open = false
      other._other = null
      other.emit('close')
    }
  }
}

export class Peer extends EventEmitter {
  constructor (id, options = {}) {
    super()
    this.options = options
    this.id = typeof id === 'string' && id.length > 0 ? id : randomId()
    this.destroyed = false
    setTimeout(() => {
      if (this.destroyed) return
      registry.set(this.id, this)
      this.emit('open', this.id)
    }, 0)
  }

  connect (targetId, opts = {}) {
    const localConn = new DataConnection(targetId, opts.metadata)
    setTimeout(() => {
      const target = registry.get(targetId)
      if (!target || target.destroyed) {
        localConn.emit('error', new Error(`peer ${targetId} not found`))
        return
      }
      const remoteConn = new DataConnection(this.id, opts.metadata)
      localConn._link(remoteConn)
      remoteConn._link(localConn)
      target.emit('connection', remoteConn)
      localConn._markOpen()
      remoteConn._markOpen()
    }, 0)
    return localConn
  }

  disconnect () {
    this.emit('disconnected')
  }

  destroy () {
    this.destroyed = true
    registry.delete(this.id)
    this.emit('close')
  }
}

export default Peer
