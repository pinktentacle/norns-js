// E9-75 — the notices that travel WITH the build.
//
// `LICENCES.md` is the argument and `SETTINGS > ABOUT` is the
// offer; this is the artefact. A deployed copy of norns-js carries other
// people's work into a browser — norns' entire Lua tree inlined into the
// bundle, SuperCollider as two wasm modules, and sixteen more libraries
// compiled into them — and several of those licences say, in as many
// words, that their notice must travel with the copy. MIT: "The above
// copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software."
//
// GENERATED, like every other fact in this project. The licence texts are
// READ OUT OF `third_party/` rather than fetched or remembered: the text
// that ships is then the text that was in the tree the binaries were built
// from, which is the only version of it that is true.
//
//   node tools/build-notices.mjs           # write public/NOTICES.txt
//   node tools/build-notices.mjs --check   # fail if it is stale
//
// The file is TRACKED, unlike the other generated things under `public/`.
// It has to be readable in a fresh clone that has no `third_party/` yet,
// and it is part of what a release is.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOT = new URL("../", import.meta.url);
const OUT = new URL("public/NOTICES.txt", ROOT);

/**
 * Everything of somebody else's that reaches a browser.
 *
 * `--no-scripts` is the deploy build, so no community script is here: the
 * catalogue installs those into the user's own storage, which is their
 * copy of the author's work and not ours. What is left is the RUNTIME.
 *
 * `pin` is the commit in `PINS.md`. `licence` is the path to the
 * text in the tree the build used — not an SPDX guess. Writing this file
 * found two things wrong in `about.ts`: sc3-plugins is GPL-2.0-OR-LATER
 * and not GPL-3.0, and STK, nova-simd, PortedPlugins, DaisySP, DaisySP-LGPL,
 * Eigen, FFTW, sc-plugins-extra and softcut-lib were not listed at all —
 * nine of the nineteen things a browser is handed.
 */
