// E9-41 — the stock drum kit at `~/dust/audio/common/808`, synthesised.
//
// WHY THIS EXISTS. A norns ships a sample library at `~/dust/audio`, and
// `audio/common/808` is part of the image rather than of any script. Here
// that directory was created empty and nothing ever filled it, so a script
// that reads it got a listing of nothing. `bakeneko` does exactly that:
//
//   local pfile = popen('ls -a "' .. configuration.sample_directory .. '"')
//   …
//   return configuration.sample_directory .. "/" .. t[math.random(1, #t)]
//
// With an empty listing `#t` is 0, `math.random(1, 0)` raises "interval is
// empty", and the script dies in `init` — measured, before this existed.
//
// WHY SYNTHESISED, AND SAID OUT LOUD. The Roland samples on a norns are not
// ours to redistribute, and shipping them because they are easy to find is
// the way a compliant bundle quietly becomes an infringing one. These are
// generated here from oscillators and noise: a stand-in with the right
// NAMES and the right rough character, not a copy of anything. The folder
// carries a README saying so, because somebody comparing this to a 909 or
// to the real thing deserves to know which they are hearing.
//
// E9-130 — AND IT IS A DOTFILE, `.README.txt`. The first version was not,
// and `bakeneko` — which this very comment says picks a file from the
// folder at random — drew it, handed a text file to `decodeAudioData`, and
// got a nil buffer that its SuperCollider engine then compared against a
// number. Five forty-line error dumps in one boot. `src/fs/shell.ts` now
// honours the leading dot the way `ls` and a glob do, which is the half of
// this that protects every other folder; the rename is the half that makes
// this one correct even for a caller that enumerates some other way.
//
// WHY THE NAMES ARE NOT INVENTED. Scripts name these files directly —
// `bakeneko`'s first track is `808-BD.wav` — so the set was read off the
// catalogue: every `808-XX.wav` any of the 354 scripts mentions. Seventeen,
// which is the TR-808's voice list.
//
// WHY A GENERATOR AND NOT COMMITTED WAVS. Everything generated in this
// repository is gitignored and rebuilt; the generator is the source. 240 KB
// of binary in git would be the exception, and a silent one.
//
//   import { kit808 } from "./kit-808.mjs"   // used by tools/build-dust.mjs
//   node tools/kit-808.mjs <dir>             // or write them somewhere to listen

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SR = 48000;

/** A 16-bit mono WAV around a float array in [-1, 1]. */
function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32600), 44 + i * 2);
  }
  return buf;
}

const len = (ms) => Math.round((SR * ms) / 1000);

/**
 * A deterministic noise source.
 *
 * `Math.random` would give a different kit on every build, which would make
 * `dust-assets.json` churn for no reason and make two builds impossible to
 * compare. Same seed, same bytes, every time.
 */
function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

/** One-pole high-pass, which is what separates a hat from a kick. */
function highpass(xs, hz) {
  const rc = 1 / (2 * Math.PI * hz);
  const a = rc / (rc + 1 / SR);
  const out = new Float64Array(xs.length);
  let prevX = 0;
  let prevY = 0;
  for (let i = 0; i < xs.length; i++) {
    out[i] = a * (prevY + xs[i] - prevX);
    prevX = xs[i];
    prevY = out[i];
  }
  return out;
}

/** One-pole low-pass, to take the glass off the noise. */
function lowpass(xs, hz) {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / SR);
  const out = new Float64Array(xs.length);
  let y = 0;
  for (let i = 0; i < xs.length; i++) {
    y += a * (xs[i] - y);
    out[i] = y;
  }
  return out;
}

/** A sine whose pitch falls, which is the whole trick of an 808 drum. */
function drop(ms, from, to, decay, curve = 30) {
  const n = len(ms);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = to + (from - to) * Math.exp(-t * curve);
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(phase) * Math.exp(-t * decay);
  }
  return out;
}

/** A noise burst with its own envelope. */
function burst(ms, decay, seed, hp, lp) {
  const n = len(ms);
  const rnd = noise(seed);
  let xs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = rnd();
  if (hp) xs = highpass(xs, hp);
  if (lp) xs = lowpass(xs, lp);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = xs[i] * Math.exp((-i / SR) * decay);
  return out;
}

/** The 808 cymbal and cowbell are square waves beaten together. */
function squares(ms, freqs, decay, seed, hp) {
  const n = len(ms);
  let xs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f of freqs) v += Math.sign(Math.sin((2 * Math.PI * f * i) / SR));
    xs[i] = v / freqs.length;
  }
  if (hp) xs = highpass(xs, hp);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = xs[i] * Math.exp((-i / SR) * decay);
  return out;
}

function mix(...parts) {
  const n = Math.max(...parts.map((p) => p.length));
  const out = new Float64Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

/** Pad or shift a part so it starts late, for the clap's four slaps. */
function at(ms, xs, total) {
  const out = new Float64Array(len(total));
  const start = len(ms);
  for (let i = 0; i < xs.length && start + i < out.length; i++) out[start + i] = xs[i];
  return out;
}

/** Peak-normalise, so no voice is twice as loud as the one beside it. */
function norm(xs, to = 0.9) {
  let peak = 0;
  for (const v of xs) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) return xs;
  const g = to / peak;
  const out = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[i] * g;
  return out;
}

