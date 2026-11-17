// norns-js: refuse the shared-memory interface rather than fake one.
//
// WHY: Server:connectSharedMemory (Server.sc:841) assigns
// ServerShmInterface(id). In sclang-wasm that returns an INTEGER, not an
// object. Nothing notices, because hasShmInterface is `serverInterface.notNil`
// and an Integer is not nil - so every shared-memory check answers a false
// `true`, takes the shared-memory branch, and dies as
//
//     ERROR: Integer does not understand the message 'getControlBusValue'
//
// deep inside SuperCollider, naming neither wasm nor shared memory. A clean
// nil would have produced SC's own accurate error instead.
//
// There is nothing to repair: sclang and scsynth are separate wasm modules
// with separate heaps, so there is no shared region to map at all. nil is the
// honest state. Upstream bug, backlog E0-33.
//
// This is INDEPENDENT of the poll transport - after NornsJsPollOverride.sc the
// polls call none of this. It is here so that other code branching on
// hasShmInterface (engines, scripts, Server:disconnectSharedMemory itself)
// takes the correct branch and fails at its own boundary when it must.
+ Server {
	connectSharedMemory {
		// deliberately empty: leaves serverInterface nil
	}
}
