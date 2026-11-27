#Requires -Version 5.1
<#
.SYNOPSIS
  Build every generated artefact norns-js needs, in the order that works.

.DESCRIPTION
  E9-95. `npm run build` cannot run on a fresh clone. Ten megabytes of
  WebAssembly and the `public/` tree it lives in are generated, gitignored,
  and produced by six scripts that have to run in a particular order with a
  particular shell. Following the list by hand went wrong three times while
  this was being written, which is why it is a script.

  TWO STAGES, and the first is the hour.

    stage 1   emscripten. sclang, scsynth, cairo, the screen, crone, and
              the class library as an archive. Git Bash, not PowerShell and
              not WSL.
    stage 2   node. The same artefacts copied and generated into `public/`.
              Seconds.

  IT SKIPS WHAT IS ALREADY THERE, AND ONLY IN STAGE 1. Each stage-1 step
  names the files it produces and is skipped when they all exist, so an
  interrupted hour continues rather than starting again. `-Force` does it
  anyway.

  STAGE 2 ALWAYS RUNS, and E9-101 is why. A build machine had an
  `sclang`/`scsynth` pair from an earlier run, so that step was skipped —
  correctly, by its own rule — and then `audio` was skipped too, because
  `public/scsynth/` existed. The result was a `public/` holding a 1493 KB
  scsynth where the right one is 5714 KB: the earlier build predated the
  patches and had no FFTW, so none of mi-UGens, PortedPlugins, sc3-plugins
  or sc-plugins-extra was compiled into it, and nothing anywhere said so.

  Stage 2 is copying and generating and the whole of it takes under a
  second, measured. There is no reason to make it conditional, and one very
  good reason not to: its inputs are stage 1's outputs, and "the output
  exists" says nothing about whether it is the output of THIS stage 1.

  THREE THINGS THE README'S LIST GOT WRONG, all found by running it:

    * `tools/sclang/build-nopreload.sh` was missing. `npm run audio` copies
      `wasm-dist/sclang-nopreload/`, which only that script writes — the
      sclang from `build.sh` keeps its 2 MB `--preload-file` class library
      and is never served.
    * `npm run assets` calls `npm run dust`, which needs `community
      patches/` — 91 MB of cloned scripts that are not in the repository.
      On a publishing machine it exits 1 and takes `npm run audio` with it.
      The publish build wants `--no-scripts` anyway.
    * `node tools/build-dust.mjs --no-scripts` WITHOUT `--write` prints a
      report and writes nothing, which looks exactly like success. The
      publishing runbook said that for a week.

  A FIFTH, AND THE WORST OF THEM (E9-105): `tools/build-ugen-list.mjs` was
  in no npm script and in no list anywhere. It writes
  `public/norns-sc/ugens.json`, the names of the UGens THIS scsynth was
  compiled with, and the page checks every SynthDef against it before
  sending one. Without that check scsynth THROWS on an unknown UGen, this
  build has exceptions off, the throw kills the thread that handles
  `/d_recv`, and that thread never comes back: no def loads, nothing sounds
  and nothing says so, while `/status` keeps answering.

  It existed on the machine this was written on because somebody had run it
  by hand in November. A fresh machine built everything, deployed, and the
  live page said `ugens.json: Unexpected token '<'` — the file was never
  generated, so the server was returning the SPA fallback.

  AND ONE ORDERING TRAP: `npm run fonts` writes `src/screen/fonts.h`, which
  `src/screen/screen.c` includes. It is an INPUT to stage 1, not an output
  of stage 2, so it runs first here. The file is tracked and normally
  identical to what is regenerated; if it is not, the screen was built
  against the other one.

  A FOURTH, FOUND ON THE FIRST REAL RUN (E9-97): `build-fftw.sh` was not in
  the list either, and nothing stops without it. `tools/sclang/build.sh`
  looks for `third_party/fftw3/build-wasm/libfftw3f.a`, does not find it,
  prints `fftw3f : absent — Tartini, Qitch and the NCAnalysis UGens will
  be missing` in the middle of a long log, and builds anyway. It runs
  before sclang here, because sclang links what it finds at configure
  time.

.PARAMETER Scripts
  Pack the community corpus into `public/dust.json` instead of `--no-scripts`.
  For a development tree that has `community patches/`. A published build
  ships an empty script folder on purpose: the catalogue is read live.

.PARAMETER Only
  Run one step by name. `-Only` with no match lists the names.

.PARAMETER Force
  Run every step even when its output is already there. For `fftw`,
  `sclang` and `nopreload` it also passes `clean`, which wipes the CMake
  build directory: reconfiguring in place keeps the old cache, and a stale
  cache is how a missing `-D` once looked like a pass.

  THIS IS HOW TO REBUILD SCLANG AND SCSYNTH, and it does not need `bash` on
  your PATH — this script finds Git Bash on disk:

      .\tools\build-wasm.ps1 -Only sclang -Force

