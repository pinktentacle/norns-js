// E9-33 — the SuperCollider Extensions tree, as a statement of fact.
//
// Thirteen catalogue scripts decide whether a UGen is available BY LOOKING
// FOR A FILE:
//
//   bitters      util.file_exists(ext.."/PulsePTR/PulsePTR.sc")
//   pedalboard   required_files = { ext.."/MiClouds/MiClouds.so", … }
//   amenbreak    find … -name AnalogTape_scsynth.so -print
//   twins        find … -name 'AnalogChew.sc' …
//
// On hardware that question is well posed: a UGen arrives as a `.so` and a
// `.sc` in that directory, so the file IS the capability. Here the UGens
// are compiled into scsynth and the directory was empty, so every one of
// those scripts took its fallback path while a working engine sat beside
// it unused.
//
// So the directory is written at boot from what the server ACTUALLY
// reports — `ugens.json`, which `tools/build-ugen-list.mjs` derives from
// the binary. A file appears exactly when the capability does, which keeps
// the scripts' question honest rather than merely answered.
//
// WHEN THIS WAS WRITTEN only `pedalboard` asked about something the build
// had; the other twelve asked for the PortedPlugins family, `ByteBeat`,
// `Fverb` and the three `*PTR` oscillators, and were told no. E9-35,
// E9-36 and E9-40 built all of those in, and not a line here had to
// change to make the answer yes — which is what driving this from the
// server's own report buys. What is added below is only the SHAPES the
// newly-true answers have to be written in, because each pack installs
// itself differently and every script tests the shape its pack makes.

import type { Vfs } from "../fs/vfs.js";

/** Both directories the scripts look in. The first is the one they write. */
export const EXTENSIONS_DIRS = [
  "/home/we/.local/share/SuperCollider/Extensions",
  "/usr/local/share/SuperCollider/Extensions",
] as const;

/**
 * The UGens that arrive as their own package directory, `<N>/<N>.sc`.
 *
 * This is the shape `pedalboard` tests and the shape v7b1/mi-UGens
 * installs. The sc3-plugins classes use a different one and are placed
 * below.
 */
const PER_PACKAGE: readonly (readonly [string, string])[] = [
  ["MiClouds", "mi"],
  ["MiRings", "mi"],
  ["MiElements", "mi"],
  ["MiPlaits", "mi"],
  ["MiBraids", "mi"],
  ["MiBeads", "mi"],
  ["MiMu", "mi"],
  ["MiOmi", "mi"],
  ["MiRipples", "mi"],
  ["MiVerb", "mi"],
  // E9-58 — the last three of the pack, built in rather than left out.
  ["MiTides", "mi"],
  ["MiWarps", "mi"],
  ["MiGrids", "mi"],
  // E9-36: the same shape, and the one `bitters` tests by name --
  // `util.file_exists(ext.."/PulsePTR/PulsePTR.sc")`.
  ["PulsePTR", "extra"],
  ["TrianglePTR", "extra"],
  ["FormantTriPTR", "extra"],
];

/** What a marker file says, for anybody who opens one. */
const MARKER = (name: string, kind: string): string =>
  `# ${name} is compiled into scsynth, not loaded from this file.\n` +
  `#\n` +
  `# norns-js builds its UGens into the server because wasm has no dlopen.\n` +
  `# This ${kind} exists because scripts ask whether a UGen is available by\n` +
  `# looking for it, and the honest answer here is yes.\n`;

export interface DeclareOptions {
  /** Where to read from. Defaults to the page's own asset paths. */
  readonly fetchText?: (url: string) => Promise<string | null>;
  readonly fetchJson?: (url: string) => Promise<unknown>;
  readonly log?: (line: string) => void;
}

async function defaultText(url: string): Promise<string | null> {
  const r = await fetch(url);
  return r.ok ? r.text() : null;
}

async function defaultJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/**
 * Write the Extensions tree, and answer how many UGens it declares.
 *
 * Safe to call more than once: it writes the same paths.
 */
