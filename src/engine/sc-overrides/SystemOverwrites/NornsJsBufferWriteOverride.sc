// norns-js: a /b_write never reaches scsynth, because it kills it.
//
// E9-218. Reported from a Pixel as "no sound in hachi", and hachi was not
// the cause: the server had died two scripts earlier, when dronecaster's
// K2 started a recording. From then on every SynthDef went unacknowledged
// ("the server has stopped completing /d_recv"), so the next script
// loaded, drew, and made no sound at all.
//
// THE BUG IS IN scsynth. This build is `-DNO_LIBSNDFILE`, and there
// `BufWriteCmd::Init` sends "scsynth compiled without libsndfile" and then
// `return false` — from a function whose zero means SUCCESS. The command
// is queued as if valid, and its destructor frees `mFilename`, which that
// early return never set: an uninitialised pointer handed to the real-time
// allocator. Every other buffer command allocates its filename before it
// bails out; `/b_write` alone does not.
//
// MEASURED IN THE PAGE, with the drone playing: a `/b_alloc` carrying a
// `/b_write` as its completion — exactly what `Recorder` sends — and the
// drone went silent and `/sync` stopped being answered, every time. A bare
// `/b_write` survived the one time it was sent alone; an uninitialised
// pointer is whatever the memory held, so that is luck, not safety, and
// both are stopped.
//
// WHO SENDS ONE. `Buffer.write` (grains and twins save buffers with it),
// and `Recorder`, which puts a `/b_write` inside its `/b_alloc` as the
// completion message (dronecaster's record key, and any script that
// records through `s.record`). Both build it with `writeMsg`, so that is
// where it is stopped. `loadToFloatArray` wrote one too, and already goes
// by `/b_getn` instead: see NornsJsBufferCollectionOverride.sc.
//
// WHAT HAPPENS INSTEAD. The write is refused and SAID: no file appears, as
// none could, and the server lives. `writeMsg` answers a `/b_query`, which
// is harmless wherever it lands — sent on its own, or carried inside a
// `/b_alloc` — and whose reply only refreshes what the client already
// knows of the buffer.
//
// E9-268 — AND NOW THE SERVER WRITES IT ITSELF. scsynth is built with
// libsndfile (tools/sclang/build-sndfile.sh), so `/b_write` is the real
// command again: Buffer.write, Recorder (whose `/b_alloc` carries a
// `/b_write` left open for DiskOut) and DiskOut. The page carries the file
// out of the server's filesystem into its own when the server says it is
// done (src/engine/sound-writes.ts).
//
// THE REFUSAL STAYS FOR A SERVER WITHOUT IT, which still dies on the
// command. Which one is running is read from its UGen list: DiskOut is
// compiled exactly when libsndfile is (server/plugins/CMakeLists.txt), so a
// server that has DiskOut writes.

+ Buffer {

	writeMsg { arg path, headerFormat = "aiff", sampleFormat = "int24", numFrames = -1,
		startFrame = 0, leaveOpen = false, completionMessage;
		if(bufnum.isNil) { Error("Cannot write a % that has been freed".format(this.class.name)).throw };
		if (Buffer.nornsJsServerWrites) {
			// upstream's message, unchanged
			^["/b_write", bufnum, path,
				headerFormat, sampleFormat, numFrames.asInteger, startFrame.asInteger,
				leaveOpen.binaryValue, completionMessage.value(this)];
		};
		("norns-js: NOT writing buffer " ++ bufnum ++ " to " ++ path
			++ " -- this scsynth cannot write sound files, and asking it to would stop the server.").postln;
		^["/b_query", bufnum]
	}

	*nornsJsServerWrites {
		var known = Library.at(\nornsJs, \ugens);
		if (known.isNil and: { Library.at(\nornsJs, \ugensTried).isNil }) {
			known = SynthDef.nornsJsLoadUGens;
		};
		^known.notNil and: { known.includes(\DiskOut) }
	}

}
