// Copy the SuperCollider wasm builds and the norns class library into public/.
//
// They live in third_party/, which is 2.5 GB and not tracked. Vite serves
// public/ at the site root, so this is what puts sclang and scsynth where a
// browser can fetch them — and keeps the paths the same in dev and in a build.
//
//   node tools/build-audio-assets.mjs            # report
//   node tools/build-audio-assets.mjs --write    # copy
//
// `locateFile` is why the directory structure is preserved exactly:
// emscripten resolves a .wasm against the script URL but a --preload-file
// .data package against the DOCUMENT, so sclang.data has to sit beside
// sclang.js at the path the loader names (E0-19 lost an afternoon to this).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "third_party/supercollider/build-wasm/wasm-dist");
const NORNS_SC = path.join(ROOT, "third_party/norns/sc");
const PUBLIC = path.join(ROOT, "public");

/** Only what the browser actually loads. The dists also carry READMEs and a dev server. */
const WANTED = new Set([".js", ".wasm", ".data", ".mjs"]);

/** The 15 norns classes the engine host injects into MEMFS. */
const NORNS_FILES = [
  "core/Crone.sc", "core/CroneAudioContext.sc", "core/CroneDefs.sc",
  "core/CroneEffects.sc", "core/CroneEngine.sc", "core/CronePoll.sc",
  "core/CroneTester.sc",
  "engines/AudioTaper.sc", "engines/BufUtil.sc", "engines/CroneGenEngine.sc",
  "engines/Engine_PolyPerc.sc", "engines/Engine_PolySub.sc",
  "engines/Engine_SimplePassThru.sc", "engines/Engine_TestSine.sc",
  "engines/PatchMatrix.sc",
];

const write = process.argv.includes("--write");
let bytes = 0;
let files = 0;

function copyDist(name, as = name) {
  const from = path.join(DIST, name);
  if (!fs.existsSync(from)) {
    console.error(`missing ${path.relative(ROOT, from)} — build it first (tools/sclang/build.sh)`);
    process.exit(1);
  }
  const to = path.join(PUBLIC, as);
  if (write) fs.mkdirSync(to, { recursive: true });
  let n = 0;
  let b = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (!e.isFile() || !WANTED.has(path.extname(e.name))) continue;
    const src = path.join(from, e.name);
    b += fs.statSync(src).size;
    n++;
    if (write) fs.copyFileSync(src, path.join(to, e.name));
  }
  console.log(`  ${as.padEnd(18)} ${String(n).padStart(2)} files, ${(b / 1048576).toFixed(2)} MB`);
  files += n;
  bytes += b;
}

console.log("wasm dists:");
// E4-02: the NO-PRELOAD sclang, served as /sclang/. Its class library is not
// baked into a 2 MB `sclang.data`; it arrives as an archive, below.
//
// The build that still has the preload stays in wasm-dist/sclang/ and is not
// copied — `tools/sclang/build-nopreload.sh` writes its own directory
// precisely so the two can sit side by side and be compared.
copyDist("sclang-nopreload", "sclang");
copyDist("scsynth");

// The class library itself: 373 files, 529 KB gzipped, cached on its own and
// replaceable without touching the binary. `src/engine/classlib-loader.mjs`
// unpacks it into MEMFS before `bootInterpreter`.
const PACK_SRC = path.join(ROOT, "tools", "pack", "build", "sclang-lib.tar.gz");
if (!fs.existsSync(PACK_SRC)) {
  console.error("missing tools/pack/build/sclang-lib.tar.gz — run `node tools/pack/pack-classlib.mjs`");
  process.exit(1);
}
const packOut = path.join(PUBLIC, "pack");
const packBytes = fs.statSync(PACK_SRC).size;
if (write) {
  fs.mkdirSync(packOut, { recursive: true });
  fs.copyFileSync(PACK_SRC, path.join(packOut, "sclang-lib.tar.gz"));
}
console.log(`  pack                1 archive, ${(packBytes / 1048576).toFixed(2)} MB`);
files += 1;
bytes += packBytes;

// The norns class library, flattened the way the host writes it into MEMFS:
// Crone.sc and Engine_PolyPerc.sc end up side by side in one directory.
const scOut = path.join(PUBLIC, "norns-sc");
if (write) fs.mkdirSync(scOut, { recursive: true });
let scN = 0;
let scB = 0;
for (const rel of NORNS_FILES) {
  const src = path.join(NORNS_SC, rel);
  if (!fs.existsSync(src)) {
    console.error(`missing ${rel} in third_party/norns/sc`);
    process.exit(1);
  }
  scB += fs.statSync(src).size;
  scN++;
  if (write) fs.copyFileSync(src, path.join(scOut, path.basename(rel)));
}
console.log(`  norns-sc           ${scN} classes, ${(scB / 1024).toFixed(0)} KB`);

