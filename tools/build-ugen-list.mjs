// The UGens this scsynth actually has, as a list the page can check against.
//
// WHY. scsynth THROWS when a SynthDef names a UGen it does not have, and
// this build has exceptions off, so the throw aborts the thread that handles
// `/d_recv` -- and that thread never comes back. One bad SynthDef kills the
// audio server for the rest of the session: no def loads, no poll reports,
// nothing sounds, while the audio thread keeps running and `/status` keeps
// answering so everything looks fine.
//
// That is not a rare case. A script may ship its OWN SuperCollider class for
// a UGen plugin that is not in this build -- `pedalboard/lib/fx/third_party/
// SmoothFold.sc` declares `SmoothFoldS`, sclang resolves it happily, and the
// server dies on the def. Adding SmoothFold to the build would fix that one
// script and not the next one.
//
// So the page checks the def before sending it, and that needs to know what
// the server has. There is no OSC command that asks, so the list is built
// here, from the same sources the binary was compiled from.
//
// HOW. Every UGen reaches the server through one of the `Define*Unit` macros
// in `SC_InterfaceTable.h`, which take the name either as a bare identifier
// or as a string. Both forms are collected, from exactly the plugin
// directories the build links in.
//
//   node tools/build-ugen-list.mjs            # report
//   node tools/build-ugen-list.mjs --write    # write public/norns-sc/ugens.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");

/**
 * Where to look, and it must match what the link line actually includes.
 *
 * sc3-plugins and mi-UGens are OPTIONAL in the build, so they are optional
 * here: a checkout that is not there contributes no UGens, which is also
 * what the binary does.
 */
const SOURCES = [
  { dir: "third_party/supercollider/server/plugins", required: true },
  // ONLY THE SETS ON THE LINK LINE. Scanning the whole checkout would
  // promise the server UGens it does not have, which is this file's own
  // failure mode inverted. Keep in step with `sc3_plugin_targets` in
  // server/plugins/CMakeLists.txt.
  { dir: "third_party/sc3-plugins/source/DistortionUGens", required: false },
  { dir: "third_party/sc3-plugins/source/TJUGens", required: false },
  { dir: "third_party/sc3-plugins/source/BlackrainUGens", required: false },
  { dir: "third_party/sc3-plugins/source/MdaUGens", required: false },
  { dir: "third_party/sc3-plugins/source/BatUGens", required: false },
  { dir: "third_party/sc3-plugins/source/SLUGens", required: false },
  // E9-28 — the sets added to reach what norns has. Keep in step with
  // `sc3_plugin_targets` in server/plugins/CMakeLists.txt, as above.
  { dir: "third_party/sc3-plugins/source/AntiAliasingOscillators", required: false },
  { dir: "third_party/sc3-plugins/source/MCLDUGens", required: false },
  { dir: "third_party/sc3-plugins/source/BhobUGens", required: false },
  { dir: "third_party/sc3-plugins/source/SkUGens", required: false },
  { dir: "third_party/sc3-plugins/source/SCMIRUGens", required: false },
  { dir: "third_party/sc3-plugins/source/JoshUGens", required: false },
  { dir: "third_party/sc3-plugins/source/BerlachUGens", required: false },
  { dir: "third_party/sc3-plugins/source/LoopBufUGens", required: false },
  { dir: "third_party/sc3-plugins/source/NHUGens", required: false },
  { dir: "third_party/sc3-plugins/source/RFWUGens", required: false },
  { dir: "third_party/sc3-plugins/source/AuditoryModeling", required: false },
  { dir: "third_party/sc3-plugins/source/BBCut2UGens", required: false },
  { dir: "third_party/sc3-plugins/source/BetablockerUGens", required: false },
  { dir: "third_party/sc3-plugins/source/ConcatUGens", required: false },
  { dir: "third_party/sc3-plugins/source/MembraneUGens", required: false },
  { dir: "third_party/sc3-plugins/source/QuantityUGens", required: false },
  { dir: "third_party/sc3-plugins/source/RMEQSuiteUGens", required: false },
  { dir: "third_party/sc3-plugins/source/SummerUGens", required: false },
  { dir: "third_party/sc3-plugins/source/TagSystemUGens", required: false },
  { dir: "third_party/sc3-plugins/source/VBAPUGens", required: false },
  { dir: "third_party/sc3-plugins/source/VOSIMUGens", required: false },
  { dir: "third_party/sc3-plugins/source/ChaosUGens", required: false },
  { dir: "third_party/sc3-plugins/source/GlitchUGens", required: false },
  { dir: "third_party/sc3-plugins/source/Neuromodules", required: false },
  { dir: "third_party/sc3-plugins/source/DWGUGens", required: false },
  { dir: "third_party/sc3-plugins/source/OteyPianoUGens", required: false },
  { dir: "third_party/sc3-plugins/source/AYUGens", required: false },
  { dir: "third_party/sc3-plugins/source/StkUGens", required: false },
  { dir: "third_party/sc3-plugins/source/StkInst", required: false },
  { dir: "third_party/sc3-plugins/source/PitchDetection", required: false },
  { dir: "third_party/sc3-plugins/source/NCAnalysisUGens", required: false },
  { dir: "tools/sclang/sc3-faust", required: false },
  { dir: "third_party/sc-plugins-extra", required: false },
  { dir: "third_party/portedplugins/plugins", required: false },
  { dir: "third_party/mi-UGens/projects", required: false },
];

