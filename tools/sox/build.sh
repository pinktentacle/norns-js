#!/usr/bin/env bash
# E9-275 — SoX for wasm: the `sox` command scripts run.
#
# sampswap, makebreakbeat, zxcvbn, norman and paracosms install sox with
# apt and run it with os.execute: trim, splice, tempo, pitch, stretch,
# reverse, silence, rate, gain, reverb, `stat`, `--i`. The program is
# compiled as it is (third_party/sox, the 14.4.2 a norns installs), from
# tools/sox-wasm/CMakeLists.txt, and the page runs one fresh instance of it
# per command (src/fs/sox.ts).
#
#   bash tools/sox/build.sh [clean]
#
# Produces third_party/sox/build-wasm/sox.js and sox.wasm, and copies them
# to public/sox/.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMSDK="$ROOT/third_party/emsdk"
SOX="$ROOT/third_party/sox"
BUILD="$SOX/build-wasm"
OUT="$ROOT/public/sox"

[ -f "$SOX/src/sox.c" ] || {
  echo "no sox at $SOX"
  echo "  .\\tools\\fetch-third-party.ps1 -Only sox"
  exit 1
}

CMAKE="$(command -v cmake 2>/dev/null)"
for c in "/c/Program Files/CMake/bin/cmake.exe" "/c/Program Files (x86)/CMake/bin/cmake.exe"; do
  [ -n "$CMAKE" ] && break
  [ -f "$c" ] && CMAKE="$c"
done
WINGET_PKGS="${LOCALAPPDATA:-}/Microsoft/WinGet/Packages"
[ -d "$WINGET_PKGS" ] || WINGET_PKGS="/c/Users/${USERNAME:-}/AppData/Local/Microsoft/WinGet/Packages"
NINJA="$(command -v ninja 2>/dev/null)"
[ -z "$NINJA" ] && NINJA="$(find "$WINGET_PKGS" -maxdepth 2 -name ninja.exe 2>/dev/null | head -1)"
[ -z "$NINJA" ] && NINJA="$(find "$ROOT/third_party/ninja" -name ninja.exe 2>/dev/null | head -1)"
[ -z "$CMAKE" ] && { echo "no cmake"; exit 1; }
[ -z "$NINJA" ] && { echo "no ninja"; exit 1; }

TOOLCHAIN="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"
[ -f "$TOOLCHAIN" ] || { echo "emscripten toolchain file missing: $TOOLCHAIN"; exit 1; }

w() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
export EM_CONFIG="$(w "$EMSDK/.emscripten")"
export MSYS2_ARG_CONV_EXCL="*"

if [ "${1:-}" = "clean" ]; then
  echo "wiping $BUILD"
  rm -rf "$BUILD"
fi
mkdir -p "$BUILD" "$OUT"

echo "sox      : $SOX"
# FLAC, Ogg Vorbis and MP3 writing, with the codecs build-sndfile.sh built
# for scsynth (a norns' sox reads them through libsox-fmt-*). All or none:
# sox without them still does everything WAV and AIFF.
DEPS="$ROOT/third_party/libsndfile/deps-wasm"
CODECS=(-DSOX_CODECS=OFF)
if [ -f "$DEPS/lib/libFLAC.a" ] && [ -f "$DEPS/lib/libvorbisfile.a" ] && [ -f "$DEPS/lib/libmp3lame.a" ] && [ -f "$DEPS/lib/libogg.a" ]; then
  CODECS=(-DSOX_CODECS=ON -DSOX_DEPS="$(w "$DEPS")")
  echo "codecs   : FLAC, Ogg Vorbis, MP3 (write) from $DEPS"
else
  echo "codecs   : none (bash tools/sclang/build-sndfile.sh builds them) - WAV, AIFF and the rest of SoX's own"
fi
"$CMAKE" -S "$(w "$ROOT/tools/sox-wasm")" -B "$(w "$BUILD")" \
  -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$(w "$NINJA")" \
  -DCMAKE_TOOLCHAIN_FILE="$(w "$TOOLCHAIN")" \
  -DCMAKE_BUILD_TYPE=Release \
  -DSOX_DIR="$(w "$SOX")" \
  "${CODECS[@]}" \
  -Wno-dev >"$BUILD/configure.log" 2>&1 || { tail -30 "$BUILD/configure.log"; echo "configure failed"; exit 1; }

"$CMAKE" --build "$(w "$BUILD")" --target sox 2>&1 | tail -15
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "build failed"; exit 1; }

for f in sox.js sox.wasm; do
  [ -f "$BUILD/$f" ] || { echo "missing $BUILD/$f"; exit 1; }
  cp "$BUILD/$f" "$OUT/$f"
done
echo
echo "BUILD OK"
ls -la "$OUT" | tail -n +2
