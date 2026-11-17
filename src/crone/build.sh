#!/usr/bin/env bash
# E4-07 / E4-08 — build crone for wasm, as an AudioWorklet.
#
# Everything that makes a sound is upstream's, compiled unchanged:
# MixerClient with its Zita reverb and stereo compressor, SoftcutClient with
# six voices, and softcut-lib. What this build replaces is the three things a
# browser cannot have:
#
#   JACK         src/crone/shim/Client.h — the DSP touches exactly two JACK
#                names outside Client.h, Tape.h and OscInterface.h
#   liblo        OscInterface.cpp is simply not compiled; commands arrive
#                through crone's own lock-free queue instead
#   libsndfile   src/crone/shim/sndfile.hh — decoding belongs to
#                AudioContext.decodeAudioData, not to a second decoder in wasm
#
# third_party/ is NOT patched. The shim directory is first on the include
# path, the same technique as the SuperCollider SystemOverwrites.
#
#   bash src/crone/build.sh
# On Windows this must be Git bash, not WSL.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CRONE="$ROOT/third_party/norns/crone"
SOFTCUT="$ROOT/third_party/softcut-lib/softcut-lib"
THIRD="$ROOT/third_party/norns/third-party"
SHIM="$ROOT/src/crone/shim"
OUT="$ROOT/src/crone/build"

# --- tools: PATH first, else the pinned emsdk ------------------------------
EMCC=""
for c in em++.bat em++ emcc.bat emcc; do
  if command -v "$c" > /dev/null 2>&1; then EMCC="$(command -v "$c")"; break; fi
done
if [ -z "$EMCC" ] && [ -d "$ROOT/third_party/emsdk" ]; then
  EMSDK_DIR="$ROOT/third_party/emsdk"
  EM_PY="$(ls -d "$EMSDK_DIR"/python/*/ 2>/dev/null | head -1)"
  EM_NODE="$(ls -d "$EMSDK_DIR"/node/*/ 2>/dev/null | head -1)"
  export EMSDK="$EMSDK_DIR"
  export EM_CONFIG="$EMSDK_DIR/.emscripten"
  [ -n "$EM_PY" ] && export EMSDK_PYTHON="${EM_PY}python.exe"
  # PATH entries must be POSIX; `pwd` here returns C:/... and bash's own
  # lookup does not understand a drive letter.
  u() { cygpath -u "$1" 2>/dev/null || printf '%s' "$1"; }
  export PATH="$(u "$EMSDK_DIR/upstream/emscripten"):$(u "${EM_NODE}bin"):$(u "${EM_PY%/}"):$PATH"
  for c in em++.bat em++; do
    if command -v "$c" > /dev/null 2>&1; then EMCC="$(command -v "$c")"; break; fi
  done
  [ -n "$EMCC" ] && echo "activated the pinned emsdk in third_party/"
fi
[ -z "$EMCC" ] && { echo "no em++ (emsdk 4.0.18 expected)"; exit 1; }
echo "em++: $EMCC"

for d in "$CRONE/src" "$SOFTCUT/src" "$THIRD/concurrentqueue"; do
  [ -d "$d" ] || { echo "missing $d"; exit 1; }
done

# --- stage the sources -----------------------------------------------------
#
# A quoted `#include "Client.h"` searches the INCLUDING FILE'S directory
# first, before any -I. So putting the shim on the include path is not enough:
# crone/src/Client.h would always win over ours.
#
# So the sources are copied into a staging directory and the shim headers are
# written over the top. third_party/ is still never modified, and the stage is
# generated — delete it and the next build rebuilds it.
STAGE="$OUT/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/effects"
cp "$CRONE"/src/*.cpp "$CRONE"/src/*.h "$STAGE/" || exit 1
cp "$CRONE"/src/effects/*.h "$STAGE/effects/" || exit 1
# The replacements, written last so they win.
cp "$SHIM"/*.h "$SHIM"/*.hh "$STAGE/" || exit 1
mkdir -p "$STAGE/jack" && cp "$SHIM"/jack/*.h "$STAGE/jack/" || exit 1

# BufDiskWorker needs three PUBLIC entry points it does not have: upstream's
# worker loop is a private, infinite `workLoop()` on a thread this
# environment cannot spawn, so there is no way to ask it for one job.
#
# A whole shim copy of the header would be 130 lines of upstream duplicated
# into this repo and left to drift. Three declarations inserted into the
# staged copy keep upstream's header the source of truth, and the grep below
# means a changed anchor fails the build rather than producing a header that
# silently lost them. The definitions are in shim/BufDiskWorkerPump.cpp.
ANCHOR='    static void init(int sr);'
grep -qF "$ANCHOR" "$STAGE/BufDiskWorker.h" || {
  echo "BufDiskWorker.h: anchor '$ANCHOR' is gone; the header changed upstream"
  exit 1
}
python - "$STAGE/BufDiskWorker.h" <<'PYEOF' || exit 1
import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
anchor = "    static void init(int sr);"
added = anchor + """

    // --- norns-js ---------------------------------------------------
    // Added to the STAGED copy by src/crone/build.sh. See
    // src/crone/shim/BufDiskWorkerPump.cpp for why the thread is gone.
    /** Set the sample rate WITHOUT starting a thread. */
    static void nornsjsSetup(int sr);
    /** Run up to `frameBudget` frames of work. True if more is pending. */
    static bool nornsjsRunJob(int frameBudget);
    /** How many jobs are queued, for the tests and the probe. */
    static size_t nornsjsPending();
