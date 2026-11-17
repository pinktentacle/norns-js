// norns-js: Bus:getSynchronous, rebuilt on the async /c_get that works here.
//
// WHY: `Bus:getSynchronous` reads a control bus through scsynth's SHARED
// MEMORY interface. sclang and scsynth are two separate wasm modules with two
// separate heaps, so there is no shared memory to read and
// `Server:getControlBusValue` throws:
//
//     ERROR: Server-getControlBusValue only supports local servers
//
// E0-34 already replaced norns' POLL transport for the same reason
// (NornsJsPollOverride). This is the other call site, and it is not optional:
// `Engine_PolySub.sc:160` reads every one of its control buses with
// `getSynchronous` inside `alloc`, so the engine fails to load — and because
// `Engine.load` only clears `is_loading` when the load COMPLETES, the failure
// also jams every later load. One engine looks broken; the rest look refused.
//
// HOW: `alloc` runs inside a `fork` (CroneEngine.sc:25), so there is a Routine
// to wait in. The async `bus.get` this build already performs on every poll
// fills in the value and releases a Condition.
//
// OUTSIDE a Routine there is nothing honest to do: the answer cannot arrive
// before the method has to return. It warns and returns 0 rather than
// blocking the only thread there is, which would freeze the page.

+ Bus {

	getSynchronous {
		var cond, value = 0.0, done = false;

		if (thisThread.isKindOf(Routine).not) {
			"norns-js: Bus:getSynchronous outside a Routine cannot wait; returning 0".warn;
			^0.0;
		};

		cond = Condition.new;
		this.get({ arg val;
			value = val;
			done = true;
			cond.unhang;
		});

		// A bounded wait. A lost reply would otherwise hang the Routine for
		// ever, and an engine that never finishes allocating is
		// indistinguishable from one that is merely slow.
		fork {
			0.5.wait;
			if (done.not) {
				"norns-js: Bus:getSynchronous timed out on bus %".format(index).warn;
				cond.unhang;
			};
		};

		cond.hang;
		^value;
	}

	// The WRITE side has the same guard and none of the difficulty: a /c_set
	// is fire-and-forget, so there is nothing to wait for and no Routine is
	// needed. `Bus:setSynchronous` is reached from engine allocation just as
	// the read side is — Engine_PolySub sets every control bus to its default
	// right after reading it.
	setSynchronous { arg ... values;
		if (values.size == 1) {
			server.sendMsg('/c_set', index, values[0].asFloat);
		} {
			values.do { arg v, i; server.sendMsg('/c_set', index + i, v.asFloat) };
		};
	}

	setnSynchronous { arg values;
		values.do { arg v, i; server.sendMsg('/c_set', index + i, v.asFloat) };
	}

	getnSynchronous { arg count;
		var cond, values, done = false;
		count = count ? numChannels;
		values = Array.fill(count, 0.0);

		if (thisThread.isKindOf(Routine).not) {
			"norns-js: Bus:getnSynchronous outside a Routine cannot wait; returning zeros".warn;
			^values;
		};

		cond = Condition.new;
		this.getn(count, { arg vals;
			values = vals;
			done = true;
			cond.unhang;
		});

		fork {
			0.5.wait;
			if (done.not) {
				"norns-js: Bus:getnSynchronous timed out on bus %".format(index).warn;
				cond.unhang;
			};
		};

		cond.hang;
		^values;
	}
}
