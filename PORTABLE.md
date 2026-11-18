# norns-js — portable copy

A monome norns in a browser tab: the real `lua/core`, a real SuperCollider
server, crone's mixer and softcut, the 128×64 screen, grid and arc.

## Does it need a server?

**Yes.** Opening `app/index.html` by double-clicking it will not work, and
the reason is not fixable by this archive:

1. **scsynth is compiled with pthreads and needs `SharedArrayBuffer`.** A
   page only gets that when it is *cross-origin isolated*, which a server
   grants with two response headers:

   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```

   A `file://` URL has no response headers at all, so nothing can grant it.
   No isolation → no `SharedArrayBuffer` → no audio engine.

2. The page is an ES module, and module scripts are fetched under CORS
   rules. A `file://` origin is opaque, so the browser refuses them before
   anything above matters.

3. The dust tree and the wasm are fetched, and `fetch` is blocked on
   `file://` for the same reason.

So: **any** static server will do, as long as it sends those two headers.
Most do not by default — `python -m http.server` does not, and nor does the
average "serve this folder" tool. `serve.mjs` here does, and nothing else.

## What do I have to install?

**Node 18 or newer, or Python 3. One or the other, and nothing else.** No
npm install, no pip install, no build step, no dependencies: `serve.mjs`
uses only what ships with Node and `serve.py` only the Python standard
library. They do the same job — pick whichever is already on the machine.

```
node serve.mjs          # or
python3 serve.py
```

A recent Chrome, Edge or any Chromium is the tested browser, and
**Firefox works** — tried, not merely assumed. Everything MEASURED in this
project was Chromium, so the numbers are Chromium's. **Safari is untested
and will stay untested**, by decision.

## Running it

```
node serve.mjs
```

then open <http://localhost:8080/>. To change the folder or the port:

```
node serve.mjs app 9000
```

**The sound is live.** It cannot actually make a noise until you have touched
the page — no browser will start an audio engine before a gesture — so the
toolbar reads `sound on` and the button mutes it. The choice is remembered.

If the log says the browser is holding the engine, click anywhere in the page
and the boot finishes.

## On a Steam Deck

**Nothing to install.** SteamOS ships Python and does not ship Node, and its
root filesystem is immutable — a `pacman -S nodejs` does not survive a system
update. So use the Python server, which needs nothing:

```
python3 serve.py
```

### From the game library

`norns-js.sh` starts the server, opens a browser on it, and stops the server
again when the browser closes. To get it into Game Mode:

1. In **desktop mode**, copy this folder somewhere on the Deck — `~/norns-js`
   is fine — and make the script executable:
   `chmod +x ~/norns-js/norns-js.sh`
2. Install a browser from **Discover** if there is none: Google Chrome or
   Chromium. Everything in this project was measured on Chromium; Firefox
   also works.
3. In Steam, **Games → Add a Non-Steam Game → Browse**, and pick
   `norns-js.sh`. Set the file filter to "All Files" or it will not be
   listed.
4. Back in **Game Mode**, open the new entry's **controller settings** →
   **Browse Configs** → **Templates**, and choose **Gamepad with Mouse
   Trackpad**. Apply it.

   This matters more than it sounds. Steam Input decides what the physical
   controls *send*: on a desktop or "Web Browser" layout the sticks become a
   mouse and the buttons become keystrokes, and the page sees **no gamepad
   at all**. The layout belongs to that one shortcut, not to the browser, so
   it has to be set on the entry you actually launch.

   While you are in there, set the **right trackpad click to Left Mouse
   button**. It is what lets you press the toolbar and the gear, and it is
   also the gesture that starts the audio — a gamepad button is not a user
   gesture as far as a browser is concerned.

5. **If the pad still is not seen**, a Flatpak browser may be sandboxed away
   from the controller device. In desktop mode:

   ```
   flatpak override --user --filesystem=/run/udev:ro com.google.Chrome
   ```

   This changes that app's permissions permanently, so it is listed as a fix
   rather than done by the launcher.

### The controls

With a gamepad layout, the Deck's own controls play the norns:

| | |
|---|---|
| **A** | K3 |
| **B** | K2 |
| **X** | K1 |
| **left stick** ←→ | E2 |
| **right stick** ←→ | E3 |
| **d-pad** ←→, **L1 / R1** | E1 |
| right trackpad | the pointer, for the toolbar and the gear |

The sticks are rate controls, not positions: push a little and the value
creeps, push to the stop and it runs. An encoder reports movement and a
stick springs back to centre, so anything else would be a knob that undoes
itself when you let go.

The page also lays itself out for the Deck's 1280×800: the norns goes left,
the grid beside it, and both fit without scrolling. Unplug the grid and the
norns takes the whole screen. If the detection gets it wrong — it is a guess
unless Steam's own browser is in use — the gear has **machine**, with
`normal`, `phone` and `steam deck` to force it.

**None of the Steam Deck path has been run on a Steam Deck.** The server
under it is measured and works; the rest is written from SteamOS's
documented shape.

## On Android

Yes — **on the phone itself**, with the same server. What does not work is
the obvious shortcut.

### The way that works

1. Install **Termux** (from F-Droid; the Play Store build is abandoned).
2. `pkg install nodejs`
3. Copy this folder onto the phone, `cd` into it, `node serve.mjs`
4. Open **http://localhost:8080/** in Chrome.

`localhost` is a secure context, so the isolation headers do their job and
the audio engine starts.

### The shortcut that does not work, and why

**Serving it from your computer and opening `http://192.168.x.x:8080` on the
phone will not work.** Cross-origin isolation requires a *secure context*,
and plain `http://` to anything but localhost is not one. You get a page
that looks completely fine and has no audio engine at all.

That failure is worth recognising, because nothing says it out loud —
measured here by serving this exact build with the two headers removed:

```
crossOriginIsolated   false
SharedArrayBuffer     undefined
the page              boots, draws, menu works
the log               stops at "loading scsynth.wasm and sclang.wasm …"
audio                 never arrives
```

If you want the server on your computer anyway, give the phone a *localhost*
to talk to:

```
adb reverse tcp:8080 tcp:8080
```

Then `http://localhost:8080/` on the phone reaches your machine, as a secure
context. Needs a USB cable and the Android platform tools.

HTTPS with a real certificate works too, and a self-signed one does not —
an untrusted certificate is not a secure context either.

### What is and is not verified

The layout was measured at phone size (375×812): it fits, nothing overflows
sideways, and the norns screen renders at the right scale. Input is pointer
events throughout, so touch is the same code path as a mouse.

**Nothing here has been run on actual Android hardware.** The honest
unknowns are memory and sustained audio: this starts two WebAssembly audio
engines, and a phone with 4 GB that evicts background tabs is a different
proposition from a laptop. Expect to find out.

Two things that will help on a small screen: the gear's **arrange devices**
lets you make the norns fill the width and move the grid below it, and it
remembers the arrangement. Turn the phone sideways for the grid.

## It arrives with no scripts. That is deliberate.

Press **community scripts** in the toolbar. It reads
[norns.community](https://norns.community/)'s own catalogue — 354 entries,
live, nothing cached here — and installs any of them straight from the
author's repository into `~/dust/code`.

Nobody else's work is shipped inside this archive, which is both the honest
arrangement and the only one that is clearly allowed: of the scripts this
project tested with, seventeen of thirty-five carry no licence at all, and
that means all rights reserved.

**A script that brings a SuperCollider engine needs one reload** before it
will run. Engine classes are compiled into sclang once, at start-up, so a
class that arrives afterwards is on disk but was never built. The install
message says so when it applies.

## When do I have to restart?

Less often than you would think. SELECT re-reads the tree every time it is
opened and loading a script re-reads the file, so **anything made of Lua is
ready at once**. What a restart is for is the three things that are built
once, at start-up.

| what you did | restart? | why |
|---|---|---|
| install or update a script that is only Lua | **no** | SELECT re-reads the tree; the file is read on load |
| install or update a script that ships a `.sc` engine | **yes** | engine classes are compiled into sclang once, at boot |
| edit a script's own `.lua` and run it again | **no** | `norns.script.load` is a `dofile`: it reads the file |
| edit a lib the script reaches with `include` | **no** | `include` is a `dofile` too (`startup.lua:58`) |
| edit a lib the script reaches with `require` | **YES** | and this is the one that catches people — see below |
| edit a `.sc` engine | **yes** | same as installing one |
| enable or disable a mod | **yes** | mods are `require`d at boot and only at boot |
| params, psets, levels, the settings panel | **no** | |

**`require` caches and `include` does not**, which is upstream Lua and
upstream norns, not something this port added: `script.clear()` drops
exactly one entry from `package.loaded` (`asl`), so every other module a
script required keeps the version it had when it was first read. Measured
here rather than taken on trust — one script requiring and including the
same lib, the lib edited between two loads:

```
first load    REQUIRE=1 INCLUDE=1
lib edited to 2, script loaded again
second load   REQUIRE=1 INCLUDE=2
```

So if you are editing a `lib/` file and your changes seem to do nothing,
look at how the script reaches it. `require` means restart.

**SYSTEM > RESTART reloads the page**, which is what a restart IS here: the
page is matron, sclang, crone and the clock, so reloading it restarts all
four. What you have written is in the browser's storage and survives it.

## What else is in the toolbar

| | |
|---|---|
| `grid` / `arc` | plug in a virtual grid (64/128/256) or an arc, or none |
| `sound on` | the master mute: press it to silence the output |
| `midi loopback` | a virtual MIDI port that echoes to itself |
| `midi keyboard` | two octaves you can play with a pointer; octave and velocity are in the gear |
| `community scripts` | the catalogue above |
| `console` | the log, the keyboard map, and `__norns` in the dev tools |
| the gear | five tabs: controls, display (machine, zoom, arrange), midi, files, about |

Keys: `1 2 3` are K1–K3, `q w` / `a s` / `z x` are the three encoders, and
all of it is remappable in the gear. Every control is named under it on the
device itself. On a Steam Deck the pad plays it instead — see above. Dragging an encoder turns it; the arc
that appears is feedback that it moved, not a position — a real norns
encoder has no mark on it.

## Your files

Everything you make lives in this browser's storage for this origin:
scripts you install, psets you save, tapes you record. Clearing site data
deletes it with no warning. The gear's **export** writes a zip of what
you have changed and **restore** puts it back; **add a script** is the other
door, for one script's zip, which it rehomes under `code/`.

## Licence

norns-js is **AGPL-3.0-or-later**; the full text is in `app/source/LICENSE`,
and the source it was built from is in `app/source/` — reachable from the
running page at <http://localhost:8080/source/>, which is where the gear's
**about** panel links. It sits inside the served tree on purpose: a folder
beside the server's root is a source offer that 404s. It stands on work under other
terms — norns itself and SuperCollider are GPL-3.0, fengari is MIT, cairo is
LGPL-2.1/MPL-1.1, FreeType is FTL/GPL-2.0 — each named in the gear's
**about** panel.

Scripts installed from the catalogue are **their authors' work under their
authors' terms**, fetched by you, into your browser. They are not part of
this archive and are not redistributed by it.

`app/source/` holds the TypeScript, the tools, the documentation and the
build configuration. It does not hold the vendored upstream trees (norns,
SuperCollider, cairo) or the prebuilt wasm, which are large and come from
their own projects; the full working tree is the complete corresponding
source.
