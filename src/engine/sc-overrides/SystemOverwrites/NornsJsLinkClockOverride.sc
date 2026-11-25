// norns-js: `LinkClock` runs as a plain TempoClock.
//
// LinkClock is SuperCollider's Ableton Link clock. Its methods are Link
// primitives (`_LinkClock_New`, `_LinkClock_SetBeats`, ...) that exist only in
// an sclang built with SC_ABLETON_LINK. Ours is not — Link needs sockets and
// threads a browser does not give — so the class compiles and every one of
// those methods fails with "Primitive '__none' failed".
//
// WHAT THAT BROKE. `Engine_CartersDelay.sc:18` is
//
//     timer = LinkClock.new(2).latency_(s.latency).quantum_(0);
//
// `alloc` died on its first line, the engine came up without synths, and its
// `free` then threw on the nil it had left behind (see NornsJsEngineLoadGuard).
//
// WHAT REPLACES IT. On a norns with no other Link peer on the network — the
// usual case — a LinkClock IS a TempoClock: same tempo, same beats, same
// scheduling; Link only adds the session it never finds. So the Link
// primitives are swapped for TempoClock's own, `numPeers` answers 0, and
// `latency` / `quantum` keep the value they were given. Latency shifts Link's
// beat/time mapping to line up with other peers; with none, there is nothing
// to line up with, and the value is only stored.

+ LinkClock {

	numPeers { ^0 }

	beats_ { |beats|
		_TempoClock_SetBeats
		^this.primitiveFailed
	}

	setTempoAtBeat { |newTempo, beats|
		_TempoClock_SetTempoAtBeat
		^this.primitiveFailed
	}

	setTempoAtSec { |newTempo, secs|
		_TempoClock_SetTempoAtTime
		^this.primitiveFailed
	}

	latency { ^Library.at(\nornsJs, \linkLatency, this) ? 0.0 }

	latency_ { |lat|
		Library.put(\nornsJs, \linkLatency, this, lat.asFloat);
	}

	// Link's quantum starts at the clock's beatsPerBar (SC_LinkClock.cpp:19).
	quantum { ^Library.at(\nornsJs, \linkQuantum, this) ? this.beatsPerBar }

	quantum_ { |quantum|
		Library.put(\nornsJs, \linkQuantum, this, quantum.asFloat);
	}

	prStart { |tempo, beats, seconds|
		_TempoClock_New
		^this.primitiveFailed
	}
}
