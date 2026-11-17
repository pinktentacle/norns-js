# tools/sclang — E0-18

**Question:** norns' whole matron↔sclang protocol is `OSCFunc`. sclang-wasm's
README says "Any kind of OSCFunc/OSCdef that goes beyond the server is not
implemented." Does an `OSCFunc` fire for a message injected through the JS
`sendOsc` boundary?

**Answer: yes — proven in source, then measured. 5/5 stages pass.**

```
PASS  stage 0  interpreter evaluates code
PASS  stage A  OSCFunc fires for sendOsc-injected OSC
PASS  stage B  sclang reply arrives in JS through onOsc
PASS  stage C1 norns SC classes compile inside sclang-wasm
PASS  stage C2 Crone answers the real /report/engines protocol
```

Real `Crone`, in WebAssembly, reporting real engines:
`[PolySub, SimplePassThru, PolyPerc, TestSine, None]`.

Write-up: [`research/sclang-wasm-osc-proof.md`](../../research/sclang-wasm-osc-proof.md).
Log: [`run-2026-11-06.log`](run-2026-11-06.log).

## Files

| File | What it is |
|---|---|
| `osc.mjs` | minimal OSC 1.0 encoder/decoder — int32, float32, string, bundles |
| `osc-test.mjs` | the experiment: boots sclang in Node, injects OSC, checks dispatch |
| `build.sh` | builds the `sclang` wasm target from `third_party/supercollider` |
| `wasm-stubs.c` | weak `wait4` — see "Toolchain" |
| `run-2026-11-06.log` | the run that settled E0-18 |

## Running it

```sh
bash tools/sclang/build.sh          # add "clean" after switching emsdk versions
node tools/sclang/osc-test.mjs
```

`build.sh` prints the dist path on success; `osc-test.mjs` defaults to it and
also accepts one as an argument. Exit code 0 means every stage passed.

## Stages

| Stage | Asserts |
|---|---|
| 0 | the interpreter evaluates `2+2` |
| A | an `OSCFunc` fires for a `sendOsc`-injected message |
| B | its reply reaches JS through `onOsc` — the full round trip |
| C1 | norns' SC classes, written into MEMFS before boot, compile |
| C2 | real `Crone` answers `/report/engines` with start/entry/end |

Stage C is the one with consequences beyond this experiment, **and it passed**.
The class library is preloaded into MEMFS at `/sc/SCClassLibrary`
(`lang/CMakeLists.txt:418`) and `bootInterpreter()` is called by JS afterwards,
so norns' 16 `.sc` files were written in at runtime with `FS.writeFile` and
compiled like any other source. No custom build, no rebuild per engine set.
User-installed engines therefore do **not** depend on sclang-wasm gaining real
file access.

Two details the harness has to handle, both learned from reading norns' source:

- `Crone.initClass` registers a `StartUp` block that boots **scsynth**, which
  does not exist in a sclang-only build. The harness injects a tiny extra class
  whose `*initClass` sets `Crone.bootOnInit = false`; every `*initClass` runs
  before any `StartUp` block, so it lands in time.
- The registration method is `Crone.initOscRx`, and `reportEngines` replies to
  `Crone.remoteAddr`, which the `StartUp` block would normally set. The harness
  sets it by hand. No server is needed — `reportEngines` only reads
  `CroneEngine.allSubclasses`.

## Why this one uses CMake

The cairo spike deliberately avoided `./configure` and `make`, driving `em++`
directly from a hand-written config. That does not transfer here: sclang is
~45 translation units plus yaml-cpp, tlsf, oscpack and a Bison-generated
parser, and the link step needs an exact set of emscripten flags — pthreads,
wasm workers, embind, ES6 module output, and a `--preload-file` package of the
class library. Reproducing that by hand would be guesswork, and the build is
upstream-supported (SC's own CI runs it, including a Node test).

## Toolchain

| | Ours | SC CI | Note |
|---|---|---|---|
| emscripten | **4.0.18** | 4.0.18 | must match — see below |
| cmake | 3.31.12 | 3.28 (Ubuntu) | CMake 4.x rejects `cmake_minimum_required` below 3.5, which SC's tree still uses |
| ninja | 1.13.2 | — | CI uses make; Ninja is the practical generator on Windows |

Two additions to the link, both in `build.sh`, neither patching the SC tree:

- **`wasm-stubs.o`** — `wasm-ld: undefined symbol: wait4`, from
  `common/sc_popen.cpp:127`. `<sys/wait.h>` declares it; emscripten below 4.x
  does not implement it. The only caller is `sc_pclose`, unreachable in wasm
  (no `fork`). The stub is **weak**, so libc's definition wins where it exists.
- **`-sEXPORTED_RUNTIME_METHODS=FS`** — without it `Module.FS` is undefined
  and stage C cannot inject anything.

### Why emscripten must match, not merely suffice

An earlier attempt used emsdk 3.1.61, on the reasoning that every API
`SC_WasmClient.cpp` needs is present in it — headers and symbols all checked.
It **compiled and linked cleanly**, then died on boot:

```
worker sent an error! __emscripten_thread_crashed is not defined
```

The gap was in emscripten's runtime JS glue for pthreads and wasm workers,
which a header check cannot see. SC's own `sclang-tests.mjs` failed the same
way on that build — the quickest way to tell a toolchain fault from a bug in
this harness. `osc-test.mjs` now recognises that error and says so.