.PARAMETER DryRun
  Print the plan and run nothing.

.EXAMPLE
  .\tools\build-wasm.ps1 -DryRun
  .\tools\build-wasm.ps1
  .\tools\build-wasm.ps1 -Only crone -Force
  .\tools\build-wasm.ps1 -Scripts
#>
[CmdletBinding()]
param(
  [switch] $Scripts,
  [string] $Only = "",
  [switch] $Force,
  [switch] $DryRun
)

$ErrorActionPreference = "Stop"
$script:Repo = Split-Path -Parent $PSScriptRoot
$script:Ran = @()
$script:Skipped = @()

function Say([string] $text, [string] $colour = "Gray") {
  Write-Host $text -ForegroundColor $colour
}
function Head([string] $text) {
  Write-Host ""
  Write-Host $text -ForegroundColor White
  Write-Host ("-" * 74) -ForegroundColor DarkGray
}

# --- git bash, found on disk and not on PATH -------------------------------
#
# `bash` on a Windows PATH is usually C:\Windows\System32\bash.exe, the WSL
# launcher, because System32 comes first — on a machine that HAS Git Bash
# installed. WSL has no emsdk, no CMake and none of `third_party/`, and the
# failure reads as a broken build script. Git for Windows puts bash beside
# git, so git's own location is the answer. Same reasoning as
# `tools/setup-windows.ps1`, and the same code, deliberately: a shared
# helper between two scripts that are run on different machines at
# different times is a dependency neither of them needs.
function Find-GitBash {
  $gitExe = (Get-Command "git" -ErrorAction SilentlyContinue)
  if ($null -ne $gitExe) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitExe.Source)
    $candidate = Join-Path $gitRoot "bin\bash.exe"
    if (Test-Path $candidate) { return $candidate }
  }
  foreach ($c in @("C:\Program Files\Git\bin\bash.exe", "C:\Program Files (x86)\Git\bin\bash.exe")) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

# --- the plan --------------------------------------------------------------
#
# Each step names what it PRODUCES, and that is what "already done" means
# here. Not a stamp file: a stamp can be newer than a build that failed
# halfway, and the artefacts cannot.