const COMPONENTS = [
  {
    what: "norns",
    who: "monome",
    spdx: "GPL-3.0-only",
    url: "https://github.com/monome/norns",
    pin: "227aa0442181",
    ships: "its whole Lua tree, inlined into the application bundle and run as the script host",
    licence: "norns/LICENSE.txt",
  },
  {
    what: "SuperCollider",
    who: "James McCartney and contributors",
    spdx: "GPL-3.0-or-later",
    url: "https://github.com/supercollider/supercollider",
    pin: "0c5a96d701be, with patches/supercollider.patch",
    ships: "sclang.wasm, scsynth.wasm and the SuperCollider class library",
    licence: "supercollider/COPYING",
  },
  {
    what: "sc3-plugins",
    who: "the SuperCollider community",
    spdx: "GPL-2.0-or-later",
    url: "https://github.com/supercollider/sc3-plugins",
    pin: "774f3f05ef40, with patches/sc3-plugins.patch",
    ships: "UGens compiled into scsynth.wasm",
    licence: "sc3-plugins/license.txt",
  },
  {
    what: "The Synthesis ToolKit in C++ (STK)",
    who: "Perry R. Cook and Gary P. Scavone",
    spdx: "MIT-like, see the text",
    url: "https://ccrma.stanford.edu/software/stk/",
    pin: "inside sc3-plugins, external_libraries/stk",
    ships: "the physical-model UGens, and the 42 raw wave tables served from /stk-rawwaves",
    licence: "sc3-plugins/external_libraries/stk/LICENSE",
  },
  {
    what: "nova-simd",
    who: "Tim Blechmann",
    spdx: "see the text",
    url: "https://github.com/timblechmann/nova-simd",
    pin: "inside sc3-plugins, external_libraries/nova-simd",
    ships: "the vector maths under the sc3-plugins UGens",
    licence: "sc3-plugins/external_libraries/nova-simd/COPYING",
  },
  {
    what: "mi-UGens",
    who: "Volker Böhm",
    spdx: "GPL-3.0-only",
    url: "https://github.com/v7b1/mi-UGens",
    pin: "10f6824f68ad (v0.0.9), with patches/mi-UGens.patch",
    ships: "the Mutable Instruments UGens compiled into scsynth.wasm",
    licence: "mi-UGens/gpl-3.0.md",
  },
  {
    what: "Mutable Instruments eurorack",
    who: "Émilie Gillet",
    spdx: "MIT",
    url: "https://github.com/pichenettes/eurorack",
    pin: "inside mi-UGens, eurorack/",
    ships: "the DSP inside every mi UGen — Plaits, Rings, Clouds, Elements and the rest",
    licence: "mi-UGens/eurorack/LICENSE.txt",
  },
  {
    what: "PortedPlugins",
    who: "Mads Kjeldgaard and contributors",
    spdx: "GPL-3.0-or-later",
    url: "https://github.com/madskjeldgaard/portedplugins",
    pin: "unpacked release, see PINS.md",
    ships: "eleven UGens compiled into scsynth.wasm",
    licence: "portedplugins/LICENSE",
  },
  {
    what: "DaisySP",
    who: "Electrosmith",
    spdx: "MIT",
    url: "https://github.com/electro-smith/DaisySP",
    pin: "2c72eaf9eac5",
    ships: "the DSP under the PortedPlugins UGens, compiled into scsynth.wasm",
    licence: "DaisySP/LICENSE",
  },
  {
    what: "DaisySP-LGPL",
    who: "Electrosmith",
    spdx: "LGPL-2.1-or-later",
    url: "https://github.com/electro-smith/DaisySP",
    pin: "2c72eaf9eac5, DaisySP-LGPL/",
    ships: "BLOsc and DCompressor, STATICALLY linked into scsynth.wasm — see the note below",
    licence: "DaisySP/DaisySP-LGPL/LICENSE",
  },
  {
    what: "Eigen",
    who: "the Eigen authors",
    spdx: "MPL-2.0",
    url: "https://gitlab.com/libeigen/eigen",
    pin: "3147391d946b (3.4.0)",
    ships: "the linear algebra under ChowDSP's GenSVF, in the Werner UGen",
    licence: "eigen/COPYING.MPL2",
  },
  {
    what: "FFTW",
    who: "Matteo Frigo and Steven G. Johnson, MIT",
    spdx: "GPL-2.0-or-later",
    url: "https://www.fftw.org/",
    pin: "fftw-3.3.10",
    ships: "the FFT under SuperCollider's spectral UGens",
    licence: "fftw3/COPYING",
  },
  {
    what: "sc-plugins-extra (ByteBeat, PulsePTR, TrianglePTR, FormantTriPTR)",
    who: "their respective authors",
    spdx: "GPL-3.0-or-later",
    url: "see PINS.md",
    pin: "unpacked release",
    ships: "four UGens compiled into scsynth.wasm",
    licence: "sc-plugins-extra/LICENSE",
  },
  {
    what: "softcut-lib",
    who: "monome",
    spdx: "GPL-3.0-only",
    url: "https://github.com/monome/softcut-lib",
    pin: "14241f2a94a7",
    ships: "the six softcut voices, compiled into crone.wasm",
    licence: "softcut-lib/LICENSE.txt",
  },
  {
    // E9-117 — this was fengari, a Lua written in JavaScript, until the
    // interpreter became the interpreter: PUC Lua itself, compiled from
    // source by `tools/lua53/build.sh`. 5.3 because norns is 5.3, which is
    // the reason fengari was chosen in the first place and the reason this
    // could replace it. `patches/fengari.patch` carried 64-bit integers
    // into a VM that had none; these are native.
    what: "Lua",
    who: "Lua.org, PUC-Rio",
    spdx: "MIT",
    url: "https://www.lua.org/",
    pin: "5.3.6, sha256 fc5fd69bb8736323f026672b1b7235da613d7177e72558893a0bdcd320466d60",
    ships: "the Lua virtual machine every script runs in, as wasm",
    licence: "lua53/doc/readme.html",
  },
  {
    what: "cairo",
    who: "the cairo authors",
    spdx: "LGPL-2.1-only or MPL-1.1",
    url: "https://www.cairographics.org/",
    pin: "cairo-1.16.0",
    ships: "the rasteriser behind the norns screen",
    licence: "cairo-build/cairo-1.16.0/COPYING",
  },
  {
    what: "pixman",
    who: "the pixman authors",
    spdx: "MIT",
    url: "https://www.pixman.org/",
    pin: "pixman-0.42.2",
    ships: "cairo's pixel back end",
    licence: "cairo-build/pixman-0.42.2/COPYING",
  },
  {
    what: "FreeType",
    who: "David Turner, Robert Wilhelm and Werner Lemberg",
    spdx: "FTL or GPL-2.0-or-later",
    url: "https://freetype.org/",
    pin: "VER-2-10-4",
    ships: "the glyph rasteriser for the screen's fonts",
    licence: "freetype-2104/freetype-VER-2-10-4/docs/FTL.TXT",
  },
  {
    what: "Electron",
    who: "Electron contributors, GitHub Inc.",
    spdx: "MIT",
    url: "https://github.com/electron/electron",
    pin: "the version in package-lock.json",
    ships: "the desktop app only — it wraps this same page in a window. Not in the browser build",
    licence: null,
    from: "node_modules/electron/LICENSE",
  },
  {
    what: "Ace",
    who: "Ajax.org B.V.",
    spdx: "BSD-3-Clause",
    url: "https://github.com/ajaxorg/ace",
    pin: "ace-builds, the version in package-lock.json",
    ships: "the code editor in the project panel",
    licence: null,
    from: "node_modules/ace-builds/LICENSE",
  },
];

const read = (rel) =>
  readFileSync(new URL(rel, ROOT), "utf8").split("\r\n").join("\n").trimEnd();

const RULE = "=".repeat(76);
const THIN = "-".repeat(76);