/**
 * What is actually REGISTERED, which is not the same as what is compiled.
 *
 * `SC_StaticPlugins.h` calls a fixed list of `X_Load(table)` functions, and
 * a plugin whose load is not called contributes nothing however thoroughly
 * it was compiled. `ML.cpp` is the case that taught this: it is on the link
 * line, it defines BeatTrack, Loudness, KeyTrack, MFCC and Onsets, and
 * `ML_UGens_Load` is not called — so those names are in the binary and not
 * in the server.
 *
 * Scanning a file whose load is not called would put them in the list, and
 * a list that over-promises is worse than no list: it lets exactly the def
 * through that kills the server.
 *
 * So the called set is read from the header, and only files declaring a
 * `PluginLoad(X)` with X in that set are scanned.
 */
/**
 * Defines this build sets, which switch whole plugins OFF in the header.
 *
 * Keep in step with tools/sclang/build.sh. `NO_LIBSNDFILE` is the one that
 * matters and the one that cost an afternoon: DiskIO_Load is declared and
 * called inside `#ifndef NO_LIBSNDFILE`, so DiskIn, VDiskIn and DiskOut are
 * compiled out of this binary. A scan that reads the call and ignores the
 * guard promises them, the SynthDef check lets a def through that names
 * one, and scsynth dies on it -- which is exactly the failure the check
 * exists to prevent, arrived at from the other side.
 */
const BUILD_DEFINES = new Set(["NO_LIBSNDFILE", "NO_X11"]);

/**
 * What is actually REGISTERED, which is not the same as what is compiled.
 *
 * `SC_StaticPlugins.h` calls a fixed list of `X_Load(table)` functions, and
 * a plugin whose load is not called contributes nothing however thoroughly
 * it was compiled. `ML.cpp` is the case that taught this: it is on the link
 * line, it defines BeatTrack, Loudness, KeyTrack, MFCC and Onsets, and
 * `ML_UGens_Load` is not called -- so those names are in the binary and not
 * in the server.
 *
 * The preprocessor is read too, lightly: a call inside `#ifndef X` where X
 * is one of this build's defines does not happen.
 */
function calledLoads() {
  const header = path.join(
    ROOT,
    "third_party/supercollider/server/plugins/SC_StaticPlugins.h",
  );
  const called = new Set();
  const stack = [];
  for (const line of fs.readFileSync(header, "utf8").split("\n")) {
    const t = line.trim();
    const ifndef = /^#\s*ifndef\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(t);
    const ifdef = /^#\s*ifdef\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(t);
    if (ifndef !== null) {
      stack.push(!BUILD_DEFINES.has(ifndef[1]));
      continue;
    }
    if (ifdef !== null) {
      // An #ifdef on something we do not define is not necessarily off --
      // STATIC_PLUGINS and SC3_PLUGINS are set by CMake, not here -- so
      // only the ones we KNOW are off are treated as off.
      stack.push(true);
      continue;
    }
    if (/^#\s*if\b/.test(t)) {
      stack.push(true);
      continue;
    }
    if (/^#\s*else\b/.test(t)) {
      if (stack.length > 0) stack[stack.length - 1] = !stack[stack.length - 1];
      continue;
    }
    if (/^#\s*endif\b/.test(t)) {
      stack.pop();
      continue;
    }
    if (stack.some((live) => live === false)) continue;
    const call = /^([A-Za-z_][A-Za-z0-9_]*)_Load\s*\(\s*table\s*\)\s*;/.exec(t);
    if (call !== null) called.add(call[1]);
  }
  if (called.size < 10) {
    console.error("could not read the called loads from SC_StaticPlugins.h");
    process.exit(1);
  }
  return called;
}

