// E6-06 — pack the community scripts into the dust tree.
//
// `community patches/<category>/<script>/…` becomes
// `/home/we/dust/code/<script>/…`. The categories are our filing, not norns':
// a norns has a flat `dust/code`, and SELECT's `find -mindepth 2` counts
// directory levels, so an extra one would hide every script.
//
// Output is ONE file, fetched once at boot and unpacked synchronously, rather
// than 439 modules inlined into the JS bundle. Three reasons: the bundle stays
// about the application, the browser can cache the scripts across deploys of
// it, and `io.open` is synchronous — a lazily fetched file cannot be read by
// Lua, which has nowhere to await.
//
//   node tools/build-dust.mjs            # report
//   node tools/build-dust.mjs --write    # write public/dust.json
//
// Text only. Audio samples and images are left on disk: they are 51 of the
// 56 MB and a script that needs one fails at the sample load, honestly and
// where the user can see it.

import fs from "node:fs";
import { parseWavHeader } from "../src/fs/wav-header.ts";
import path from "node:path";
import zlib from "node:zlib";
import { KIT_README, KIT_README_PATH, kit808 } from "./kit-808.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "community patches");
const OUT = path.join(ROOT, "public", "dust.json");
/**
 * Where a script's SOUND FILES go, and why they are not in dust.json.
 *
 * `amen` ships 11 MB of WAV and cannot work without one of them — its break
 * is the whole script. Inlining that would put 12 MB of base64 in front of
 * every page load for a file most sessions never touch, so the audio is
 * copied out as ordinary files and dust.json carries a MANIFEST of path,
 * url and size instead. The VFS answers `exists` and `size` from the
 * manifest and fetches the bytes the first time something actually wants
 * them (src/fs/vfs.ts, `mountRemote`).
 */
const BIN_DIR = path.join(ROOT, "public", "dust-bin");
// Images join the audio: `screen.display_png` and `screen.load_png` read
// from the tree (E5-24), and mi-eng draws sixteen waveform pictures from
// `lib/waves/`. Lazy like everything here -- the file is a URL in the
// manifest and nothing fetches it until a script asks.
const BIN_EXT = new Set([".wav", ".aif", ".aiff", ".flac", ".ogg", ".mp3", ".png"]);
/** One sound file this big is a sample library, not a script's asset. */
const MAX_BIN_BYTES = 16 * 1024 * 1024;

/** What a script is made of, as far as norns is concerned. */
const TEXT_EXT = new Set([".lua", ".sc", ".txt", ".md", ".json", ".toml", ".csv"]);
/**
 * Licence files, which have no extension and were therefore being skipped.
 *
 * Not a detail: a GPL script may be redistributed only WITH its licence,
 * and twelve of the bundled scripts are GPL. Shipping the code and leaving
 * the LICENSE behind is the one way to turn a compliant bundle into an
 * infringing one by accident.
 */
const LICENCE_FILE = /^(licen[sc]e|copying|notice|authors)(\.(md|txt))?$/i;
/** Never useful inside a dust tree, and large. */
/**
 * Directories inside a SCRIPT that are never part of it.
 *
 * `audio` used to be in this list, and it was wrong. On a norns,
 * `~/dust/audio` is the user's sample library and skipping it makes sense —
 * but this walks `<script>/`, where `audio/` is the script's OWN demo
 * material. It cost `timber/audio/piano-c.wav`, which `timber/keys.lua`
 * loads by itself on the first run: a script that is playable the moment
 * it opens on hardware arrived here silent, with nothing to say why.
 */
const SKIP_DIRS = new Set([".git", ".github", "node_modules", "img", "images", "screenshots"]);
/** One file this big is a mistake, not a script. */
const MAX_BYTES = 512 * 1024;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// Read before the check below needs it: `const` is not hoisted.
const noScripts = process.argv.includes("--no-scripts");

// E9-82 — `--no-scripts` DOES NOT NEED THE CORPUS, and used to insist on it.
//
// The deploy build is the one that ships nobody else's work, and it was the
// one build that could not be made without 91 MB of other people's scripts
// on disk: this exited 1 with `no "community patches" directory` before it
// had looked at the flag. A machine doing a release had to hold the corpus
// in order to leave it out.
//
// The other two builds still refuse, and loudly: without the corpus they
// would silently produce an empty tree, which is the same output
// `--no-scripts` asks for ON PURPOSE and would be indistinguishable from a
// successful run.
if (!fs.existsSync(SOURCE)) {
  if (!noScripts) {
    console.error(`no "community patches" directory at ${SOURCE}`);
    process.exit(1);
  }
  console.log(`no "community patches" directory — nothing to leave out (--no-scripts)`);
}

