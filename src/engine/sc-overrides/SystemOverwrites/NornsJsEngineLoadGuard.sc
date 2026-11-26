// norns-js: an engine whose `alloc` throws must SAY SO, not hang.
//
// WHAT HAPPENS WITHOUT THIS, on hardware as well as here. `CroneEngine.sc:25`
// is:
//
//     fork {
//         this.alloc;
//         doneCallback.value(this);
//     };
//
// No protection. If `alloc` throws — a missing UGen, a bad SynthDef, a server
// that went away — the Routine dies at the throw and `doneCallback` is never
// reached. Nothing sends `/report/did_engine_load`, so matron's
// `Engine.is_loading` is never cleared, and `oracle.cc:118`'s gate stays
// shut. The script sits on "loading..." for ever.
//
// That is what `amen` does today: `Engine_Amen.sc:109` calls `Decimator.ar`,
// an sc3-plugins UGen this scsynth build does not have, the SynthDef build
// throws, and the screen freezes with the real error buried a hundred lines
// up the log. The frozen screen is worse than the missing UGen: one is a
// known gap, the other looks like the whole port is broken.
//
// THIS IS A DELIBERATE DIVERGENCE FROM UPSTREAM, and the only one in the
// engine path. It is worth it because the upstream behaviour is not a
// behaviour anyone chose — nobody decided that a failing engine should hang
// norns; it falls out of an unprotected `fork`. What replaces it:
//
//   1. the error is posted where it happened, with the engine's name;
//   2. `doneCallback` runs anyway, so the gate clears and norns keeps going.
//
// (2) is the part to be careful about. It tells norns the engine loaded when
// it did not, and the script's own `init` will then send commands to an
// engine that is missing some or all of its synths. Those produce errors of
// their own — which are visible, and visible is the whole point. The
// alternative is a screen that never changes and a log nobody scrolls back
// through.

+ CroneEngine {

	init { arg argContext, doneCallback;
		commands = List.new;
		commandNames = Dictionary.new;
		pollNames = Set.new;
		context = argContext;
		context.postln;
		fork {
			// `try`, NOT `protect`. Both take the same shape and only one of
			// them is right here: `protect` runs its handler and then
			// RE-RAISES, so the Routine would still die at the throw and
			// `doneCallback` would still never run — the hang would survive
			// the fix and look fixed. `try` catches.
			try {
				this.alloc;
			} { arg error;
				if (error.notNil) {
					"".postln;
					"────────────────────────────────────────────────".postln;
					("norns-js: engine " ++ this.class.name.asString
						++ " failed to allocate").postln;
					error.errorString.postln;
					("the script will run WITHOUT a working engine. "
						++ "the error above is the reason.").postln;
					"────────────────────────────────────────────────".postln;
				};
			};
			// Unconditional, and that is the point: the callback is what
			// clears `Engine.is_loading`. Skipping it on failure is exactly
			// upstream's hang.
			doneCallback.value(this);
		};
	}

	// The other half. `Crone.setEngine` frees the old engine before loading
	// the new one, and waits on `deinit`'s callback (`Crone.sc:108`). An
	// engine whose `alloc` failed half-way has nils where its synths should
	// be, so its `free` throws — carter's delay: `cutoffLFOs[i]` is nil — the
	// routine dies before the callback, and EVERY engine loaded after it
	// hangs, in other scripts too. Same divergence as above, same reason:
	// `free` is tried, the error is posted, the callback runs.
	//
	// And ONCE. `Crone.sc` frees the engine from two routines: `/engine/free`
	// (sent by `Script.clear`) and `setEngine` (the next script's engine).
	// Each checks `engine.notNil`, then waits on `deinit` before setting it
	// to nil — so the second arrives while the first is still in
	// `server.sync`, and the same `free` runs twice: "Cannot call free on a
	// Buffer that has been freed", buses freed twice, and an engine whose
	// `free` is not written for it may throw. The second call does not free:
	// it waits for the first to finish and answers then, so the two routines
	// still resume in upstream's order (the first sets `engine = nil` before
	// the second loads the next engine). Answered at once instead, the first
	// could set nil AFTER the next engine had arrived, and lose it.
	deinit { arg doneCallback;
		var waiting = Library.at(\nornsJs, \engineFree, this);
		if (waiting.notNil) {
			if (waiting == \done) { doneCallback.value(this) } { waiting.add(doneCallback) };
			^this
		};
		waiting = List.new;
		Library.put(\nornsJs, \engineFree, this, waiting);
		postln("CroneEngine.free");
		commands.do({ arg com;
			com.oscdef.free;
		});
		pollNames.do({ arg name;
			CronePollRegistry.remove(name);
		});
		try {
			this.free;
		} { arg error;
			if (error.notNil) {
				("norns-js: engine " ++ this.class.name.asString
					++ " failed to free: " ++ error.errorString).postln;
			};
		};
		Crone.server.sync;
		// E9-256 — a `free` that was `Server.freeAll`: the next engine
		// waits for crone's context to be built again (at most 5 s).
		50.do {
			if (Library.at(\nornsJs, \contextRebuild) == true) { 0.1.wait };
		};
		// E9-258 — and the context whole at all, whatever took a part of it.
		if (Crone.context.notNil) { Crone.context.nornsJsEnsure };
		Library.put(\nornsJs, \engineFree, this, \done);
		doneCallback.value(this);
		waiting.do({ arg cb; cb.value(this) });
	}
}