const CALLED = calledLoads();
const PLUGIN_LOAD = /PluginLoad\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/;

// EVERY registration form, counted from the sources rather than guessed:
// DefineSimpleUnit, DefineDtorUnit, DefinePVUnit, DefineInfoUnit,
// DefineDelayUnit, DefineSimpleCantAliasUnit, DefineDtorCantAliasUnit,
// DefineBufInfoUnit, DefineUnit, DefineUnitCmdEx. Missing one is not a
// small error: a UGen left out of the list is a SynthDef refused, and the
// first draft of this file dropped DC and ControlDur that way --
// DefineInfoUnit(ControlDur) and a registerUnit<DC>(ft, "DC").
const BARE = /Define[A-Za-z]*Unit[A-Za-z]*\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/g;
const STRING = /Define[A-Za-z]*Unit[A-Za-z]*\s*\(\s*"([^"]+)"/g;
/** The template form, which names itself in a string. */
const TEMPLATE = /registerUnit\s*<[^>]+>\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*"([^"]+)"/g;

const names = new Set();
const skipped = [];
let files = 0;

/**
 * E9-242 — AND A FILE THAT ONLY HAS AN `initX(InterfaceTable*)` BELONGS TO
 * THE LOAD THAT CALLS IT. `Convolution` is defined in `Convolution.cpp`
 * inside `initConvolution`, which `PluginLoad(PV_ThirdParty)` in
 * `FFT2InterfaceTable.cpp` calls. With that load never called, the rule
 * below still scanned `Convolution.cpp` — it owns no load — and the list
 * said the server had Convolution. sclang then sent downtown's SynthDef,
 * and the server refused it. These are the init functions called from
 * loads nobody calls.
 */
const uncomment = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
function deadInits() {
  const dead = new Set();
  // A helper both kinds of load call (`init_SCComplex`) is not dead.
  const live = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git") walk(full);
        continue;
      }
      if (!/\.(cpp|cc|c|h|hpp)$/.test(e.name)) continue;
      const src = uncomment(fs.readFileSync(full, "utf8"));
      const load = PLUGIN_LOAD.exec(src);
      if (load === null) continue;
      const into = CALLED.has(load[1]) ? live : dead;
      for (const m of src.matchAll(/\b(init[A-Za-z0-9_]+)\s*\(\s*inTable\s*\)/g)) into.add(m[1]);
    }
  };
  for (const { dir } of SOURCES) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) walk(full);
  }
  for (const name of live) dead.delete(name);
  return dead;
}
const DEAD_INITS = deadInits();
/** A DEFINITION, with its body: `void initConvolution(InterfaceTable* it) {`. */
const DEFINES_INIT = /\bvoid\s+(init[A-Za-z0-9_]+)\s*\(\s*(?:struct\s+)?InterfaceTable\s*\*\s*[A-Za-z_]*\s*\)\s*\{/g;

function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git") continue;
      scan(full);
      continue;
    }
    if (!/\.(cpp|cc|c|h|hpp)$/.test(e.name)) continue;
    const src = fs.readFileSync(full, "utf8");
    // Names in comments are not registrations: `//DefineDtorUnit(MIDelay);`
    // put five UGens on the list that no server has (E9-242).
    const live = uncomment(src);
    const load = PLUGIN_LOAD.exec(src);
    // SKIP a file that OWNS a load nobody calls; scan everything else.
    //
    // The first rule here was the other way round -- scan only the files
    // that declare a called load -- and it was wrong in a way worth
    // recording: `FFT` is defined in `FFT_UGens.cpp` and registered by the
    // `PluginLoad(FFT_UGens)` in `FFTInterfaceTable.cpp`. A define and its
    // load are routinely in different files, so "has no PluginLoad" does
    // not mean "contributes nothing". Owning an uncalled one does.
    if (load !== null && !CALLED.has(load[1])) {
      skipped.push(`${e.name} (${load[1]}_Load is never called)`);
      continue;
    }
    const init = load === null ? [...live.matchAll(DEFINES_INIT)].find((m) => DEAD_INITS.has(m[1])) : undefined;
    if (init !== undefined) {
      skipped.push(`${e.name} (${init[1]} is called only by a load nobody calls)`);
      continue;
    }
    files++;
    for (const m of live.matchAll(BARE)) names.add(m[1]);
    for (const m of live.matchAll(STRING)) names.add(m[1]);
    for (const m of live.matchAll(TEMPLATE)) names.add(m[1]);
  }
}

