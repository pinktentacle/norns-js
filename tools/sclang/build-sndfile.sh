#!/usr/bin/env bash
# E9-268 — libsndfile, for wasm, so scsynth can WRITE sound files.
#
# scsynth was built `-DNO_LIBSNDFILE`. Reading never needed it here — the
# page decodes every format with `decodeAudioData` and pushes the samples in
# (src/engine/buffers.ts) — but writing has no browser API at all, and three
# things a script does went nowhere:
#
#   Buffer.write   grains and twins save their buffers with it
#   Recorder       `s.record`: dronecaster's record key
#   DiskOut        o-o-o records through it, and Recorder streams with it
#
# Worse than nowhere at first: `/b_write` in a NO_LIBSNDFILE scsynth freed a
# pointer it never set and took the server down (E9-218), so it was refused
# in sclang instead. With libsndfile linked, the server's own code does all
# three, and its DiskIO_UGens (DiskOut, DiskIn, VDiskIn) are compiled in.
#
# E9-269 — AND ITS CODECS. libsndfile writes WAV/AIFF/CAF by itself; FLAC,
# Ogg/Vorbis, Opus and mp3 are external libraries, and o-o-o records every
# voice as .flac. So this builds them first, each into one install prefix
# (third_party/libsndfile/deps-wasm), then libsndfile against them:
#
#   libogg 1.3.5, libvorbis 1.3.7, libFLAC 1.4.3, libopus 1.5.2   (Xiph)
#   libmpg123 1.32.9, LAME 3.100                                   (mp3)
#
# libsndfile turns the Xiph set on only when Vorbis, FLAC and Opus are all
# there, and mp3 only when both mpg123 and LAME are. A missing tree is left
# out with a line saying so, and the build is what it was without it.
#
# Threads ON in every compile (`-pthread`): scsynth links with pthreads, and
# wasm-ld refuses an object without atomics into a shared memory.
#
#   bash tools/sclang/build-sndfile.sh [clean]
#
# Produces third_party/libsndfile/build-wasm/libsndfile.a, and the codec
# libraries under deps-wasm/lib, which tools/sclang/build.sh links after it.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMSDK="$ROOT/third_party/emsdk"
SNDFILE="$ROOT/third_party/libsndfile"
BUILD="$SNDFILE/build-wasm"
DEPS="$SNDFILE/deps-wasm"

[ -f "$SNDFILE/CMakeLists.txt" ] || {
  echo "no libsndfile at $SNDFILE"
  echo "  .\\tools\\fetch-third-party.ps1 -Only libsndfile"
  exit 1
}

CMAKE="$(command -v cmake 2>/dev/null)"
for c in "/c/Program Files/CMake/bin/cmake.exe" "/c/Program Files (x86)/CMake/bin/cmake.exe"; do
  [ -n "$CMAKE" ] && break
  [ -f "$c" ] && CMAKE="$c"
done
WINGET_PKGS="$LOCALAPPDATA/Microsoft/WinGet/Packages"
[ -d "$WINGET_PKGS" ] || WINGET_PKGS="/c/Users/$USERNAME/AppData/Local/Microsoft/WinGet/Packages"
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
  echo "wiping $BUILD and $DEPS"
  rm -rf "$BUILD" "$DEPS"
  for t in libogg libvorbis flac opus mpg123/ports/cmake lame; do rm -rf "$ROOT/third_party/$t/build-wasm"; done
fi
mkdir -p "$BUILD" "$DEPS"

# Every configure here: the emscripten toolchain, static, -pthread, and the
# deps prefix both as where to install and as a ROOT to find things in —
# the toolchain restricts find_* to its sysroot, so a plain prefix path
# would never be searched.
COMMON=(
  -G Ninja
  -DCMAKE_MAKE_PROGRAM="$(w "$NINJA")"
  -DCMAKE_TOOLCHAIN_FILE="$(w "$TOOLCHAIN")"
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_C_FLAGS="-O2 -pthread"
  -DCMAKE_CXX_FLAGS="-O2 -pthread"
  -DBUILD_SHARED_LIBS=OFF
  -DCMAKE_INSTALL_PREFIX="$(w "$DEPS")"
  -DCMAKE_PREFIX_PATH="$(w "$DEPS")"
  -DCMAKE_FIND_ROOT_PATH="$(w "$DEPS")"
  -Wno-dev
)

# codec <name> <source dir> <what it makes, under deps-wasm> [cmake options…]
codec() {
  local name="$1" src="$2" makes="$3"
  shift 3
  if [ ! -f "$src/CMakeLists.txt" ]; then
    echo "codec    : $name absent - $(basename "$src") not in third_party"
    return 1
  fi
  if [ -f "$DEPS/$makes" ]; then
    echo "codec    : $name (built)"
    return 0
  fi
  local b="$src/build-wasm"
  [ "$name" = "lame" ] && b="$ROOT/third_party/lame/build-wasm"
  mkdir -p "$b"
  echo "codec    : $name ..."
  # A tree that is THERE and does not build stops everything: dropping its
  # format quietly would ship a server that cannot write what it should.
  if ! "$CMAKE" -S "$(w "$src")" -B "$(w "$b")" "${COMMON[@]}" "$@" > "$b/configure.log" 2>&1; then
    tail -15 "$b/configure.log"
    echo "CONFIGURE FAILED: $name"
    exit 1
  fi
  if ! "$CMAKE" --build "$(w "$b")" > "$b/build.log" 2>&1 || ! "$CMAKE" --install "$(w "$b")" > "$b/install.log" 2>&1; then
    tail -15 "$b/build.log"
    grep -n -i -m 10 "error:" "$b/build.log" | cut -c1-200
    echo "BUILD FAILED: $name"
    exit 1
  fi
  [ -f "$DEPS/$makes" ] || { echo "BUILD FAILED: $name made no $makes"; exit 1; }
  echo "codec    : $name ok"
}

