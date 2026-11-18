# norns-js

**A [monome norns](https://monome.org/docs/norns/) in a browser tab.**

Not a re-implementation. The upstream norns Lua runs here *unmodified* —
`lua/core` with **zero patches** — on real SuperCollider, `sclang` **and**
`scsynth`, compiled to WebAssembly. Real softcut, real crone, and the 128×64
screen drawn by cairo rather than approximated with Canvas2D. Scripts come
from [norns.community](https://norns.community/) at the click of a button,
from their authors' own repositories.

> **Port, don't emulate.** norns' Lua talks to its C core through one table,
> `_norns`, with 174 functions. Implement those and every
> script-compatibility question is answered structurally instead of one bug
> at a time.

---

## Try it

**<https://norns-js.pages.dev/>** — nothing to install. Open it, press **+**,
pick a script.

It needs a recent **Chromium** browser (Chrome, Edge, Brave, Arc) or
**Firefox**, where it has been tried and works. Every number in this
repository was measured on Chromium, so treat the measurements as Chromium's
and the behaviour as both.

**Safari is untested, and is going to stay that way** — that is a decision
rather than a gap waiting to be filled. If it fails there, it fails.

---

## What is real, and what is not

This is the part worth reading before anything else, because the whole point
of the project is that the answer is *most of it*.

**Real:**

| | |
|---|---|
| **The script host** | norns' own `lua/core`, unpatched — `script.lua`, `params`, `clock`, `metro`, `menu`, PSETs, PMAPs |
| **The audio** | `sclang` and `scsynth` as WebAssembly. Engines compile from SuperCollider source at boot, the way they do on hardware |
| **The DSP** | softcut's six voices, crone's mixer and Tape, 26 engines built in — and a script that brings its own gets compiled too |
| **The screen** | cairo and FreeType on norns' own fonts. The same rasteriser, so the same pixels |
| **The devices** | grid and arc over WebSocket (`serialosc`) or on screen; MIDI over Web MIDI; a computer keyboard |
| **The filesystem** | a dust tree in your browser's own storage, surviving reloads, with the editor and PSETs reading and writing it |

**Not real, and it says so rather than failing quietly:**

Ableton Link (needs UDP multicast), `osc_*` (needs raw UDP), `system_cmd` and
`execute` (no shell — though `git clone`, `wget` and `curl` are recognised and
*fetched* for you), `crow_*` (USB serial). Each of these logs a line naming
itself when a script reaches it, so a script that behaves oddly tells you why.

---

## Using it

**Scripts.** The pencil in the rail opens the editor; its **project** tab
reads the live norns.community catalogue — 355 entries, nothing cached here —
and installs any of them straight from the author's repository into
`~/dust/code`. A script that needs another script, or another script's
SuperCollider engine, pulls it in with it. A script that needs a GitHub
repository nobody publishes any more says so instead.

**Nothing of anyone else's ships inside this.** A script you install is your
copy of its author's work, with their licence file beside it. See
[`LICENCES.md`](LICENCES.md) for why that is the only honest
arrangement.

**Hardware.** Plug in a grid or an arc through
[serialosc](https://monome.org/docs/serialosc/) and they just work; plug in
MIDI and it just works. Or use the on-screen grid, arc, keyboard and faders —
they are the same code path a real one takes.

**What a script is missing.** `community-blockers.json` is a sweep of all 355
catalogue entries, and a row that needs something says what: a GitHub release
file a browser cannot fetch, a network reply that cannot arrive in time, a
MIDI device you have to attach first. **20 of 355** carry a note today.

---

## Cross-origin isolation is not optional

`scsynth` is compiled with pthreads and needs `SharedArrayBuffer`, which a
page only gets when it is **cross-origin isolated**. That is granted by two
response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

A `file://` URL has no response headers at all, so **double-clicking
`index.html` can never work** and no amount of configuration will change it.
Without the headers the page still loads, draws and runs its menus — the log
simply stops at *"loading scsynth.wasm and sclang.wasm …"* and no audio ever
arrives. A page that looks completely fine and is deaf. Measured, by serving
this exact build with the two lines removed.

[`public/_headers`](public/_headers) covers Cloudflare Pages and Netlify
unchanged. GitHub Pages cannot set headers at all.

---

## Running a copy

Any static server that sends those two headers. One with no dependencies is
included, for whichever of the two a machine is likely to have:

```bash
node tools/serve.mjs dist 8080
```

```bash
python3 tools/serve.py dist 8080
```

---

## Development

On Windows, one script puts the tools in place and installs nothing that is
already there:

```powershell
.\tools\setup-windows.ps1 -Role build       # -DryRun to see what it would do
```

It is written for **PowerShell 5.1**, which is what a fresh Windows has, and
it checks `Get-Command` rather than parsing winget, whose output is
localised. `-Role publish` is the smaller set: git and Node, enough to make a
repository and deploy a build.

```bash
npm install
npm run dev          # http://localhost:5173/, with the two headers set
npm test             # 901 tests
npm run typecheck
npm run pins:check   # third_party/ still matches PINS.md
npm run notices:check
npm run licences:check
```

**Node 22.12 or newer**, which is `vitest`'s own declaration and not a
guess. Two other versions are pinned and both will stop a build rather than
produce a subtly different one: **emscripten 4.0.18**, and **CMake 3.31.x** —
CMake 4 dropped compatibility with the `cmake_minimum_required` SuperCollider
still declares.

`npm run dev` configures the headers deliberately, so the dev server behaves
like the deployment target instead of hiding the constraint until the first
deploy.

### `third_party/` is most of the work and none of it is ours

Eight upstream git trees and nine unpacked releases — norns, SuperCollider,
sc3-plugins, mi-UGens, softcut-lib, DaisySP, Eigen, cairo, pixman, FreeType,
FFTW and the toolchain — about 2.7 GB, **not in this repository**. The exact
commit of each is in **[`PINS.md`](PINS.md)**, generated
rather than hand-kept so it cannot quietly go stale, and `npm run pins:check`
fails when it does.

**One script puts it all there**, reading the git trees out of `PINS.md` and
verifying every download by sha256:

```powershell
.\tools\fetch-third-party.ps1 -DryRun
.\tools\fetch-third-party.ps1
```

A release file on a project's own server never changes, so a mismatch stops
it; a GitHub source archive is regenerated and a branch moves, so there a
difference is reported with both values and it carries on. It skips the
emsdk, which `setup-windows.ps1 -Role build` already cloned.

It also **applies `patches/`**, which is not a convenience: without
`patches/supercollider.patch` the build below completes, says BUILD OK and
produces something subtly different, because CMake accepts an unknown `-D`
in silence. `npm run pins:check` should answer **15 trees, 3 patched**; `0
patched` means they are not on.

Three of them are patched, and the patches are in
[`patches/`](patches/) rather than applied in place, so what is ours and what
is theirs stay separable. Without `patches/supercollider.patch` the build
completes and produces something subtly different — CMake accepts an unknown
`-D` in silence, which is how `SC_WASM_PRELOAD_CLASSLIB` once looked like a
pass.

### The two build stages

**One script runs both**, skipping what is already built, checking that each
step produced the file it promised rather than trusting its exit code:

```powershell
.\tools\build-wasm.ps1 -DryRun     # the plan, and what is already there
.\tools\build-wasm.ps1
```

It finds Git Bash on disk rather than on PATH, because `bash` on a Windows
PATH is usually WSL's and WSL has none of `third_party/`. `-Only <step>`
runs one, `-Force` redoes one, `-Scripts` packs the community corpus into
the filesystem image instead of leaving it empty.

By hand it is eleven commands in two stages. The first is slow, needs the
whole toolchain and you do it once:

```bash
node tools/extract-fonts.mjs --write   # src/screen/fonts.h, which screen.c INCLUDES
bash tools/sclang/build.sh             # sclang.wasm and scsynth.wasm
bash tools/sclang/build-nopreload.sh   # the sclang that is actually SERVED
bash tools/screen/build-cairo.sh       # cairo + pixman — minutes
bash src/screen/build.sh               # links screen.wasm against them
bash src/crone/build.sh                # crone.wasm: the mixer, softcut, Tape
node tools/pack/pack-classlib.mjs      # sclang's class library, as a tar
```

The second takes seconds:

```bash
npm run clock           # the clock worklet
npm run dust            # the filesystem image — needs `community patches/`
npm run audio           # stage 1's wasm, into public/
npm run ugens           # the UGens THIS scsynth has, for the SynthDef check
npm run crone:worklet   # regenerated far less often, so it is separate
```

Two of those lines are easy to get wrong and both were, in this README,
until the script was written and the list was followed:

* **`build-nopreload.sh` is not optional.** `npm run audio` serves
  `wasm-dist/sclang-nopreload/`; the sclang from `build.sh` keeps its 2 MB
  `--preload-file` class library and is never copied. Skip it and `npm run
  audio` stops with `missing — build it first`.
* **`npm run ugens` is not optional either**, and it is the one that fails
  invisibly. It writes the names of the UGens this scsynth was compiled
  with; the page checks every SynthDef against that list before sending it,
  because scsynth THROWS on an unknown UGen and this build has exceptions
  off — the throw kills the thread that handles `/d_recv` and it never
  comes back. No def loads, nothing sounds, and `/status` keeps answering.
* **`npm run dust` needs `community patches/`**, which is 91 MB of cloned
  scripts and is not in this repository. A tree without it wants
  `node tools/build-dust.mjs --no-scripts --write`, which is what a
  published build ships anyway — and which the script does by default.

Each script explains in its own header what it does and what it refuses to
do. `src/crone/build.sh` is worth reading: it does **not** patch
`third_party/` — three shims (JACK, liblo, libsndfile) go first on the
include path instead, the same technique as SuperCollider's
`SystemOverwrites`.

### Looking at what it is doing

Press **console** in the toolbar. The first line is the build stamp, so there
is never a question of which copy is running. `window.__norns` exposes the
host, the VFS, the screen, the clock and a `peak()` meter that sits *before*
the master gain — which is what lets a muted page still answer "did this
script make a sound". And there is an exerciser that loads every script in
the tree and reports what each one drew, answered and played:

```js
__norns.exercise()
```

---

## What is in this repository

| | |
|---|---|
| [LICENCES.md](LICENCES.md) | what may be redistributed and what may not, and why no script ships inside this |
| [PINS.md](PINS.md) | exactly what `third_party/` is — every upstream tree and the commit it is pinned at |
| [NOTICES.txt](public/NOTICES.txt) | twenty components, every licence text in full, generated from what the build links |
| `src/` | the application: the `_norns` host, the screen, the engine, crone, the UI |
| `tools/` | the generators and build scripts — `npm run assets`, the notices, the blockers table |
| `tools/sclang`, `tools/screen`, `tools/pack` | the WebAssembly builds — `sclang`, `scsynth`, the screen, the class library. These are how every `.wasm` here was produced, and each is a `build.sh` you can run |
| `patches/` | three upstream trees need changes; they are diffs, so what is ours stays separable |
| `test/` | 901 of them, and six that say so when they are skipped |
| `desktop/`, `electron-builder.yml` | the Electron shell for the Windows app — four files; the page it wraps is the same `src/` |

**This is the source, not the workshop.** The development tree also holds
about seventy working papers — research notes, a backlog, measurement
transcripts, the spikes that answered a question and were then left behind.
They are not part of what is served to anybody, so they are not published,
and **39 published files cite one by name** (`research/crone-port.md`,
`docs/07-HARDWARE.md`, `spike/lua64/README.md` and so on). The reasoning is in the comment beside the
code; the citation is to a longer paper you will not find here. Ask if you
want one.


---

## Licence and copyright

norns-js is © 2026 pinktentacle.

- **The code** is free software under the
  [GNU AGPL v3.0 or later](LICENSE): you may use, study, share and change it
  under its terms. The AGPL rather than the GPL is not a matter of taste —
  SuperCollider's wasm binding, which this project ships, is itself AGPL
  "version 3 or later", so the combined work takes the strongest term in the
  stack. Its §13 is the one that bites: software interacted with over a
  network — which a web page always is — must **offer its source to the
  people using it**, so a production build is refused unless
  `VITE_SOURCE_URL` names the repository it came from, and the running app
  shows that link in its gear.

- **The norns-js name and these documents** are © 2026 pinktentacle,
  all rights reserved.

- **Built on others' work.** norns is monome's (GPL-3.0) and its Lua is
  inlined into the bundle; SuperCollider, sc3-plugins, mi-UGens,
  PortedPlugins and softcut-lib are compiled into the two wasm modules;
  the sound of the mi UGens is [Émilie Gillet's Mutable Instruments
  code](https://github.com/pichenettes/eurorack) (MIT), via Volker Böhm's
  [mi-UGens](https://github.com/v7b1/mi-UGens); the screen is cairo, pixman
  and FreeType; the Lua VM is [Lua](https://www.lua.org) itself (MIT), 5.3.6
  compiled from source. **[`NOTICES.txt`](public/NOTICES.txt)**
  carries every one of the twenty with its licence in full, generated from
  what the build actually links, and the running app serves it at
  `/NOTICES.txt`.

- **A script you install is not covered by any of this.** It is fetched from
  its author's repository into your browser, with their licence beside it,
  and stays theirs.

- norns-js is **not a monome product**. monome, norns, Mutable Instruments
  and all other product names are trademarks of their respective owners,
  named only to say what this is built on and what it works with. No
  affiliation with or endorsement by them is implied.
