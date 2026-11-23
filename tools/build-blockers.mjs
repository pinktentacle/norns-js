// E9-39 — what each catalogue script is missing here, as a table the page
// can show on a row.
//
//   node tools/fetch-catalogue.mjs <cache-dir>     once, ~3600 files
//   node tools/build-blockers.mjs <cache-dir>      writes public/community-blockers.json
//
// WHY A TABLE AND NOT A LIVE CHECK: answering this for one row means
// reading that repository's Lua and SuperCollider, which is a dozen
// requests per script. For 354 that is a catalogue scan, not a page load.
//
// IT FAILS OPEN, and that is the design. A script absent from the table
// gets no note — right for one added since the table was made, and the
// opposite mistake (a note on a script that works) is the one that would
// stop somebody trying it.
//
// EVERY REASON HERE SURVIVED A FALSE-POSITIVE PASS, and the passes are
// worth listing because each one cost a wrong answer first:
//
//   - a name used as `X.ar(` is NOT a missing UGen if it is a class:
//     SuperCollider is full of pseudo-UGens (`Mix`, `SelectX`, `Silent`,
//     `SoundIn`, `Greyhole`, `PulseDPW`). Asking sclang instead of a name
//     list took the count from 88 scripts to ONE.
//   - an engine is not missing if the SERVER already reports it. Thirty
//     scripts looked blocked on `PolyPerc`, which norns itself ships.
//   - a library is not missing if our dust bundle has it, if the include
//     is wrapped in a `pcall`, or if the script fetches it itself — which
//     the shell now starts for it.
//   - E9-70: and it is not missing if NORNS has it, or if the SCRIPT
//     decides whether to ask for it. That pass cost ten wrong answers:
//     every single "not in the catalogue" note this rule had ever
//     produced. `tools/lib-ask.mjs` holds both questions and
//     `test/lib-ask.test.ts` measures them against the real lines.
//
// The note says what is MISSING; it does not pass a verdict on the script.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isGuarded, nornsAnswers } from "./lib-ask.mjs";
import { join, dirname } from "node:path";

const HERE = process.argv[2] ?? dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const FILES = join(HERE, "files");
const listings = JSON.parse(readFileSync(join(HERE, "listings.json"), "utf8"));

// What our dust bundle already ships: 35 folders, several of them the
// libraries other scripts include. Without this, `nb` and `midigrid`
// looked missing.
// E9-71 — relative to this module, not to whichever machine wrote it.
const ROOT = new URL("../", import.meta.url);
const dust = JSON.parse(readFileSync(new URL("public/dust.json", ROOT), "utf8"));
const bundled = new Set(
  Object.keys(dust)
    .filter((p) => p.startsWith("/home/we/dust/code/"))
    .map((p) => p.split("/")[5].toLowerCase()),
);

// E9-70 — norns' OWN Lua, which the library rule never knew about.
//
// `sky` and `container` are not libraries anybody installs. They are in
// the norns image — `lua/extn/sky/` and `lua/lib/container/deque.lua` —
// and the rule only knew about the catalogue and our dust bundle, so it
// reported tambla and phonotype as blocked on something they already had.
// Both run, measured, with nothing installed.
const NORNS_LUA = new URL("third_party/norns/lua", ROOT);
const nornsFiles = new Set(
  readdirSync(NORNS_LUA, { recursive: true })
    .map((f) => String(f).split("\\").join("/"))
    .filter((f) => f.endsWith(".lua"))
    .map((f) => f.slice(0, -4)),
);
const nornsHas = (name) => nornsFiles.has(name);

// Measured E9-70: an ask the script guards with something this rule cannot
// read. `lib-ask.mjs` covers the three guards that NAME the library; these
// two name nothing, so they are measured by hand and the guard is quoted.
//
// Running them with the library absent and then present changed nothing
// either way, which is the measurement: tetrabobo 695 px, tetrabotis 417,
// gridstep 1448, with and without.
const GUARDED = {
  "tetrabobo:shnth": "sh = hid.connect(1) ... if sh.device then",
  "tetrabotis:shnth": "sh = hid.connect(1) ... if sh.device then",
  "shnthsalslied:shnth": "sh = hid.connect(1) ... if sh.device then",
  "gridstep:gridcapture": "_GRID_CAPTURE = false ... if _GRID_CAPTURE then",
};

