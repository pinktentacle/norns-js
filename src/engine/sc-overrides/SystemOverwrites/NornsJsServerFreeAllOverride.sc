// norns-js (E9-256): an engine that frees EVERY node takes crone's audio
// context with it, and every engine after it plays into nothing.
//
// lemniscate's `Engine_Lemnisc8.free` is `context.server.freeAll`. That is
// `/g_freeAll 0`: it frees group 1, and crone's input, process and output
// groups live in group 1 (`CroneAudioContext.sc:35`), with the input and
// analysis synths in them. `initTree` brings group 1 back and nothing brings
// those back: the next engine's `Synth(..., context.xg)` fails with "Group
// 1001 not found", and the input polls stop. On a norns as well, until
// SYSTEM > RESTART. Measured in the looper+fx sweep: leslie, manifold and
// massif silent after lemniscate in the same session.
//
// A DIVERGENCE, like the engine guard's, for the same reason: nobody chose
// "one script's cleanup silences every other script". The context is built
// again the way `CroneAudioContext.init` builds it, same buses, once the
// tree is back; `CroneEngine.deinit` (NornsJsEngineLoadGuard.sc) waits for
// it, so the next engine allocates into live groups.

+ Server {
	freeAll {
		var rebuild = (this === Crone.server) and: { Crone.context.notNil };
		if (rebuild) { Library.put(\nornsJs, \contextRebuild, true) };
		this.sendMsg("/g_freeAll", 0);
		this.sendMsg("/clearSched");
		this.initTree;
		if (rebuild) {
			// After `initTree`'s own fork on the same clock: its `/g_new 1`
			// is sent before this `sync`, so group 1 is there when it returns.
			fork({
				this.sync;
				Crone.context.nornsJsRebuild;
				postln("norns-js: Server.freeAll took crone's audio context with it; rebuilt");
				Library.put(\nornsJs, \contextRebuild, nil);
			}, AppClock);
		};
	}
}

+ CroneAudioContext {
	// `init`'s groups and synths (CroneAudioContext.sc:35-100), into the
	// buses it already has.
	nornsJsRebuild {
		ig = Group.new(server);
		xg = Group.after(ig);
		og = Group.after(xg);
		in_s = Array.fill(2, { |i|
			Synth.new(\adc, [\in, i, \out, in_b[i].index], ig);
		});
		amp_in_s = Array.fill(2, { |i|
			Synth.new(\amp_env, [\in, in_b[i].index, \out, amp_in_b[i].index], ig, \addAfter);
		});
		amp_out_s = Array.fill(2, { |i|
			Synth.new(\amp_env, [\in, i, \out, amp_out_b[i].index], og, \addAfter);
		});
		pitch_in_s = Array.fill(2, { |i|
			Synth.new(\pitch, [\in, in_b[i].index, \out, pitch_in_b[i].index], ig, \addAfter);
		});
	}

	// E9-258 — AND WHEN ONLY PART OF IT WENT. Measured in the looper+fx
	// sweep (batch 4): groups 1000-1002 still there, the adc, amp_env and
	// pitch synths gone, after sway's NodeProxies hit "duplicate node ID".
	// The trigger was not reproduced; the result is the same as above for
	// every engine after it (no input, no level polls), so the engine guard
	// asks this on every switch: is `init`'s input synth still on the
	// server? If the server says no, what is left goes and it is built again.
	nornsJsEnsure {
		var answered, ok, no, waited = 0;
		var id = in_s[0].nodeID;
		ok = OSCFunc({ answered = true }, '/n_info', server.addr, argTemplate: [id]).oneShot;
		no = OSCFunc({ answered = false }, '/fail', server.addr, argTemplate: ['/n_query']).oneShot;
		server.sendMsg("/n_query", id);
		while { answered.isNil and: { waited < 20 } } { 0.05.wait; waited = waited + 1 };
		ok.free;
		no.free;
		if (answered == false) {
			(in_s ++ amp_in_s ++ amp_out_s ++ pitch_in_s ++ [ig, xg, og]).do { |n|
				server.sendMsg("/n_free", n.nodeID)
			};
			server.sync;
			this.nornsJsRebuild;
			postln("norns-js: crone's input and analysis synths were gone; rebuilt");
		};
	}
}
