// norns-js: a SynthDef is on the server before the next line runs.
//
// `/d_recv` is an ASYNCHRONOUS scsynth command: it is handled on the
// non-real-time thread and completes some time later. `/s_new` is handled on
// the real-time thread, immediately. So this, which `Engine_Amen` does and
// which many engines do, is a race:
//
//     (0..4).do { |i| SynthDef("playerAmen" ++ i, { ... }).add };
//     playerAmen = Array.fill(4, { |i| Synth("playerAmen" ++ i, ...) });
//
// On hardware the race is won: `/d_recv` lands in microseconds and the
// `/s_new`s that follow find their defs. Here it is LOST, and not randomly —
// the first two defs arrive in time and the rest do not, every run:
//
//     *** ERROR: SynthDef playerAmen2 not found
//     FAILURE IN SERVER /s_new SynthDef not found
//
// which reads like a size limit or a dropped message and is neither. Sending
// the same defs again by hand afterwards makes `Synth("playerAmen2")` work,
// which is what pinned it down.
//
// WHERE THE ORDERING LIVES, after two attempts that did not hold:
//
//   `server.sync` here — correct in principle and it breaks the BOOT.
//   `CroneDefs` sends twelve defs before the server is notifying, every one
//   of them waits out its deadline, and norns passes the 12 s startup gate
//   with nothing loaded.
//
//   A `/d_recv` barrier in the transport that held everything behind it —
//   which held `/sync` too, and `/sync`'s whole purpose is to answer from
//   behind the queue. `server.sync` then waited on a reply to a message
//   that was waiting on it.
//
// So the barrier stayed and `/sync` is exempt from it. See
// `src/engine/host.ts`. What is left here is the other half: never the
// `/d_load` fallback.

+ SynthDef {

	// --- the UGen check -------------------------------------------------
	//
	// scsynth THROWS when a def names a UGen it does not have, and this
	// build has exceptions off, so the throw aborts the thread that handles
	// /d_recv -- and that thread never comes back. One bad def kills the
	// audio server for the rest of the session: nothing loads, no poll
	// reports, nothing sounds, while the audio thread keeps running and
	// /status keeps answering so it all looks fine.
	//
	// A script only has to ship its own class for a UGen that is not in
	// this build. pedalboard/lib/fx/third_party/SmoothFold.sc declares
	// SmoothFoldS; sclang resolves it, and the server dies on the def.
	// Compiling SmoothFold would fix that script and not the next one.
	//
	// HERE rather than in the transport, because here a SynthDef is still
	// an object: `ugen.name` is exactly the string the def file carries and
	// the server looks up, so the check is the same lookup, done earlier.
	// Refusing it in the OSC stream would mean re-encoding a bundle and
	// risking the /sync inside it.
	//
	// The list lives in Library, put there at boot from
	// public/norns-sc/ugens.json, which tools/build-ugen-list.mjs builds
	// from the same sources the binary was compiled from. No list means no
	// checking: a missing list must not become a reason to refuse every def.
	*nornsJsLoadUGens {
		var set = IdentitySet.new;
		var path = "/sc/ugens.txt";
		Library.put(\nornsJs, \ugensTried, true);
		if (File.exists(path).not) {
			"norns-js: no /sc/ugens.txt; SynthDefs will not be checked".postln;
			^nil
		};
		File.readAllString(path).split(Char.nl).do { arg line;
			var t = line.stripWhiteSpace;
			if (t.size > 0) { set.add(t.asSymbol) };
		};
		// A short list would refuse almost every def, which is worse than
		// the problem. SuperCollider's own plugins alone are 300-odd.
		if (set.size < 100) {
			("norns-js: /sc/ugens.txt has only " ++ set.size.asString
				++ " names; not checking SynthDefs").postln;
			^nil
		};
		Library.put(\nornsJs, \ugens, set);
		^set
	}

	nornsJsMissingUGens {
		var known = Library.at(\nornsJs, \ugens);
		var missing = IdentitySet.new;
		if (known.isNil and: { Library.at(\nornsJs, \ugensTried).isNil }) {
			known = SynthDef.nornsJsLoadUGens;
		};
		if (known.isNil) { ^nil };
		this.children.do { arg u;
			var n = u.name.asSymbol;
			if (known.includes(n).not) { missing.add(n) };
		};
		if (missing.size == 0) { ^nil };
		^missing.asArray
	}

	doSend { arg server, completionMsg;
		var missing = this.nornsJsMissingUGens;
		if (missing.notNil) {
			"".postln;
			("norns-js: NOT sending SynthDef " ++ name.asString ++ " -- it uses "
				++ missing.collect({ arg x; x.asString }).join(", ")
				++ ", which this build of scsynth does not have.").postln;
			("Sending it would abort the server and take every later SynthDef, "
				++ "poll and sound with it.").postln;
			^this
		};
		// Always `/d_recv`, never the `/d_load` fallback: that writes a file
		// and tells the server to read it, and scsynth is a separate wasm
		// module with its own MEMFS, so the path does not exist there and
		// the failure is silent. Our channel is not UDP and has no size
		// limit — sclang's OSC goes straight into `scsynth.sendOsc` in the
		// same process.
		server.sendMsg("/d_recv", this.asBytes, completionMsg);
	}

	// E9-215 — `load` is the same hole by its front door. Upstream writes
	// the def file and sends `/d_load` with its path, which scsynth cannot
	// open, and says nothing: dronecaster built all thirty-seven drones,
	// and the first `Synth` answered "SynthDef Apparatus not found".
	// sampswap loads its defs the same way. The file is still written, as
	// upstream does, and the def goes the way every other one goes.
	load { arg server, completionMsg, dir(synthDefDir);
		server = server ? Server.default;
		if(metadata.trueAt(\shouldNotSend)) {
			this.loadReconstructed(server, completionMsg);
		} {
			dir = dir ? synthDefDir;
			this.writeDefFile(dir);
			this.doSend(server, completionMsg);
		};
	}
}
