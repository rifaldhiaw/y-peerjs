import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { PeerjsProvider } from '../src/lib/index.js'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForEvent = (
  provider: PeerjsProvider,
  name: string,
  predicate: (arg: any) => boolean = () => true,
  timeout = 3000
) =>
  new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${name}'`)), timeout)
    const handler = (args: any) => {
      if (predicate(args)) {
        clearTimeout(timer)
        provider.off(name, handler)
        resolve(args)
      }
    }
    provider.on(name, handler)
  })

describe('PeerjsProvider', () => {
  it('registers peers, syncs both ways, propagates live updates', async () => {
    // --- Test 1: basic connect + two-way sync ---
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const providerA = new PeerjsProvider(docA, { peerId: 'alice' })
    const providerB = new PeerjsProvider(docB, { peerId: 'bob' })

    await Promise.all([providerA.whenReady, providerB.whenReady])
    expect(providerA.id).toBe('alice')
    expect(providerB.id).toBe('bob')

    docA.getText('shared').insert(0, 'hello ')

    await providerA.connect('bob')
    await Promise.all([
      waitForEvent(providerA, 'synced', ({ peerId }) => peerId === 'bob'),
      waitForEvent(providerB, 'synced', ({ peerId }) => peerId === 'alice')
    ])

    expect(docB.getText('shared').toString()).toBe('hello ')
    expect(providerA.connectedPeers).toEqual(['bob'])
    expect(providerB.connectedPeers).toEqual(['alice'])

    docB.getText('shared').insert(6, 'world')
    await wait(50)
    expect(docA.getText('shared').toString()).toBe('hello world')

    // --- Test 2: awareness propagation ---
    providerA.awareness.setLocalState({ user: { name: 'Alice' } })
    await wait(50)
    expect(providerB.awareness.getStates().get(docA.clientID)).toEqual({ user: { name: 'Alice' } })

    providerA.destroy()
    providerB.destroy()
  })

  it('disconnect() stops propagation on both sides', async () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const providerA = new PeerjsProvider(docA, { peerId: 'alice' })
    const providerB = new PeerjsProvider(docB, { peerId: 'bob' })
    await Promise.all([providerA.whenReady, providerB.whenReady])

    docA.getText('shared').insert(0, 'hello ')
    await providerA.connect('bob')
    await Promise.all([
      waitForEvent(providerA, 'synced', ({ peerId }) => peerId === 'bob'),
      waitForEvent(providerB, 'synced', ({ peerId }) => peerId === 'alice')
    ])

    providerA.disconnect('bob')
    await wait(20)
    expect(providerA.connectedPeers.length).toBe(0)
    expect(providerB.connectedPeers.length).toBe(0)

    docA.getText('shared').insert(0, 'X')
    await wait(50)
    expect(docB.getText('shared').toString().startsWith('X')).toBe(false)

    providerA.destroy()
    providerB.destroy()
  })

  it('reconnect() resyncs missed state', async () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const providerA = new PeerjsProvider(docA, { peerId: 'alice' })
    const providerB = new PeerjsProvider(docB, { peerId: 'bob' })
    await Promise.all([providerA.whenReady, providerB.whenReady])

    await providerA.connect('bob')
    await Promise.all([
      waitForEvent(providerA, 'synced', ({ peerId }) => peerId === 'bob'),
      waitForEvent(providerB, 'synced', ({ peerId }) => peerId === 'alice')
    ])

    providerA.disconnect('bob')
    docA.getText('shared').insert(0, 'missed-while-away ')
    await wait(50)

    await providerA.connect('bob')
    await Promise.all([
      waitForEvent(providerA, 'synced', ({ peerId }) => peerId === 'bob'),
      waitForEvent(providerB, 'synced', ({ peerId }) => peerId === 'alice')
    ])
    await wait(20)
    expect(docB.getText('shared').toString()).toBe(docA.getText('shared').toString())

    providerA.destroy()
    providerB.destroy()
  })

  it('third peer syncs full state through a single connect()', async () => {
    const docA = new Y.Doc()
    const docC = new Y.Doc()
    const providerA = new PeerjsProvider(docA, { peerId: 'alice' })
    const providerC = new PeerjsProvider(docC, { peerId: 'carol' })
    await Promise.all([providerA.whenReady, providerC.whenReady])

    docA.getText('shared').insert(0, 'hello ')
    await providerA.connect('carol')
    await waitForEvent(providerC, 'synced', ({ peerId }) => peerId === 'alice')
    expect(docC.getText('shared').toString()).toBe(docA.getText('shared').toString())

    providerA.destroy()
    providerC.destroy()
  })

  it('custom send()/message event works', async () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const providerA = new PeerjsProvider(docA, { peerId: 'alice' })
    const providerB = new PeerjsProvider(docB, { peerId: 'bob' })
    await Promise.all([providerA.whenReady, providerB.whenReady])

    await providerA.connect('bob')
    await waitForEvent(providerA, 'synced', ({ peerId }) => peerId === 'bob')

    const gotMessage = waitForEvent(providerB, 'message', ({ peerId }) => peerId === 'alice')
    providerA.send('bob', 'ping')
    const { data } = await gotMessage
    expect(new TextDecoder().decode(data)).toBe('ping')

    providerA.destroy()
    providerB.destroy()
  })

  it('star topology: hub relays between spokes without a direct connection', async () => {
    const docHub = new Y.Doc()
    const docSpoke1 = new Y.Doc()
    const docSpoke2 = new Y.Doc()
    const providerHub = new PeerjsProvider(docHub, { peerId: 'hub' })
    const providerSpoke1 = new PeerjsProvider(docSpoke1, { peerId: 'spoke1' })
    const providerSpoke2 = new PeerjsProvider(docSpoke2, { peerId: 'spoke2' })
    await Promise.all([providerHub.whenReady, providerSpoke1.whenReady, providerSpoke2.whenReady])

    const starSynced = Promise.all([
      waitForEvent(providerSpoke1, 'synced', ({ peerId }) => peerId === 'hub'),
      waitForEvent(providerSpoke2, 'synced', ({ peerId }) => peerId === 'hub')
    ])
    await Promise.all([
      providerSpoke1.connect('hub'),
      providerSpoke2.connect('hub')
    ])
    await starSynced
    expect(providerSpoke1.connectedPeers).toEqual(['hub'])
    expect(providerSpoke2.connectedPeers).toEqual(['hub'])

    // spoke1 types something — must reach spoke2 by relaying through hub.
    docSpoke1.getText('shared').insert(0, 'from-spoke1 ')
    await wait(100)
    expect(docHub.getText('shared').toString()).toBe('from-spoke1 ')
    expect(docSpoke2.getText('shared').toString()).toBe('from-spoke1 ')

    // spoke2 types something — must reach spoke1 the same way, through the hub.
    docSpoke2.getText('shared').insert(docSpoke2.getText('shared').length, 'from-spoke2')
    await wait(100)
    expect(docSpoke1.getText('shared').toString()).toBe('from-spoke1 from-spoke2')

    // awareness should propagate the same way through the hub.
    providerSpoke1.awareness.setLocalState({ user: { name: 'Spoke1' } })
    await wait(100)
    expect(providerSpoke2.awareness.getStates().get(docSpoke1.clientID)).toEqual({ user: { name: 'Spoke1' } })

    providerHub.destroy()
    providerSpoke1.destroy()
    providerSpoke2.destroy()
  })

  it('triangle topology: update reaches everyone without infinite relay loop', async () => {
    const docX = new Y.Doc()
    const docY = new Y.Doc()
    const docZ = new Y.Doc()
    const providerXX = new PeerjsProvider(docX, { peerId: 'x' })
    const providerYY = new PeerjsProvider(docY, { peerId: 'y' })
    const providerZZ = new PeerjsProvider(docZ, { peerId: 'z' })
    await Promise.all([providerXX.whenReady, providerYY.whenReady, providerZZ.whenReady])

    const cycleSynced = Promise.all([
      waitForEvent(providerXX, 'synced', ({ peerId }) => peerId === 'y'),
      waitForEvent(providerYY, 'synced', ({ peerId }) => peerId === 'z'),
      waitForEvent(providerZZ, 'synced', ({ peerId }) => peerId === 'x')
    ])
    await Promise.all([
      providerXX.connect('y'),
      providerYY.connect('z'),
      providerZZ.connect('x')
    ])
    await cycleSynced

    docX.getText('shared').insert(0, 'cycle-test')
    await wait(150) // generous margin — if this were looping, it would never settle
    expect(docY.getText('shared').toString()).toBe('cycle-test')
    expect(docZ.getText('shared').toString()).toBe('cycle-test')

    providerXX.destroy()
    providerYY.destroy()
    providerZZ.destroy()
  })

  it('destroy() tears down cleanly', async () => {
    const docA = new Y.Doc()
    const providerA = new PeerjsProvider(docA, { peerId: 'alice' })
    await providerA.whenReady

    providerA.destroy()
    expect(providerA.connectedPeers.length).toBe(0)
  })

  it('mesh protocol: indirect peers learned via announcements with correct via/path', async () => {
    // Chain: A -- B -- C. A and C are not directly connected, but each
    // should learn about the other through B's announcements.
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const docC = new Y.Doc()
    const providerA = new PeerjsProvider(docA, { peerId: 'chain-a' })
    const providerB = new PeerjsProvider(docB, { peerId: 'chain-b' })
    const providerC = new PeerjsProvider(docC, { peerId: 'chain-c' })
    await Promise.all([providerA.whenReady, providerB.whenReady, providerC.whenReady])

    await Promise.all([providerA.connect('chain-b'), providerC.connect('chain-b')])

    // Wait for mesh announcements to propagate (interval is 10s but each
    // peer announces immediately when its neighborhood changes).
    await wait(200)

    // A sees C as indirect, via B. `path` holds intermediates between the
    // next hop and the destination — none in a 2-hop chain.
    const aViewOfC = providerA.mesh.get('chain-c')
    expect(aViewOfC).toBeDefined()
    expect(aViewOfC!.via).toBe('chain-b')
    expect(aViewOfC!.path).toEqual([])
    // C sees A as indirect, via B.
    const cViewOfA = providerC.mesh.get('chain-a')
    expect(cViewOfA).toBeDefined()
    expect(cViewOfA!.via).toBe('chain-b')
    // B has no indirect peers — it's directly connected to both.
    expect(providerB.mesh.size).toBe(0)
    // neighborTables: B heard full tables from both A and C.
    expect(providerB.neighborTables.get('chain-a')?.has('chain-a')).toBe(true)
    expect(providerB.neighborTables.get('chain-c')?.has('chain-c')).toBe(true)

    // Dropping B-C means C vanishes from A's mesh (it was only reachable
    // through B) and B's table from C is discarded.
    providerC.disconnect('chain-b')
    await wait(50)
    expect(providerA.mesh.has('chain-c')).toBe(false)
    expect(providerB.neighborTables.has('chain-c')).toBe(false)

    providerA.destroy()
    providerB.destroy()
    providerC.destroy()
  })
})
