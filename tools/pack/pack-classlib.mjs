// E0-38 — build-time packer for the SuperCollider class library.
//
// Replaces emscripten's `--preload-file SCClassLibrary@/sc/SCClassLibrary`
// (third_party/supercollider/lang/CMakeLists.txt:418) with an archive the
// page fetches and unpacks into MEMFS before bootInterpreter(). See
// research/class-library-packaging.md for the numbers and the CMake diff.
//
//   node tools/pack/pack-classlib.mjs [--out DIR] [--no-norns] [--quiet]
//
// Writes, into DIR (default tools/pack/build/):
//   sclang-lib.tar           deterministic ustar, the thing that gets unpacked
//   sclang-lib.tar.gz        gzip -9    — the default artifact: self-describing,
//                                         decompressed by DecompressionStream,
//                                         needs no server configuration
//   sclang-lib.tar.br        brotli q11 — for hosts that can serve a
//                                         precompressed sidecar with
//                                         Content-Encoding: br
//   sclang-lib.manifest.txt  sha256 + size + path, one line per file, sorted
//   sclang-lib.json          summary, digests, source roots
//
// Determinism: entries sorted by name, mtime/uid/gid/mode fixed. Identical
// inputs give a byte-identical .tar, so its sha256 identifies a class library.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeTar } from "../../src/engine/tar.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const OUT_DIR = path.resolve(opt("--out", path.join(ROOT, "tools/pack/build")));
const WITH_NORNS = !flag("--no-norns");
const QUIET = flag("--quiet");
const say = (...a) => { if (!QUIET) console.log(...a); };

// --------------------------------------------------------------- sources ----
//
// Archive paths are relative to the unpack root, which is sclang's
// SC_DATA_DIR. That is baked into the binary as "/sc"
// (third_party/supercollider/CMakeLists.txt:102), so "SCClassLibrary/X"
// here lands at "/sc/SCClassLibrary/X" — exactly where --preload-file put it.

const SC_LIB = path.join(ROOT, "third_party/supercollider/SCClassLibrary");
const NORNS_SC = path.join(ROOT, "third_party/norns/sc");
// The two class-library overrides that must be INSIDE the archive, because
// a standalone sclang (boot-test.mjs, no browser host) has nothing to write
// them in later. The browser does: `src/engine/host.ts` writes all twelve of
// `src/engine/sc-overrides/` to this same `/sc/SCClassLibrary/norns/` path at
// boot, over these.
//
// Named rather than walked, and read from `src/` rather than from a second
// copy. E9-92: there WAS a second copy, `spike/sc-overrides`, byte-identical
// and two files behind a tree of twelve — and `spike/` is not published, so
// this build could not have run from a clone of the published tree.
const OVERRIDES = path.join(ROOT, "src/engine/sc-overrides");
const OVERRIDE_FILES = ["NornsJsPollOverride.sc", "NornsJsShmOverride.sc"];

// norns' own classes. The runtime flattens core/ and engines/ into one
// directory, which is what the engine host does today and what
// research/sclang-wasm-osc-proof.md §6 proved compiles.
const NORNS_FILES = [
  "core/Crone.sc", "core/CroneAudioContext.sc", "core/CroneDefs.sc",
  "core/CroneEffects.sc", "core/CroneEngine.sc", "core/CronePoll.sc",
  "core/CroneTester.sc",
  "engines/AudioTaper.sc", "engines/BufUtil.sc", "engines/CroneGenEngine.sc",
  "engines/Engine_PolyPerc.sc", "engines/Engine_PolySub.sc",
  "engines/Engine_SimplePassThru.sc", "engines/Engine_TestSine.sc",
  "engines/PatchMatrix.sc",
];

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

const entries = [];
const seen = new Map();
function add(archivePath, sourcePath) {
  if (seen.has(archivePath)) {
    throw new Error(
      `two sources map to ${archivePath}:\n  ${seen.get(archivePath)}\n  ${sourcePath}`);
  }
  seen.set(archivePath, sourcePath);
  entries.push({ name: archivePath, data: new Uint8Array(fs.readFileSync(sourcePath)), source: sourcePath });
}

if (!fs.existsSync(SC_LIB)) throw new Error(`no SCClassLibrary at ${SC_LIB}`);
for (const rel of walk(SC_LIB)) add("SCClassLibrary/" + rel, path.join(SC_LIB, rel));
const scCount = entries.length;

let nornsCount = 0;
if (WITH_NORNS) {
  for (const rel of NORNS_FILES) {
    add("SCClassLibrary/norns/" + path.basename(rel), path.join(NORNS_SC, rel));
    nornsCount++;
  }
  const ovDir = path.join(OVERRIDES, "SystemOverwrites");
  for (const rel of OVERRIDE_FILES) {
    add("SCClassLibrary/norns/SystemOverwrites/" + rel, path.join(ovDir, rel));
    nornsCount++;
  }
}

// ---------------------------------------------------------------- output ----

const tar = writeTar(entries);
const gz = zlib.gzipSync(tar, { level: 9 });
const br = zlib.brotliCompressSync(tar, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: tar.length,
  },
});

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));
const manifest = sorted
  .map((e) => `${String(e.data.length).padStart(8)}  ${sha(e.data)}  ${e.name}`)
  .join("\n") + "\n";

const payloadBytes = entries.reduce((n, e) => n + e.data.length, 0);
const summary = {
  generatedBy: "tools/pack/pack-classlib.mjs (E0-38)",
  files: entries.length,
  scClassLibraryFiles: scCount,
  nornsFiles: nornsCount,
  payloadBytes,
  tarBytes: tar.length,
  gzipBytes: gz.length,
  brotliBytes: br.length,
  sha256: { tar: sha(tar), gz: sha(gz), br: sha(br), manifest: sha(Buffer.from(manifest)) },
  sources: {
    SCClassLibrary: path.relative(ROOT, SC_LIB).split(path.sep).join("/"),
    norns: WITH_NORNS ? path.relative(ROOT, NORNS_SC).split(path.sep).join("/") : null,
    overrides: WITH_NORNS ? path.relative(ROOT, OVERRIDES).split(path.sep).join("/") : null,
  },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const w = (name, data) => { fs.writeFileSync(path.join(OUT_DIR, name), data); return data.length; };
w("sclang-lib.tar", tar);
w("sclang-lib.tar.gz", gz);
w("sclang-lib.tar.br", br);
w("sclang-lib.manifest.txt", manifest);
w("sclang-lib.json", JSON.stringify(summary, null, 2) + "\n");

const kib = (n) => (n / 1024).toFixed(1).padStart(8) + " KiB";
say(`out            : ${OUT_DIR}`);
say(`files          : ${entries.length}  (${scCount} SCClassLibrary + ${nornsCount} norns)`);
say(`payload        : ${kib(payloadBytes)}`);
say(`sclang-lib.tar : ${kib(tar.length)}`);
say(`        .tar.gz: ${kib(gz.length)}   x${(tar.length / gz.length).toFixed(2)}`);
say(`        .tar.br: ${kib(br.length)}   x${(tar.length / br.length).toFixed(2)}`);
say(`sha256(tar)    : ${summary.sha256.tar}`);