"""
io.open(p, "w", encoding="utf-8").write(s.replace(anchor, added, 1))
PYEOF
echo "staged $(ls "$STAGE"/*.cpp "$STAGE"/*.h | wc -l) files, $(ls "$SHIM" | wc -l) replaced"

INC="-I $STAGE -I $CRONE -I $SOFTCUT/include"
INC="$INC -I $THIRD/concurrentqueue -I $THIRD/readerwriterqueue"

# NOT compiled, and each for a reason:
#   main.cpp         starts a JACK client and an OSC server
#   OscInterface.cpp 1015 lines of liblo; the command queue replaces it
# BufDiskWorker.cpp IS compiled now (E4-11). Its thread is replaced by a pump
# in the render callback and libsndfile by shim/sndfile.{hh,cpp}; everything
# it actually does — the fades, the mixes, the raised-cosine curves — is
# upstream's, unchanged.
SRC="$STAGE/BufDiskWorker.cpp
     $STAGE/Commands.cpp
     $STAGE/MixerClient.cpp
     $STAGE/SoftcutClient.cpp
     $STAGE/Taper.cpp
     $STAGE/Window.cpp
     $STAGE/crone.cpp
     $STAGE/crone_param_dispatch.cpp
     $SOFTCUT/src/FadeCurves.cpp
     $SOFTCUT/src/ReadWriteHead.cpp
     $SOFTCUT/src/SubHead.cpp
     $SOFTCUT/src/Svf.cpp
     $SOFTCUT/src/Voice.cpp
     $ROOT/src/crone/shim/oracle.cpp
     $ROOT/src/crone/shim/sndfile.cpp
     $ROOT/src/crone/shim/BufDiskWorkerPump.cpp
     $ROOT/src/crone/worklet.cpp"

mkdir -p "$OUT"

# ALLOW_MEMORY_GROWTH is OFF: this runs inside an audio callback, and growth
# allocates a new ArrayBuffer and DETACHES every view (ADR-04e). softcut's
# buffer alone is 2 x 2^24 frames, so the heap is sized up front.
echo "--- compiling crone ---"
"$EMCC" -O3 -std=c++17 \
  $SRC $INC \
  -DNDEBUG \
  -sALLOW_MEMORY_GROWTH=0 \
  -sINITIAL_MEMORY=320MB \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createCroneModule \
  -sENVIRONMENT=web,worker,node \
  -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU8,ccall,cwrap,stringToUTF8,lengthBytesUTF8 \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -o "$OUT/crone.mjs" || { echo "BUILD FAILED"; exit 1; }

ls -la "$OUT"/crone.wasm | awk '{printf "  crone.wasm %8.0f KB\n", $5/1024}'

# ---- the same program again, as a CLASSIC script ------------------------
#
# `audioWorklet.addModule()` loads a classic script. An `import` is a syntax
# error there, so the ES6 module above cannot be the one the worklet runs.
#
# The wasm is NOT embedded. `-sSINGLE_FILE` would base64 it into the script,
# which is the usual recipe -- but an AudioWorkletGlobalScope is not a
# WorkerGlobalScope, so it has no `atob`, and it has no `fetch` either. The
# way out is simpler than either: the main thread fetches crone.wasm once and
# hands the bytes to the processor in `processorOptions`, and emscripten uses
# `Module.wasmBinary` without going looking for a file. The wasm then stays a
# separate, cacheable, 230 KB artefact instead of 307 KB of base64 inside a
# script that is re-parsed on every worklet load.
#
# ENVIRONMENT=web, not worker: emscripten decides which it is with
# `typeof importScripts == "function"`, and a worklet has no importScripts
# either. `web` is the branch whose file-loading code sits behind
# `typeof document !== "undefined"` guards, and with wasmBinary supplied none
# of it runs.
echo "--- compiling crone (classic, for the worklet) ---"
"$EMCC" -O3 -std=c++17   $SRC $INC   -DNDEBUG   -sALLOW_MEMORY_GROWTH=0   -sINITIAL_MEMORY=320MB   -sMODULARIZE=1   -sEXPORT_ES6=0   -sEXPORT_NAME=createCroneModule   -sENVIRONMENT=web   -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU8,ccall,cwrap,stringToUTF8,lengthBytesUTF8   -sEXPORTED_FUNCTIONS=_malloc,_free   -o "$OUT/crone-classic.js" || { echo "BUILD FAILED (classic)"; exit 1; }

ls -la "$OUT"/crone-classic.js | awk '{printf "  crone-classic.js %5.0f KB\n", $5/1024}'

echo "BUILD OK"
