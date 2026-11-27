// Engine_Mycelium — the sound of a forest floor: the network's forks as
// small struck and plucked things, and the ground they are in.
//
// note(voice, freq, amp, pan, bright, decay) sounds one node:
//
//   1 wood    a struck bar, three modes, the mallet softer as `bright` drops
//   2 drop    a water drop: a pure tone that rises into its note
//   3 glass   a few pure partials, one of them a bell's
//   4 bow     a soft bowed swell with a slow vibrato
//   5 pluck   a plucked string
//   6 bloom   a slow bloom of detuned voices, for a mushroom opening
//
// earth(drone, freq, life, crackle) sets the bed: a low drone on `freq` whose
// filter opens with `life` (how much of the network is alive), and the
// crackle of everything else living in the soil.
// rain(level) is rain on the floor above, and drips seeping through.
//
// One shared space: a ping-pong echo, a room and a limiter.

Engine_Mycelium : CroneEngine {
	var voices, mixBus, sendBus, master, earth;
	var defs;

	*new { arg context, doneCallback;
		^super.new(context, doneCallback);
	}

	alloc {
		var s = context.server;

		var emit = { arg sig;
			var st = Pan2.ar(sig * \amp.kr(0.2), \pan.kr(0));
			Out.ar(\out.kr(0), st);
			Out.ar(\sendOut.kr(0), st * \send.kr(0.55));
		};

		SynthDef(\my_wood, {
			var freq = \freq.kr(440), bright = \bright.kr(0.5), dec = \decay.kr(1) * bright.linlin(0, 1, 1.1, 0.7);
			var mallet = Decay2.ar(Impulse.ar(0), 0.0003, bright.linlin(0, 1, 0.008, 0.002));
			var bar = Klank.ar(`[[1, 3.99, 10.65], [1, 0.3, 0.08], [dec, dec * 0.28, dec * 0.08]], mallet, freq);
			EnvGen.kr(Env([1, 1], [dec + 0.2]), doneAction: 2);
			emit.((bar * 0.12).tanh);
		}).add;

		SynthDef(\my_drop, {
			var freq = \freq.kr(440), bright = \bright.kr(0.5), dec = \decay.kr(1) * bright.linlin(0, 1, 0.35, 0.18);
			var f = EnvGen.ar(Env([freq * 0.72, freq * 1.04, freq], [0.025, 0.06], [3, -2]));
			var env = EnvGen.ar(Env.perc(0.001, dec, 1, -5), doneAction: 2);
			var tick = BPF.ar(WhiteNoise.ar, (freq * 4).clip(300, 15000), 0.4) * EnvGen.ar(Env.perc(0.0005, 0.006)) * 0.2;
			emit.(((SinOsc.ar(f) + (SinOsc.ar(f * 2) * 0.12)) * env + tick) * 1.8);
		}).add;

		SynthDef(\my_glass, {
			var freq = \freq.kr(880), bright = \bright.kr(0.5), dec = \decay.kr(1) * bright.linlin(0, 1, 1.8, 3.2);
			var partials = SinOsc.ar(freq * [1, 2.756, 5.404, 2.0], 0, [1, bright * 0.3, bright * 0.1, 0.15]).sum;
			var env = EnvGen.ar(Env([0, 1, 0], [0.006, dec], [2, -4.5]), doneAction: 2);
			emit.(partials * env * 0.42);
		}).add;

		SynthDef(\my_bow, {
			var freq = \freq.kr(220), bright = \bright.kr(0.5), dec = \decay.kr(1) * 2.4;
			var vib = SinOsc.kr(Rand(4.2, 5.4), 0, 0.004 * EnvGen.kr(Env([0, 0, 1], [0.3, 0.6])), 1);
			var osc = Saw.ar(freq * vib * [1, 1.003]).sum * 0.5;
			var env = EnvGen.ar(Env([0, 1, 0.7, 0], [bright.linlin(0, 1, 0.35, 0.12), dec * 0.4, dec * 0.6], [2, -1, -3]), doneAction: 2);
			emit.(LPF.ar(osc, (freq * bright.linlin(0, 1, 2.5, 7)).clip(150, 9000)) * env * 0.8);
		}).add;

		SynthDef(\my_pluck, {
			var freq = \freq.kr(440), bright = \bright.kr(0.5), dec = \decay.kr(1) * bright.linlin(0, 1, 1.3, 2.6);
			var str = Pluck.ar(WhiteNoise.ar(1), Impulse.kr(0), 0.05, freq.reciprocal, dec, bright.linlin(0, 1, 0.6, 0.15));
			EnvGen.kr(Env([1, 1], [dec + 0.1]), doneAction: 2);
			emit.(LPF.ar(str, (freq * 7).clip(400, 12000)) * 2.8);
		}).add;

		SynthDef(\my_bloom, {
			var freq = \freq.kr(220), bright = \bright.kr(0.5), dec = \decay.kr(1) * 4;
			var osc = LFTri.ar(freq * [1, 1.004, 0.998]).sum * 0.33 + (SinOsc.ar(freq * 2) * 0.12);
			var env = EnvGen.ar(Env([0, 1, 0], [bright.linlin(0, 1, 1.2, 0.3), dec], [2, -3]), doneAction: 2);
			emit.(LPF.ar(osc, (freq * bright.linlin(0, 1, 2, 5)).clip(200, 8000)) * env * 0.42);
		}).add;

		// The ground: a drone that opens as the network lives, the crackle of
		// soil life, rain above and drips below.
		SynthDef(\my_earth, {
			var drone = Lag.kr(\drone.kr(0), 3), freq = Lag.kr(\freq.kr(55), 5), life = Lag.kr(\life.kr(0), 4);
			var crackle = Lag.kr(\crackle.kr(0), 2), rain = Lag.kr(\rain.kr(0), 3);
			var d, cr, rn, drips;
			d = VarSaw.ar(freq * [1, 1.5, 2.001, 0.5] * LFNoise1.kr(0.07 ! 4).range(0.996, 1.004), 0, 0.35, [0.5, 0.3, 0.18, 0.4]);
			d = Splay.ar(d, 0.7);
			d = RLPF.ar(d, LFNoise2.kr(0.04).range(140, 380) + (life * 900), 0.45) * drone * 0.14;
			cr = Decay2.ar(Dust.ar([1, 1] * (crackle * 30 + 0.5)), 0.0005, 0.004) * WhiteNoise.ar(1);
			cr = BPF.ar(cr, LFNoise1.kr([0.3, 0.37]).range(1800, 5200), 0.6) * crackle * 0.35;
			rn = HPF.ar(PinkNoise.ar([1, 1]), 900) * LFNoise2.kr(0.2).range(0.6, 1) * rain * 0.06;
			drips = Decay2.ar(Dust.ar([1, 1] * rain * 4), 0.001, 0.05)
				* SinOsc.ar(TExpRand.ar(900, 2400, Dust.ar([1, 1] * rain * 4))) * rain * 0.08;
			Out.ar(\out.kr(0), d + cr + rn + drips);
			Out.ar(\sendOut.kr(0), (d * 0.4) + (drips * 0.6) + (cr * 0.2));
		}).add;

		SynthDef(\my_master, {
			var dry = In.ar(\in.kr(0), 2);
			var wet = In.ar(\fxin.kr(0), 2);
			var fb, dl, sig, room;
			fb = LocalIn.ar(2);
			dl = DelayC.ar(wet + (fb.reverse * \efb.kr(0.4)), 2.0, Lag.kr(\etime.kr(0.36), 0.3));
			LocalOut.ar(LPF.ar(HPF.ar(dl, 220), 3800));
			sig = dry + (dl * \emix.kr(0.3));
			room = FreeVerb2.ar(sig[0], sig[1], 1, 0.9, 0.55);
			sig = sig + (room * \space.kr(0.4));
			sig = Limiter.ar(LeakDC.ar(sig) * \level.kr(1), 0.95, 0.01);
			Out.ar(\out.kr(0), sig);
		}).add;

		defs = [\my_wood, \my_drop, \my_glass, \my_bow, \my_pluck, \my_bloom];

		s.sync;

		mixBus = Bus.audio(s, 2);
		sendBus = Bus.audio(s, 2);
		voices = Group.tail(context.xg);
		s.sync;
		earth = Synth.head(voices, \my_earth, [\out, mixBus, \sendOut, sendBus]);
		master = Synth.tail(context.xg, \my_master, [\in, mixBus, \fxin, sendBus, \out, context.out_b]);

		// note(voice, freq, amp, pan, bright, decay)
		this.addCommand("note", "ifffff", { arg msg;
			var id = msg[1].asInteger.clip(1, defs.size) - 1;
			Synth(defs[id], [\out, mixBus, \sendOut, sendBus, \freq, msg[2], \amp, msg[3],
				\pan, msg[4], \bright, msg[5], \decay, msg[6]], voices);
		});

		// earth(drone, freq, life, crackle)
		this.addCommand("earth", "ffff", { arg msg;
			earth.set(\drone, msg[1], \freq, msg[2], \life, msg[3], \crackle, msg[4]);
		});

		this.addCommand("rain", "f", { arg msg; earth.set(\rain, msg[1]) });

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
