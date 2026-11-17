// E0-18 — the decisive experiment.
//
// QUESTION: sclang-wasm's README says "Any kind of OSCFunc/OSCdef that goes
// beyond the server is not implemented."  norns' entire matron<->sclang
// protocol is built on OSCFunc.  Does an OSCFunc fire for a message injected
// through the JS sendOsc() boundary?
//
// Source reading says yes (see research/sclang-wasm-osc-proof.md): sendOsc
// lands in ProcessOSCPacket, the same entry point a real UDP packet uses.
// This runs it.
//
//   node osc-test.mjs <dir containing sclang.js>
//
// Exit code 0 = all stages passed.

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { encodeMessage, decode } from "./osc.mjs";

const distDir = process.argv[2]
  ? path.resolve(process.argv[2]) + path.sep
  : fileURLToPath(new URL("../../third_party/supercollider/build-wasm/wasm-dist/sclang/", import.meta.url));

const NORNS_SC = fileURLToPath(new URL("../../third_party/norns/sc/", import.meta.url));

// A failing pthread takes the whole process down from inside a MessagePort
// callback, where no await can catch it. Turn that into a diagnosis.
process.on("uncaughtException", (e) => {
  console.error(`\nFATAL: ${e.message}`);
  if (String(e.message).includes("__emscripten_thread_crashed")) {
    console.error(
      "\nThat is emscripten's pthread / wasm-worker glue failing to start under\n" +
      "Node - not an OSC problem, and not this harness. SuperCollider's CI pins\n" +
      "emscripten 4.0.18; an older emsdk compiles and links cleanly but emits a\n" +
      "runtime whose workers cannot boot. SC's own sclang-tests.mjs fails the\n" +
      "same way, which is how to tell this apart from a bug here.\n\n" +
      "Fix: install 4.0.18, then  bash tools/sclang/build.sh clean",
    );
  }
  process.exit(4);
});

const log = [];        // every line sclang prints
const received = [];   // every OSC message sclang sends out
let sclang;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sawLine = (s) => log.some((l) => l.includes(s));

/** Wait until `pred()` is true, or give up. */
async function until(pred, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(100);
  }
  console.log(`    timeout after ${ms}ms waiting for ${what}`);
  return false;
}

const results = [];
function report(stage, pass, detail) {
  results.push({ stage, pass });
  console.log(`\n  ${pass ? "PASS" : "FAIL"}  ${stage}${detail ? "\n        " + detail : ""}`);
}

// ---------------------------------------------------------------- boot ----

if (!fs.existsSync(path.join(distDir, "sclang.js"))) {
  console.error(`sclang.js not found in:\n  ${distDir}\n\nBuild it first - see tools/sclang/build.sh`);
  process.exit(2);
}

console.log(`sclang dist : ${distDir}`);
const { default: ScLang } = await import(pathToFileURL(path.join(distDir, "sclang.js")).href);

sclang = await ScLang({ locateFile: (p) => distDir + p });

sclang.printCallback = (t) => { log.push(t); process.stdout.write(`    | ${t}\n`); };
sclang.printErrCallback = (t) => { log.push(t); process.stdout.write(`    ! ${t}\n`); };
sclang.onOsc = (bytes) => {
  const m = decode(bytes);
  received.push(m);
  console.log(`    <- OSC ${JSON.stringify(m)}`);
};

// ---- Stage C setup must happen BEFORE boot: the class library is compiled
// ---- during bootInterpreter(), reading from MEMFS at /sc/SCClassLibrary.
const wantNorns = fs.existsSync(path.join(NORNS_SC, "core", "Crone.sc"));
if (wantNorns) {
  try {
    sclang.FS.mkdir("/sc/SCClassLibrary/norns");
    let n = 0;
    for (const sub of ["core", "engines"]) {
      const dir = path.join(NORNS_SC, sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".sc")) continue;
        sclang.FS.writeFile(`/sc/SCClassLibrary/norns/${f}`, fs.readFileSync(path.join(dir, f)));
        n++;
      }
    }
    // Crone.initClass registers a StartUp block that boots scsynth. There is
    // no server in a sclang-only build, so switch it off. StartUp blocks run
    // after every *initClass, so this lands in time.
    sclang.FS.writeFile(
      "/sc/SCClassLibrary/norns/NornsJsTestHook.sc",
      `NornsJsTestHook { *initClass { Crone.bootOnInit = false; } }\n`,
    );
    n++;
    console.log(`norns classes injected into MEMFS: ${n} files`);
  } catch (e) {
    console.log(`could not inject norns classes: ${e}`);
  }
}

console.log("\nbooting interpreter...");
sclang.bootInterpreter();