/**
 * The seventeen voices, in the TR-808's own order.
 *
 * Each is one line of synthesis and one line of why it sounds like that,
 * because "CL" and "RS" are not self-explanatory to anybody who has not
 * read an 808 service manual.
 */
const VOICES = {
  // Bass drum: a long falling sine with a click on the front.
  "808-BD": () => norm(mix(drop(700, 115, 47, 7, 55), burst(4, 900, 1, 1200, null))),
  // Bass synth, the kit's one tonal voice — a longer, lower BD.
  "808-BS": () => norm(mix(drop(1200, 70, 41, 3, 40))),
  // Snare: two tuned sines plus a band of noise.
  "808-SD": () =>
    norm(mix(drop(170, 190, 180, 28, 5), drop(140, 330, 320, 34, 5), burst(190, 22, 2, 900, 7000))),
  // Rimshot: a very short ring, almost pitchless.
  "808-RS": () => norm(mix(drop(32, 1700, 1650, 150, 5), burst(14, 400, 3, 2000, null))),
  // Clave: one high sine, dry.
  "808-CL": () => norm(drop(60, 2500, 2480, 70, 5)),
  // Handclap: three slaps 10 ms apart and a tail.
  "808-CP": () => {
    const slap = (s) => burst(12, 300, s, 1000, 4500);
    return norm(
      mix(
        at(0, slap(4), 260),
        at(9, slap(5), 260),
        at(19, slap(6), 260),
        at(27, burst(230, 16, 7, 1000, 4000), 260),
      ),
    );
  },
  // Maracas: a short hiss, high and dry.
  "808-MA": () => norm(burst(55, 70, 8, 5000, null)),
  // Closed hat and open hat: the same six squares, held for different lengths.
  "808-CH": () => norm(squares(60, [263, 400, 421, 474, 587, 845], 70, 9, 7000)),
  "808-OH": () => norm(squares(420, [263, 400, 421, 474, 587, 845], 9, 10, 7000)),
  // Cymbal: the same bank, longer and with noise behind it.
  "808-CY": () =>
    norm(mix(squares(1400, [263, 400, 421, 474, 587, 845], 3.2, 11, 5000), burst(1400, 3.2, 12, 6000, null))),
  // Cowbell: the 808's two squares, a fifth and a bit apart.
  "808-CB": () => norm(squares(320, [540, 800], 11, 13, 400)),
  // Toms, low to high: falling sines with a little noise in the hit.
  "808-LT": () => norm(mix(drop(420, 110, 82, 11, 26), burst(18, 180, 14, 1500, 6000))),
  "808-MT": () => norm(mix(drop(360, 160, 120, 13, 26), burst(18, 180, 15, 1500, 6000))),
  "808-HT": () => norm(mix(drop(300, 230, 175, 15, 26), burst(18, 180, 16, 1500, 6000))),
  // Congas, same shape but tighter and tuned up.
  "808-LC": () => norm(mix(drop(300, 230, 220, 16, 30), burst(10, 300, 17, 2000, 7000))),
  "808-MC": () => norm(mix(drop(260, 310, 300, 18, 30), burst(10, 300, 18, 2000, 7000))),
  "808-HC": () => norm(mix(drop(220, 420, 405, 20, 30), burst(10, 300, 19, 2000, 7000))),
};

/** What the folder says about itself, for anybody who opens it. */
export const KIT_README =
  "This is NOT the Roland TR-808 sample set.\n" +
  "\n" +
  "A norns ships a sample library at ~/dust/audio that is part of the disk\n" +
  "image rather than of any script, and those samples are not norns-js's to\n" +
  "redistribute. Scripts still read this directory by name — bakeneko picks\n" +
  "a file from it at random and names 808-BD.wav outright — so the folder is\n" +
  "filled with sounds SYNTHESISED by tools/kit-808.mjs: oscillators, noise\n" +
  "and envelopes, carrying the right names and the right rough character.\n" +
  "\n" +
  "They are made by this project and are covered by its licence. If you want\n" +
  "the real thing, drop your own files in here; nothing depends on these\n" +
  "bytes, only on the names.\n" +
  "\n" +
  "This file is dotted so that the scripts described above do not find it.\n" +
  "An earlier version was called README.txt, bakeneko duly picked it at\n" +
  "random, and SuperCollider spent forty lines explaining that a text file\n" +
  "is not a sound.\n";

/** The kit, as a map of filename to bytes. Deterministic. */
export function kit808() {
  const out = new Map();
  for (const [name, make] of Object.entries(VOICES)) out.set(`${name}.wav`, wav(make()));
  out.set(".README.txt", Buffer.from(KIT_README, "utf8"));
  return out;
}

// Run directly, or imported by tools/build-dust.mjs. `import.meta.url`
// against a hand-built `file://` URL does not survive Windows paths, so the
// two are compared as paths.
if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "")) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node tools/kit-808.mjs <dir>");
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const [name, data] of kit808()) {
    fs.writeFileSync(path.join(dir, name), data);
    bytes += data.length;
  }
  console.log(`${kit808().size} files, ${(bytes / 1024).toFixed(0)} KB -> ${dir}`);
}