const categories = fs.existsSync(SOURCE)
  ? fs
      .readdirSync(SOURCE, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  : [];

const tree = {};
// Hoisted: the copy loop below needs it, and it used to be decided after.
const write = process.argv.includes("--write");

// E9-128 — THE SIDECARS ARE CLEARED FIRST, because this script only ever
// added to them.
//
// `public/dust-bin/` is where a file too big to inline goes: the index in
// `dust.json` points at `/dust-bin/<script>/...` and the page fetches it
// when something reads it. Nothing else writes there and it is gitignored,
// so everything in it came from a previous run of THIS script.
//
// Which is the bug. A `--no-scripts` run writes a new index that names only
// the stock 808 kit, and left every sidecar the last `--scripts` run had
// put there: `vite build` copies `public/` wholesale, so `dist/dust-bin/`
// came out at 19 MB holding amen, beets, dreamsequence and foulplay — other
// people's sample files, in the build whose whole purpose is to serve none
// of them. Seventeen of the thirty-five scripts tested with carry no licence
// at all, which means all rights reserved.
//
// Measured, not reasoned about: `dist/dust-bin` 19 MB against a `dust.json`
// that named 0 files under `dust/code`. The index was right and the folder
// beside it was not, which is exactly how this kind of thing survives a
// check. Same family as E9-123, one layer down.
if (write) {
  fs.rmSync(BIN_DIR, { recursive: true, force: true });
}

/**
 * `--redistributable` leaves out the scripts nobody has given us permission
 * to serve (E7-13).
 *
 * Running a script on your own machine is not distribution; serving it from
 * a public URL is, and a script with no licence defaults to all rights
 * reserved. Seventeen of the thirty-five are in that position. They stay in
 * the repository and stay usable locally — and anyone can still install one
 * themselves through the gear, which IS their own copy and not ours.
 *
 * The list is read from `licences.json`, generated by
 * `tools/audit-licences.mjs`, so adding a script re-runs the audit rather
 * than relying on someone remembering to edit a list.
 */
/**
 * `--no-scripts` ships a norns with an EMPTY script folder (E6-11).
 *
 * The community dialogue reads norns.community's catalogue live and
 * installs any of its 354 entries straight from the author's repository, so
 * a deployed copy does not have to carry anybody's work to be useful — it
 * carries the means to fetch it. That also settles E7-13 outright: nothing
 * of anyone else's is being served by us at all.
 *
 * The default still packs everything, because the default build is for
 * working on this and the exerciser needs scripts to exercise.
 */
const redistributableOnly = process.argv.includes("--redistributable");
let allowed = null;
if (redistributableOnly) {
  const auditPath = path.join(ROOT, "docs", "licences.json");
  if (!fs.existsSync(auditPath)) {
    console.error("licences.json is missing. Run: node tools/audit-licences.mjs");
    process.exit(1);
  }
  const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
  allowed = new Set(audit.list.filter((s) => s.redistributable).map((s) => s.name));
}
let skippedUnlicensed = 0;

const scripts = [];
const assets = {};
let skippedBinary = 0;
let skippedLarge = 0;
let assetBytes = 0;

for (const category of categories) {
  const catDir = path.join(SOURCE, category);
  for (const e of fs.readdirSync(catDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    if (noScripts) {
      skippedUnlicensed++;
      continue;
    }
    if (allowed && !allowed.has(name)) {
      skippedUnlicensed++;
      continue;
    }
    const scriptDir = path.join(catDir, name);
    let kept = 0;
    let bytes = 0;

    for (const file of walk(scriptDir)) {
      const ext = path.extname(file).toLowerCase();
      if (BIN_EXT.has(ext)) {
        const stat = fs.statSync(file);
        if (stat.size > MAX_BIN_BYTES) {
          skippedLarge++;
          continue;
        }
        const rel = path.relative(scriptDir, file).split(path.sep).join("/");
        const vpath = `/home/we/dust/code/${name}/${rel}`;
        const dest = path.join(BIN_DIR, name, rel);
        if (write) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(file, dest);
        }
        // The header, read once here, so `audio.file_info` can answer
        // without the bytes. A script that computes a duration from it and
        // gets nothing produces NaN all the way down: `amen` asks its
        // engine to load `nan` samples and draws NaN/NaN on screen.
        const head = fs.readFileSync(file);
        const info = ext === ".wav" ? parseWavHeader(head) : null;
        assets[vpath] = {
          url: `/dust-bin/${name}/${rel}`,
          size: stat.size,
          ...(info ? { audio: info } : {}),
        };
        assetBytes += stat.size;
        continue;
      }
      if (!TEXT_EXT.has(ext) && !LICENCE_FILE.test(path.basename(file))) {
        skippedBinary++;
        continue;
      }
      const stat = fs.statSync(file);
      if (stat.size > MAX_BYTES) {
        skippedLarge++;
        continue;
      }
      const rel = path.relative(scriptDir, file).split(path.sep).join("/");
      tree[`/home/we/dust/code/${name}/${rel}`] = fs.readFileSync(file, "utf8");
      kept++;
      bytes += stat.size;
    }
    scripts.push({ name, category, files: kept, bytes });
  }
}

// E9-41 — the one part of the tree that is not a script.
//
// A norns ships a sample library at `~/dust/audio`, and `audio/common/808`
// belongs to the IMAGE rather than to any script, so nothing in
// `community patches/` could ever have produced it. Here that directory
// was created empty and stayed empty, and `bakeneko` — which lists it and
// picks a file at random — died in `init` on `math.random(1, 0)`.
//
// The sounds are synthesised, not Roland's: see tools/kit-808.mjs for why,
// and `audio/common/.808-README.txt` says so BESIDE the folder. Not in it
// (E9-230): bakeneko lists the folder with `ls -a` and picked the note at
// random, dotted or not, and a norns' 808 folder holds only the sounds.
// Text goes INLINE, because `io.open` is synchronous and a lazily fetched
// file has nowhere to await. A README nobody can read is not a README.
tree[KIT_README_PATH] = KIT_README;
const KIT_DIR = '/home/we/dust/audio/common/808';
let kitFiles = 0;
let kitBytes = 0;
for (const [name, data] of kit808()) {
  const vpath = `${KIT_DIR}/${name}`;
  const dest = path.join(BIN_DIR, '_stock', 'audio', 'common', '808', name);
  if (write) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  assets[vpath] = {
    url: `/dust-bin/_stock/audio/common/808/${name}`,
    size: data.length,
    ...(parseWavHeader(data) ? { audio: parseWavHeader(data) } : {}),
  };
  assetBytes += data.length;
  kitFiles++;
  kitBytes += data.length;
}

// A SEPARATE file, not a key in dust.json: every consumer of dust.json
// treats it as a flat path -> text map, and widening that shape to carry a
// manifest would make each of them learn the difference.
const ASSETS_OUT = path.join(ROOT, "public", "dust-assets.json");

const json = JSON.stringify(tree);
const gz = zlib.gzipSync(Buffer.from(json), { level: 9 }).length;

console.log(`${scripts.length} scripts from ${categories.length} categories`);
for (const c of categories) {
  const inCat = scripts.filter((s) => s.category === c);
  console.log(
    `  ${c.padEnd(20)} ${String(inCat.length).padStart(2)} scripts, ` +
      `${inCat.reduce((n, s) => n + s.files, 0)} files`,
  );
}
console.log();
console.log(`  files packed      ${Object.keys(tree).length}`);
console.log(`  skipped, binary   ${skippedBinary}`);
if (noScripts) {
  console.log(`  skipped, all scripts ${skippedUnlicensed} (--no-scripts)`);
} else if (allowed) {
  console.log(`  skipped, no licence ${skippedUnlicensed} (--redistributable)`);
}
console.log(`  skipped, >512 KB  ${skippedLarge}`);
console.log(`  dust.json         ${(json.length / 1048576).toFixed(2)} MB raw, ${(gz / 1048576).toFixed(2)} MB gzip`);
console.log(
  `  sound files       ${Object.keys(assets).length} kept out of line, ` +
    `${(assetBytes / 1048576).toFixed(1)} MB (fetched only when read)`,
);
console.log(
  `  stock 808 kit     ${kitFiles} synthesised files, ${(kitBytes / 1024).toFixed(0)} KB ` +
    `at ${KIT_DIR}`,
);

const noMain = scripts.filter((s) => !tree[`/home/we/dust/code/${s.name}/${s.name}.lua`]);
if (noMain.length) {
  // Not fatal: some scripts name their entry point differently, and SELECT
  // lists every .lua outside lib/data/crow/test/docs rather than just one.
  console.log(`  no <name>.lua     ${noMain.length}: ${noMain.map((s) => s.name).join(", ")}`);
}

if (write) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  fs.writeFileSync(ASSETS_OUT, JSON.stringify(assets, null, 2) + "\n");
  console.log(`\nwrote ${path.relative(ROOT, OUT)} and ${path.relative(ROOT, ASSETS_OUT)}`);
}