$steps = @(
  @{
    Name = "fonts"; Stage = 0; How = "node"
    Run  = @("tools/extract-fonts.mjs", "--write")
    Makes = @("src/screen/fonts.h")
    Why  = "the font table, read out of third_party/norns — an INPUT to the screen build"
    Always = $true   # tracked, cheap, and stage 1 compiles it
  },
  @{
    # E9-117 — the Lua interpreter every script runs in.
    #
    # Stage 1 because it is a wasm build like the others and skips when it
    # is already there; it is also the fastest of them, about a minute,
    # and it fetches its own source. Without it `npm run build` stops at
    # `import("./lua53/lua53.mjs")` the way it stops at the screen module.
    Name = "lua"; Stage = 1; How = "bash"; Clean = $true
    Run  = @("tools/lua53/build.sh")
    Makes = @("src/lua/lua53/lua53.wasm", "src/lua/lua53/lua53.mjs")
    Why  = "PUC Lua 5.3, which replaced fengari (docs/13-CPU.md): 2.4-13x per script"
  },
  @{
    Name = "fftw"; Stage = 1; How = "bash"; Clean = $true
    Run  = @("tools/sclang/build-fftw.sh")
    Makes = @("third_party/fftw3/build-wasm/libfftw3f.a")
    Why  = "libfftw3f.a, which sclang links or does without IN SILENCE"
  },
  @{
    # E9-268 — before sclang, for the same reason as fftw: build.sh links
    # it when it is there and builds a server that cannot write sound
    # files, without a word, when it is not.
    Name = "sndfile"; Stage = 1; How = "bash"; Clean = $true
    Run  = @("tools/sclang/build-sndfile.sh")
    Makes = @("third_party/libsndfile/build-wasm/libsndfile.a")
    Why  = "libsndfile.a: Buffer.write, Recorder and DiskOut in scsynth"
  },
  @{
    # E9-275 — the sox command scripts run, after sndfile because its FLAC,
    # Ogg Vorbis and LAME come from there.
    Name = "sox"; Stage = 1; How = "bash"; Clean = $true
    Run  = @("tools/sox/build.sh")
    Makes = @("public/sox/sox.wasm", "public/sox/sox.js")
    Why  = "sox.wasm: the sox command (src/fs/sox.ts)"
  },
  @{
    Name = "sclang"; Stage = 1; How = "bash"; Clean = $true
    Run  = @("tools/sclang/build.sh")
    Makes = @("third_party/supercollider/build-wasm/wasm-dist/sclang/sclang.js",
              "third_party/supercollider/build-wasm/wasm-dist/scsynth/scsynth.js")
    Why  = "sclang.wasm and scsynth.wasm — the long one, most of the hour"
  },
  @{
    Name = "nopreload"; Stage = 1; How = "bash"; Clean = $true
    Run  = @("tools/sclang/build-nopreload.sh")
    Makes = @("third_party/supercollider/build-wasm/wasm-dist/sclang-nopreload/sclang.js")
    Why  = "the sclang that is actually SERVED: no baked-in class library"
  },
  @{
    Name = "cairo"; Stage = 1; How = "bash"
    Run  = @("tools/screen/build-cairo.sh")
    Makes = @("tools/screen/build/lib/libcairo.a", "tools/screen/build/lib/libpixman-1.a")
    Why  = "118 cairo translation units and 30 of pixman — minutes"
  },
  @{
    Name = "screen"; Stage = 1; How = "bash"
    Run  = @("src/screen/build.sh")
    Makes = @("src/screen/build/screen.mjs", "src/screen/build/screen.wasm")
    Why  = "links screen.wasm against the cairo above"
  },
  @{
    Name = "crone"; Stage = 1; How = "bash"
    Run  = @("src/crone/build.sh")
    Makes = @("src/crone/build/crone.mjs", "src/crone/build/crone-classic.js")
    Why  = "crone.wasm: the mixer, softcut and Tape"
  },
  @{
    Name = "pack"; Stage = 1; How = "node"
    Run  = @("tools/pack/pack-classlib.mjs")
    Makes = @("tools/pack/build/sclang-lib.tar.gz")
    Why  = "sclang's class library as a tar, because a browser build has no --preload-file"
  },
  @{
    Name = "clock"; Stage = 2; How = "node"; Always = $true
    Run  = @("tools/build-clock-worklet.mjs", "--write")
    Makes = @("public/clock-processor.js")
    Why  = "the clock worklet, concatenated from src/clock/"
  },
  @{
    Name = "dust"; Stage = 2; How = "node"; Always = $true
    Run  = @("tools/build-dust.mjs", "--write")   # --no-scripts added below
    Makes = @("public/dust.json")
    Why  = "the filesystem image the page boots with"
  },
  @{
    Name = "audio"; Stage = 2; How = "node"; Always = $true
    Run  = @("tools/build-audio-assets.mjs", "--write")
    Makes = @("public/sclang", "public/scsynth", "public/norns-sc", "public/pack")
    Why  = "stage 1's wasm, copied into public/ where the page can fetch it"
  },
  @{
    Name = "ugens"; Stage = 2; How = "node"; Always = $true
    Run  = @("tools/build-ugen-list.mjs", "--write")
    Makes = @("public/norns-sc/ugens.json")
    Why  = "the list of UGens THIS scsynth has, without which one bad SynthDef is fatal"
  },
  @{
    Name = "worklet"; Stage = 2; How = "node"; Always = $true
    Run  = @("tools/build-crone-worklet.mjs", "--write")
    Makes = @("public/crone-worklet.js", "public/crone.wasm")
    Why  = "crone as a classic worklet script — a worklet has no fetch and no import"
  }
)

# `--no-scripts` unless asked otherwise. A published build ships an empty
# script folder: norns.community is read live, so nothing of anybody else's
# is served by us at all (E6-11, and it settles E7-13 outright).
if (-not $Scripts) {
  foreach ($s in $steps) { if ($s.Name -eq "dust") { $s.Run += "--no-scripts" } }
}

if ($Only -ne "") {
  $match = @($steps | Where-Object { $_.Name -eq $Only })
  if ($match.Count -eq 0) {
    Say "no step called '$Only'. The names are:" "Red"
    foreach ($s in $steps) { Say ("  " + $s.Name) }
    exit 1
  }
  $steps = $match
}

# --- what is already here --------------------------------------------------

function Step-Done($step) {
  if ($Force) { return $false }
  if ($step.ContainsKey("Always") -and $step.Always) { return $false }
  foreach ($m in $step.Makes) {
    if (-not (Test-Path (Join-Path $script:Repo $m))) { return $false }
  }
  return $true
}

# --- preconditions ---------------------------------------------------------

Head "before anything"

$bash = Find-GitBash
$needBash = @($steps | Where-Object { $_.How -eq "bash" }).Count -gt 0

if ($needBash) {
  if ($null -eq $bash) {
    Say "no Git Bash. It comes with Git for Windows; WSL's bash cannot run these." "Red"
    Say "Run: .\tools\setup-windows.ps1 -Role build" "DarkGray"
    exit 1
  }
  Say ("git bash   " + $bash) "Green"
}

