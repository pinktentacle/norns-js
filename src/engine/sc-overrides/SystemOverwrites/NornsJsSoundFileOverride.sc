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
// WHAT IS NOT PROVIDED. `writeData`, `openWrite` and the rest still do
// nothing. `seek` and `readData` are served since E9-251, inside a Routine
// (see below); the samples otherwise reach the server through `Buffer.read`.
//
// A FILE THE MANIFEST HAS NEVER HEARD OF returns nil, which is exactly what
// libsndfile does for a file that is not there. A script that loads a sample
// the user added after the build gets "Could not open file", and that is an
// honest answer to give until E6-08 can rebuild the manifest at run time.

+ SoundFile {

	*nornsJsTable {
		var table = Library.at(\nornsJs, \soundFiles);
		var path = "/sc/soundfiles.txt";
		// E9-234 — THE TABLE MOVES DURING A SESSION. A WAV written after boot
		// (rpmate records into /dev/shm and has its engine read the file
		// back; a sample a script downloads) was "Could not open file" for
		// the rest of the session. The host bumps this generation each time
		// it rewrites the table, and a cached table from an older one is
		// read again. A short file, read per lookup: lookups are per sample
		// load, not per block.
		var genPath = "/sc/soundfiles.gen";
		var gen = if (File.nornsJsExistsReal(genPath)) { File.readAllString(genPath) } { nil };
		if (table.notNil and: { gen == Library.at(\nornsJs, \soundFilesGen) }) { ^table };
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
		Library.put(\nornsJs, \soundFilesGen, gen);
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
	//
	// E9-220 — AND `..` IS FOLLOWED, and the staged class library is read as
	// the dust tree. A script's class is compiled from
	// `/sc/SCClassLibrary/dust/<script>/...`, so an engine that finds its
	// samples beside itself (`filenameSymbol.pathOnly ++ "../waves/"`) asks
	// about that path; the table, like the device, knows them under
	// `/home/we/dust/code`. See src/engine/dust-path.ts.
	*nornsJsTidy { arg pathName;
		var parts = List.new;
		pathName.asString.split($/).do { arg p;
			case
			{ p.isEmpty or: { p == "." } } { }
			{ p == ".." } { if (parts.notEmpty) { parts.pop } }
			{ parts.add(p) };
		};
		if (parts.size >= 3 and: { parts[0] == "sc" and: { parts[1] == "SCClassLibrary" and: { parts[2] == "dust" } } }) {
			parts = List["home", "we", "dust", "code"] ++ parts.copyToEnd(3);
		};
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
		// E9-251: the read position, in frames, where libsndfile keeps its
		// FILE*. Non-nil is also what `isOpen` asks, as on hardware.
		fileptr = 0;
		^true
	}

	// E9-251 — SEEK AND READDATA, WITH THE SAMPLES.
	//
	// grains reads a file's samples to draw its waveform before playing it,
	// and gave the whole load up when `readData` failed: no voice ever
	// started. twins does the same, timber for its waveform. The page decodes
	// the file at its own rate into sclang's filesystem (sound-data.ts) and
	// `readData` reads it there with `File:readLE`, at C speed.
	//
	// THE PAGE IS ASKED ONCE PER OPEN FILE, and only a Routine can wait for
	// it — grains and twins read in one. Outside a Routine nothing can wait,
	// and `readData` fails as it always did here.
	seek { arg offset = 0, origin = 0;
		var pos;
		if (fileptr.isNil) { Error("SoundFile:seek - the file is not open").throw };
		pos = switch (origin.asInteger)
			{ 1 } { fileptr + offset }
			{ 2 } { numFrames + offset }
			{ offset };
		fileptr = pos.asInteger.clip(0, numFrames);
	}

	readData { arg rawArray;
		var raw, f, pos;
		if (fileptr.isNil) { Error("SoundFile:readData - the file is not open").throw };
		raw = this.nornsJsSamples;
		if (raw.isNil) {
			Error("SoundFile:readData - norns-js could not read the samples of " ++ path).throw
		};
		pos = fileptr;
		f = File(raw, "rb");
		f.seek(pos * numChannels * 4, 0);
		f.readLE(rawArray);
		f.close;
		fileptr = (pos + (rawArray.size div: numChannels.max(1))).min(numFrames);
		^true
	}

	nornsJsRaw { ^"/tmp/norns-js-sf/" ++ this.identityHash.abs.asString ++ ".f32" }

	nornsJsSamples {
		var raw = this.nornsJsRaw, key = raw.asSymbol, have, cond;
		have = Library.at(\nornsJs, \sfRaw, key);
		if (have.notNil) { ^if (have > 0) { raw } { nil } };
		if (thisThread.isKindOf(Routine).not) { ^nil };
		SoundFile.nornsJsListen;
		cond = Condition(false);
		Library.put(\nornsJs, \sfWait, key, cond);
		Server.default.addr.nornsJsSendMsgDirect('/norns-js/soundfile/data', path.asString, raw);
		// A deadline, so a page that never answers cannot hang the script.
		fork { 10.wait; if (cond.test.not) { cond.test = true; cond.signal } };
		cond.wait;
		Library.put(\nornsJs, \sfWait, key, nil);
		have = Library.at(\nornsJs, \sfRaw, key);
		if (have.isNil) { Library.put(\nornsJs, \sfRaw, key, 0); ^nil };
		^if (have > 0) { raw } { nil }
	}

	*nornsJsListen {
		if (Library.at(\nornsJs, \sfListening) == true) { ^this };
		Library.put(\nornsJs, \sfListening, true);
		OSCdef(\nornsJsSoundFileReady, { arg msg;
			var key = msg[1].asSymbol, cond = Library.at(\nornsJs, \sfWait, key);
			Library.put(\nornsJs, \sfRaw, key, msg[2]);
			if (cond.notNil) { cond.test = true; cond.signal };
		}, '/norns-js/soundfile/ready');
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
	close {
		var key = this.nornsJsRaw.asSymbol;
		// E9-251: the samples go with the file.
		if (Library.at(\nornsJs, \sfRaw, key).notNil) {
			Library.put(\nornsJs, \sfRaw, key, nil);
			Server.default.addr.nornsJsSendMsgDirect('/norns-js/soundfile/close', this.nornsJsRaw);
		};
		fileptr = nil;
		^true
	}
}
