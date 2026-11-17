// E0-38a — sclang boots from the tar on a build that has no data package.
//
//   SCLANG_DIST=third_party/supercollider/build-wasm/wasm-dist/sclang-nopreload \
//     node tools/pack/boot-test.mjs
//
// E0-38 answered the runtime question on the preload build, by deleting
// /sc/SCClassLibrary out of MEMFS and unpacking the archive in its place.
// E0-38a answers the build question: with -DSC_WASM_PRELOAD_CLASSLIB=OFF
// (tools/sclang/classlib-preload-option.patch, built by
// tools/sclang/build-nopreload.sh) there is no sclang.data at all, so:
//
//   1  instantiate sclang and check that NOTHING populated /sc/SCClassLibrary
//   2  check the build itself carries no package (no .data, no loadPackage)
//   3  unpack sclang-lib.tar.gz into /sc with the loader
//   4  bootInterpreter() and see whether it compiles
//
// Checks 1 and 2 are the E0-38 checks inverted: there, the preloaded tree had
// to be present and then deleted; here it has to be absent to begin with.
// `--expect-preload` restores the E0-38 behaviour so the same test still runs
// against the preload build. See research/class-library-packaging.md §11.
//
// Plain Node: the target is built with -sENVIRONMENT=web,worker,node.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadClassLibrary } from "../../src/engine/classlib-loader.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// Which build to test. The default is the no-preload one; the working build
// that every other harness boots is left alone unless asked for by name.
const DIST = path.resolve(
  ROOT,
  process.env.SCLANG_DIST ||
    "third_party/supercollider/build-wasm/wasm-dist/sclang-nopreload") + path.sep;
const EXPECT_PRELOAD = process.argv.includes("--expect-preload");
const ARCHIVE = path.join(ROOT, "tools/pack/build/sclang-lib.tar.gz");

process.on("uncaughtException", (e) => {
  console.error(`\nFATAL: ${e.message}`);
  if (String(e.message).includes("__emscripten_thread_crashed")) {
    console.error(
      "\nemscripten's pthread glue failing to start under Node - a toolchain\n" +
      "mismatch, not this test. See research/sclang-wasm-osc-proof.md §6.");
  }
  process.exit(4);
});

for (const [what, p] of [["sclang.js", path.join(DIST, "sclang.js")], ["archive", ARCHIVE]]) {
  if (!fs.existsSync(p)) {
    console.error(`${what} not found: ${p}\n` +
      (what === "archive" ? "Run:  node tools/pack/pack-classlib.mjs"
                          : "Build it: bash tools/sclang/build-nopreload.sh"));
    process.exit(2);
  }
}

const results = [];
const report = (stage, pass, detail = "") => {
  results.push(pass);
  console.log(`\n  ${pass ? "PASS" : "FAIL"}  ${stage}${detail ? "\n        " + detail : ""}`);
};

const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sawLine = (s) => log.some((l) => l.includes(s));
async function until(pred, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); }
  console.log(`    timeout after ${ms}ms waiting for ${what}`);
  return false;
}

// -------------------------------------------------------- 1  instantiate ----
console.log(`sclang dist : ${DIST}`);
console.log(`archive     : ${ARCHIVE}  (${fs.statSync(ARCHIVE).size} B)`);
const { default: ScLang } = await import(pathToFileURL(path.join(DIST, "sclang.js")).href);
const sclang = await ScLang({ locateFile: (p) => DIST + p });
sclang.printCallback = (t) => { log.push(t); process.stdout.write(`    | ${t}\n`); };
sclang.printErrCallback = (t) => { log.push(t); process.stdout.write(`    ! ${t}\n`); };

const FS = sclang.FS;
if (!FS) { console.error("Module.FS is not exported - rebuild with -sEXPORTED_RUNTIME_METHODS=FS"); process.exit(3); }

function walkFS(dir, out = []) {
  for (const name of FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const p = `${dir}/${name}`;
    const st = FS.stat(p);
    if (FS.isDir(st.mode)) { walkFS(p, out); out.push({ p, dir: true }); }
    else out.push({ p, dir: false });
  }
  return out;
}

const fsExists = (p) => { try { FS.stat(p); return true; } catch { return false; } };

// What the preload used to carry. E0-38 §1 established that sclang.data's 356
// extents are exactly, name for name, the 356 files in the SCClassLibrary
// source tree, so the tree is a sound stand-in — and on a build where MEMFS
// starts empty it is the only one available. The later checks compare against
// this rather than against whatever MEMFS happened to contain, which is what
// keeps them from going vacuous here.
function walkSrc(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, base, out);
    else if (e.isFile()) {
      out.push("/sc/SCClassLibrary/" + path.relative(base, p).split(path.sep).join("/"));
    }
  }
  return out;
}
const expected = walkSrc(path.join(ROOT, "third_party/supercollider/SCClassLibrary"));