export async function declareExtensions(vfs: Vfs, opts: DeclareOptions = {}): Promise<number> {
  const text = opts.fetchText ?? defaultText;
  const json = opts.fetchJson ?? defaultJson;
  const ext = EXTENSIONS_DIRS[0];

  let names: Set<string>;
  try {
    const body = await json("/norns-sc/ugens.json");
    const list = Array.isArray(body) ? body : [];
    names = new Set(list.filter((x): x is string => typeof x === "string"));
  } catch {
    return 0; // no report, no claims
  }
  if (names.size === 0) return 0;

  /** Everything this call vouches for. Anything else there is a leftover. */
  const ours = new Set<string>();
  const put = (path: string, body: string): void => {
    vfs.write(path, body);
    ours.add(path);
  };

  let declared = 0;
  for (const [name, dir] of PER_PACKAGE) {
    if (!names.has(name)) continue;
    const src = await text(`/norns-sc/${dir}/${name}.sc`);
    if (src === null) continue;
    put(`${ext}/${name}/${name}.sc`, src);
    put(`${ext}/${name}/${name}.so`, MARKER(name, "file"));
    put(`${ext}/${name}/${name}.cpp`, MARKER(name, "file"));
    declared++;
  }

  // E9-57 — what the mi set IS, for a script that asks rather than looks.
  //
  // `terrarium/lib/needs.lua` finds all seven classes it needs — its own
  // `find` lists them — and still will not play, because the question it
  // asks next is which BUILD they came from:
  //
  //     local f = io.open(EXT .. "/mi-UGens/BUILDINFO", "r")
  //     ... info:match("\nprs:[^\n]*%f[%d]24%f[%D]") and built >= BUILT
  //
  // It wants a set carrying Beads, which is pull request 24, and one built
  // no earlier than the one it pins. Both are true here and neither is a
  // claim about anybody's tarball: MiBeads IS that pull request (E9-38,
  // curled as pull/24.diff, applied as patches/mi-UGens.patch), and
  // `built:` is the mtime of the scsynth it is compiled into.
  //
  // Written only when the server reports the set, like everything else in
  // this module. tools/build-ugen-list.mjs makes the file from the binary.
  if (PER_PACKAGE.some(([name, dir]) => dir === "mi" && names.has(name))) {
    const info = await text("/norns-sc/mi/BUILDINFO");
    if (info !== null) {
      put(`${ext}/mi-UGens/BUILDINFO`, info);
      declared++;
    }
  }

  // E9-40 — ByteBeat, in the shape `bitebeet` tests, which is its own.
  // `lib/install.lua` builds a three-file manifest and opens every one
  // of them before it will run:
  //
  //   <ext>/ByteBeat/ByteBeat/ByteBeat_scsynth.so
  //   <ext>/ByteBeat/ByteBeat/Classes/ByteBeat.sc
  //   <ext>/ByteBeat/ByteBeat/Classes/ByteBeatController.sc
  //
  // The doubled directory is not a typo of ours: the installer copies a
  // release tarball that already contains a `ByteBeat/` into a path it
  // builds as `INSTALL_DIR .. name .. '/' .. name`. Miss it and the
  // script offers to download an ARM binary instead of making a sound.
  if (names.has("ByteBeat")) {
    const home = `${ext}/ByteBeat/ByteBeat`;
    for (const cls of ["ByteBeat", "ByteBeatController"]) {
      const src = await text(`/norns-sc/extra/${cls}.sc`);
      if (src === null) continue;
      put(`${home}/Classes/${cls}.sc`, src);
    }
    if (vfs.exists(`${home}/Classes/ByteBeat.sc`)) {
      put(`${home}/ByteBeat_scsynth.so`, MARKER("ByteBeat", "file"));
      declared++;
    }
  }

  // E9-35 — the PortedPlugins classes, flat, under the name that pack
  // installs itself as. `twins` asks with `find … -name 'AnalogChew.sc'`
  // and `amenbreak` with `find … -name AnalogTape_scsynth.so`, so the
  // depth does not matter and the two spellings both have to exist.
  // Only the ones the server really reports: thirteen of this pack's
  // classes need daisysp or Eigen and are not compiled in, and a file
  // for one of those would be the lie this whole module exists to avoid.
  try {
    const index = await json("/norns-sc/ported/index.json");
    for (const f of Array.isArray(index) ? index : []) {
      if (typeof f !== "string" || !f.endsWith(".sc")) continue;
      const stem = f.slice(0, -3);
      if (!names.has(stem)) continue;
      const src = await text(`/norns-sc/ported/${f}`);
      if (src === null) continue;
      put(`${ext}/PortedPlugins/${f}`, src);
      put(`${ext}/PortedPlugins/${stem}_scsynth.so`, MARKER(stem, "file"));
      declared++;
    }
  } catch {
    /* no PortedPlugins classes in this build */
  }

  // The sc3-plugins classes, under the directory name three scripts use
  // when they install that pack by hand. A `find … -name 'X.sc'` reaches
  // them at any depth, which is how twins and amenbreak ask.
  try {
    const index = await json("/norns-sc/sc3/index.json");
    const files = Array.isArray(index) ? index : [];
    for (const f of files) {
      if (typeof f !== "string" || !f.endsWith(".sc")) continue;
      const src = await text(`/norns-sc/sc3/${f}`);
      if (src === null) continue;
      put(`${ext}/supercollider-plugins/${f}`, src);
      declared++;
    }
  } catch {
    /* no sc3 classes in this build */
  }

  // AUTHORITATIVE, NOT ADDITIVE — and this is the half that matters after
  // a reload. A session before this existed could have a script's own copy
  // sitting here: `bitters` writes its bundled `PulsePTR.sc` in and OPFS
  // keeps it, so the next boot would find a class whose UGen is in no
  // binary and the script would ask for an engine that cannot load. The
  // directory says what the SERVER has; anything else in it is a claim
  // nobody can honour.
  let swept = 0;
  for (const dir of EXTENSIONS_DIRS) {
    for (const p of vfs.walk(dir)) {
      if (ours.has(p)) continue;
      vfs.remove(p);
      swept++;
    }
  }
  opts.log?.(
    `extensions: ${declared} declared in ${ext}` +
      (swept > 0 ? `, ${swept} stale file(s) removed` : ""),
  );
  return declared;
}

/** True when a path is inside either Extensions directory. */
export function insideExtensions(path: string): boolean {
  return EXTENSIONS_DIRS.some((d) => path === d || path.startsWith(d + "/"));
}
