// norns-js: DiodeRingMod, from sc3-plugins' DEINDUGens, without the binary.
//
// E9-215. dronecaster builds every drone when its engine starts, and one of
// them, UNREANTH, rings two oscillators through `DiodeRingMod`. The UGen is
// not compiled into this scsynth, so sclang said "Undefined class", the
// drone's function came back nil, and the error climbed out of the loop
// that builds them: no drone at all, for all thirty-seven.
//
// THE UGEN HAS NO STATE, so it does not need to be compiled to be exact.
// `DiodeRingMod.cpp` is, per sample:
//
//     in1 = car + 0.5 mod        in2 = car - 0.5 mod
//     out = d(in1) + d(-in1) - d(in2) - d(-in2)
//
// with the diode curve d (v_b = 0.2, v_l = 0.6, h = 1):
//
//     x <= 0.2         0
//     0.2 < x <= 0.6   1.25 (x - 0.2)^2
//     x > 0.6          x - 0.4
//
// which is, without a branch, 1.25 (clip(x, 0.2, 0.6) - 0.2)^2 + max(x - 0.6, 0):
// the curve stops growing at 0.6, where it is worth 0.2, and the straight
// part takes over from there. Same numbers, built from core UGens the
// server has. Its inputs are made audio rate, as the UGen's own are.

DiodeRingMod : UGen {
	*ar { arg car = 0.0, mod = 0.0;
		var c = car.asAudioRateInput, m = mod.asAudioRateInput;
		var in1 = c + (0.5 * m), in2 = c - (0.5 * m);
		^this.nornsJsDiode(in1) + this.nornsJsDiode(in1.neg)
			- this.nornsJsDiode(in2) - this.nornsJsDiode(in2.neg)
	}

	*nornsJsDiode { arg x;
		^(1.25 * (x.clip(0.2, 0.6) - 0.2).squared) + (x - 0.6).max(0)
	}
}