function build() {
  const out = [];
  out.push("norns-js — licences and notices");
  out.push(RULE);
  out.push("");
  out.push("norns-js is © 2026 pinktentacle. It is free software under the GNU");
  out.push("Affero General Public License, version 3 or later (LICENSE, beside this file).");
  out.push("");
  out.push("The AGPL's section 13 is why this file exists in a web build at all: software");
  out.push("interacted with over a network — which a page always is — must OFFER its");
  out.push("Corresponding Source to the people using it. That offer is the source link in");
  out.push("SETTINGS > ABOUT of the running application, and it covers everything listed");
  out.push("below as well as norns-js itself.");
  out.push("");
  out.push("The norns-js name and its documents are © 2026 pinktentacle, all rights");
  out.push("reserved. The code is not: see the AGPL.");
  out.push("");
  out.push("norns-js is not a monome product. monome, norns, Mutable Instruments, Daisy");
  out.push("and all other product names are trademarks of their respective owners, named");
  out.push("here only to say what this is built on and what it is compatible with. No");
  out.push("affiliation with or endorsement by any of them is implied.");
  out.push("");
  out.push("No community script is in this build. They are fetched from their own");
  out.push("repositories, on request, into the user's own browser storage — that copy is");
  out.push("between the user and the author, and carries the author's own licence file");
  out.push("with it. LICENCES.md is why.");
  out.push("");
  out.push("");
  out.push("The DESKTOP app carries one thing a browser tab does not: Electron, and");
  out.push("the Chromium it is built on. Electron is MIT and its notice is below;");
  out.push("Chromium and the hundreds of libraries inside it carry their own, and");
  out.push("electron-builder puts the whole set in the package as");
  out.push("LICENSES.chromium.html, beside the executable. The browser build has none");
  out.push("of this — it runs in a browser somebody else installed.");
  out.push("");
  out.push("");
  out.push("What this build carries");
  out.push(RULE);
  out.push("");

  const texts = new Map();
  for (const c of COMPONENTS) {
    const text = read(c.licence === null ? c.from : "third_party/" + c.licence);
    const key = createHash("sha256").update(text).digest("hex").slice(0, 12);
    if (!texts.has(key)) texts.set(key, { text, used: [] });
    texts.get(key).used.push(c.what);
    c.key = key;
  }

  for (const c of COMPONENTS) {
    out.push(c.what);
    out.push(THIN);
    out.push("  by        " + c.who);
    out.push("  licence   " + c.spdx + "   [text " + c.key + "]");
    out.push("  upstream  " + c.url);
    out.push("  version   " + c.pin);
    out.push("  in here   " + c.ships);
    out.push("");
  }

  out.push("");
  out.push("Two obligations stated rather than assumed");
  out.push(RULE);
  out.push("");
  out.push("DaisySP-LGPL is linked STATICALLY into scsynth.wasm, which is the strictest");
  out.push("case the LGPL has. Its section 3 permits taking the library under GPL-2 or any");
  out.push("later version; GPL-3 is a later version, and AGPL-3 section 13 permits");
  out.push("combining a GPL-3 work with an AGPL one. What the LGPL asks of a static link —");
  out.push("that a recipient can relink against a modified library — is met by the source");
  out.push("offer above: the whole tree, the exact commits in PINS.md, and the");
  out.push("build scripts that produced the binaries.");
  out.push("");
  out.push('sc3-plugins and FFTW are GPL-2.0-OR-LATER, not GPL-2.0-only. The "or later" is');
  out.push("what makes them combinable here at all, and it is in their own words: FFTW's");
  out.push('COPYRIGHT says "(at your option) any later version", and every sc3-plugins');
  out.push('source file carries "either version 2 of the License, or ... any later');
  out.push('version".');
  out.push("");
  out.push("");
  out.push("Licence texts");
  out.push(RULE);
  out.push("");
  out.push("One copy of each distinct text, keyed by the tag beside each component above.");
  out.push("Every one is read out of the tree these binaries were built from, so what");
  out.push("ships is the text that was actually there.");
  out.push("");

  for (const [key, { text, used }] of texts) {
    out.push("");
    out.push("[" + key + "]  " + used.join(", "));
    out.push(RULE);
    out.push("");
    out.push(text);
    out.push("");
  }

  return out.join("\n") + "\n";
}

const body = build();
if (process.argv.includes("--check")) {
  let have = "";
  try {
    have = readFileSync(OUT, "utf8");
  } catch {
    /* missing counts as stale */
  }
  if (have !== body) {
    console.error("public/NOTICES.txt is stale — run: node tools/build-notices.mjs");
    process.exit(1);
  }
  console.log("NOTICES.txt is current");
} else {
  writeFileSync(OUT, body);
  console.log(
    "public/NOTICES.txt: " +
      COMPONENTS.length +
      " components, " +
      (body.length / 1024).toFixed(0) +
      " KB",
  );
}