// E9-71 — a library that is not in the catalogue, and where it actually is.
//
// "the shnth library is not in the catalogue" told a reader that the thing
// they want is nowhere, which was never what it meant. Six of these were
// found and checked in E9-70 and they live in `src/community/off-catalogue.json`,
// the same file the project panel installs them from — one source, so a
// note and an install cannot disagree.
const offCatalogue = JSON.parse(
  readFileSync(new URL("src/community/off-catalogue.json", ROOT), "utf8"),
).libraries;
const MAX_FILES = JSON.parse(
  readFileSync(new URL("src/community/limits.json", ROOT), "utf8"),
).installMaxFiles;

const libraryNote = (shown) => {
  const known = offCatalogue[shown.toLowerCase()];
  const where = known ? `; it is at ${known.url.replace(/^https?:\/\//, "")}` : "";
  return `the ${shown} library is not in the catalogue${where}`;
};

const catalogueNames = new Set();
// E9-71 — AND A CATALOGUE ENTRY WHOSE REPOSITORY WILL NOT LIST IS NOT ONE.
//
// "installable, and offered" was the reason the library rule passed over a
// head it found in the catalogue, and for four entries that is no longer
// true: the repository has been renamed, made private or deleted, and
// jsDelivr answers 404. `tmi` requires `kolor`, `kolor` is in the
// catalogue, so `tmi` got no note at all — and `kolor` is exactly the one
// that cannot be fetched. The failed listings are already right here.
const catalogueDead = new Set();
for (const [key, v] of Object.entries(listings)) {
  const names = [(v.name ?? key.split("/")[1]).toLowerCase(), key.split("/")[1].toLowerCase()];
  for (const n of names) (v.failed ? catalogueDead : catalogueNames).add(n);
}

// The stock sample tree, which is not a script and so comes from neither
// the catalogue nor dust.json's code tree. E9-41 synthesises an 808 kit
// into it; read here rather than assumed, so the day it is dropped the
// note comes back by itself.
const stockAudio = new Set(
  Object.keys(
    JSON.parse(readFileSync(new URL("public/dust-assets.json", ROOT), "utf8")),
  )
    .filter((f) => f.startsWith("/home/we/dust/audio/"))
    .map((f) => f.slice("/home/we/dust/audio/".length).split("/").slice(0, 2).join("/")),
);

// What the binary beside this table actually has, so a UGen that gets
// built in stops being a blocker without anyone editing this file.
const ugens = new Set(
  JSON.parse(readFileSync(new URL("public/norns-sc/ugens.json", ROOT), "utf8")),
);

// E9-203 — a service a script reads with curl and that will not answer a
// page. MEASURED, with an Origin header, on the date beside it; a service
// not listed here is assumed to answer, which is the table failing open.
// Three that do, for the record: api.open-meteo.com (avonlea),
// global-warming.org (ppm_norns) and api.wheretheiss.at (ufo), all
// `Access-Control-Allow-Origin: *` on 2026-11-23.
const SERVICES = {
  // 2026-11-23: connection timed out. IEX Cloud closed, so this is as
  // true on a norns as it is here.
  "cloud.iexapis.com": "has closed and answers nobody",
};

const blockers = new Map(); // script -> [reasons]
const add = (script, why) => {
  if (!blockers.has(script)) blockers.set(script, []);
  if (!blockers.get(script).includes(why)) blockers.get(script).push(why);
};

/**
 * E9-55 — the ones that were RUN, rather than read.
 *
 * Everything else in this file is inferred from a repository's text, which
 * is why it is careful to fail open. These five were loaded in the browser
 * with the engine up, and each one's reason is the message it printed. A
 * reader of the table cannot tell the two kinds apart and does not need
 * to — the note says what is missing either way — but the pass that
 * produced them can only ever be hand-made, so it lives here as data.
 *
 * FOUR OF THEM ARE GONE, and that matters more than their being here did.
 * `splnkr`, `tapedeck`, `pirate-radio` and `folio` were in this list and
 * are not any more, because they now run: E9-66 and E9-67 closed the three
 * class files that crashed sclang and moved the subprocess override onto
 * `Pipe` where the missing `fork` is, E9-68 corrected splnkr's one rate
 * error, and E9-69 writes the two catalogs maiden leaves in the dust tree,
 * which is all folio was ever asking for. A note on a script that works is
 * the worst entry this table can hold — it is the one that stops somebody
 * trying it — so they come out the moment the measurement changes.
 */
