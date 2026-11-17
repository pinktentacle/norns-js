// norns-js: SoundFile.openRead, from a manifest instead of from libsndfile.
//
// WHAT THIS UNBLOCKS, and it is not a small thing. `SoundFile` is how a
// SuperCollider engine asks a file how long it is before deciding what to do
// with it, and sclang's `SoundFile` is a libsndfile primitive. This build is
// `-DNO_LIBSNDFILE`, so `openRead` returns nil — and an engine that asks
// politely gets a polite no:
//
//     file = SoundFile.openRead(filePath);
//     if (file.isNil, { this.loadFailed(sampleId, "Could not open file") })
//
// That is `Engine_Timber.sc:540`, and it is why timber and takt load without
// error and then make no sound at all. Nothing is broken downstream; the
// sample simply never has a length, so nothing is ever played.
//
// WHY A MANIFEST. The answer has to be SYNCHRONOUS: `openRead` returns a
// file or nil, immediately, and an engine's `alloc` is not a Routine. Our
// other file seam — `Buffer.read` over `/norns-js/buffer/read` — is a round
// trip through the host and cannot be made to answer in place. So the
// metadata goes the other way: the host writes what it already knows about
// every bundled sound file into sclang's own filesystem at boot, and this
// reads it there. `tools/build-dust.mjs` has the channels, frames and rate
// for every audio asset already, because the page needs them too.
//
// WHAT IS NOT PROVIDED. `readData`, `writeData`, `openWrite` and the rest
// still do nothing: those want the samples, not the header, and the samples
// reach the server through `Buffer.read`. An engine that reads sample data
// in sclang — rare, because it is slow on hardware too — is not served.
//
// A FILE THE MANIFEST HAS NEVER HEARD OF returns nil, which is exactly what
// libsndfile does for a file that is not there. A script that loads a sample
// the user added after the build gets "Could not open file", and that is an
// honest answer to give until E6-08 can rebuild the manifest at run time.

+ SoundFile {

	*nornsJsTable {
		var table = Library.at(\nornsJs, \soundFiles);
		var path = "/sc/soundfiles.txt";
		if (table.notNil) { ^table };
		// NO LATCH ON ABSENCE, and `nornsJsExistsReal` rather than `exists`.
		//
		// The manifest is written into sclang's filesystem by the host
		// during boot, and questions arrive before that. A cached "there is
		// no manifest" from one early call would outlive the file arriving
		// and leave every sound file unknown for the rest of the session.
		// And the real primitive, because `File.exists` now ASKS THIS TABLE
		// when the filesystem says no — calling it here would recurse until
		// the stack ran out.
		if (File.nornsJsExistsReal(path).not) { ^nil };
		table = IdentityDictionary.new;
		File.readAllString(path).split(Char.nl).do { arg line;
			// path TAB frames TAB channels TAB rate
			var f = line.split(Char.tab);
			if (f.size >= 4) {
				table.put(f[0].asSymbol, [f[1].asInteger, f[2].asInteger, f[3].asInteger]);
			};
		};
		Library.put(\nornsJs, \soundFiles, table);
		^table
	}

	// A path as a filesystem would see it, not as a script spelled it.
	//
	// The table is an exact-match lookup, and a script builds paths by
	// concatenation: `_path.code` already ends in a slash, so
	// `_path.code ++ "/timber/audio/piano-c.wav"` carries a DOUBLE slash.
	// Every real filesystem collapses that and this did not, so
	// `timber/keys.lua` -- which loads its own demo piano on the first run
	// and is playable the moment it opens on hardware -- arrived silent,
	// with "Could not open file" and nothing to say why.
	*nornsJsTidy { arg pathName;
		var parts = pathName.asString.split($/).reject({ arg p; p.isEmpty or: { p == "." } });
		^("/" ++ parts.join("/"))
	}

	// What the manifest knows about one path, or nil.
	*nornsJsInfo { arg pathName;
		var table = SoundFile.nornsJsTable;
		if (table.isNil) { ^nil };
		^table.at(SoundFile.nornsJsTidy(pathName).asSymbol)
	}

	// For `File.exists`, which has the same question and wants a boolean.
	*nornsJsKnows { arg pathName;
		^SoundFile.nornsJsInfo(pathName).notNil
	}

	*openRead { arg pathName;
		var file = SoundFile.new;
		if (file.openRead(pathName)) { ^file } { ^nil }
	}

	// `SoundFile.use` DOES NOT GO THROUGH `*openRead`.
	//
	// Upstream's `*use` is `var file = this.new; file.openRead(path); ...`
	// — the INSTANCE method, which is the libsndfile primitive this build
	// does not have. Overriding only the class method left `use` failing
	// with `_SFOpenRead failed`, and `Engine_Glut.sc:27` asks for its
	// channel count exactly that way, inside the `File.exists` guard above
	// it. So glut and mangl loaded no sample at all, drew their "load
	// samples via menu > parameters" screen for ever, and said nothing —
	// the engine was fine, the sample simply never arrived.
	//
	// `*openRead` now goes through here too, so there is one implementation
	// and not two that can drift.
	openRead { arg pathName;
		var info = SoundFile.nornsJsInfo(pathName);
		if (info.isNil) { ^false };
		path = pathName.asString;
		this.nornsJsSetInfo(info[0], info[1], info[2]);
		^true
	}

	// `numFrames`, `numChannels` and `sampleRate` are filled by the primitive
	// on hardware and have no setters. This is that fill, by another route.
	nornsJsSetInfo { arg frames, channels, rate;
		numFrames = frames;
		numChannels = channels;
		sampleRate = rate;
		headerFormat = "WAV";
		sampleFormat = "float";
	}

	// Nothing was opened, so nothing has to be closed -- and an engine that
	// closes a file it got from here must not see an error for doing the
	// right thing.
	close { ^true }
}