// The SuperCollider CLASSES for the sc3-plugins UGens compiled into scsynth
// by tools/sclang/build.sh. Two halves of one thing and both are needed: the
// UGen makes the sound, the class is what `Decimator.ar` resolves to in
// sclang. Shipping the UGen without the class gives "Class 'Decimator' not
// found"; shipping the class without the UGen gives a SynthDef that builds
// and a server that refuses it.
//
// Optional on purpose: without the checkout the build is what it was, and
// this copies nothing rather than failing.
const SC3_SRC = path.join(ROOT, "third_party", "sc3-plugins", "source");
const SC3_FILES = [
  "DistortionUGens/sc/DistortionPlugins.sc",
  "TJUGens/sc/TJUGens.sc",
  "BlackrainUGens/sc/blackrain_ugens.sc",
  "MdaUGens/sc/MdaUGens.sc",
  // The Faust pair, compiled through the wrappers in tools/sclang/sc3-faust.
  // `JPverb` and `Greyhole` are thin SC classes over `JPverbRaw` and
  // `GreyholeRaw`, which are the UGens the server actually knows.
  "DEINDUGens/sc/JPverb.sc",
  "DEINDUGens/sc/Greyhole.sc",
  // Coyote, the onset detector oooooo's SimpleDelay engine builds its
  // trigger synth from. The UGen was already compiled -- STATIC_PLUGINS
  // builds the whole checkout -- so the only thing missing was the class,
  // and "Nil does not understand the message 'kr'" is what that looks like.
  "BatUGens/sc/BatUGens.sc",
  // EnvFollow, which Pedalboard uses.
  "SLUGens/sc/classes/SLUGens.sc",
];

/**
 * E9-28 — the sets added to reach what norns actually has.
 *
 * These carry too many classes to name one by one (290 between them), so a
 * directory is given instead. What is EXCLUDED is the point:
 *
 *   osx/          a platform extension (`asEnv.sc`), not a UGen class
 *   LJP Classes/  a general-purpose library LoopBufUGens happens to carry,
 *                 including a GUI editor; only `LoopBuf.sc` is wanted
 *   Class Files/  JoshUGens' own spare copies
 *   HelpSource/   documentation
 *
 * A DUPLICATE CLASS NAME DOES NOT DEGRADE SCLANG, IT STOPS IT: the class
 * library fails to compile and nothing runs at all. Every class declared
 * below was checked against SuperCollider's own library and against what is
 * already shipped — 290 new, none clashing — and the copy below refuses a
 * duplicate FILENAME for the same reason, since these land in one flat
 * directory.
 */
const SC3_DIRS = [
  ["AntiAliasingOscillators", "sc"],
  ["MCLDUGens", "sc"],
  ["BhobUGens", "sc/classes"],
  ["SkUGens", "sc"],
  ["SCMIRUGens", "sc/Classes"],
  ["JoshUGens", "sc/classes"],
  ["BerlachUGens", "sc/classes"],
  ["LoopBufUGens", "sc/classes"],
  ["NHUGens", "sc"],
  ["RFWUGens", "sc/classes"],
  ["AuditoryModeling", "sc/Classes"],
  ["BBCut2UGens", "sc"],
  ["BetablockerUGens", "sc"],
  ["ConcatUGens", "sc"],
  ["MembraneUGens", "sc"],
  ["QuantityUGens", "sc"],
  ["RMEQSuiteUGens", "sc"],
  ["SummerUGens", "sc"],
  ["TagSystemUGens", "sc"],
  ["VBAPUGens", "sc"],
  ["VOSIMUGens", "sc"],
  ["ChaosUGens", "sc"],
  ["GlitchUGens", "sc"],
  ["Neuromodules", "sc"],
  ["DWGUGens", "sc/classes"],
  ["OteyPianoUGens", "sc/classes"],
  ["AYUGens", "sc"],
  ["StkUGens", "sc"],
  ["StkInst", "sc/classes"],
  ["PitchDetection", "sc/classes"],
  ["NCAnalysisUGens", "sc/classes"],
];
const SC3_DIR_EXCLUDE = /[/\\](osx|LJP Classes|Class Files|HelpSource|Help)[/\\]/i;

function scFilesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...scFilesUnder(p));
    else if (e.name.endsWith(".sc")) out.push(p);
  }
  return out;
}
let sc3N = 0;
let sc3B = 0;
if (fs.existsSync(SC3_SRC)) {
  const sc3Out = path.join(scOut, "sc3");
  if (write) fs.mkdirSync(sc3Out, { recursive: true });
  for (const rel of SC3_FILES) {
    const src = path.join(SC3_SRC, rel);
    if (!fs.existsSync(src)) {
      console.error(`missing ${rel} in third_party/sc3-plugins/source`);
      process.exit(1);
    }
    sc3B += fs.statSync(src).size;
    sc3N++;
    if (write) fs.copyFileSync(src, path.join(sc3Out, path.basename(rel)));
  }
  // E9-28: the directories.
  const taken = new Map();
  for (const rel of SC3_FILES) taken.set(path.basename(rel), rel);
  for (const [set, sub] of SC3_DIRS) {
    const dir = path.join(SC3_SRC, set, sub);
    if (!fs.existsSync(dir)) {
      console.error(`missing ${set}/${sub} in third_party/sc3-plugins/source`);
      process.exit(1);
    }
    for (const src of scFilesUnder(dir)) {
      if (SC3_DIR_EXCLUDE.test(src.replace(/\\/g, "/"))) continue;
      const base = path.basename(src);
      const prev = taken.get(base);
      if (prev !== undefined) {
        console.error(`two classes would land as ${base}: ${prev} and ${set}/${sub}`);
        process.exit(1);
      }
      taken.set(base, `${set}/${sub}`);
      sc3B += fs.statSync(src).size;
      sc3N++;
      if (write) fs.copyFileSync(src, path.join(sc3Out, base));
    }
  }
  // E9-28: A MANIFEST, so the two halves cannot drift apart.
  //
  // The page used to carry this list hard-coded. Eight names were liveable;
  // seventy-five are not, and a list in two places is a list that goes out
  // of step — which is the exact failure the comment beside it warns about,
  // a class shipped without its UGen or a UGen with no class.
  if (write) {
    fs.writeFileSync(
      path.join(sc3Out, "index.json"),
      JSON.stringify([...taken.keys()].sort(), null, 1),
    );
  }
  console.log(`  norns-sc/sc3       ${sc3N} classes, ${(sc3B / 1024).toFixed(0)} KB`);
} else {
  console.log("  norns-sc/sc3       absent (no third_party/sc3-plugins checkout)");
}

// E9-30 — STK's wavetables, which are DATA and not code.
//
// `StkInst` and `StkUGens` are built from the STK that sc3-plugins vendors,
// and several of its instruments — Plucked, Mandolin, Shakers, Sitar — read
// a `.raw` wavetable at note-on. `Stk::setRawwavePath` decides where from;
// unset, STK looks in `rawwaves/` relative to the process's directory,
// which inside scsynth's wasm filesystem is `/`. So they are shipped and
// `src/engine/host.ts` writes them into `/rawwaves/` before the server
// runs. 45 files, 348 KB.
//
// Without them the UGens exist and the instruments that want a wavetable
// go silent, which is the quiet half-failure this project keeps trying not
// to ship.
const STK_RAW = path.join(SC3_SRC, "..", "external_libraries", "stk", "rawwaves");
let rawN = 0;
let rawB = 0;
if (fs.existsSync(STK_RAW)) {
  const rawOut = path.join(PUBLIC, "stk-rawwaves");
  if (write) fs.mkdirSync(rawOut, { recursive: true });
  const names = fs.readdirSync(STK_RAW).filter((f) => f.endsWith(".raw")).sort();
  for (const name of names) {
    rawB += fs.statSync(path.join(STK_RAW, name)).size;
    rawN++;
    if (write) fs.copyFileSync(path.join(STK_RAW, name), path.join(rawOut, name));
  }
  if (write) fs.writeFileSync(path.join(rawOut, "index.json"), JSON.stringify(names, null, 1));
  console.log(`  stk-rawwaves       ${rawN} files, ${(rawB / 1024).toFixed(0)} KB`);
} else {
  console.log("  stk-rawwaves       absent (no vendored stk)");
}

// E9-35 — the PortedPlugins classes.
//
// A third pack with a third licence (GPL-3) and a directory of its own, so
// a missing checkout reports itself as PortedPlugins rather than as
// sc3-plugins being short of a few files. One `.sc` per plugin, flat.
const PP_SRC = path.join(ROOT, "third_party", "portedplugins", "plugins");
let ppN = 0;
let ppB = 0;
if (fs.existsSync(PP_SRC)) {
  const ppOut = path.join(scOut, "ported");
  if (write) fs.mkdirSync(ppOut, { recursive: true });
  const taken = [];
  for (const dir of fs.readdirSync(PP_SRC).sort()) {
    const at = path.join(PP_SRC, dir);
    if (!fs.statSync(at).isDirectory()) continue;
    for (const f of fs.readdirSync(at).sort()) {
      if (!f.endsWith(".sc")) continue;
      ppB += fs.statSync(path.join(at, f)).size;
      ppN++;
      taken.push(f);
      if (write) fs.copyFileSync(path.join(at, f), path.join(ppOut, f));
    }
  }
  if (write) fs.writeFileSync(path.join(ppOut, "index.json"), JSON.stringify(taken.sort(), null, 1));
  console.log(`  norns-sc/ported    ${ppN} classes, ${(ppB / 1024).toFixed(0)} KB`);
} else {
  console.log("  norns-sc/ported    absent (no portedplugins checkout)");
}