const MEASURED = {
  // E9-203 — reworded, because there is a curl of sorts now and the reason
  // was never its absence: the file is NYSE's and NYSE sends no
  // `Access-Control-Allow-Origin`. Checked again on 2026-11-23.
  tulpamancer: "reads a file from nyse.com, which does not let a page read it",
  // METRONOME CAME OUT HERE in E9-203. Its note said it "requires
  // metronome/lib/nb, which is not in its repository", and that is still
  // true of the repository. But the library is sixolet/nb; the panel now
  // installs it beside the script and the `require` is answered from
  // there, without writing anything into the script's folder. Measured in
  // the page: `# script init`, no error.
  // TERRARIUM CAME OUT HERE in E9-73, and the note it used to carry said
  // "It LOADS and inits in about a second; what it will not do is play".
  // It plays. Installed fresh and run: engine Terrarium, 919 pixels,
  // peak 0.18, every key, encoder and the grid answered, and the screen
  // draws its night sky rather than norns-deps' install screen. The
  // earlier measurement was taken against a jsDelivr listing that E9-56
  // had already caught being three days stale; `listFiles` asks GitHub
  // first now, so what gets installed is the tree the repository has.
  // Measured E9-70, and NOT the namesizer note this used to carry.
  // `ping_midi_devices` (line 2084) walks `midi.devices` to find the
  // highest id and then `for i = 1, midi_dev_max` — with nothing plugged
  // in the table is empty, `midi_dev_max` stays nil, and `init` dies on
  // "'for' limit must be a number". A norns with no MIDI does the same.
  // Here a device can be attached over WebMIDI, which is why this says
  // what to do rather than what is absent.
  cheat_codes_2:
    "needs a MIDI device before it starts — attach the keyboard in the rail, or plug one in",
  // SHNTHSALSLIED CAME OUT HERE in E9-74. Its note said the LiedMotor
  // class "is not in the repository", which is true of ITS repository and
  // was never the whole sentence: its own README says it "requires
  // schicksalslied as well as the shnth library", and schicksalslied is a
  // catalogue entry carrying `lib/Engine_LiedMotor.sc`. The panel installs
  // it with the script now — `shnthsalslied also needs schicksalslied, for
  // the LiedMotor engine` — and both run.
  // Measured E9-70, and the ONE case in the ten where a missing library
  // was visible at all. `lib/Fx_FixedFilterBankingCrisis.sc` declares
  // `FxFixedFilterBankingCrisis : FxBase`, and `FxBase` is in sixolet/fx.
  // The .sc is staged whether or not the mod is enabled, so installing
  // this script alone puts "Error: Undefined classes — This superclass
  // does not exist" into the class library. sclang drops the class and
  // carries on — Compile done, 3624 classes — and the script runs with
  // its own engine, but the insert FX cannot exist. Installing fx clears
  // the error, measured.
  "fixed-filter-banking-crisis":
    "its Fx class needs github.com/sixolet/fx; without it one SuperCollider class does not compile",
};
for (const [script, why] of Object.entries(MEASURED)) add(script, why);

