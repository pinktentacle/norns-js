// What hardware each bundled script can talk to, read from its own source.
//
//   node tools/hardware-report.mjs            # print
//   node tools/hardware-report.mjs --write    # docs/07-HARDWARE.md
//
// WHY READ THE SOURCE rather than run them. Hardware support is not a
// property a script announces; it is which norns APIs it calls. A script
// that calls `grid.connect` wants a grid whether or not one is plugged in,
// and running it on a machine with nothing attached would report that
// nothing is supported. The source says what it would use.
//
// WHAT THIS IS NOT. A call is not a guarantee: a script may reference an API
// in a comment, in dead code, or behind a parameter nobody turns on. The
// report says what a script REACHES FOR, which is the useful question when
// deciding what to plug in, and it is checkable by reading the same lines.
// Each finding carries the file and line it came from for exactly that.
//
// `include`d libraries count. `nb` in particular (note blocks, a voice
// router many scripts vendor) brings MIDI and crow output with it, and a
// script that ships it can drive both without naming either itself.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "community patches");
const OUT = path.join(ROOT, "docs", "07-HARDWARE.md");

/**
 * One entry per kind of thing you can plug in.
 *
 * `test` is deliberately narrow: `midi` alone would match `midi_device` in a
 * parameter name and half the corpus would look like a MIDI controller.
 */