// The mi-UGens classes. A separate pack, a separate licence (GPL-3), and a
// separate directory so that a missing checkout reports itself as mi-UGens
// rather than as sc3-plugins being short of a few files.
//
// MiBraids rides on libsamplerate, which mi-UGens carries as a submodule of
// its own and a plain clone leaves empty. The scsynth build tests the same
// file and leaves the UGen out when it is missing, so the class is tested
// for here too: shipping a class whose UGen is absent gives a SynthDef that
// builds and a server that refuses it.
// E9-36/40 — the single-plugin repositories: the three PTR oscillators
// and ByteBeat, vendored one repository each from
// robbielyman/{FormantTriPTR,pulseptr,triangleptr}. Four scripts bundle an
// ARM `.so` for these and copy it into Extensions, which is the half-state
// E9-33 refuses — so until they were built those scripts could not have
// them at all.
const EXTRA_SRC = path.join(ROOT, "third_party", "sc-plugins-extra");
let extraN = 0;
let extraB = 0;
if (fs.existsSync(EXTRA_SRC)) {
  const extraOut = path.join(scOut, "extra");
  if (write) fs.mkdirSync(extraOut, { recursive: true });
  const taken = [];
  for (const dir of fs.readdirSync(EXTRA_SRC).sort()) {
    const at = path.join(EXTRA_SRC, dir);
    if (!fs.statSync(at).isDirectory()) continue;
    for (const f of fs.readdirSync(at)) {
      if (!f.endsWith(".sc")) continue;
      extraB += fs.statSync(path.join(at, f)).size;
      extraN++;
      taken.push(f);
      if (write) fs.copyFileSync(path.join(at, f), path.join(extraOut, f));
    }
  }
  if (write) fs.writeFileSync(path.join(extraOut, "index.json"), JSON.stringify(taken.sort(), null, 1));
  console.log(`  norns-sc/extra     ${extraN} classes, ${(extraB / 1024).toFixed(0)} KB`);
} else {
  console.log("  norns-sc/extra     absent (no sc-plugins-extra checkout)");
}

const MI_SRC = path.join(ROOT, "third_party", "mi-UGens", "sc", "Classes");
const MI_BRAIDS = fs.existsSync(
  path.join(ROOT, "third_party", "mi-UGens", "projects", "MiBraids", "libsamplerate", "src", "samplerate.c"),
);
// E9-36 — the four added beside the five. MiBeads is not among them and
// cannot be: there is no MiBeads in v7b1/mi-UGens, here or upstream.
const MI_FILES = [
  "MiRings.sc",
  "MiClouds.sc",
  "MiElements.sc",
  "MiPlaits.sc",
  "MiBeads.sc",
  "MiRipples.sc",
  "MiVerb.sc",
  "MiMu.sc",
  "MiOmi.sc",
  // E9-58 — the last three in the checkout, now on the link line too.
  "MiTides.sc",
  "MiWarps.sc",
  "MiGrids.sc",
];
if (MI_BRAIDS) MI_FILES.push("MiBraids.sc");
let miN = 0;
let miB = 0;
if (fs.existsSync(MI_SRC)) {
  const miOut = path.join(scOut, "mi");
  if (write) fs.mkdirSync(miOut, { recursive: true });
  for (const name of MI_FILES) {
    const src = path.join(MI_SRC, name);
    if (!fs.existsSync(src)) {
      console.error(`missing ${name} in third_party/mi-UGens/sc/Classes`);
      process.exit(1);
    }
    miB += fs.statSync(src).size;
    miN++;
    if (write) fs.copyFileSync(src, path.join(miOut, name));
  }
  // A manifest, for the same reason sc3 and ported have one: a list of
  // names kept in the page as well drifts from what is on disk.
  if (write) {
    fs.writeFileSync(path.join(miOut, "index.json"), JSON.stringify([...MI_FILES].sort(), null, 1));
  }
  console.log(`  norns-sc/mi        ${miN} classes, ${(miB / 1024).toFixed(0)} KB`);
} else {
  console.log("  norns-sc/mi        absent (no third_party/mi-UGens checkout)");
}

console.log(`\ntotal ${files + scN} files, ${((bytes + scB + sc3B) / 1048576).toFixed(2)} MB`);
if (write) console.log(`wrote into ${path.relative(ROOT, PUBLIC)}/`);
else console.log("(dry run; pass --write)");
