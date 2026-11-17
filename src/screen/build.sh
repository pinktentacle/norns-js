#!/usr/bin/env bash
# E2-01 — link the product screen module against the cairo built in E0-16.
#
# This does NOT rebuild cairo or pixman. `tools/screen/build-cairo.sh` compiles
# 118 cairo translation units and 30 of pixman and takes minutes; its output in
# tools/screen/build/lib is what we link here. Run that first if the archives
# are missing.
#
# Emscripten's own FreeType and libpng ports are used, as in E0-16. That is a
# deliberate difference from norns, which links Debian bullseye's FreeType
# 2.10.4 — E0-17a built 2.10.4 to wasm and swapped it in, and for norns.ttf at
# 8 px every scene hash was identical, so the difference provably cannot change
# a default-font pixel. research/screen-fidelity.md §0.
#
#   bash src/screen/build.sh
#
# On Windows this must be Git bash, not WSL:
#   & "C:\Program Files\Git\bin\bash.exe" src/screen/build.sh

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE="$ROOT/tools/screen"
LIB="$SPIKE/build/lib"
GEN="$SPIKE/gen"
CASRC="$ROOT/third_party/cairo-build/cairo-1.16.0/src"
PXSRC="$ROOT/third_party/cairo-build/pixman-0.42.2/pixman"
RES="$ROOT/third_party/norns/resources"
OUT="$ROOT/src/screen/build"

# --- tools ------------------------------------------------------------------
# PATH first, so an activated emsdk wins. Otherwise activate the pinned one in
# third_party/emsdk ourselves: the spike scripts required the caller to have
# run emsdk_env first, which is a step that is easy to forget and produces a
# confusing failure (emcc.bat reports "Python est introuvable" because the
# Windows Store alias intercepts `python`).
EMCC=""
for c in emcc.exe emcc.bat emcc; do
  if command -v "$c" > /dev/null 2>&1; then EMCC="$(command -v "$c")"; break; fi
done

if [ -z "$EMCC" ] && [ -d "$ROOT/third_party/emsdk" ]; then
  EMSDK_DIR="$ROOT/third_party/emsdk"
  EM_PY="$(ls -d "$EMSDK_DIR"/python/*/ 2>/dev/null | head -1)"
  EM_NODE="$(ls -d "$EMSDK_DIR"/node/*/ 2>/dev/null | head -1)"
  export EMSDK="$EMSDK_DIR"
  export EM_CONFIG="$EMSDK_DIR/.emscripten"
  [ -n "$EM_PY" ] && export EMSDK_PYTHON="${EM_PY}python.exe"

  # PATH entries must be POSIX. `pwd` in this Git bash returns `C:/temp/...`,
  # and bash's own PATH lookup does not understand a drive letter — so
  # `command -v emcc.bat` finds nothing even though the file is right there.
  # The environment variables above are handed to Windows programs and stay in
  # Windows form; only PATH is converted. Same family of trap as the `cygpath
  # -m` the cmake scripts need, in the opposite direction.
  u() { cygpath -u "$1" 2>/dev/null || printf '%s' "$1"; }
  export PATH="$(u "$EMSDK_DIR/upstream/emscripten"):$(u "${EM_NODE}bin"):$(u "${EM_PY%/}"):$PATH"
  for c in emcc.exe emcc.bat emcc; do
    if command -v "$c" > /dev/null 2>&1; then EMCC="$(command -v "$c")"; break; fi
  done
  [ -n "$EMCC" ] && echo "activated the pinned emsdk in third_party/"
fi

if [ -z "$EMCC" ]; then
  echo "no emcc. Expected emsdk 4.0.18 (research/toolchain.md) on PATH or in third_party/emsdk."
  exit 1
fi
echo "emcc: $EMCC"
VER="$("$EMCC" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [ "$VER" != "4.0.18" ]; then
  # 3.1.61 links fine and then fails at RUNTIME with
  # `__emscripten_thread_crashed is not defined`. A compile-time check does not
  # answer a runtime question, so the version is checked rather than assumed.
  echo "WARNING: emcc is $VER, this project pins 4.0.18"
fi

# --- inputs that must already exist -----------------------------------------
for f in "$LIB/libcairo.a" "$LIB/libpixman-1.a"; do
  [ -f "$f" ] || { echo "missing $f — run tools/screen/build-cairo.sh first"; exit 1; }
done
[ -d "$RES" ] || { echo "missing $RES"; exit 1; }

# The font table is generated from norns' source; regenerate so a change
# upstream cannot silently shift every font index.
node "$ROOT/tools/extract-fonts.mjs" --write || exit 1

mkdir -p "$OUT"

# --- link -------------------------------------------------------------------
# MODULARIZE + EXPORT_ES6 so the result is an ES module the app imports, rather
# than something that installs itself on a global.
#
# ALLOW_MEMORY_GROWTH is ON here and that is safe: unlike the softcut and clock
# worklets (ADR-04e), this module never runs inside an audio callback, so a
# growth that detaches views cannot tear a block of audio.
echo "--- linking screen ---"
"$EMCC" -O2 \
  "$ROOT/src/screen/screen.c" \
  -I "$ROOT/src/screen" -I "$GEN/cairo" -I "$CASRC" -I "$PXSRC" -I "$GEN/pixman" \
  "$LIB/libcairo.a" \
  "$LIB/libpixman-1.a" \
  -sUSE_FREETYPE=1 \
  -sUSE_LIBPNG=1 \
  -sSUPPORT_LONGJMP=emscripten \
  -sALLOW_MEMORY_GROWTH=1 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createScreenModule \
  -sENVIRONMENT=node,web \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAPU32,HEAPF64,stringToUTF8,lengthBytesUTF8,getValue \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  --preload-file "$RES/norns.ttf"@/fonts/norns.ttf \
  --preload-file "$RES/liquid.ttf"@/fonts/liquid.ttf \
  -o "$OUT/screen.mjs" || { echo "LINK FAILED"; exit 1; }

echo
ls -la "$OUT"/screen.wasm "$OUT"/screen.data 2>/dev/null |
  awk '{printf "  %-28s %7.0f KB\n", $9, $5/1024}'
echo "BUILD OK"
