// Engine_No12 — sixteen sounds, two knobs each, and the PO-12's effects.
//
// Each sound is a buffer read from the script's own samples/ folder. A sound
// started again cuts itself off: one voice per sound, a five-millisecond
// release, no click.
//
//   sample(slot, path)                 read a sound into slot 1..16
//                                      (not "load": engine.load is norns' own)
//   hit(slot, amp, rate, decay, color) play it
//        rate    knob A: playback speed, so pitch (1 = as recorded)
//        decay   knob B below its middle: how much of the sound is heard (1 = all)
//        color   knob B above its middle: a resonant edge and a little drive (0 = none)
//   fx(n)                              the effect punched in, 1..16, or 0
//   bpm(f)                             what the delay and the sweeps follow
//   sync(mode)                         SY0..SY5: clicks out on the left, sound
//                                      mono on the right (1, 3, 5); clicks in
//                                      on the left input heard (2..5)
//   pulse()                            one sync click
//
// A click heard on the input is sent to the script as the poll "sync".
//
// Of the sixteen effects, the ones that change the sound are here; the ones
// that change the order of the notes (stutter, repeat, note shuffle,
// parameter lfo) are the sequencer's, in no12.lua, and send fx(0).

Engine_No12 : CroneEngine {
	var buffers, voices, chokeBus, gens, mixBus, vibBus, master, listener, syncPoll, pulses;

	*new { arg context, doneCallback;
		^super.new(context, doneCallback);
	}

	alloc {
		var s = context.server;

		SynthDef(\no12_voice, {
			var buf = \buf.kr(0);
			var speed = \rate.kr(1);
			var vib = 1 + (In.kr(\vib.kr(0)) * SinOsc.kr(5.5) * 0.03);
			var cut = In.kr(\choke.kr(0)) > \gen.kr(0);
			var len = BufDur.kr(buf) / speed.max(0.05);
			var dec = \decay.kr(1);
			var shape = EnvGen.kr(Env([1, 1, 0], [len * dec * 0.6, (len * dec * 0.4) + 0.004], [0, -4]), doneAction: 2);
			var gate = EnvGen.kr(Env.asr(0, 1, 0.005), 1 - cut, doneAction: 2);
			var sig = PlayBuf.ar(2, buf, BufRateScale.kr(buf) * speed * vib, doneAction: 2);
			var color = \color.kr(0);
			var edged = (BPeakEQ.ar(sig, 2600, 0.7, 10) * (1 + (color * 2.5))).tanh;
			sig = SelectX.ar(color, [sig, edged]);
			Out.ar(\out.kr(0), sig * shape * gate * \amp.kr(1));
		}).add;

		SynthDef(\no12_master, {
			var dry = In.ar(\in.kr(0), 2);
			var beat = 60 / \bpm.kr(80).max(20);
			var sweep = LFTri.kr(1 / (beat * 4), 1);
			var sig, lp, hp, fb, echo, ring, ringIn, ms, mono;
			sig = dry;
			// 1 low sample rate
			sig = SelectX.ar(Lag.kr(\lsr.kr(0), 0.005), [sig, Latch.ar(sig, Impulse.ar(4000))]);
			// 2 distortion
			sig = SelectX.ar(Lag.kr(\dist.kr(0), 0.005), [sig, (sig * 10).tanh * 0.55]);
			// 3 bit crush: sixteen levels
			sig = SelectX.ar(Lag.kr(\crush.kr(0), 0.005), [sig, (sig * 8).round / 8]);
			// 5, 6 low-pass, fixed or sweeping; 7, 8 high-pass, fixed or sweeping
			lp = Select.kr(\lp.kr(0), [19000, 650, sweep.linexp(-1, 1, 180, 9000)]);
			hp = Select.kr(\hp.kr(0), [20, 1800, sweep.linexp(-1, 1, 60, 5000)]);
			sig = RLPF.ar(sig, Lag.kr(lp, 0.02), 0.45);
			sig = RHPF.ar(sig, Lag.kr(hp, 0.02), 0.45);
			// 4 delay: what is sent while it is held, echoing three sixteenths on, and on
			fb = LocalIn.ar(2);
			echo = DelayC.ar((sig * Lag.kr(\dsend.kr(0), 0.005)) + (fb.reverse * 0.55), 2, Lag.kr(beat * 0.75, 0.1));
			LocalOut.ar(LPF.ar(echo, 6000));
			// 14 feedback: a short line fed back on itself, swirling
			ringIn = sig * Lag.kr(\fsend.kr(0), 0.005);
			ring = CombC.ar(ringIn, 0.05, SinOsc.kr(0.3).range(0.004, 0.012), 1.6);
			sig = sig + echo + (LeakDC.ar(ring) * 0.6);
			sig = Limiter.ar(sig, 0.95, 0.005);
			// sync out (SY1, SY3, SY5): the sound in mono on the right, the left left for clicks
			ms = \monosync.kr(0);
			mono = (sig[0] + sig[1]) * 0.5;
			sig = [sig[0] * (1 - ms), (sig[1] * (1 - ms)) + (mono * ms)];
			Out.ar(\out.kr(0), sig);
		}).add;

		// a sync pulse: five milliseconds on the left channel
		SynthDef(\no12_pulse, {
			var click = EnvGen.ar(Env([0, 0.9, 0.9, 0], [0, 0.005, 0.0005]), doneAction: 2);
			Out.ar(\out.kr(0), [click, DC.ar(0)]);
		}).add;

		// sync in (SY2 - SY5): a click on the left input is a pulse, two to a beat
		SynthDef(\no12_listen, {
			var in = In.ar(\in.kr(0), 1);
			var pulse = Trig1.ar((in > \thresh.kr(0.2)) * \on.kr(0), 0.03);
			SendReply.ar(pulse, '/no12/pulse', 1);
		}).add;

		buffers = Array.newClear(16);
		gens = Array.fill(16, 0);
		chokeBus = Bus.control(s, 16);
		chokeBus.setn(0 ! 16);
		vibBus = Bus.control(s, 1);
		vibBus.set(0);
		mixBus = Bus.audio(s, 2);
		voices = Group.tail(context.xg);
		s.sync;
		master = Synth.tail(context.xg, \no12_master, [\in, mixBus, \out, context.out_b]);
		listener = Synth.head(context.xg, \no12_listen, [\in, context.in_b[0]]);
		syncPoll = this.addPoll(\sync, periodic: false);
		pulses = OSCFunc({ syncPoll.update(1) }, '/no12/pulse');

		this.addCommand("sample", "is", { arg msg;
			var slot = msg[1].asInteger.clip(1, 16) - 1;
			if (buffers[slot].notNil) { buffers[slot].free };
			buffers[slot] = Buffer.read(s, msg[2].asString);
		});

		this.addCommand("hit", "iffff", { arg msg;
			var slot = msg[1].asInteger.clip(1, 16) - 1;
			var buf = buffers[slot];
			if (buf.notNil) {
				gens[slot] = gens[slot] + 1;
				chokeBus.setAt(slot, gens[slot]);
				Synth(\no12_voice, [\out, mixBus, \buf, buf, \amp, msg[2], \rate, msg[3],
					\decay, msg[4].clip(0.02, 1), \color, msg[5].clip(0, 1),
					\choke, chokeBus.index + slot, \gen, gens[slot], \vib, vibBus.index], voices);
			};
		});

		this.addCommand("fx", "i", { arg msg;
			var n = msg[1].asInteger;
			master.set(\lsr, (n == 1).binaryValue, \dist, (n == 2).binaryValue, \crush, (n == 3).binaryValue,
				\dsend, (n == 4).binaryValue,
				\lp, case { n == 5 } { 1 } { n == 6 } { 2 } { 0 },
				\hp, case { n == 7 } { 1 } { n == 8 } { 2 } { 0 },
				\fsend, (n == 14).binaryValue);
			vibBus.set((n == 16).binaryValue);
		});

		this.addCommand("bpm", "f", { arg msg; master.set(\bpm, msg[1]) });

		// sync(mode): SY0 .. SY5, as the PO-12's guide lists them
		this.addCommand("sync", "i", { arg msg;
			var mode = msg[1].asInteger;
			master.set(\monosync, [1, 3, 5].includes(mode).binaryValue);
			listener.set(\on, (mode >= 2).binaryValue);
		});

		this.addCommand("pulse", "", { arg msg;
			Synth(\no12_pulse, [\out, context.out_b], context.xg, \addToTail);
		});
	}

	// Called twice when one script follows another: a clear frees the engine,
	// and loading the next one frees it again before either has finished.
	free {
		if (pulses.notNil) { pulses.free; pulses = nil };
		if (listener.notNil) { listener.free; listener = nil };
		if (master.notNil) { master.free; master = nil };
		if (voices.notNil) { voices.free; voices = nil };
		if (mixBus.notNil) { mixBus.free; mixBus = nil };
		if (vibBus.notNil) { vibBus.free; vibBus = nil };
		if (chokeBus.notNil) { chokeBus.free; chokeBus = nil };
		if (buffers.notNil) { buffers.do({ arg b; if (b.notNil) { b.free } }); buffers = nil };
	}
}
