// norns-js: File.exists, for the tree that is not in sclang's filesystem.
//
// WHAT THIS UNBLOCKS. sclang runs in its own emscripten filesystem, which
// holds the class library and nothing else. The dust tree lives in the
// PAGE's store — some of it written there, most of it declared and fetched
// on first use — so `File.exists("/home/we/dust/audio/…")` is false for
// every sound file this project ships, including the ones a script is
// looking at on screen.
//
// An engine that guards its buffer read with that question therefore loads
// nothing, and says nothing, because not-finding-a-file is not an error:
//
//     readBuf { arg i, path;
//         if (File.exists(path), {
//             numChannels = SoundFile.use(path.asString(), { |f| f.numChannels });
//             ...
//
// That is `Engine_Glut.sc:21`, and it is why glut and mangl draw "load
// samples via menu > parameters" for ever: pick a sample in PARAMS, press a
// grid key, and nothing happens at all. Measured in the page —
// `File.exists` on a path the manifest lists, and that the user can see in
// the file browser, answered false.
//
// WHY THE MANIFEST IS THE RIGHT ANSWER. The question is synchronous and the
// store is not: this is the three-state problem (resident / declared /
// absent) arriving in sclang instead of in Lua, and it gets the same answer
// it got there — a file that is DECLARED exists, because it does. The host
// already writes what it knows about every bundled sound file into
// `/sc/soundfiles.txt` for `SoundFile.openRead`; this reads the same table.
//
// WHAT IS NOT CLAIMED. Only sound files, and only the ones the build knows
// about. A `.pset` in the dust tree still reads as absent here, because
// nothing has told sclang about it — and the real filesystem is asked FIRST,
// so this can only ever turn a false into a true, never the other way.

+ File {

	// The primitive, under a name the override can still reach.
	//
	// A method's primitive is bound by the `_Name` in its body and not by
	// what the method is called, so this is the same `_FileExists` that
	// upstream's `*exists` runs. Without it the override below would have
	// no way left to ask the filesystem.
	*nornsJsExistsReal { arg pathName;
		_FileExists
		^this.primitiveFailed
	}

	*exists { arg pathName;
		if (File.nornsJsExistsReal(pathName)) { ^true };
		// NOT BEFORE `Library` EXISTS. `Quarks.initClass` calls this while
		// the class tree is still being initialised, and the manifest is
		// cached in `Library` — reaching for it there answers "Nil does not
		// understand the message 'at'" and takes the whole class library
		// down with it, which is a blank screen and no audio at all.
		// Measured, once, by shipping it without this line.
		//
		// Nothing in the dust tree is being asked about that early, so the
		// filesystem's own answer is the honest one.
		if (Library.global.isNil) { ^false };
		^SoundFile.nornsJsKnows(pathName)
	}
}
