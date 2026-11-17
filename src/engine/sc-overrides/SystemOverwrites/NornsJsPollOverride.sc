// norns-js: norns' poll transport, rebuilt on /c_get instead of shared memory.
//
// WHY: six of norns' eight polls read their value with Bus:getSynchronous,
// which goes to scsynth's SHARED MEMORY interface. Here sclang and scsynth
// are two wasm modules with two separate heaps, so there is no shared region
// to map, and the call dies. The value itself is fine - asking scsynth
// /c_get for the same bus returns it. See research/poll-transport.md.
//
// So the fix is to stop reading and start asking. Asking is a round trip,
// which means the poll function can no longer RETURN the value. Everything
// below exists to invert that one direction, and nothing else.

+ CronePoll {

	// WHY: CronePoll's periodic callback, built in init, is
	//     { var val = function.value; this.value = val; this.sendValue }
	// An asynchronous poll function has nothing to return yet, so it returns
	// nil - and nil must not go out: matron registers /poll/value with the
	// typespec "if" (matron/src/oracle.cc:178) and would not dispatch it.
	//
	// Guarding here rather than rewriting `callback` leaves init, the Task,
	// start, stop and setTime exactly as upstream wrote them, and keeps every
	// SYNCHRONOUS poll working unchanged - which matters, because engines
	// register their own polls through CroneEngine:addPoll and those still
	// return a value directly.
	sendValue {
		if(value.notNil, {
			this.oscAddr.sendMsg(oscPath, index, value);
		});
	}

	// WHY: the other half of the inversion. The /c_set reply lands here, a few
	// milliseconds later, and sends then.
	//
	// Deliberately NOT `update`: update is gated on isRunning, but
	// /poll/request/value must answer for a stopped poll too - that is what
	// lua's Poll:update() calls.
	receiveValue { arg val;
		value = val;
		this.sendValue;
	}
}

+ CroneAudioContext {

	// WHY a whole replacement: every bus-reading poll function changes shape.
	// Registration ORDER is load-bearing and therefore copied exactly -
	// CronePollRegistry.register hands out the index from polls.size, and
	// matron addresses polls by that integer, so reordering silently renames
	// every poll.
	initPolls {
		postln("AudioContext: initPolls [norns-js async /c_get transport]");

		// Untouched: these never touch a bus. They are broken for an unrelated
		// reason - the wasm driver never writes peakCPU/avgCPU. See
		// research/cpu-metric.md; not this override's business.
		this.registerPoll(\cpu_peak, { server.peakCPU });
		this.registerPoll(\cpu_avg, { server.avgCPU; });

		this.registerPoll(\amp_in_l,  this.prAsyncAmpPoll(\amp_in_l,  amp_in_b[0]));
		this.registerPoll(\amp_in_r,  this.prAsyncAmpPoll(\amp_in_r,  amp_in_b[1]));
		this.registerPoll(\amp_out_l, this.prAsyncAmpPoll(\amp_out_l, amp_out_b[0]));
		this.registerPoll(\amp_out_r, this.prAsyncAmpPoll(\amp_out_r, amp_out_b[1]));

		this.registerPoll(\pitch_in_l, this.prAsyncPitchPoll(\pitch_in_l, pitch_in_b[0]));
		this.registerPoll(\pitch_in_r, this.prAsyncPitchPoll(\pitch_in_r, pitch_in_b[1]));
	}

	// WHY the lookup by name instead of capturing the CronePoll: the poll does
	// not exist yet when this function is built - registerPoll constructs it
	// FROM this function. One Dictionary lookup per reply.
	//
	// Bus:get expands to OSCFunc(\c_set, server.addr, argTemplate: [index])
	// .oneShot plus a /c_get. That is the same shape as the /done /notify
	// handshake this build already completes on every boot, so the srcID match
	// against the wasm reply address is not a new assumption.
	prAsyncAmpPoll { arg pollName, bus;
		^{
			bus.get({ arg val;
				CronePollRegistry.getPollFromName(pollName).receiveValue(val);
			});
			nil // the value arrives in the block above, not from here
		}
	}

	// WHY getn: a pitch bus is 2 channels, [freq, clarity]. The clarity test
	// is upstream's, integer -1 included - see research/poll-transport.md for
	// why that -1 is worth a second look, and why changing it is not this
	// override's job.
	prAsyncPitchPoll { arg pollName, bus;
		^{
			bus.getn(2, { arg vals;
				var pitch = vals[0], clar = vals[1];
				CronePollRegistry.getPollFromName(pollName).receiveValue(
					if(clar > 0, { pitch }, { -1 })
				);
			});
			nil
		}
	}
}
