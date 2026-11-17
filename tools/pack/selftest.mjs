// E0-38 — verify the packer and the loader without touching sclang.
//
//   node tools/pack/selftest.mjs
//
// Checks, in order:
//   1  the archive round-trips: every entry byte-identical to its source file
//   2  the archive's SCClassLibrary file set is EXACTLY the set sclang.data
//      carries today, read out of sclang.js's own package metadata
//   3  the loader writes the same bytes into an FS (a stub standing in for
//      MEMFS), from the .tar.gz, through DecompressionStream
//   4  GNU tar, if present, can list and extract our archive  (the "diffable
//      and greppable" claim, tested rather than asserted)
//   5  our reader can read an archive GNU tar produced
//   6  how long gunzip + untar + write takes in this Node
//
// Exit code 0 = all passed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readTar, writeTar } from "../../src/engine/tar.js";
import { loadClassLibrary } from "../../src/engine/classlib-loader.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUILD = path.join(ROOT, "tools/pack/build");
const SCLANG_JS = path.join(ROOT, "third_party/supercollider/build-wasm/wasm-dist/sclang/sclang.js");

let failures = 0;
const ok = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "\n          " + detail : ""}`);
};

// ------------------------------------------------------------------- 0 ----
if (!fs.existsSync(path.join(BUILD, "sclang-lib.tar"))) {
  console.error("no archive yet - run:  node tools/pack/pack-classlib.mjs");
  process.exit(2);
}
const tar = new Uint8Array(fs.readFileSync(path.join(BUILD, "sclang-lib.tar")));
const gz = new Uint8Array(fs.readFileSync(path.join(BUILD, "sclang-lib.tar.gz")));
const summary = JSON.parse(fs.readFileSync(path.join(BUILD, "sclang-lib.json"), "utf8"));
console.log(`archive: ${tar.length} B tar, ${gz.length} B gz, ${summary.files} files\n`);

// ------------------------------------------------------------------- 1 ----
const { entries, skipped } = readTar(tar);
ok("round-trip: entry count", entries.length === summary.files,
   `${entries.length} read, ${summary.files} packed`);
ok("round-trip: no skipped headers", skipped === 0, `skipped=${skipped}`);

const SC_LIB = path.join(ROOT, "third_party/supercollider/SCClassLibrary");
const NORNS = path.join(ROOT, "third_party/norns/sc");
const OVR = path.join(ROOT, "src/engine/sc-overrides");
const nornsByName = new Map();
for (const d of ["core", "engines"]) {
  for (const f of fs.readdirSync(path.join(NORNS, d))) nornsByName.set(f, path.join(NORNS, d, f));
}

let mismatched = [], unresolved = [];
for (const e of entries) {
  let src = null;
  if (e.name.startsWith("SCClassLibrary/norns/SystemOverwrites/")) {
    src = path.join(OVR, "SystemOverwrites", path.basename(e.name));
  } else if (e.name.startsWith("SCClassLibrary/norns/")) {
    src = nornsByName.get(path.basename(e.name)) ?? null;
  } else if (e.name.startsWith("SCClassLibrary/")) {
    src = path.join(SC_LIB, e.name.slice("SCClassLibrary/".length));
  }
  if (!src || !fs.existsSync(src)) { unresolved.push(e.name); continue; }
  const want = fs.readFileSync(src);
  if (want.length !== e.data.length || !Buffer.from(e.data).equals(want)) mismatched.push(e.name);
}
ok("round-trip: every source resolved", unresolved.length === 0, unresolved.slice(0, 5).join(", "));
ok("round-trip: every entry byte-identical to source", mismatched.length === 0,
   mismatched.slice(0, 5).join(", "));

// ------------------------------------------------------------------- 2 ----
// sclang.js carries the file packager's metadata: filename + [start,end) into
// sclang.data. Parsing it out is how we know the archive covers the same set.
let preloadNames = null;
if (fs.existsSync(SCLANG_JS)) {
  const js = fs.readFileSync(SCLANG_JS, "utf8");
  const at = js.indexOf("loadPackage({");
  if (at >= 0) {
    const open = at + "loadPackage(".length;
    let depth = 0, end = -1, inStr = false, q = "";
    for (let k = open; k < js.length; k++) {
      const c = js[k];
      if (inStr) { if (c === "\\") { k++; continue; } if (c === q) inStr = false; continue; }
      if (c === '"' || c === "'") { inStr = true; q = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = k + 1; break; } }
    }
    const meta = (0, eval)("(" + js.slice(open, end) + ")");
    preloadNames = new Set(meta.files.map((f) => f.filename.replace(/^\/sc\//, "")));
  }
}
if (preloadNames) {
  const archiveSC = new Set(entries.map((e) => e.name).filter((n) => !n.startsWith("SCClassLibrary/norns/")));
  const missing = [...preloadNames].filter((n) => !archiveSC.has(n));
  const extra = [...archiveSC].filter((n) => !preloadNames.has(n));
  ok("archive covers everything sclang.data carries", missing.length === 0,
     `${missing.length} missing: ${missing.slice(0, 5).join(", ")}`);
  ok("archive adds nothing sclang.data lacks", extra.length === 0,
     `${extra.length} extra: ${extra.slice(0, 5).join(", ")}`);
} else {
  console.log("  SKIP  sclang.data comparison (no sclang.js to read metadata from)");
}

// ------------------------------------------------------------------- 3 ----
// A stand-in for MEMFS with the same three calls the loader uses.
function stubFS() {
  const files = new Map(), dirs = new Set(["/"]);
  return {
    files, dirs,
    mkdirTree(p) { let c = ""; for (const s of p.split("/")) { if (!s) continue; c += "/" + s; dirs.add(c); } },
    mkdir(p) { if (dirs.has(p)) { const e = new Error("EEXIST"); e.errno = 20; throw e; } dirs.add(p); },
    writeFile(p, data) {
      const d = p.slice(0, p.lastIndexOf("/"));
      if (!dirs.has(d)) throw new Error(`no parent directory for ${p}`);
      files.set(p, Buffer.from(data));
    },
    stat(p) { if (!files.has(p) && !dirs.has(p)) { const e = new Error("ENOENT"); e.errno = 44; throw e; } return {}; },
  };
}

const FS = stubFS();
const t0 = process.hrtime.bigint();
const res = await loadClassLibrary({ FS }, { bytes: gz, root: "/sc" });
const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
ok("loader: inflated the gzip", res.compressed === true);
ok("loader: wrote every file", res.files === summary.files, `${res.files} of ${summary.files}`);
ok("loader: wrote every byte", res.bytes === summary.payloadBytes,
   `${res.bytes} of ${summary.payloadBytes}`);
let wrong = 0;
for (const e of entries) {
  const got = FS.files.get("/sc/" + e.name);
  if (!got || !got.equals(Buffer.from(e.data))) wrong++;
}
ok("loader: bytes in the FS match the archive", wrong === 0, `${wrong} differ`);
ok("loader: Crone landed where sclang will look",
   FS.files.has("/sc/SCClassLibrary/norns/Crone.sc"));
ok("loader: refuses to clobber a preloaded tree",
   await (async () => {
     try { await loadClassLibrary({ FS }, { bytes: gz, root: "/sc" }); return false; }
     catch (e) { return /already exists/.test(e.message); }
   })());
ok("loader: overwrite: true is honoured",
   await (async () => {
     try { await loadClassLibrary({ FS }, { bytes: gz, root: "/sc", onConflict: "overwrite" }); return true; }
     catch { return false; }
   })());

// ------------------------------------------------------------------- 4 ----
let haveTar = true;
try { execFileSync("tar", ["--version"], { stdio: "pipe" }); } catch { haveTar = false; }

if (haveTar) {
  // -C plus a bare filename, because GNU tar on Windows reads "C:\..." as a
  // remote host spec ("Cannot connect to C: resolve failed").
  const inBuild = (args) => execFileSync("tar", args,
                                         { cwd: BUILD, encoding: "buffer", maxBuffer: 1 << 26 });
  const listing = inBuild(["-tf", "sclang-lib.tar"]).toString("utf8")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  ok("GNU tar lists the archive", listing.length === summary.files,
     `tar -tf saw ${listing.length}, packer wrote ${summary.files}`);

  const one = "SCClassLibrary/Common/Core/Object.sc";
  const extracted = inBuild(["-xOf", "sclang-lib.tar", one]);
  const want = fs.readFileSync(path.join(SC_LIB, "Common/Core/Object.sc"));
  ok("GNU tar extracts one file, byte-identical (greppable)", extracted.equals(want));

  // 5: can we read what GNU tar writes?
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e038-"));
  const gnuTar = path.join(tmp, "gnu.tar");
  execFileSync("tar", ["--format=ustar", "--force-local",
                       "-C", path.join(ROOT, "third_party/supercollider"),
                       "-cf", gnuTar, "SCClassLibrary"], { stdio: "pipe" });
  const gnu = readTar(new Uint8Array(fs.readFileSync(gnuTar)));
  const gnuFiles = gnu.entries.length;
  ok("our reader reads a GNU-tar archive", gnuFiles === summary.scClassLibraryFiles,
     `read ${gnuFiles}, expected ${summary.scClassLibraryFiles}`);
  let gnuWrong = 0;
  for (const e of gnu.entries) {
    const src = path.join(ROOT, "third_party/supercollider", e.name);
    if (!Buffer.from(e.data).equals(fs.readFileSync(src))) gnuWrong++;
  }
  ok("GNU-tar entries read byte-identical", gnuWrong === 0, `${gnuWrong} differ`);
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log("  SKIP  GNU tar interop (tar not on PATH)");
}

// ------------------------------------------------------------------- 6 ----
const N = 5;
let tGun = 0, tUntar = 0;
for (let i = 0; i < N; i++) {
  let a = process.hrtime.bigint();
  const inflated = zlib.gunzipSync(gz);
  let b = process.hrtime.bigint();
  readTar(new Uint8Array(inflated));
  let c = process.hrtime.bigint();
  tGun += Number(b - a) / 1e6;
  tUntar += Number(c - b) / 1e6;
}
console.log(`\ntiming (Node ${process.version}, ${os.cpus()[0]?.model?.trim() ?? "?"}):`);
console.log(`  gunzip            ${(tGun / N).toFixed(1)} ms   (zlib, same code path as DecompressionStream)`);
console.log(`  untar (parse)     ${(tUntar / N).toFixed(1)} ms`);
console.log(`  loader end-to-end ${elapsed.toFixed(1)} ms   (gunzip + parse + ${summary.files} writes into a JS Map)`);
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
