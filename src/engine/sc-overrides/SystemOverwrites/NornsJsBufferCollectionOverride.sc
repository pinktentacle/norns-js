// norns-js: Buffer.loadCollection, over OSC instead of over a temp file.
//
// WHAT BREAKS WITHOUT IT. SuperCollider has two ways to put an array of
// floats into a server buffer and they are not equivalent here:
//
//   * `sendCollection` sets the samples with `/b_setn` messages. Pure OSC.
//   * `loadCollection` writes the array to a temporary SOUND FILE and then
//     `/b_allocRead`s it. Two filesystems and libsndfile.
//
// scsynth is built `-DNO_LIBSNDFILE` (see tools/sclang/build.sh), so the
// write fails at the first step with
//
//     ERROR: Primitive '_SFOpenWrite' failed with message : 'Failed.'.
//
// which is thrown out of `alloc`, caught by NornsJsEngineLoadGuard, and
// leaves the engine running with NO COMMANDS AT ALL -- `addCommand` is
// called further down the same method and never runs. The visible symptom is
// a script failing on its first `engine.something(...)`, a long way from the
// cause. `otis` is the measured case: `Engine_Decimator.alloc` builds a
// wavetable with `Env(...).asSignal(1025)` and loads it this way, and every
// one of Decimator's commands goes missing because of it.
//
// WHY THIS IS A FAITHFUL SUBSTITUTION, not a patch. The two methods exist
// for a performance reason, not a semantic one: a file is one round trip
// where `/b_setn` is many, so `loadCollection` wins for large arrays. They
// produce the SAME buffer. Routing one to the other costs a few milliseconds
// on arrays of the size engines actually use -- a wavetable is 1024 or 2048
// floats, around four `/b_setn` messages -- and is otherwise invisible.
//
// `loadToFloatArray` is the same story in reverse: it writes the buffer to a
// file and reads it back, where `getToFloatArray` streams it over OSC. UI
// code uses it to draw a waveform.
//
// NOT OVERRIDDEN: `write`, and `loadCollection`'s cousin on paths that a
// script passes a real filename to. Those are asking for a file on a
// filesystem scsynth can see, and there is not one; they fail as they did.

+ Buffer {

	*loadCollection { arg server, collection, numChannels = 1, action;
		^Buffer.sendCollection(server, collection, numChannels, 0.01, action);
	}

	loadCollection { arg collection, startFrame = 0, action;
		^this.sendCollection(collection, startFrame, 0.01, action);
	}

	// `wait` and `timeout` are getToFloatArray's own defaults. The buffer
	// comes back in /b_setn-sized pieces and the Routine reassembles them;
	// a timeout here means the server never answered, which is a real
	// failure rather than a slow one.
	loadToFloatArray { arg index = 0, count = -1, action;
		^this.getToFloatArray(index, count, 0.01, 10, action);
	}
}