TP="$ROOT/third_party"
XIPH=1
codec ogg "$TP/libogg" lib/libogg.a -DINSTALL_DOCS=OFF -DBUILD_TESTING=OFF || XIPH=0
codec vorbis "$TP/libvorbis" lib/libvorbisenc.a -DBUILD_TESTING=OFF || XIPH=0
codec flac "$TP/flac" lib/libFLAC.a \
  -DBUILD_PROGRAMS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF -DBUILD_DOCS=OFF \
  -DINSTALL_MANPAGES=OFF -DBUILD_CXXLIBS=OFF -DWITH_OGG=ON \
  -DWITH_STACK_PROTECTOR=OFF -DWITH_FORTIFY_SOURCE=OFF || XIPH=0
codec opus "$TP/opus" lib/libopus.a \
  -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF -DOPUS_INSTALL_PKG_CONFIG_MODULE=OFF \
  -DOPUS_STACK_PROTECTOR=OFF -DOPUS_FORTIFY_SOURCE=OFF || XIPH=0
MPEG=1
codec mpg123 "$TP/mpg123/ports/cmake" lib/libmpg123.a \
  -DBUILD_PROGRAMS=OFF -DBUILD_LIBOUT123=OFF || MPEG=0
codec lame "$ROOT/tools/sclang/lame-wasm" lib/libmp3lame.a -DLAME_DIR="$(w "$TP/lame")" || MPEG=0

EXT=OFF
[ "$XIPH" = 1 ] && EXT=ON
MP3=OFF
[ "$MPEG" = 1 ] && MP3=ON
echo "codecs   : FLAC/Vorbis/Opus $EXT, mp3 $MP3"
echo

# The codec choice changed since the last configure: start libsndfile over,
# or its cache keeps what it found (or did not) the first time.
STAMP="$BUILD/codecs.txt"
if [ "$(cat "$STAMP" 2>/dev/null)" != "$EXT $MP3" ]; then rm -rf "$BUILD"; mkdir -p "$BUILD"; fi
echo "$EXT $MP3" > "$STAMP"

"$CMAKE" -S "$(w "$SNDFILE")" -B "$(w "$BUILD")" "${COMMON[@]}" \
  -DBUILD_PROGRAMS=OFF \
  -DBUILD_EXAMPLES=OFF \
  -DBUILD_TESTING=OFF \
  -DBUILD_REGTEST=OFF \
  -DENABLE_EXTERNAL_LIBS=$EXT \
  -DENABLE_MPEG=$MP3 \
  -DENABLE_CPACK=OFF \
  -DENABLE_PACKAGE_CONFIG=OFF \
  -DINSTALL_PKGCONFIG_MODULE=OFF \
  -DINSTALL_MANPAGES=OFF \
  -DENABLE_BOW_DOCS=OFF > "$BUILD/configure.log" 2>&1
grep -E "ENABLE_EXTERNAL_LIBS|ENABLE_MPEG|Enabled features|Disabled features" -A0 "$BUILD/configure.log" | head -8

[ -f "$BUILD/build.ninja" ] || { echo; tail -20 "$BUILD/configure.log"; echo "CONFIGURE FAILED"; exit 1; }
# Asked for and not found is a failure, not a quieter library.
if [ "$EXT" = ON ] && ! grep -q "HAVE_EXTERNAL_XIPH_LIBS 1" "$BUILD/src/config.h" 2>/dev/null; then
  echo "libsndfile did not take the Xiph codecs (see $BUILD/configure.log)"; exit 1
fi
if [ "$MP3" = ON ] && ! grep -q "HAVE_MPEG 1" "$BUILD/src/config.h" 2>/dev/null; then
  echo "libsndfile did not take mpg123/LAME (see $BUILD/configure.log)"; exit 1
fi

echo
echo "--- building sndfile ---"
if "$CMAKE" --build "$(w "$BUILD")" --target sndfile > "$BUILD/build.log" 2>&1; then
  tail -3 "$BUILD/build.log"
else
  tail -20 "$BUILD/build.log"
  echo
  grep -n -i -m 10 "error:" "$BUILD/build.log" | cut -c1-200
  exit 1
fi

LIB="$BUILD/libsndfile.a"
if [ -f "$LIB" ] && [ -f "$SNDFILE/include/sndfile.h" ]; then
  echo
  echo "BUILD OK  $LIB  $(du -k "$LIB" | cut -f1) KB"
  ls "$DEPS/lib"/*.a 2>/dev/null | sed 's#.*/#          #'
else
  echo "BUILD FAILED - no libsndfile.a or include/sndfile.h"
  exit 1
fi
