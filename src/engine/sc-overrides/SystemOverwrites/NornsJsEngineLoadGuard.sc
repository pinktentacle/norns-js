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
}