const booted = await until(
  () => sawLine("Welcome to SuperCollider") || sawLine("compile done"),
  90_000,
  "class library compilation",
);
if (!booted) { console.error("\nsclang never finished booting."); process.exit(3); }
await sleep(1000);

// --------------------------------------------------- stage 0: sanity ----
console.log("\n=== stage 0 : interpreter is alive ===");
log.length = 0;
sclang.runCode("2+2");
await until(() => sawLine("-> 4"), 10_000, "2+2");
report("stage 0  interpreter evaluates code", sawLine("-> 4"));

// ------------------------------- stage A: does OSCFunc fire at all? ----
console.log("\n=== stage A : OSCFunc fires for a sendOsc-injected message ===");
log.length = 0;
sclang.runCode(`OSCFunc.new({ arg msg, time, addr, port;
    ("E0018-FIRED path:" ++ msg[0] ++ " nargs:" ++ (msg.size-1) ++ " port:" ++ port).postln;
}, '/report/engines');`);
await sleep(1000);

sclang.sendOsc(encodeMessage("/report/engines"));
const fired = await until(() => sawLine("E0018-FIRED"), 10_000, "OSCFunc to fire");
report(
  "stage A  OSCFunc fires for sendOsc-injected OSC",
  fired,
  fired ? log.find((l) => l.includes("E0018-FIRED")) : "OSCFunc did not fire",
);

// ------------------- stage B: full round trip, the matron<->sclang shape ----
console.log("\n=== stage B : reply reaches JS via onOsc (full round trip) ===");
log.length = 0;
received.length = 0;
sclang.runCode(`~replyAddr = NetAddr("127.0.0.1", 57120);
OSCFunc.new({ arg msg;
    ~replyAddr.sendMsg('/report/engines/start', 2);
    ~replyAddr.sendMsg('/report/engines/entry', 0, "TestSine");
    ~replyAddr.sendMsg('/report/engines/entry', 1, "PolyPerc");
    ~replyAddr.sendMsg('/report/engines/end');
}, '/roundtrip');`);
await sleep(1000);

sclang.sendOsc(encodeMessage("/roundtrip"));
const gotAll = await until(() => received.some((m) => m.address === "/report/engines/end"), 10_000, "the reply burst");
const entries = received.filter((m) => m.address === "/report/engines/entry");
report(
  "stage B  sclang reply arrives in JS through onOsc",
  gotAll && entries.length === 2,
  `${received.length} messages out, ${entries.length} entries: ${entries.map((e) => e.args[1]).join(", ")}`,
);

// ----------------------------- stage C: the real norns class library ----
console.log("\n=== stage C : real norns Crone answers /report/engines ===");
if (!wantNorns) {
  console.log("  SKIP - third_party/norns not present");
} else {
  log.length = 0;
  received.length = 0;
  // Did the norns classes actually compile into the library?
  // Reached through symbols, so the snippet still compiles if the norns
  // classes are absent - otherwise an unknown class name is a parse error and
  // we would learn nothing.
  sclang.runCode(`(
var ce = \\CroneEngine.asClass;
("E0018-CRONE-CLASS:" ++ (\\Crone.asClass.notNil)).postln;
("E0018-ENGINE-SUBCLASSES:" ++ if(ce.notNil, { ce.allSubclasses.size }, { -1 })).postln;
)`);
  await sleep(1500);
  const croneCompiled = sawLine("E0018-CRONE-CLASS:true");
  report(
    "stage C1 norns SC classes compile inside sclang-wasm",
    croneCompiled,
    log.find((l) => l.includes("E0018-ENGINE-SUBCLASSES")) ?? "Crone class not found",
  );

  if (croneCompiled) {
    received.length = 0;
    // Register Crone's OSCFunc table by hand. reportEngines needs only
    // remoteAddr and CroneEngine.allSubclasses - no running server.
    sclang.runCode(`Crone.remoteAddr = NetAddr("127.0.0.1", 8888);
Crone.initOscRx;`);
    await sleep(1500);
    sclang.sendOsc(encodeMessage("/report/engines"));
    const answered = await until(
      () => received.some((m) => m.address === "/report/engines/end"),
      10_000,
      "Crone to answer /report/engines",
    );
    const names = received.filter((m) => m.address === "/report/engines/entry").map((m) => m.args[1]);
    report(
      "stage C2 Crone answers the real /report/engines protocol",
      answered,
      answered ? `engines reported: ${names.join(", ") || "(none)"}` : "no reply",
    );
  }
}

// ------------------------------------------------------------ verdict ----
console.log("\n" + "=".repeat(64));
for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.stage}`);
const allPass = results.every((r) => r.pass);
console.log("=".repeat(64));
console.log(allPass ? "\nE0-18: GO - OSCFunc works across the JS boundary.\n" : "\nE0-18: at least one stage failed.\n");
process.exit(allPass ? 0 : 1);