const KINDS = [
  {
    id: "grid",
    label: "monome grid",
    note: "64, 128 or 256 keys. The page has a virtual one.",
    test: /\bgrid\.connect\s*\(|\bg\.key\s*=|\bgrid\.add\b|\bg:led\b|\bg\.led\s*\(/,
  },
  {
    id: "arc",
    label: "monome arc",
    note: "Four encoders with LED rings. The page has a virtual one.",
    test: /\barc\.connect\s*\(|\ba\.delta\s*=|\barc\.add\b|\ba:segment\b/,
  },
  {
    id: "midi-in",
    label: "MIDI in",
    note: "A keyboard, pads or a controller sending to norns.",
    // NOT `.event = function`: a metro, a grid and an OSC handler are all
    // written that way too, and it reported `m.grid_refresh.event` as MIDI.
    // Only the ways a MIDI port is actually obtained count.
    test: /\bmidi\.connect\s*\(|\bmidi\.devices\b|\bmidi\.vports\b|\bmidi\.add\b/,
  },
  {
    id: "midi-notes",
    label: "MIDI keyboard",
    note: "Reads note on/off, so a keyboard plays it.",
    // READING a note, not sending one — `:note_on(` is output and has its
    // own row. A keyboard plays a script only if the script inspects the
    // type of a message coming in.
    test: /type\s*==\s*["']note_(on|off)["']|\bmidi\.to_msg\b/,
  },
  {
    id: "midi-cc",
    label: "MIDI control surface",
    note: "Reads continuous controllers, so knobs and faders map to it.",
    test: /type\s*==\s*["']cc["']|\bcontrol_change\b/,
  },
  {
    id: "midi-out",
    label: "MIDI out",
    note: "Drives an external synth or drum machine.",
    test: /:note_on\s*\(|:note_off\s*\(|:cc\s*\(|:program_change\s*\(|\bmidi_out\b/,
  },
  {
    id: "midi-clock",
    label: "MIDI clock",
    note: "Syncs to or sends MIDI beat clock.",
    test: /type\s*==\s*["'](clock|start|stop|continue)["']/,
  },
  {
    id: "crow",
    label: "crow",
    note: "CV and gate in and out, and i2c to the rest of a modular rack.",
    test: /\bcrow\.(output|input|ii|send|reset|add)\b|\bcrow\[/,
  },
  {
    id: "ii",
    label: "i2c devices",
    note: "just friends, w/, Teletype expanders — through crow's ii bus.",
    test: /\bcrow\.ii\b|\bii\.(jf|wsyn|wslash|txo|txi|ansible)\b/,
  },
  {
    id: "hid",
    label: "HID device",
    note: "Gamepads and other USB controllers.",
    test: /\bhid\.connect\s*\(|\bhid\.devices\b|\bhid\.vports\b/,
  },
  {
    id: "keyboard",
    label: "USB keyboard",
    note: "A typing keyboard plugged into norns.",
    test: /\bkeyboard\.(code|char|connect)\b|\bkeyboard\s*=\s*function/,
  },
  {
    id: "audio-in",
    label: "audio input",
    note: "The line or mic inputs: sampling, looping, processing.",
    // `adc` on its own turns up in variable names and in prose; these are
    // the calls that actually open or route the inputs.
    test: /\blevel_adc\b|\blevel_input_cut\b|\blevel_monitor\b|\brec_level\b/,
  },
  {
    id: "link",
    label: "Ableton Link",
    note: "Network tempo sync. Needs UDP multicast, which a browser has not.",
    test: /\bclock\.link\.|clock_source.*link|==\s*["']link["']/,
  },
  {
    id: "osc",
    label: "OSC",
    note: "Network messages to and from other software.",
    test: /\bosc\.send\s*\(|\bosc\.event\s*=|\bosc\.connect\b/,
  },
  {
    id: "nb",
    label: "note blocks (nb)",
    note: "A voice router: whatever it is pointed at, including MIDI and crow.",
    test: /lib\/nb\b|["']nb["']|\bnb\.voice\b|\bnb:/,
  },
];

/**
 * What norns-js can offer, per kind. HAND-MAINTAINED and marked as such in
 * the output: no script's source can say what this project supports, and a
 * generated-looking table of our own claims would be the worst of both.
 */
const SUPPORT = {
  grid: { state: "**yes**", why: "A virtual 64, 128 or 256 in the page, and a remote one over `?grid-remote=`." },
  arc: { state: "**yes**", why: "A virtual arc in the page." },
  "midi-in": { state: "**yes**", why: "Real devices through WebMIDI, plus a loopback port in the toolbar." },
  "midi-notes": { state: "**yes**", why: "Same path: a USB keyboard reaches scripts as MIDI." },
  "midi-cc": { state: "**yes**", why: "Same path." },
  "midi-out": { state: "**yes**", why: "Same path, outward." },
  "midi-clock": { state: "**yes**", why: "Clock in and out ride the same WebMIDI ports." },
  crow: { state: "no", why: "crow is a USB **serial** device. WebSerial could carry it and has not been built; `crow_send` fails honestly rather than pretending (E5-10)." },
  ii: { state: "no", why: "Reached through crow, so it waits on the same thing." },
  hid: { state: "no", why: "The callback into Lua exists; nothing feeds it. WebHID could, and a gamepad currently drives the norns keys directly instead (the Steam Deck work)." },
  keyboard: { state: "no", why: "The computer's keyboard drives K1-K3 and the encoders, not norns' `keyboard` module, so a script reading `keyboard.char` gets nothing." },
  "audio-in": { state: "**yes**", why: "`getUserMedia` into scsynth's worklet, measured in E0-32 — and ask for RAW capture: Chrome's default adds echo cancellation, AGC and noise suppression, which for a sampler is a gate, a compressor and a ducking filter." },
  link: { state: "no", why: "Ableton Link needs UDP multicast. A browser has no UDP at all, so this one is not a matter of effort." },
  osc: { state: "partial", why: "`osc_send` is implemented; sending and receiving off-page needs the relay (`?osc-relay=`), because a browser cannot open a UDP socket." },
  nb: { state: "partial", why: "Whatever it is pointed at: its engine and MIDI destinations work, its crow ones do not." },
};

/**
 * Models a script checks for by exact MIDI name. Hand-written from the
 * sources, like SUPPORT, because the useful rendering of a device list is
 * prose and a generated one would be a column of matched strings.
 */
const NAMED = {
  midigrid: [
    "turns a MIDI grid controller INTO a monome grid, so these appear to a",
    "script as a grid rather than as a control surface. 23 names in",
    "`lib/supported_devices.lua`: Novation **Launchpad** (original, S, Mini,",
    "MK2, Mini MK3, Pro MK3, X, Open), Akai **APC mini** and **APC mini mk2**,",
    "Ableton **Push 2** and **Push 3**, Roger Linn **LinnStrument**, Synthstrom",
    "**Deluge**, Livid **Block**, and **smartpad**.",
  ].join(" "),
  flora: "looks for a MIDI device literally named **16n** — the open-hardware 16-fader bank, the norns world's usual fader surface — and binds it on sight.",
  "mi-eng": "builds a MIDI parameter map for the **16n** faderbank.",
  cheat_codes_2: "special-cases four by name: **Midi Fighter Twister** (DJ TechTools, 16 encoders), **Faderfox EC4** (16 encoders), **Ableton Push 2**, and the Teenage Engineering **OP-Z**. The encoder boxes get different handling from everything else, because an endless encoder sends relative values and a fader sends absolute ones.",
};

const AUDIO_FILE = /\.(wav|aif|aiff|flac|ogg|mp3)$/i;

/**
 * What a script needs in the way of FILES, which is the other half of
 * "what do I need to use this".
 *
 * A sampler with no sample is not broken, it is empty — and the two look
 * identical from the outside. Three signals, in order of how much they
 * settle:
 *
 *   ships      audio in the script's own folder. It works as it arrives.
 *   file param `params:add_file`, a chooser: you point it at a sample.
 *   dust/audio it reads or writes `~/dust/audio`, which may mean it wants
 *              your library, or merely that it records into it.
 */
function fileNeeds(dir, luaText) {
  let ships = 0;
  let bytes = 0;
  let urls = 0;
  const walk = (at) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(at, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (AUDIO_FILE.test(e.name)) {
        ships++;
        bytes += fs.statSync(full).size;
      }
      if (/^urls?\.txt$/i.test(e.name)) urls++;
    }
  };
  walk(dir);
  const live = luaText
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
  return {
    ships,
    kb: Math.round(bytes / 1024),
    urls,
    fileParam: /params:add_file/.test(live),
    dustAudio: /_path\.audio/.test(live),
  };
}

/** Every .lua a script owns, including the libraries it ships. */
function luaFiles(dir) {
  const out = [];
  const walk = (at) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(at, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".lua")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const scripts = [];
for (const category of fs.readdirSync(SOURCE, { withFileTypes: true })) {
  if (!category.isDirectory()) continue;
  const catDir = path.join(SOURCE, category.name);
  for (const e of fs.readdirSync(catDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(catDir, e.name);
    const files = luaFiles(dir);
    if (files.length === 0) continue;
    const hits = new Map();
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      const lines = text.split("\n");
      for (const kind of KINDS) {
        if (hits.has(kind.id)) continue;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Comments do not count: a script that mentions a grid in a note
          // to the reader is not a script that drives one.
          if (/^\s*--/.test(line)) continue;
          if (kind.test.test(line)) {
            hits.set(kind.id, `${path.relative(dir, f).split(path.sep).join("/")}:${i + 1}`);
            break;
          }
        }
      }
    }
    const luaText = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    scripts.push({
      name: e.name,
      category: category.name,
      files: files.length,
      hits,
      needs: fileNeeds(dir, luaText),
    });
  }
}
scripts.sort((a, b) => a.name.localeCompare(b.name));

const L = [];
L.push("# 07 — What each script can be played with");
L.push("");
L.push("**Generated by `node tools/hardware-report.mjs --write`. Do not edit by hand.**");
L.push("");
L.push("Read from each script's own source, across every `.lua` it ships — the");
L.push("libraries it vendors included, because a script that bundles `nb` can drive");
L.push("MIDI and crow without naming either itself.");
L.push("");
L.push("**A call is not a promise.** This reports what a script REACHES FOR, which is");
L.push("the useful question when deciding what to plug in. An API can sit in dead code");
L.push("or behind a parameter nobody turns on, so every finding carries the file and");
L.push("line it came from and can be checked by reading that line. Comment lines are");
L.push("ignored: a script that mentions a grid in a note to the reader is not one that");
L.push("drives a grid.");
L.push("");
L.push(`${scripts.length} scripts.`);
L.push("");

const SHOW = KINDS.filter((k) => scripts.some((s) => s.hits.has(k.id)));
L.push("| Script | " + SHOW.map((k) => k.label).join(" | ") + " |");
L.push("|---|" + SHOW.map(() => "---").join("|") + "|");
for (const s of scripts) {
  L.push(
    `| \`${s.name}\` | ` + SHOW.map((k) => (s.hits.has(k.id) ? "●" : "")).join(" | ") + " |",
  );
}
L.push("");
L.push("## The hardware this corpus asks for");
L.push("");
L.push("| | Scripts | What it is |");
L.push("|---|---|---|");
for (const k of KINDS) {
  const n = scripts.filter((s) => s.hits.has(k.id)).length;
  L.push(`| **${k.label}** | ${n} | ${k.note} |`);
}
L.push("");
L.push("## Scripts that need files you supply");
L.push("");
L.push("A sampler with no sample is not broken, it is empty — and from the outside");
L.push("those look identical. This is which is which.");
L.push("");
L.push("### They bring their own, and play as they arrive");
L.push("");
for (const s of scripts.filter((x) => x.needs.ships > 0)) {
  L.push(`- \`${s.name}\` — ${s.needs.ships} sound file(s), ${s.needs.kb} KB`);
}
L.push("");
L.push("### They ask you to choose a file");
L.push("");
L.push("`params:add_file` puts a file chooser in PARAMS: point it at a sample.");
L.push("");
for (const s of scripts.filter((x) => x.needs.fileParam && x.needs.ships === 0)) {
  L.push(`- \`${s.name}\``);
}
L.push("");
L.push("### They reach into `~/dust/audio`");
L.push("");
L.push("Which may mean they want your library, or only that they record into it —");
L.push("the call alone does not say which, and both look the same from here.");
L.push("");
for (const s of scripts.filter((x) => x.needs.dustAudio && !x.needs.fileParam && x.needs.ships === 0)) {
  L.push(`- \`${s.name}\`${s.needs.urls > 0 ? " — ships a `urls.txt` naming what to download, and no audio" : ""}`);
}
L.push("");
L.push("## Devices named by name");
L.push("");
L.push("The table above is about CAPABILITIES — a script reads continuous");
L.push("controllers, so anything with knobs will drive it through norns' own MIDI");
L.push("mapping. A few scripts go further and check for a device by its exact MIDI");
L.push("name, which is the only place a model appears. Found by searching for");
L.push("`.name == \"…\"`, because a keyword list reported `beets`'s local variable");
L.push("`beatstep` as an Arturia BeatStep.");
L.push("");
for (const [script, items] of Object.entries(NAMED)) {
  L.push(`**\`${script}\`** — ${items}`);
  L.push("");
}
L.push("## What norns-js can actually plug in");
L.push("");
L.push("Hand-maintained, unlike everything above it: this is **our** status, not");
L.push("something a script's source can say. Each line was checked against the code");
L.push("on 2026-11-12.");
L.push("");
L.push("| | norns-js | |");
L.push("|---|---|---|");
for (const k of KINDS) {
  const s = SUPPORT[k.id];
  L.push(`| **${k.label}** | ${s.state} | ${s.why} |`);
}
L.push("");
L.push("## Where each finding came from");
L.push("");
for (const s of scripts) {
  if (s.hits.size === 0) {
    L.push(`- \`${s.name}\` — nothing beyond the three keys and three encoders.`);
    continue;
  }
  const parts = [...s.hits.entries()].map(
    ([id, where]) => `${KINDS.find((k) => k.id === id).label} (\`${where}\`)`,
  );
  L.push(`- \`${s.name}\` — ${parts.join(", ")}`);
}
L.push("");

const body = L.join("\n");
if (process.argv.includes("--write")) {
  fs.writeFileSync(OUT, body, "utf8");
  process.stdout.write(`docs/07-HARDWARE.md — ${scripts.length} scripts\n`);
} else {
  process.stdout.write(body + "\n");
}