$node = (Get-Command "node" -ErrorAction SilentlyContinue)
if ($null -eq $node) {
  Say "no node. Run: .\tools\setup-windows.ps1 -Role build" "Red"
  exit 1
}
Say ("node       " + (& node --version)) "Green"

$tp = Join-Path $script:Repo "third_party"
if (-not (Test-Path $tp)) {
  Say "no third_party/. That is 2.7 GB of other people's code and it is not in the" "Red"
  Say "repository. PINS.md says what each tree is and which commit it sits at." "Red"
  exit 1
}
Say ("third_party " + (@(Get-ChildItem $tp -Directory).Count) + " directories") "Green"

$em = Join-Path $script:Repo "third_party\emsdk\upstream\emscripten\emcc.bat"
if ($needBash -and -not (Test-Path $em)) {
  Say "no emsdk at third_party/emsdk. Run: .\tools\setup-windows.ps1 -Role build" "Red"
  exit 1
}
if ($needBash) { Say "emsdk      third_party/emsdk" "Green" }

# --- the plan, said out loud -----------------------------------------------

Head "the plan"

foreach ($s in $steps) {
  $state = "run"
  if (Step-Done $s) { $state = "skip (already built)" }
  if ($s.Stage -eq 2) { $state = "run (stage 2 always does)" }
  $colour = "White"
  if ($state -ne "run") { $colour = "DarkGray" }
  Say ("  [{0}] {1,-10} {2,-22} {3}" -f $s.Stage, $s.Name, $state, $s.Why) $colour
}

if ($DryRun) {
  Say ""
  Say "-DryRun: nothing was run." "DarkYellow"
  exit 0
}

# --- running ---------------------------------------------------------------

Push-Location $script:Repo
try {
  foreach ($s in $steps) {
    if (Step-Done $s) {
      Say ""
      Say ("skipped " + $s.Name + " — " + ($s.Makes -join ", ") + " already exist") "DarkGray"
      $script:Skipped += $s.Name
      continue
    }

    Head ("stage " + $s.Stage + " — " + $s.Name)
    Say $s.Why "DarkGray"
    $started = Get-Date

    if ($s.How -eq "bash") {
      # `-Force` ON A CMAKE BUILD MEANS CLEAN. E9-102: reconfiguring in
      # place leaves the old cache, and a cache is exactly how
      # `SC_WASM_PRELOAD_CLASSLIB` once looked like a pass — CMake accepts
      # an unknown `-D` in silence and keeps whatever it decided last time.
      # The three scripts that take a `clean` argument get it; the other
      # three link from sources every time and have nothing to stale.
      $runArgs = @($s.Run)
      if ($Force -and $s.ContainsKey("Clean") -and $s.Clean) { $runArgs += "clean" }
      Say ("bash " + ($runArgs -join " ")) "DarkGray"
      & $bash @($runArgs)
    } else {
      Say ("node " + ($s.Run -join " ")) "DarkGray"
      & node @($s.Run)
    }
    $code = $LASTEXITCODE

    $took = [int]((Get-Date) - $started).TotalSeconds
    if ($code -ne 0) {
      Say ""
      Say ("{0} FAILED after {1}s, exit {2}." -f $s.Name, $took, $code) "Red"
      Say "Nothing after it was run. Fix it and start this again — the steps that" "DarkGray"
      Say "did finish are skipped on the next run." "DarkGray"
      exit 1
    }

    # EXIT 0 IS NOT THE MEASUREMENT. A shell script that ends with an `echo`
    # exits 0 whatever happened above it, which is how a build that produced
    # nothing once looked like a pass.
    $absent = @()
    foreach ($m in $s.Makes) {
      if (-not (Test-Path (Join-Path $script:Repo $m))) { $absent += $m }
    }
    if ($absent.Count -gt 0) {
      Say ""
      Say ("{0} exited 0 but did not produce:" -f $s.Name) "Red"
      foreach ($m in $absent) { Say ("  " + $m) "Red" }
      exit 1
    }

    Say ""
    Say ("{0} ok, {1}s" -f $s.Name, $took) "Green"
    $script:Ran += $s.Name
  }
} finally {
  Pop-Location
}

# --- what happened ---------------------------------------------------------

Head "done"

if ($script:Ran.Count -gt 0) { Say ("built   " + ($script:Ran -join ", ")) "Green" }
if ($script:Skipped.Count -gt 0) { Say ("skipped " + ($script:Skipped -join ", ")) "DarkGray" }

if ($Only -eq "") {
  Say ""
  Say "Next, and all of it should pass before you build:" "DarkGray"
  Say "  npm run licences:check; npm run notices:check; npm run pins:check" "DarkGray"
  Say "  npm test; npm run typecheck" "DarkGray"
  Say '  $env:VITE_SOURCE_URL = "https://github.com/pinktentacle/norns-js"' "DarkGray"
  Say "  npm run build" "DarkGray"
}
