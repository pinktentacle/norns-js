// norns-js: OSC that a script sends to MATRON must not land on the server.
//
// THE PROBLEM. sclang-wasm removed the concept of an address and a port, so
// everything sclang sends leaves through one callback. ADR-04c owns the
// demultiplexer and splits on the ADDRESS, with a small closed set going to
// matron and everything else to scsynth — which is safe as long as the only
// two destinations are matron and the server.
//
// They are not. A script's engine can send OSC to the SCRIPT, and norns'
// scripts do: matron listens on port **10111** (`matron/src/args.cc:21`,
// `remote_port`), and `_norns.osc.event` hands what arrives there to Lua.
// `Engine_Amen.sc:133` is
//
//     NetAddr("127.0.0.1", 10111).sendMsg("poscheck", 1, msg[3]);
//
// With the port gone, that arrives at the router as the bare address
// `poscheck`, which is not in the matron set, so it goes to the server and
// comes back as `FAILURE IN SERVER: poscheck Command not found` — once per
// message, for ever, while the script waits for a reply that is being sent
// to the wrong process.
//
// THE FIX. Keep the port by putting it in the address. A message to any port
// that is not the server's is wrapped as
//
//     /norns-js/osc <port> <original address> <original args...>
//
// which the router sends to matron because of the `/norns-js/` prefix, and
// which JS unwraps into `_norns.osc.event(path, args, from)` — the same
// shape norns' own OSC-in has.
//
// WHY NOT INVERT THE ROUTER'S RULE instead, and send anything that is not a
// known scsynth command to matron: because the server's command set would
// then have to be enumerated here and kept in step with scsynth, and a
// command this port had not heard of would be silently diverted away from
// the server rather than loudly ignored by it. ADR-04c chose the closed set
// in the safe direction; this keeps it closed and adds one explicit prefix.

+ NetAddr {

	// The primitive, under a name of its own, because an extension REPLACES
	// a method and there is no `super` to fall back to for the same class.
	// Same body as `NetAddr.sendMsg`; a primitive reads the receiver and the
	// args off the stack and does not care what the method is called.
	nornsJsSendMsgDirect { arg ... args;
		_NetAddr_SendMsg
		^this.primitiveFailed
	}

	// The ports that are already a channel of their own and must pass
	// through untouched:
	//
	//   57110  the server
	//   57120  what sclang-wasm mocks itself as
	//    8888  matron's OSC in, which is where `Crone.remoteAddr` points —
	//          `/crone/ready` and every `/report/*` go here, and the router
	//          already sends them to matron by address
	//    9999  crone's own port on hardware
	//
	// Wrapping 8888 was this override's first bug: `/crone/ready` became
	// `/norns-js/osc 8888 /crone/ready`, the boot gate never fired, and
	// norns timed out after 12 s with sclang visibly printing the message
	// it had just sent.
	*nornsJsInternalPort { arg p;
		^#[57110, 57120, 8888, 9999].includes(p)
	}

	sendMsg { arg ... args;
		if (port.notNil and: { NetAddr.nornsJsInternalPort(port).not }) {
			^this.nornsJsSendMsgDirect('/norns-js/osc', port, *args);
		};
		^this.nornsJsSendMsgDirect(*args);
	}

	nornsJsSendBundleDirect { arg time ... args;
		_NetAddr_SendBundle
		^this.primitiveFailed
	}

	sendBundle { arg time ... args;
		if (port.notNil and: { NetAddr.nornsJsInternalPort(port).not }) {
			// A bundle to a script is time-stamped for a clock this build
			// does not share. Flattening it to messages loses the timing and
			// keeps the content, which is the better half to keep: nothing
			// in norns' own OSC path schedules bundles to 10111.
			args.do { arg msg; this.sendMsg(*msg) };
			^this;
		};
		^this.nornsJsSendBundleDirect(time, *args);
	}
}
