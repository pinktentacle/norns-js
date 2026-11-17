// norns-js: `server.sync` returns.
//
// `NetAddr.makeSyncResponder` is
//
//     OSCFunc({ |msg| if (msg[1] == id) { ... } }, '/synced', this)
//
// and the third argument is `srcID: this` — only a `/synced` whose SOURCE
// ADDRESS is this NetAddr dispatches. In this build there is no source
// address: OSC reaches sclang through `sclang.sendOsc(bytes)` and
// `SC_WasmClient` hands it to `ProcessOSCPacket(packet, 57120, ...)` with no
// reply address attached. The filter never matches, the Condition is never
// signalled, and the Routine waits for ever.
//
// WHAT THAT LOOKS LIKE. `Engine_MGlut.sc:130` is `context.server.sync` after
// sending its SynthDefs — the careful thing to do, and what every engine
// that loads buffers or many defs does. With the filter in place `mangl`
// stops dead after `a CroneAudioContext`: no commands added, no polls, no
// error. An engine that THROWS is caught and reported by
// NornsJsEngineLoadGuard; one that waits is not, because there is nothing
// to catch. The script sits there and the log ends mid-sentence.
//
// THE FIX is to drop the source filter and keep the id. `UniqueID.next`
// gives a value no other sync is using, and there is exactly one server, so
// the id alone identifies the reply as precisely as the pair did.
//
// AND A DEADLINE, which upstream does not have — its own comment says
// "maybe needed: a timeout". Here it is needed: a `/synced` that is lost for
// any other reason would hang an engine load with no way out, and a late
// engine is better than a dead one. 2 s is far longer than the server takes
// and short enough that nobody watches a blank screen wondering.

+ NetAddr {

	makeSyncResponder { arg condition;
		var id = UniqueID.next;
		var done = false;
		var resp;
		resp = OSCFunc({ arg msg;
			if (msg[1] == id) {
				done = true;
				resp.free;
				condition.test = true;
				condition.signal;
			};
		}, '/synced'); // no srcID: see above
		condition.test = false;

		fork {
			2.0.wait;
			if (done.not) {
				"norns-js: server.sync timed out; continuing without it".warn;
				resp.free;
				condition.test = true;
				condition.signal;
			};
		};

		^id
	}
}
