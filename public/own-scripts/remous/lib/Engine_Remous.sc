// Engine_Remous — the stones of a pond, and the water they ring into.
//
// strike(kind, freq, amp, pan, bright) rings one stone:
//
//   1 bell   an FM bell, its brightness fading with the ring
//   2 wood   three modes of a struck bar, the mallet as soft as `bright` is low
//   3 glass  a few pure partials with a slow shimmer
//   4 pluck  a plucked string
//   5 jelly  a soft bloom, for a jellyfish's pulse
//   6 bubble a drop of rising pitch, for a bubble at the surface
//
// drone(level, freq) sets a quiet bed under it all, which the script
// raises and lowers with how much is alive in the pond.
//
// Everything goes through one shared space: a ping-pong echo, a room and a
// limiter.

Engine_Remous : CroneEngine {
	var voices, mixBus, sendBus, master, drone;
	var defs;

	*new { arg context, doneCallback;
		^super.new(context, doneCallback);
	}

	alloc {
		var s = context.server;

		var emit = { arg sig;
			var st = Pan2.ar(sig * \amp.kr(0.3), \pan.kr(0));
			Out.ar(\out.kr(0), st);
			Out.ar(\sendOut.kr(0), st * \send.kr(0.5));
		};

		SynthDef(\remous_bell, {
			var freq = \freq.kr(440), bright = \bright.kr(0.5);
			var dec = bright.linlin(0, 1, 2.2, 4.5);
			var index = EnvGen.ar(Env.perc(0.001, dec * 0.3)) * bright.linlin(0, 1, 0.6, 3.5);
			var mod = SinOsc.ar(freq * 3.5, 0, freq * index);
			var env = EnvGen.ar(Env.perc(0.002, dec, 1, -5), doneAction: 2);
			var shine = SinOsc.ar(freq * 2.01) * EnvGen.ar(Env.perc(0.001, dec * 0.4)) * 0.12;
			emit.((SinOsc.ar(freq + mod) + shine) * env * 0.5);
		}).add;

		SynthDef(\remous_wood, {
			var freq = \freq.kr(440), bright = \bright.kr(0.5);
			var dec = bright.linlin(0, 1, 0.9, 0.5);
			var mallet = Decay2.ar(Impulse.ar(0), 0.0003, bright.linlin(0, 1, 0.006, 0.0015));
			var bar = Klank.ar(`[[1, 3.93, 9.24], [1, 0.35, 0.12], [dec, dec * 0.3, dec * 0.1]], mallet, freq);
			EnvGen.kr(Env([1, 1], [dec + 0.2]), doneAction: 2);
			emit.((bar * 0.5).tanh);
		}).add;

		SynthDef(\remous_glass, {
			var freq = \freq.kr(440), bright = \bright.kr(0.5);
			var dec = bright.linlin(0, 1, 1.6, 3.2);
			var partials = Mix(SinOsc.ar(freq * [1, 2.0, 3.01, 4.17], 0, [1, 0.3, bright * 0.25, bright * 0.12]));
			var shimmer = 1 + SinOsc.kr(Rand(3.5, 5.5), 0, 0.12);
			var env = EnvGen.ar(Env([0, 1, 0], [0.03, dec], [2, -4]), doneAction: 2);
			emit.(partials * shimmer * env * 0.32);
		}).add;

		SynthDef(\remous_pluck, {
			var freq = \freq.kr(440), bright = \bright.kr(0.5);
			var dec = bright.linlin(0, 1, 1.5, 3.0);
			var str = Pluck.ar(WhiteNoise.ar(0.6), Impulse.kr(0), 0.05, freq.reciprocal, dec, bright.linlin(0, 1, 0.55, 0.12));
			EnvGen.kr(Env([1, 1], [dec + 0.1]), doneAction: 2);
			emit.(LPF.ar(str, (freq * 8).clip(400, 14000)) * 0.9);
		}).add;

		// A jellyfish's pulse: a soft bloom that leans into its note.
		SynthDef(\remous_jelly, {
			var freq = \freq.kr(440), bright = \bright.kr(0.5);
			var dec = bright.linlin(0, 1, 2.6, 1.2);
			var bend = EnvGen.ar(Env([1.03, 1], [0.08], -3));
			var osc = (SinOsc.ar(freq * bend * [1, 1.003]).sum * 0.5)
				+ (SinOsc.ar(freq * 2 * bend) * 0.12 * bright)
				+ (LFTri.ar(freq * 0.5) * 0.15);
			var env = EnvGen.ar(Env([0, 1, 0], [0.025, dec], [3, -4]), doneAction: 2);
			emit.(LPF.ar(osc, (freq * 4).clip(200, 14000)) * env * 0.45);
		}).add;

		// A bubble breaking the surface: a drop of pitch that rises, and a tick.
		SynthDef(\remous_bubble, {
			var freq = \freq.kr(600), bright = \bright.kr(0.5);
			var dec = bright.linlin(0, 1, 0.22, 0.08);
			var f = EnvGen.ar(Env([freq * 0.6, freq * 1.25, freq], [0.035, 0.06], [2, -2]));
			var env = EnvGen.ar(Env.perc(0.002, dec, 1, -6), doneAction: 2);
			var click = BPF.ar(WhiteNoise.ar, (freq * 3).clip(200, 16000), 0.5) * EnvGen.ar(Env.perc(0.0005, 0.008)) * 0.3;
			emit.(((SinOsc.ar(f) * env) + click) * 0.6);
		}).add;

		SynthDef(\remous_drone, {
			var freq = Lag.kr(\freq.kr(55), 4);
			var level = Lag.kr(\level.kr(0), 3);
			var osc = VarSaw.ar(freq * [1, 1.5, 2, 0.5] * LFNoise1.kr(0.1 ! 4).range(0.997, 1.003), 0, 0.3);
			var sig = Splay.ar(osc, 0.8);
			sig = RLPF.ar(sig, LFNoise2.kr(0.05).range(260, 900) + (level * 700), 0.4);
			Out.ar(\out.kr(0), sig * level * 0.07);
			Out.ar(\sendOut.kr(0), sig * level * 0.03);
		}).add;

		SynthDef(\remous_master, {
			var dry = In.ar(\in.kr(0), 2);
			var wet = In.ar(\fxin.kr(0), 2);
			var fb, dl, sig, room;
			fb = LocalIn.ar(2);
			dl = DelayC.ar(wet + (fb.reverse * \efb.kr(0.45)), 2.0, Lag.kr(\etime.kr(0.42), 0.3));
			LocalOut.ar(LPF.ar(HPF.ar(dl, 200), 4500));
			sig = dry + (dl * \emix.kr(0.45));
			room = FreeVerb2.ar(sig[0], sig[1], 1, 0.88, 0.45);
			sig = sig + (room * \space.kr(0.35));
			sig = Limiter.ar(LeakDC.ar(sig) * \level.kr(1), 0.95, 0.01);
			Out.ar(\out.kr(0), sig);
		}).add;

		defs = [\remous_bell, \remous_wood, \remous_glass, \remous_pluck, \remous_jelly, \remous_bubble];

		s.sync;

		mixBus = Bus.audio(s, 2);
		sendBus = Bus.audio(s, 2);
		voices = Group.tail(context.xg);
		s.sync;
		drone = Synth.head(voices, \remous_drone, [\out, mixBus, \sendOut, sendBus]);
		master = Synth.tail(context.xg, \remous_master, [\in, mixBus, \fxin, sendBus, \out, context.out_b]);

		// strike(kind, freq, amp, pan, bright)
		this.addCommand("strike", "iffff", { arg msg;
			var id = msg[1].asInteger.clip(1, defs.size) - 1;
			Synth(defs[id], [\out, mixBus, \sendOut, sendBus, \freq, msg[2], \amp, msg[3],
				\pan, msg[4], \bright, msg[5]], voices);
		});

		this.addCommand("drone", "ff", { arg msg;
			drone.set(\level, msg[1], \freq, msg[2]);
		});

		[\space, \emix, \efb, \etime, \level].do({ arg key;
			this.addCommand(key, "f", { arg msg; master.set(key, msg[1]) });
		});
	}

	// Called twice when one script follows another: a clear frees the engine,
	// and loading the next one frees it again before either has finished.
	free {
		if (master.notNil) { master.free; master = nil };
		if (voices.notNil) { voices.free; voices = nil };
		if (mixBus.notNil) { mixBus.free; mixBus = nil };
		if (sendBus.notNil) { sendBus.free; sendBus = nil };
	}
}
