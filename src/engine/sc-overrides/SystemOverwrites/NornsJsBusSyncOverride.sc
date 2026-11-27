// norns-js: Bus:getSynchronous, read where the server keeps the bus.
//
// WHY: `Bus:getSynchronous` reads a control bus through scsynth's SHARED
// MEMORY interface. sclang and scsynth are two separate wasm modules with two
// separate heaps, so there is no shm interface, and `Server:getControlBusValue`
// throws:
//
//     ERROR: Server-getControlBusValue only supports local servers
//
// `Engine_PolySub.sc:160` reads every one of its control buses with
// `getSynchronous` inside `alloc`, so without this the engine failed to load,
// and `Engine.load` only clears `is_loading` when the load COMPLETES, so the
// failure also jammed every later load.
//
// E9-271 — THE PAGE READS THE SERVER'S MEMORY. scsynth's heap is a
// SharedArrayBuffer the page holds, and the page lays the control buses out as
// a Float32Array over it; `_NornsJsControlBusGet` / `_NornsJsControlBusSet`
// (SC_WasmClient.cpp) read and write it from the language thread, now, the way
// the shm interface does on a norns. Command handlers are not Routines, and
// that is where engines read their buses — PolySub, FM7, MT7, orgn,
// turntable, R, dronecaster, the Glut family — and where this file used to
// warn and return 0. An engine that maps the bus right after (PolySub's
// `start`) was saved by the map reaching the server before the first block;
// one that does not kept the 0: PolySub's `solo` voice started at level 0
// (measured: peak 0.087 before, 1.114 with E9-271), orgn's release time read
// 0, turntable's position 0.
//
// THE OLD PATH STAYS as the fallback, for a page without the view (the node
// tests): inside a Routine the async /c_get, outside one a warning and 0.

+ Server {

	nornsJsBusGet { |busIndex, count = 1|
		_NornsJsControlBusGet
		^nil
	}

	nornsJsBusSet { |busIndex, values|
		_NornsJsControlBusSet
		^nil
	}

	getControlBusValue { |busIndex|
		var v = this.nornsJsBusGet(busIndex, 1);
		if (v.isNil) { Error("Server-getControlBusValue: norns-js could not read the server's buses").throw };
		^v[0]
	}

	getControlBusValues { |busIndex, busChannels|
		var v = this.nornsJsBusGet(busIndex, busChannels);
		if (v.isNil) { Error("Server-getControlBusValues: norns-js could not read the server's buses").throw };
		^v
	}

	setControlBusValue { |busIndex, value|
		if (this.nornsJsBusSet(busIndex, [value]).isNil) {
			this.sendMsg('/c_set', busIndex, value.asFloat)
		}
	}

	setControlBusValues { |busIndex, valueArray|
		if (this.nornsJsBusSet(busIndex, valueArray.asArray).isNil) {
			this.sendMsg('/c_setn', busIndex, valueArray.size, *valueArray.asArray.collect(_.asFloat))
		}
	}
}

+ Bus {

	getSynchronous {
		var cond, value = 0.0, done = false, direct;

		if (index.isNil) { Error("Cannot call % on a % that has been freed".format(thisMethod.name, this.class.name)).throw };
		if (this.isSettable.not) { Error("Bus-getSynchronous only works for control-rate busses").throw };

		direct = server.nornsJsBusGet(index, 1);
		if (direct.notNil) { ^direct[0] };

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

	// The WRITE side, into the server's buses as the shm interface does; a
	// /c_set when the page has no view. `Bus:setSynchronous` is reached from
	// engine allocation just as the read side is: Engine_PolySub sets every
	// control bus to its default right after reading it.
	setSynchronous { arg ... values;
		if (index.isNil) { Error("Cannot call % on a % that has been freed".format(thisMethod.name, this.class.name)).throw };
		if (server.nornsJsBusSet(index, values).notNil) { ^this };
		if (values.size == 1) {
			server.sendMsg('/c_set', index, values[0].asFloat);
		} {
			values.do { arg v, i; server.sendMsg('/c_set', index + i, v.asFloat) };
		};
	}

	setnSynchronous { arg values;
		if (index.isNil) { Error("Cannot call % on a % that has been freed".format(thisMethod.name, this.class.name)).throw };
		if (server.nornsJsBusSet(index, values.asArray).notNil) { ^this };
		values.do { arg v, i; server.sendMsg('/c_set', index + i, v.asFloat) };
	}

	getnSynchronous { arg count;
		var cond, values, done = false, direct;
		count = count ? numChannels;

		if (index.isNil) { Error("Cannot call % on a % that has been freed".format(thisMethod.name, this.class.name)).throw };

		direct = server.nornsJsBusGet(index, count);
		if (direct.notNil) { ^direct };

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
