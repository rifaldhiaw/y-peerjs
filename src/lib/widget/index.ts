export { createTopologyWidget, type TopologyWidget, type TopologyWidgetOptions, type TopologySnapshot } from './TopologyWidget.js'
// Backwards-compat re-export: TopologyTracker now lives in the package root
// ('y-peerjs'). Prefer importing it from there; this will be removed in 1.0.
export { TopologyTracker } from '../TopologyTracker.js'
export type { RemotePeerInfo, TopologyTrackerOptions } from '../TopologyTracker.js'
