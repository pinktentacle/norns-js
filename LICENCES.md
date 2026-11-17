# Licences — what may be served, and what may not

**E7-13. This is a gate on deployment, not a note.**

Running a script on your own machine is not distribution. Serving it from a
public URL is. A script that carries no licence defaults to *all rights
reserved*, and seventeen of the thirty-five bundled scripts are in exactly
that position.

The facts are generated, not remembered: `tools/audit-licences.mjs` reads
the tree and writes [`licences.json`](licences.json). Run it after adding a
script; `--check` fails if the file is stale. The failure mode of a
hand-kept list is silent — a script is added, nobody edits the list, and it
ships anyway.

## What the audit finds

| licence | scripts |
|---|---|
| **none at all** | **17** |
| GPL-3.0 | 11 |
| MIT | 6 |
| GPL-2.0 | 1 |

**Redistributable: 18 of 35.**

Without a licence: `ack`, `awake`, `cheat_codes_2`, `cranes`, `foulplay`,
`glut`, `less_concepts`, `mangl`, `mi-eng`, `mlr`, `n.kria`, `nb`, `orca`,
`otis`, `reels`, `rudiments`, `takt`.

Checked by hand as well as by tool: none of the seventeen states a licence
in a README, a header or an SPDX line. The only hits a loose scan produced
were **vendored third-party files inside them** — Robert Penner's easing
equations in `cheat_codes_2`, a CC-BY `JSON.lua` in `orca` — which are
grants for those files and not for the script.

## The decision

`tools/build-dust.mjs --redistributable` builds a tree containing only the
eighteen. It reads `licences.json`, so it cannot drift from the audit.

```
  files packed      489        (vs 705)
  skipped, no licence 17
  dust.json         3.99 MB raw, 0.89 MB gzip
```

The other seventeen stay in the repository and stay usable locally, which is
not distribution. Anyone who wants one on a deployed copy installs it
themselves through the gear — **that is their copy of the author's work, not
ours**, and it is only possible because E6-08 shipped import and install.

So the default build keeps all thirty-five, because the default build is for
working on this. A deploy uses the flag. Nothing is deployed yet.

## Compliance for the eighteen that do ship

A GPL work may be redistributed **with its licence**. Twelve of the eighteen
are GPL, and `LICENSE` files have no extension — so the dust build was
dropping every one of them while packing the code beside it. That is the one
way to turn a compliant bundle into an infringing one by accident, and it
had already happened. Licence files are packed now: **19 of them in the
tree**, verified in `dust.json`.

## The sample library, which is the image's and not a script's

A norns ships `~/dust/audio`, and `audio/common/808` is part of the disk
image. Scripts read it by name — `bakeneko` lists it and picks a file at
random, and dies in `init` when the listing is empty — so the directory
has to be filled for that script to run at all.

**It is filled with sounds this project generates, not with Roland's.**
`tools/kit-808.mjs` synthesises seventeen voices from oscillators, noise
and envelopes; they carry the names the catalogue asks for and a
`README.txt` saying, in the folder, that they are not the TR-808 sample
set. Copying the real ones because they are easy to find is exactly the
accident this page exists to prevent, one directory further along.

Still owed before a public deploy, and tracked separately:

* **E7-08** — norns-js is AGPL-3.0. That needs attribution and a *visible*
  source link from the running app, not just a file in the repository.
* The bundled scripts are an **aggregate**, not a derived work: they sit
  beside norns-js rather than being linked into it, so their licences do not
  reach back into ours. The GPL texts travel with them.
* **norns itself** is GPL-3.0 and is vendored under `third_party/norns`. Its
  Lua is loaded and run, which is the thing GPLv3 is about; AGPL-3.0 is
  compatible with GPL-3.0 for combination, and the combined work is offered
  under the AGPL. The source link covers it.

## The Lua runtime, vendored (E9-64)

`third_party/fengari` is **fengari@0.1.5** as npm publishes it, with
`patches/fengari.patch` applied — 64-bit integers, because norns' Lua has
them. Fengari is **MIT** and the patch does not change that: it is a
derivative work under the same terms, kept as a diff so what is ours and
what is theirs stay separable. The package is still a dependency in
`package.json`; the vendored copy is what the build resolves, and
`tools/pins.mjs --check` fails if the patch drifts from it.

## The DSP libraries compiled into scsynth (E9-58)

Seventeen UGens were added to the server, and three trees came with them.
All are linked statically into `scsynth.wasm`, which is the strictest case
there is, so the terms are set out rather than assumed.

| library | licence | why it is here |
|---|---|---|
| `DaisySP` | MIT | eleven PortedPlugins UGens — AnalogBassDrum, StringVoice, ZOsc and the rest |
| `DaisySP-LGPL` | LGPL-2.1 | `BLOsc` and `DCompressor`, the two whose classes Electrosmith moved out of the MIT tree |
| `eigen` 3.4.0 | MPL-2.0 | `Werner`, through ChowDSP's `GenSVF` |

MIT and MPL-2.0 combine with AGPL-3.0 without argument. **LGPL-2.1 needs the
chain stated**: its §3 permits taking the library under GPL-2 *or any later
version*, GPL-3 is a later version, and AGPL-3.0 §13 permits combining a
GPL-3 work with an AGPL one. The obligation LGPL puts on a *static* link —
that a recipient can relink against a modified library — is met by the AGPL
offer this project already makes: the whole source tree, the pinned commits
in [`PINS.md`](PINS.md), and the build script that produced the binary.

Nothing here is modified. All three are vendored unpatched, and
`tools/pins.mjs --check` fails if that stops being true.

## The notices that travel with the build (E9-75)

This page is the argument and `SETTINGS > ABOUT` is the offer.
[`public/NOTICES.txt`](../public/NOTICES.txt) is the artefact: **nineteen
components, every licence text in full**, generated by
`npm run notices` from what the build actually links and read out of
`third_party/` rather than fetched or remembered — so what ships is the text
that was in the tree the binaries were built from.

It is not a courtesy. Several of those licences say in as many words that
their notice must travel with the copy; MIT's whole second paragraph is that
sentence. And a web build is the case where it is easiest to forget, because
nothing is "copied" in the way a download is.

**Writing it found nine omissions and one error**, which is the argument for
generating it rather than keeping a list. `about.ts` named eight components;
a browser is handed nineteen. Missing: STK (and the 42 raw wave tables served
from `/stk-rawwaves`), nova-simd, PortedPlugins, DaisySP, DaisySP-LGPL,
Eigen, FFTW, sc-plugins-extra and softcut-lib. And `sc3-plugins` was listed
as GPL-3.0 when every one of its source files says **GPL-2.0-or-later** — a
difference that matters, because the "or later" is the whole reason it can be
combined with an AGPL work at all.

`npm run notices:check` fails when the file is stale, for the same reason
`licences:check` and `pins:check` do.

### Copyright and trademark

Both were absent until E9-75: the `LICENSE` file was the bare AGPL text and
nothing anywhere named a holder. Now, in `about.ts`, in `NOTICES.txt`, and in
the README:

* **© 2026 pinktentacle.** A project name and not a person, which is
  the same choice glassgarden made with terrarium.
* **The name and the documents**, all rights reserved; the code is not.
* **Not a monome product.** monome, norns, Mutable Instruments and the rest
  are named only to say what this is built on and what it works with. One
  sentence, it costs nothing, and it is the difference between naming a thing
  and claiming it.

## Asking

The honest alternative to leaving the seventeen out is to ask their authors.
Nobody has been asked, and nothing has been posted — six upstream reports
and the forum posts drafted during this project are all still held. That
remains the user's call.