for (const { dir, required } of SOURCES) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) {
    if (required) {
      console.error(`missing ${dir}`);
      process.exit(1);
    }
    console.log(`  ${dir.padEnd(44)} absent`);
    continue;
  }
  const before = names.size;
  scan(full);
  console.log(`  ${dir.padEnd(44)} +${names.size - before}`);
}

// The Faust pair name themselves at RUNTIME -- `(*ft->fDefineUnit)` is
// called with a `std::string` built in the wrapper -- so they cannot be
// scanned for. They are listed because the wrappers in
// tools/sclang/sc3-faust define exactly these two and nothing else.
if (fs.existsSync(path.join(ROOT, "tools/sclang/sc3-faust/JPverbRaw_static.cpp"))) {
  names.add("JPverbRaw");
  names.add("GreyholeRaw");
}
// E9-35: PortedPlugins' two Faust reverbs, the same way and for the same
// reason. Left out, the SynthDef guard in NornsJsSynthDefOverride.sc
// refuses every def that uses them — which is how this was noticed:
//   norns-js: NOT sending SynthDef pp_fverb -- it uses Fverb, which this
//   build of scsynth does not have.
if (fs.existsSync(path.join(ROOT, "tools/sclang/sc3-faust/Fverb_static.cpp"))) {
  names.add("Fverb");
  names.add("Fverb2");
}

const sorted = [...names].sort();
console.log(`\n${sorted.length} UGens from ${files} files`);

// A sanity floor. SuperCollider's own plugins are several hundred UGens, and
// a regex that silently stopped matching would otherwise produce an empty
// list -- which would refuse every SynthDef instead of the bad one.
if (sorted.length < 300) {
  console.error(`only ${sorted.length} UGens found; the scan is broken`);
  process.exit(1);
}

/**
 * E9-57 — what the mi-UGens set in this build IS, in its own words.
 *
 * `terrarium/lib/needs.lua` will not play until it can tell WHICH mi-UGens
 * are installed: not the count, not the class names — those it already
 * finds — but whether the build carries Beads. It asks the way the set's
 * own installer answers, by reading `Extensions/mi-UGens/BUILDINFO` for a
 * `prs:` line naming 24 and a `built:` no older than the one it pins.
 *
 * Both are things this build can say and have them be true. MiBeads IS
 * pull request 24 of v7b1/mi-UGens, curled as `pull/24.diff` and applied
 * as `patches/mi-UGens.patch` (E9-38, 43 files); `built:` is the mtime of
 * the scsynth these UGens are compiled into, read here rather than
 * written down, so it cannot drift from the binary.
 *
 * It is NOT a copy of anybody's release marker, and it says so in its
 * first line. Nothing here claims to be the tarball terrarium downloads —
 * the claim is only what this build contains, which is the question.
 */
function buildinfo() {
  const wasm = path.join(ROOT, "public", "scsynth", "scsynth.wasm");
  let built = null;
  try {
    built = new Date(fs.statSync(wasm).mtimeMs).toISOString().replace(/\.\d+Z$/, "Z");
  } catch {
    return null; // no binary, nothing to describe
  }
  const mi = [...names].filter((n) => /^Mi[A-Z]/.test(n)).sort();
  if (mi.length === 0) return null;
  return [
    "# mi-UGens, as norns-js builds them. NOT a release tarball's marker:",
    "# these UGens are compiled INTO scsynth, because wasm has no dlopen,",
    "# and the classes beside them under Extensions are that build's own.",
    "# This file exists because scripts ask what the set is, and every line",
    "# below is a fact about the binary that is actually running.",
    "name: mi-UGens",
    "source: https://github.com/v7b1/mi-UGens @ 10f6824f68ad (v0.0.9)",
    "prs: 24 — MiBeads, from Calebcrittenden/mi-UGens, applied as patches/mi-UGens.patch",
    `built: ${built}`,
    "by: norns-js",
    `ugens: ${mi.join(" ")}`,
    "",
  ].join("\n");
}

if (write) {
  const out = path.join(ROOT, "public", "norns-sc", "ugens.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(sorted) + "\n");
  console.log(`wrote ${path.relative(ROOT, out)}`);

  const info = buildinfo();
  if (info !== null) {
    const bi = path.join(ROOT, "public", "norns-sc", "mi", "BUILDINFO");
    fs.mkdirSync(path.dirname(bi), { recursive: true });
    fs.writeFileSync(bi, info);
    console.log(`wrote ${path.relative(ROOT, bi)}`);
  }
} else {
  console.log("(dry run; pass --write)");
  const info = buildinfo();
  if (info !== null) console.log("\n" + info);
}
