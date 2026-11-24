// Engine_Nianfo -- eight loop boxes on a wall, and what the air does to them.
//
// Each box plays one loop, round and round, at its own speed. Changing a
// box's loop crossfades in thirty milliseconds; switching it off lets it
// fade. Every box's level is sent back fifteen times a second, as the polls
// amp1 .. amp8, for the grilles on the screen.
//
//   play(box, index, path)   box 1..8 plays loop 1..54 (edition * 9 + n), from
//                            its start, read from path if not yet in memory
//   stop(box)                box 1..8 falls silent
//   rate(box, r)             playback speed, so pitch (1 = as made)
//   amp(box, a)   pan(box, p)
//   speaker(x)  crush(x)  wobble(x)  battery(x)  filter(x: -1..1)
//   echo(x)  echo_time(s)  space(x)  drift(x)  level(x)

Engine_Nianfo : CroneEngine {
	var buffers, using, voices, rates, amps, pans, mixBus, meterBus, batBus, driftBus, group, master, meter, ampPolls, ampOsc;

	*new { arg context, doneCallback;
		^super.new(context, doneCallback);
	}

	alloc {
		var s = context.server;

		SynthDef(\nianfo_voice, {
			var buf = \buf.kr(0);
			var env = EnvGen.kr(Env.asr(\fadein.kr(0.03), 1, \fadeout.kr(0.15)), \gate.kr(1), doneAction: 2);
			// the battery sags every box; drift lets each wander on its own
			var wander = 1 + (In.kr(\driftbus.kr(0)) * 0.03 * LFNoise2.kr(Rand(0.05, 0.09)));
			var rate = Lag.kr(\rate.kr(1), 0.15) * In.kr(\batbus.kr(0)) * wander;
			var sig = PlayBuf.ar(1, buf, BufRateScale.kr(buf) * rate, loop: 1);
			sig = sig * env * Lag.kr(\amp.kr(0.7), 0.1);
			Out.kr(\meter.kr(0), Amplitude.kr(sig, 0.02, 0.3));
			Out.ar(\out.kr(0), Pan2.ar(sig, Lag.kr(\pan.kr(0), 0.1)));
		}).add;

		SynthDef(\nianfo_meter, {
			var amps = In.kr(\bus.kr(0), 8);
			SendReply.kr(Impulse.kr(15), '/nianfo/amps', amps);
			ReplaceOut.kr(\bus.kr(0), 0 ! 8);
		}).add;

		SynthDef(\nianfo_master, {
			var sig = In.ar(\in.kr(0), 2);
			var spk = Lag.kr(\speaker.kr(0), 0.1), crush = Lag.kr(\crush.kr(0), 0.1);
			var wob = Lag.kr(\wobble.kr(0), 0.1), bat = Lag.kr(\battery.kr(0), 0.3);
			var filt = Lag.kr(\filter.kr(0), 0.1), echo = Lag.kr(\echo.kr(0), 0.1), space = Lag.kr(\space.kr(0), 0.1);
			var box, cr, bits, dip, lpf, hpf, fb, del, wet;
			// the box's own speaker: no bass, a nasal middle, no top, a cone that breaks up
			box = HPF.ar(sig, 340);
			box = BPeakEQ.ar(box, 1500, 0.8, 8);
			box = LPF.ar(box, 4200);
			box = (box * (1.5 + (spk * 6))).tanh * 0.6;
			sig = SelectX.ar(spk, [sig, box]);
			// crush: fewer bits, a lower rate
			bits = 2 ** crush.linlin(0, 1, 12, 3);
			cr = Latch.ar(sig, Impulse.ar(crush.linexp(0, 1, 22050, 2200)));
			cr = (cr * bits).round / bits;
			sig = SelectX.ar((crush * 3).clip(0, 1), [sig, cr]);
			// wobble: the motor that turns the tape is not steady
			sig = DelayC.ar(sig, 0.05, 0.012 + (wob * ((SinOsc.kr(0.55) * 0.004) + (LFNoise2.kr(7) * 0.0008))));
			// battery: now and then the sound drops, as the cells give out
			dip = 1 - (bat * 0.7 * Lag.kr(LFNoise0.kr(1.1) > 0.75, 0.04));
			sig = sig * dip;
			// filter: left of the middle a low-pass, right of it a high-pass
			lpf = filt.linexp(-1, 0, 220, 20000).clip(220, 20000);
			hpf = filt.linexp(0, 1, 20, 3500).clip(20, 3500);
			sig = RHPF.ar(RLPF.ar(sig, Lag.kr(lpf, 0.05), 0.75), Lag.kr(hpf, 0.05), 0.75);
			// echo: fed back, left and right crossing
			fb = LocalIn.ar(2);
			del = DelayC.ar(sig + (fb * echo.linlin(0, 1, 0.25, 0.72)), 2, Lag.kr(\echo_time.kr(0.43), 0.4));
			LocalOut.ar(LPF.ar(HPF.ar(del, 150), 3800).reverse);
			sig = sig + (del * echo * 0.8);
			// space
			wet = FreeVerb2.ar(sig[0], sig[1], 1, 0.93, 0.45);
			sig = sig + (wet * space * 1.4);
			sig = Limiter.ar(sig * Lag.kr(\level.kr(1), 0.1), 0.95, 0.01);
			Out.ar(\out.kr(0), sig);
			// the boxes' pitch, sagging with the battery and dipping with the drops
			Out.kr(\batbus.kr(0), 1 - (bat * (0.05 + (0.06 * LFNoise2.kr(0.11).abs))) - (bat * 0.05 * (1 - dip)));
			Out.kr(\driftbus.kr(0), Lag.kr(\drift.kr(0), 0.2));
		}).add;

		buffers = Array.newClear(54);
		using = Array.newClear(8);
		voices = Array.newClear(8);
		rates = Array.fill(8, 1);
		amps = Array.fill(8, 0.7);
		pans = Array.fill(8, 0);
		mixBus = Bus.audio(s, 2);
		meterBus = Bus.control(s, 8);
		batBus = Bus.control(s, 1);
		batBus.set(1);
		driftBus = Bus.control(s, 1);
		driftBus.set(0);
		group = Group.head(context.xg);
		s.sync;
		meter = Synth.after(group, \nianfo_meter, [\bus, meterBus]);
		master = Synth.tail(context.xg, \nianfo_master, [\in, mixBus, \out, context.out_b, \batbus, batBus, \driftbus, driftBus]);

		ampPolls = (1..8).collect({ arg i; this.addPoll(("amp" ++ i).asSymbol, periodic: false) });
		ampOsc = OSCFunc({ arg msg;
			8.do({ arg i; ampPolls[i].update(msg[3 + i]) });
		}, '/nianfo/amps');

		// A loop is read when a box asks for it and let go when no box plays it:
		// only what is playing is in memory (all of them would not fit in a
		// browser's, and on norns they would only slow the start).
		this.addCommand("play", "iis", { arg msg;
			var b = msg[1].asInteger.clip(1, 8) - 1;
			var idx = msg[2].asInteger.clip(1, 54) - 1;
			var old = using[b];
			var start = { arg buf;
				if (voices.notNil and: { using[b] == idx }) {
					if (voices[b].notNil) { voices[b].set(\gate, 0) };
					voices[b] = Synth(\nianfo_voice, [\buf, buf, \rate, rates[b], \amp, amps[b], \pan, pans[b],
						\out, mixBus, \meter, meterBus.index + b, \batbus, batBus, \driftbus, driftBus], group);
				};
			};
			using[b] = idx;
			if (buffers[idx].notNil) {
				start.(buffers[idx]);
			} {
				buffers[idx] = Buffer.read(s, msg[3].asString, action: { arg buf; start.(buf) });
			};
			if (old.notNil and: { old != idx }) { this.letGo(old) };
		});

		this.addCommand("stop", "i", { arg msg;
			var b = msg[1].asInteger.clip(1, 8) - 1;
			var old = using[b];
			using[b] = nil;
			if (voices[b].notNil) { voices[b].set(\fadeout, 0.4, \gate, 0); voices[b] = nil };
			if (old.notNil) { this.letGo(old) };
		});

		this.addCommand("rate", "if", { arg msg;
			var b = msg[1].asInteger.clip(1, 8) - 1;
			rates[b] = msg[2];
			if (voices[b].notNil) { voices[b].set(\rate, msg[2]) };
		});

		this.addCommand("amp", "if", { arg msg;
			var b = msg[1].asInteger.clip(1, 8) - 1;
			amps[b] = msg[2];
			if (voices[b].notNil) { voices[b].set(\amp, msg[2]) };
		});

		this.addCommand("pan", "if", { arg msg;
			var b = msg[1].asInteger.clip(1, 8) - 1;
			pans[b] = msg[2];
			if (voices[b].notNil) { voices[b].set(\pan, msg[2]) };
		});

		[\speaker, \crush, \wobble, \battery, \filter, \echo, \echo_time, \space, \drift, \level].do({ arg name;
			this.addCommand(name.asString, "f", { arg msg; master.set(name, msg[1]) });
		});
	}

	// a loop no box plays any more is freed, once its voice has faded
	letGo { arg idx;
		SystemClock.sched(1.0, {
			if (buffers.notNil and: { using.includes(idx).not } and: { buffers[idx].notNil }) {
				buffers[idx].free;
				buffers[idx] = nil;
			};
			nil
		});
	}

	// Called twice when one script follows another: free what is still there.
	free {
		if (ampOsc.notNil) { ampOsc.free; ampOsc = nil };
		if (voices.notNil) { voices.do({ arg v; if (v.notNil) { v.free } }); voices = nil };
		if (meter.notNil) { meter.free; meter = nil };
		if (master.notNil) { master.free; master = nil };
		if (group.notNil) { group.free; group = nil };
		if (mixBus.notNil) { mixBus.free; mixBus = nil };
		if (meterBus.notNil) { meterBus.free; meterBus = nil };
		if (batBus.notNil) { batBus.free; batBus = nil };
		if (driftBus.notNil) { driftBus.free; driftBus = nil };
		if (buffers.notNil) { buffers.do({ arg b; if (b.notNil) { b.free } }); buffers = nil };
	}
}
