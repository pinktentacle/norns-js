// Engine_Fireflies — a summer night: the fireflies' lights as small bells,
// and the meadow they flash over.
//
// flash(voice, freq, amp, pan, bright, decay) rings one firefly:
//
//   1 glass    a few pure partials, a bell's inharmonic one among them
//   2 bell     a soft FM bell
//   3 kalimba  a plucked tine: a blip of pitch, a short ring
//   4 breath   a slow bloom of two detuned voices, for chords
//   5 pluck    a plucked string
//
// night(crickets, rate, frogs, wind) sets the meadow's own sounds: a few
// crickets chirping at `rate` chirps a second (the script follows Dolbear's
// law, the warmer the faster), frogs now and then, and the wind;
// gust(strength) blows once through it, leaves and all.
// owl(amp, pan) hoots once; bird(amp, pan) is a first bird at dawn.
//
// Everything goes through one shared space: a ping-pong echo, a room and a
// limiter.

Engine_Fireflies : CroneEngine {
	var voices, mixBus, sendBus, master, night;
	var defs;

	*new { arg context, doneCallback;
		^super.new(context, doneCallback);
	}

	alloc {
		var s = context.server;

		var emit = { arg sig;
			var st = Pan2.ar(sig * \amp.kr(0.2), \pan.kr(0));
			Out.ar(\out.kr(0), st);
			Out.ar(\sendOut.kr(0), st * \send.kr(0.6));
		};

		SynthDef(\ff_glass, {
			var freq = \freq.kr(880), bright = \bright.kr(0.5), dec = \decay.kr(1) * bright.linlin(0, 1, 2.0, 3.6);
			var partials = SinOsc.ar(freq * [1, 2.756, 5.404, 2.0], 0, [1, bright * 0.32, bright * 0.11, 0.18]).sum;
			var env = EnvGen.ar(Env([0, 1, 0], [0.006, dec], [2, -4.5]), doneAction: 2);
			var air = SinOsc.kr(Rand(4, 6.5), Rand(0, 6), 0.06, 1);
			emit.(partials * env * air * 0.3);
		}).add;

		SynthDef(\ff_bell, {
			var freq = \freq.kr(880), bright = \bright.kr(0.5), dec = \decay.kr(1) * bright.linlin(0, 1, 2.2, 4.0);
			var index = EnvGen.ar(Env.perc(0.002, dec * 0.25)) * bright.linlin(0, 1, 0.4, 2.4);
			var mod = SinOsc.ar(freq * 3.5, 0, freq * index);
			var env = EnvGen.ar(Env([0, 1, 0], [0.004, dec], [2, -5]), doneAction: 2);
			emit.(SinOsc.ar(freq + mod) * env * 0.36);
		}).add;

		SynthDef(\ff_kalimba, {
			var freq = \freq.kr(880), bright = \bright.kr(0.5), dec = \decay.kr(1) * bright.linlin(0, 1, 0.9, 1.8);
			var f = freq * EnvGen.ar(Env([1.015, 1], [0.03]));
			var tine = SinOsc.ar(f) + (SinOsc.ar(f * 5.95) * EnvGen.ar(Env.perc(0.001, 0.08)) * 0.25 * bright);
			var thump = LPF.ar(WhiteNoise.ar, 900) * EnvGen.ar(Env.perc(0.0005, 0.012)) * 0.25;
			var env = EnvGen.ar(Env.perc(0.002, dec, 1, -4), doneAction: 2);
			emit.((tine * env + thump) * 0.4);
		}).add;

		SynthDef(\ff_breath, {
			var freq = \freq.kr(440), bright = \bright.kr(0.5), dec = \decay.kr(1) * 3.2;
			var osc = LFTri.ar(freq * [1, 1.004]).sum * 0.5 + (SinOsc.ar(freq * 2) * 0.15);
			var env = EnvGen.ar(Env([0, 1, 0], [bright.linlin(0, 1, 0.6, 0.15), dec], [2, -3]), doneAction: 2);
			emit.(LPF.ar(osc, (freq * bright.linlin(0, 1, 2, 6)).clip(200, 9000)) * env * 0.3);
		}).add;

		SynthDef(\ff_pluck, {
			var freq = \freq.kr(440), bright = \bright.kr(0.5), dec = \decay.kr(1) * bright.linlin(0, 1, 1.4, 2.8);
			var str = Pluck.ar(WhiteNoise.ar(0.5), Impulse.kr(0), 0.05, freq.reciprocal, dec, bright.linlin(0, 1, 0.6, 0.15));
			EnvGen.kr(Env([1, 1], [dec + 0.1]), doneAction: 2);
			emit.(LPF.ar(str, (freq * 7).clip(400, 12000)) * 0.8);
		}).add;

		// The meadow at night: crickets, frogs, the wind in the grass.
		SynthDef(\ff_night, {
			var crick = Lag.kr(\crickets.kr(0), 2), rate = Lag.kr(\rate.kr(1.8), 3);
			var frog = Lag.kr(\frogs.kr(0), 2), wind = Lag.kr(\wind.kr(0.2), 2);
			var gust = EnvGen.kr(Env([0, 1, 0], [0.7, 3.2], [2, -3]), \gt.tr(0)) * \gs.kr(0);
			var crickets, frogs, air, leaves, ftrig, fenv, ffreq;
			// a few crickets, each with its own rate, pitch and place
			crickets = Mix.fill(4, { arg i;
				var r = rate * Rand(0.9, 1.1);
				var chirp = EnvGen.ar(Env.linen(0.004, Rand(0.05, 0.09), 0.02), Impulse.ar(r, Rand(0, 1)));
				var syll = LFPulse.ar(Rand(26, 42), 0, 0.45);
				var tone = SinOsc.ar(Rand(3700, 4900)) + (SinOsc.ar(Rand(7400, 9000)) * 0.15);
				Pan2.ar(tone * syll * chirp, Rand(-0.85, 0.85), 1) * Rand(0.5, 1);
			}) * crick * 0.05;
			// frogs: a croak now and then, a buzz through a throat
			ftrig = Dust.kr(frog * 0.6 + 0.0001);
			fenv = EnvGen.kr(Env([0, 1, 0.8, 0], [0.01, 0.18, 0.12]), ftrig);
			ffreq = TRand.kr(95, 170, ftrig);
			frogs = RLPF.ar(Saw.ar(ffreq * EnvGen.kr(Env([1.12, 1], [0.25]), ftrig)) * LFPulse.ar(TRand.kr(16, 30, ftrig), 0, 0.5),
				ffreq * TRand.kr(3, 5, ftrig), 0.25);
			frogs = Pan2.ar(frogs * fenv, TRand.kr(-0.7, 0.7, ftrig)) * frog * 0.22;
			// the wind, and the leaves it stirs when it blows
			air = BPF.ar(PinkNoise.ar([1, 1]), LFNoise2.kr([0.11, 0.13]).range(280, 800) + (gust * 900), 0.55);
			air = air * (wind * 0.5 + gust) * LFNoise2.kr(0.35).range(0.4, 1) * 0.35;
			leaves = HPF.ar(Decay2.ar(Dust.ar([1, 1] * (gust * 120 + (wind * 12) + 1)), 0.001, 0.02) * WhiteNoise.ar(1), 2500);
			leaves = leaves * (gust * 0.6 + (wind * 0.08)) * 0.25;
			Out.ar(\out.kr(0), crickets + frogs + air + leaves);
			Out.ar(\sendOut.kr(0), (crickets + frogs) * 0.35 + (air * 0.2));
		}).add;

		// An owl: hoo — hoo-hoo — hooo.
		SynthDef(\ff_owl, {
			var f = Rand(310, 370);
			var env = EnvGen.ar(Env([0, 1, 0.7, 0, 0, 0.8, 0, 0, 0.9, 0.75, 0],
				[0.07, 0.28, 0.06, 0.32, 0.04, 0.12, 0.09, 0.07, 0.4, 0.15], [2, -1, -4, 0, 2, -4, 0, 2, -1, -4]), doneAction: 2);
			var pitch = f * EnvGen.ar(Env([1.03, 1, 0.97], [0.1, 1.6]));
			var voice = SinOsc.ar(pitch) + (SinOsc.ar(pitch * 2.01) * 0.06);
			var breath = BPF.ar(PinkNoise.ar, pitch * 2, 0.4) * 0.25;
			var sig = LPF.ar(voice + breath, 1600) * env;
			Out.ar(\out.kr(0), Pan2.ar(sig * \amp.kr(0.2), \pan.kr(0)));
			Out.ar(\sendOut.kr(0), Pan2.ar(sig * \amp.kr(0.2) * 0.7, \pan.kr(0)));
		}).add;

		// A first bird at dawn: a few quick whistles.
		SynthDef(\ff_bird, {
			var n = 5;
			var trig = Impulse.ar(Rand(7, 11));
			var gate = EnvGen.ar(Env([1, 1, 0], [Rand(0.35, 0.6), 0.01]), doneAction: 2);
			var sweep = EnvGen.ar(Env([1, 1.35, 0.9], [0.03, 0.05], [2, -2]), trig);
			var f = Rand(2600, 4200) * sweep;
			var env = EnvGen.ar(Env.perc(0.004, 0.07), trig);
			var sig = SinOsc.ar(f) * env * gate;
			Out.ar(\out.kr(0), Pan2.ar(sig * \amp.kr(0.1), \pan.kr(0)));
			Out.ar(\sendOut.kr(0), Pan2.ar(sig * \amp.kr(0.1) * 0.6, \pan.kr(0)));
		}).add;

		SynthDef(\ff_master, {
			var dry = In.ar(\in.kr(0), 2);
			var wet = In.ar(\fxin.kr(0), 2);
			var fb, dl, sig, room;
			fb = LocalIn.ar(2);
			dl = DelayC.ar(wet + (fb.reverse * \efb.kr(0.4)), 2.0, Lag.kr(\etime.kr(0.48), 0.3));
			LocalOut.ar(LPF.ar(HPF.ar(dl, 250), 4200));
			sig = dry + (dl * \emix.kr(0.35));
			room = FreeVerb2.ar(sig[0], sig[1], 1, 0.92, 0.5);
			sig = sig + (room * \space.kr(0.45));
			sig = Limiter.ar(LeakDC.ar(sig) * \level.kr(1), 0.95, 0.01);
			Out.ar(\out.kr(0), sig);
		}).add;

		defs = [\ff_glass, \ff_bell, \ff_kalimba, \ff_breath, \ff_pluck];

		s.sync;

		mixBus = Bus.audio(s, 2);
		sendBus = Bus.audio(s, 2);
		voices = Group.tail(context.xg);
		s.sync;
		night = Synth.head(voices, \ff_night, [\out, mixBus, \sendOut, sendBus]);
		master = Synth.tail(context.xg, \ff_master, [\in, mixBus, \fxin, sendBus, \out, context.out_b]);

		// flash(voice, freq, amp, pan, bright, decay)
		this.addCommand("flash", "ifffff", { arg msg;
			var id = msg[1].asInteger.clip(1, defs.size) - 1;
			Synth(defs[id], [\out, mixBus, \sendOut, sendBus, \freq, msg[2], \amp, msg[3],
				\pan, msg[4], \bright, msg[5], \decay, msg[6]], voices);
		});

		// night(crickets, rate, frogs, wind)
		this.addCommand("night", "ffff", { arg msg;
			night.set(\crickets, msg[1], \rate, msg[2], \frogs, msg[3], \wind, msg[4]);
		});

		this.addCommand("gust", "f", { arg msg;
			night.set(\gs, msg[1], \gt, 1);
		});

		this.addCommand("owl", "ff", { arg msg;
			Synth(\ff_owl, [\out, mixBus, \sendOut, sendBus, \amp, msg[1], \pan, msg[2]], voices);
		});

		this.addCommand("bird", "ff", { arg msg;
			Synth(\ff_bird, [\out, mixBus, \sendOut, sendBus, \amp, msg[1], \pan, msg[2]], voices);
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