// ----------------------------------- 1, 2  the package must not exist at all ----
//
// The E0-38 pair, inverted. There the preloaded tree had to be present so it
// could be deleted; the whole point of E0-38a is that there is nothing to
// delete. Two separate claims, because they can fail separately: the link
// line may still carry the package (sclang.data on disk, loadPackage() in the
// glue), or it may not and something else may still have written the tree.
const hasData = fs.existsSync(path.join(DIST, "sclang.data"));
const hasLoadPackage = fs.readFileSync(path.join(DIST, "sclang.js"), "utf8").includes("loadPackage(");
const inMemfs = fsExists("/sc/SCClassLibrary");

if (EXPECT_PRELOAD) {
  const preloaded = inMemfs ? walkFS("/sc/SCClassLibrary").filter((e) => !e.dir) : [];
  report("the preload populated /sc/SCClassLibrary", preloaded.length > 0, `${preloaded.length} files`);
  if (inMemfs) {
    for (const e of walkFS("/sc/SCClassLibrary")) e.dir ? FS.rmdir(e.p) : FS.unlink(e.p);
    FS.rmdir("/sc/SCClassLibrary");
  }
  report("the preloaded class library is deleted from MEMFS", !fsExists("/sc/SCClassLibrary"));
} else {
  report("the build carries no class-library package", !hasData && !hasLoadPackage,
         `${hasData ? "sclang.data EXISTS" : "no sclang.data on disk"}; ` +
         `${hasLoadPackage ? "sclang.js still calls loadPackage()" : "no loadPackage() in sclang.js"}`);
  report("nothing populated /sc/SCClassLibrary before the unpack", !inMemfs,
         inMemfs
           ? `${walkFS("/sc/SCClassLibrary").filter((e) => !e.dir).length} files are already there`
           : "/sc/SCClassLibrary does not exist");
}

// ------------------------------------------------------------- 3  unpack ----
const bytes = new Uint8Array(fs.readFileSync(ARCHIVE));
const res = await loadClassLibrary(sclang, { bytes, root: "/sc" });
console.log(`\n    unpacked ${res.files} files / ${res.bytes} B in ${res.totalMs} ms ` +
            `(inflate ${res.inflateMs} ms, write ${res.writeMs} ms)`);
const after = walkFS("/sc/SCClassLibrary").filter((e) => !e.dir);
report("the archive is unpacked into MEMFS", after.length === res.files,
       `${after.length} files on disk, ${res.files} reported`);

// Every file the preload used to carry must be there, byte-identical.
const expectedSet = new Set(expected);
const afterSet = new Set(after.map((e) => e.p));
const missing = [...expectedSet].filter((p) => !afterSet.has(p));
report("every file the preload carried is back", missing.length === 0,
       missing.length === 0
         ? `${expectedSet.size} expected, ${afterSet.size} present`
         : `${missing.length} missing: ${missing.slice(0, 5).join(", ")}`);

let differ = 0;
for (const p of expectedSet) {
  const disk = p.replace("/sc/SCClassLibrary/", "");
  const src = path.join(ROOT, "third_party/supercollider/SCClassLibrary", disk);
  if (!fs.existsSync(src)) continue;
  const inFs = Buffer.from(FS.readFile(p));
  if (!inFs.equals(fs.readFileSync(src))) differ++;
}
report("MEMFS contents are byte-identical to the source tree", differ === 0, `${differ} differ`);

// The one file the archive deliberately does not carry: a test-only hook that
// stops Crone.initClass booting a server that does not exist in this process.
FS.writeFile("/sc/SCClassLibrary/norns/NornsJsTestHook.sc",
             "NornsJsTestHook { *initClass { Crone.bootOnInit = false; } }\n");

// -------------------------------------------------------------- 4  boot ----
console.log("\n--- bootInterpreter() on the unpacked library ---");
log.length = 0;
sclang.bootInterpreter();
const booted = await until(() => sawLine("Welcome to SuperCollider"), 120000, "class library compilation");
report("the class library compiles from the archive", booted,
       log.filter((l) => /ERROR|error:/.test(l)).slice(0, 3).join(" | "));

if (booted) {
  log.length = 0;
  sclang.runCode(`("E038-ARITH:" ++ (2+2)).postln;`);
  await until(() => sawLine("E038-ARITH:4"), 10000, "2+2");
  report("the interpreter evaluates", sawLine("E038-ARITH:4"));

  log.length = 0;
  sclang.runCode(`("E038-CLASSES:" ++ Object.allSubclasses.size).postln;`);
  await until(() => sawLine("E038-CLASSES:"), 10000, "class count");
  const classes = log.find((l) => l.includes("E038-CLASSES:"));
  report("SuperCollider's own classes are present", !!classes, classes ?? "");

  log.length = 0;
  sclang.runCode(`("E038-ENGINES:" ++ CroneEngine.allSubclasses.size).postln;`);
  await until(() => sawLine("E038-ENGINES:"), 10000, "norns engines");
  const engines = log.find((l) => l.includes("E038-ENGINES:"));
  const n = engines ? parseInt(engines.split("E038-ENGINES:")[1], 10) : 0;
  report("norns' classes came out of the same archive", n >= 4,
         engines ?? "CroneEngine not found");
}

const failed = results.filter((r) => !r).length;
console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}  (${results.length} checks)`);
process.exit(failed === 0 ? 0 : 1);