for (const [key, v] of Object.entries(listings)) {
  const name = v.name ?? key.split("/")[1];
  const all = v.files ?? [];
  if (v.failed) {
    add(name, "its repository will not list — renamed, private or gone");
    continue;
  }
  // E9-72 — the number comes from `limits.json`, which is also what the
  // installer defaults to and what SETTINGS > FILES shows. It was 400 here
  // and 400 there, and two copies of a number is how a note comes to
  // describe a limit that is no longer the one being enforced.
  if (all.length > MAX_FILES) {
    add(name, `${all.length} files, over the install limit of ${MAX_FILES}`);
  }

  const luas = all.filter((f) => f.endsWith(".lua"));
  const scs = all.filter((f) => f.endsWith(".sc"));
  const own = new Set(luas.map((f) => f.replace(/\.lua$/, "")));
  const ownBase = new Set([...own].map((f) => f.split("/").pop()));

  for (const rel of luas) {
    let t;
    try {
      t = readFileSync(join(FILES, key, rel), "utf8");
    } catch {
      continue;
    }
    const live = t
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");

    // A library whose head is not in the catalogue and not its own.
    for (const m of live.matchAll(/(include|require)\s*\(?\s*["']([^"']+)["']/g)) {
      const keyword = m[1];
      const target = m[2];
      if (!target.includes("/") || /^https?:/.test(target)) continue;
      if (own.has(target) || ownBase.has(target.split("/").pop())) continue;
      const head = target.split("/")[0].toLowerCase();
      if (["core","lib","engine","softcut","extn","params","..","test","tests","data"].includes(head)) continue;
      if (head === name.toLowerCase() || head === key.split("/")[1].toLowerCase()) continue;
      if (!catalogueDead.has(head) && catalogueNames.has(head)) continue; // installable, and offered
      if (bundled.has(head)) continue; // already in the dust tree
      // E9-70 — norns itself has it (`extn/` for include, package.path for
      // require), so there was never anything to install.
      if (nornsAnswers(keyword, target, nornsHas)) continue;
      // E9-70 — the script decides whether to ask: a mod that must be
      // enabled, a folder it tests for, a device, a constant shipped false.
      if (isGuarded(rel, live, head)) continue;
      if (GUARDED[`${name.toLowerCase()}:${head}`] !== undefined) continue;
      // An include the script WRAPS, because it has a path without it.
      // `seeker_ii` does exactly this and runs.
      if (live.includes("pcall") && live.includes(target)) continue;
      // Fetched by the script itself, which the shell now starts (E9-37).
      if (new RegExp("(?:git clone|wget|curl)[^\n]*" + head, "i").test(live)) continue;
      // E9-71 — a catalogue entry whose repository will not list is not
      // installable, and the reason to say so is different: it is not that
      // nobody published this, it is that what was published has gone.
      // ASKED LAST, after the guards: `oooooo` names kolor too, and asks
      // `util.file_exists(_path.code.."kolor")` before it does.
      if (catalogueDead.has(head)) {
        add(name, `needs ${target.split("/")[0]}, whose repository will not list — renamed, private or gone`);
        continue;
      }
      add(name, libraryNote(target.split("/")[0]));
    }

    // A SAMPLE DIRECTORY that belongs to the norns image rather than to
    // any script. `bakeneko` reads `~/dust/audio/common/808` with
    // `io.popen('ls -a …')` and then `math.random(1, #t)` — with an empty
    // listing that is `math.random(1, 0)`, which raises, in `init`.
    // Measured: it died there, and ran as soon as the directory had files.
    //
    // `live` and not `t`: goldeneye carries the same path COMMENTED OUT
    // beside the one it uses, and reading comments put it on this list
    // for a line it never executes.
    for (const m of live.matchAll(/\/home\/we\/dust\/audio\/(common\/[A-Za-z0-9_-]+)/g)) {
      if (stockAudio.has(m[1])) continue;
      add(name, `the stock ${m[1].split("/")[1]} samples, which this build does not ship`);
    }

    // A url fetched for its OUTPUT.
    //
    // E9-203 — THIS USED TO SAY "reads a network reply at once, which cannot
    // arrive in time" of every script that does it, and it is no longer
    // true: a `curl` whose output is read is answered now (the coroutine
    // that asked sleeps until the reply is in). What is left to say is
    // about the SERVICE, and only where it was measured: a note on a
    // script that works is the one mistake this table cannot afford.
    //
    // AND `\b`, WHICH IT NEVER HAD. `nornsfetch` was on this list for
    // `util.os_capture("iwgetid -r")` — "iWGETid". It reads no network.
    if (/(?:os_capture|io\.popen|os\.capture)[^\n]*\b(?:curl|wget)\b/.test(live)) {
      for (const m of live.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
        const why = SERVICES[m[1].toLowerCase()];
        if (why !== undefined) add(name, `reads ${m[1]}, which ${why}`);
      }
    }
  }

  // A UGen class that exists nowhere. Measured by asking sclang: of the
  // 225 names the whole catalogue uses, exactly one was missing --
  // ByteBeat, and E9-40 built it in, so this now adds nothing. The rule
  // is kept and READ OFF THE BUILD rather than deleted: the question is
  // not whether ByteBeat was ported once, it is whether the binary this
  // table ships beside has it.
  for (const rel of scs) {
    let t;
    try {
      t = readFileSync(join(FILES, key, rel), "utf8");
    } catch {
      continue;
    }
    if (!ugens.has("ByteBeat") && /ByteBeats*.s*(?:ar|kr)/.test(t)) {
      add(name, "the ByteBeat UGen is in no pack here");
    }
  }
}

// E9-46 — a file it downloads from a GITHUB RELEASE, which no browser may
// fetch. Measured three ways in docs/11-MISSING.md: the download URL sends
// no Access-Control-Allow-Origin, the API asset endpoint redirects to the
// same host, and jsDelivr serves repository files only. It is not our CSP:
// the page sends none.
//
// Read from the Lua AND from the `.sh` the script runs, because five of
// the six hide the URL in a shell script — `amenbreak` holds its in
// `lib/install.sh`, and a rule that read only Lua said nothing about the
// one script whose symptom a user actually reported.
//
// AND IT IS READ AGAINST WHAT THE BUILD HAS, which the first draft was
// not: it flagged `twins`, `rachim`, `tapedeck` and `graintopia` for
// downloading PortedPlugins — the pack E9-35 COMPILED IN. A note on a
// script that works is the one mistake this table cannot afford, because
// it is the one that stops somebody trying it. An archive whose UGens the
// server already reports is not a missing file.
const PROVIDED = [
  // archive name fragment -> one UGen it would have installed
  [/portedplugins/i, "AnalogTape"],
  [/mi-ugens|mutable/i, "MiClouds"],
];
const RELEASE = new RegExp(
  "https?://github\\.com/[^\\s\"')]+/releases/download/[^\\s\"')]+",
  "g",
);
for (const [key, v] of Object.entries(listings)) {
  const name = v.name ?? key.split("/")[1];
  const names = new Set();
  for (const rel of (v.files ?? []).filter((f) => f.endsWith(".lua") || f.endsWith(".sh"))) {
    let t;
    try {
      t = readFileSync(join(FILES, key, rel), "utf8");
    } catch {
      continue;
    }
    const live = t
      .split("\n")
      .filter((l) => !/^\s*(--|#)/.test(l))
      .join("\n");
    for (const m of live.matchAll(RELEASE)) {
      const url = m[0];
      const file = url.split("/").pop() ?? "";
      // A URL that ends in the directory names nothing to miss.
      if (file === "") continue;
      if (PROVIDED.some(([re, ugen]) => re.test(url) && ugens.has(ugen))) continue;
      names.add(file);
    }
  }
  // ONE note per script. Three sentences saying the same thing about three
  // files is a row nobody finishes reading.
  if (names.size > 0) {
    const first = [...names].slice(0, 2);
    const shown = first.length === 2 ? `${first[0]} and ${first[1]}` : first[0];
    const more = names.size > 2 ? `, and ${names.size - 2} more` : "";
    add(name, `${shown}${more}, from a GitHub release the browser may not fetch`);
  }
}

// An engine no catalogue script defines.
//
// E9-71 — READ OFF THE CACHE, not out of `tools/engine-classes.json`.
// That file was the last thing standing between this generator and anyone
// being able to run it: nothing in the repository wrote it, so it could
// not be rebuilt, so the table could not be regenerated, so three notes
// sat in it for weeks after they had stopped being true. The cache
// already holds every `.sc` in all 354 repositories, and an engine class
// is a declaration in one of them — which is the same thing the file
// used to say, derived instead of remembered.
const haveEngine = new Set();
// E9-74 — and WHICH SCRIPT has it, which is the other half of the same scan.
//
// `needs.ts` could say "shnthsalslied needs the LiedMotor engine" and
// nothing more, because an engine class can be in any of the 355 and it
// carried no index of them. The sweep that fills this file reads every
// `.sc` in all 355 repositories to answer a different question; the answer
// to this one was already in its hands.
const engineIn = {};
for (const [key, v] of Object.entries(listings)) {
  const script = (v.name ?? key.split("/")[1]);
  for (const rel of (v.files ?? []).filter((f) => f.endsWith(".sc"))) {
    let t;
    try {
      t = readFileSync(join(FILES, key, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of t.matchAll(/Engine_([A-Za-z0-9_]+)\s*:/g)) {
      haveEngine.add(m[1]);
      (engineIn[m[1]] ??= []).push(script);
    }
  }
}
// Engines the server itself reports with nothing installed: norns' own and
// the ones our dust bundle brings. Read off a running page. Without these
// every script using `PolyPerc` looked blocked, which is 30 of them.
// E9-203 — and the engines of monome's studies, which no script publishes
// and the panel now fetches from the study itself (study-engines.ts).
for (const n of Object.keys(
  JSON.parse(readFileSync(new URL("src/community/study-engines.json", ROOT), "utf8")).engines,
)) haveEngine.add(n);
for (const n of ["Glut","TextureC","Rudiments","PolySub","ResonateR","SimpleDelay","Zxcvbn",
                 "Ack","MGlut","SimplePassThru","MacroB","SimpleDelayKolor","Pedalboard",
                 "MollyThePoly","Decimator","PolyPerc","Timber","MxSamples","Amen","Passersby",
                 "Timber_Takt","TestSine","ModalE","BandSaw","MacroP","None"]) haveEngine.add(n);
for (const [key, v] of Object.entries(listings)) {
  const name = v.name ?? key.split("/")[1];
  for (const rel of (v.files ?? []).filter((f) => f.endsWith(".lua"))) {
    let t;
    try {
      t = readFileSync(join(FILES, key, rel), "utf8");
    } catch {
      continue;
    }
    for (const line of t.split("\n")) {
      if (line.trim().startsWith("--")) continue;
      const m = /engine\.name\s*=\s*["']([A-Za-z0-9_]+)["']/.exec(line);
      if (!m || m[1] === "None") continue;
      if (!haveEngine.has(m[1])) {
        add(name, `the ${m[1]} engine is in no catalogue script`);
      }
    }
  }
}

const rows = [...blockers].sort((a, b) => a[0].localeCompare(b[0]));
console.log(`scripts that cannot run as they are: ${rows.length} of ${Object.keys(listings).length}\n`);
for (const [s, why] of rows) console.log(`${s.padEnd(22)} ${why.join(" · ")}`);

const out = {};
for (const [s, why] of rows) out[s] = why;
// The page reads this, so it carries its own date and its own
// disclaimer: a table that fails open has to say so where it is read,
// not only where it is made.
const stamp = new Date().toISOString().slice(0, 10);
// E9-74 — the engine index, written beside the table and from the same scan.
//
// ONE NAME TO ONE SCRIPT, and an engine two scripts declare is left out
// rather than guessed at: the point is to install the thing that has it,
// and a choice is not an answer. 20 of 355 would be a coin toss.
//
// `needs.ts` used to argue against exactly this file — "a table of engine
// names built at release time would go stale the first time somebody adds
// a script, and a stale answer here is worse than an honest 'something is
// missing'". It fails OPEN, which is what makes that argument survivable
// and is the same contract the blockers table has: an engine this does not
// name produces the same null `entry` it always did, so a script added
// since costs nothing. The only way to be WRONG is for a script to delete
// an engine class it used to declare, and then the install simply does not
// help.
const engineIndex = {};
for (const [name, scripts] of Object.entries(engineIn)) {
  const uniq = [...new Set(scripts)];
  if (uniq.length === 1) engineIndex[name] = uniq[0];
}
writeFileSync(
  new URL("src/community/engines.json", ROOT),
  JSON.stringify(
    {
      what:
        "Engine class name -> the catalogue script that declares it, read off every .sc in all "
        + Object.keys(listings).length
        + " repositories by tools/build-blockers.mjs. An engine two scripts declare is left out: "
        + "the point is to install the thing that has it, and a choice is not an answer. "
        + "Fails open, like the blockers table: an engine not named here produces the same null "
        + "entry needs.ts always produced.",
      engines: Object.fromEntries(Object.entries(engineIndex).sort(([a], [b]) => a.localeCompare(b))),
    },
    null,
    1,
  ) + "\n",
);
console.log(`engine index: ${Object.keys(engineIndex).length} engines in one script each`);

writeFileSync(
  new URL("public/community-blockers.json", ROOT),
  JSON.stringify(
    {
      generated: stamp,
      // COUNTED, not remembered: this said 354 while the catalogue had
      // grown to 355, which is a small lie of exactly the kind this whole
      // file is about.
      from: `the ${Object.keys(listings).length}-entry monome/norns-community catalogue`,
      note:
        "A script listed here is missing something. Some will not start; some run with less. Absence from this list is not a promise.",
      scripts: out,
    },
    null,
    1,
  ) + "\n",
);
