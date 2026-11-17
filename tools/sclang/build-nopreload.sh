#!/usr/bin/env bash
# E0-38a — build sclang for wasm WITHOUT the class-library preload.
#
# Same configure as tools/sclang/build.sh, with one flag changed:
#
#     -DSC_WASM_PRELOAD_CLASSLIB=OFF
#
# That option does not exist in SuperCollider upstream. It is added by
# tools/sclang/classlib-preload-option.patch, which this script refuses to run
# without. With the option OFF, lang/CMakeLists.txt swaps
# `--preload-file SCClassLibrary@/sc/SCClassLibrary` for `-sFORCE_FILESYSTEM=1`,
# so no sclang.data is emitted and the class library has to be unpacked into
# MEMFS before bootInterpreter() — see tools/pack/classlib-loader.mjs and
# research/class-library-packaging.md.
#
# Two deliberate differences from build.sh, both about not breaking the
# artefact every other harness in this repo boots:
#
#   * it configures its OWN build directory, third_party/supercollider/
#     build-wasm-nopreload/. Reconfiguring build-wasm/ would leave
#     SC_WASM_PRELOAD_CLASSLIB=OFF in its CMake cache, and a later
#     `build.sh` — which passes no -D for it — would silently inherit OFF.
#   * it builds only the `sclang` target, and copies the result to
#     build-wasm/wasm-dist/sclang-nopreload/. build-wasm/wasm-dist/sclang/
#     is never written to.
#
#   bash tools/sclang/build-nopreload.sh [clean]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMSDK="$ROOT/third_party/emsdk"
SC="$ROOT/third_party/supercollider"
BUILD="$SC/build-wasm-nopreload"
OUT="$SC/build-wasm/wasm-dist/sclang-nopreload"

# The option is ours, not upstream's. Without the patch, cmake would ignore
# -DSC_WASM_PRELOAD_CLASSLIB=OFF without a word and produce a build that still
# has the preload — which looks like a pass and is not one.
if ! grep -q "SC_WASM_PRELOAD_CLASSLIB" "$SC/lang/CMakeLists.txt"; then
  echo "lang/CMakeLists.txt has no SC_WASM_PRELOAD_CLASSLIB option."
  echo "Apply it first:"
  echo "  (cd $SC && git apply $ROOT/tools/sclang/classlib-preload-option.patch)"
  exit 1
fi

# --- tool discovery: identical to build.sh ----------------------------------
WINGET_PKGS="$LOCALAPPDATA/Microsoft/WinGet/Packages"
[ -d "$WINGET_PKGS" ] || WINGET_PKGS="/c/Users/$USERNAME/AppData/Local/Microsoft/WinGet/Packages"

CMAKE="$(command -v cmake 2>/dev/null)"
for c in "/c/Program Files/CMake/bin/cmake.exe" "/c/Program Files (x86)/CMake/bin/cmake.exe"; do
  [ -n "$CMAKE" ] && break
  [ -f "$c" ] && CMAKE="$c"
done
[ -z "$CMAKE" ] && CMAKE="$(find "$ROOT/third_party/cmake" -name cmake.exe -path '*/bin/*' 2>/dev/null | head -1)"

NINJA="$(command -v ninja 2>/dev/null)"
[ -z "$NINJA" ] && NINJA="$(find "$WINGET_PKGS" -maxdepth 2 -name ninja.exe 2>/dev/null | head -1)"
[ -z "$NINJA" ] && NINJA="$(find "$ROOT/third_party/ninja" -name ninja.exe 2>/dev/null | head -1)"
[ -z "$CMAKE" ] && { echo "no cmake on PATH or under third_party/cmake"; exit 1; }
[ -z "$NINJA" ] && { echo "no ninja on PATH or under third_party/ninja"; exit 1; }

# CMake 4.x removed compatibility with cmake_minimum_required below 3.5, which
# SuperCollider's tree still declares.
CMVER="$("$CMAKE" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
case "$CMVER" in
  4.*|5.*) echo "cmake $CMVER is too new for SuperCollider - install 3.31.x"; exit 1 ;;
esac

TOOLCHAIN="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"
[ -f "$TOOLCHAIN" ] || { echo "emscripten toolchain file missing: $TOOLCHAIN"; exit 1; }

# cmake.exe and ninja.exe are native Windows binaries and cannot read POSIX
# paths. Convert absolute paths explicitly; cygpath -m leaves relative ones
# relative, which is why only absolutes go through it.
w() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

EMSDK_P="$EMSDK"
export EM_CONFIG="$(w "$EMSDK/.emscripten")"
export EMSDK="$(w "$EMSDK")"
export MSYS2_ARG_CONV_EXCL="*"

echo "cmake    : $CMAKE  ($CMVER)"
echo "ninja    : $NINJA"
echo "emsdk    : $(cat "$EMSDK_P/upstream/emscripten/emscripten-version.txt" 2>/dev/null)"
echo "sc       : $(cd "$SC" && git log --oneline -1)"
echo "build    : $BUILD"
echo "out      : $OUT"
echo

# --- wait4 stub: same object build.sh links -------------------------------
EMCC=""
for c in emcc.bat emcc.exe emcc; do
  [ -f "$EMSDK_P/upstream/emscripten/$c" ] && { EMCC="$EMSDK_P/upstream/emscripten/$c"; break; }
done
[ -z "$EMCC" ] && { echo "no emcc found under $EMSDK_P"; exit 1; }

STUB_OBJ="$ROOT/tools/sclang/build/wasm-stubs.o"
mkdir -p "$(dirname "$STUB_OBJ")"
if ! "$EMCC" -O2 -pthread -c "$(w "$ROOT/tools/sclang/wasm-stubs.c")" -o "$(w "$STUB_OBJ")"; then
  echo "failed to compile the wait4 stub"
  exit 1
fi
echo "stub     : $(w "$STUB_OBJ")"
echo

if [ "${1:-}" = "clean" ]; then
  echo "wiping $BUILD"
  rm -rf "$BUILD"
fi

mkdir -p "$BUILD"

"$CMAKE" -S "$(w "$SC")" -B "$(w "$BUILD")" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$(w "$NINJA")" \
  -DCMAKE_TOOLCHAIN_FILE="$(w "$TOOLCHAIN")" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXE_LINKER_FLAGS="$(w "$STUB_OBJ") -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8" \
  -DSC_WASM_PRELOAD_CLASSLIB=OFF \
  -DSC_EL=no \
  -DSC_VIM=no \
  -DSC_ED=no \
  -DSC_IDE=no \
  -DSC_QT=no \
  -DSUPERNOVA=no \
  -DSC_HIDAPI=no \
  -DNO_LIBSNDFILE=yes \
  -DSTATIC_PLUGINS=yes \
  -DNO_AVAHI=yes \
  -DSC_ABLETON_LINK=no \
  -DNO_X11=yes \
  -DSSE=no \
  -DSSE2=no \
  -DAUDIOAPI=webaudio \
  -Wno-dev > "$BUILD/configure.log" 2>&1; tail -12 "$BUILD/configure.log"

if [ ! -f "$BUILD/build.ninja" ]; then
  echo
  echo "CONFIGURE FAILED - no build.ninja produced"
  exit 1
fi

# The cache is what cmake will actually use; -D on the command line is not
# proof it took. Read it back.
CACHED="$(grep -E '^SC_WASM_PRELOAD_CLASSLIB:' "$BUILD/CMakeCache.txt" || true)"
echo "cache    : ${CACHED:-SC_WASM_PRELOAD_CLASSLIB not in cache}"
case "$CACHED" in
  *=OFF) ;;
  *) echo "SC_WASM_PRELOAD_CLASSLIB is not OFF in the cache - refusing to build"; exit 1 ;;
esac

# scsynth is unaffected by this option; build.sh's artefact is the one to use.
echo
echo "--- building target: sclang ---"
LOG="$BUILD/build-sclang.log"
if "$CMAKE" --build "$(w "$BUILD")" --target sclang > "$LOG" 2>&1; then
  tail -4 "$LOG"
else
  tail -25 "$LOG"
  echo
  echo "--- first errors in $LOG ---"
  grep -n -i -m 15 "error:\|undefined symbol\|emcc: error\|wasm-ld:" "$LOG" | cut -c1-220
  echo
  echo "BUILD FAILED - build-wasm/wasm-dist/sclang/ is untouched"
  exit 1
fi

DIST="$BUILD/wasm-dist/sclang"
[ -f "$DIST/sclang.js" ] || { echo "BUILD FAILED - no sclang.js in $DIST"; exit 1; }

# The point of the exercise: no data package.
if [ -f "$DIST/sclang.data" ]; then
  echo
  echo "FAILED - $DIST/sclang.data exists, so the preload is still on."
  exit 1
fi
if grep -q "loadPackage" "$DIST/sclang.js"; then
  echo
  echo "FAILED - sclang.js still calls loadPackage(), so a data package is wired in."
  exit 1
fi

mkdir -p "$OUT"
cp -f "$DIST"/* "$OUT"/
echo
echo "BUILD OK   no sclang.data, no loadPackage() in sclang.js"
echo "  wasm-dist/sclang-nopreload/"
ls -la "$OUT" | awk '$5 > 0 {printf "    %-24s %9.0f KB\n", $9, $5/1024}'
echo
echo "next:  node tools/pack/pack-classlib.mjs"
echo "       SCLANG_DIST=$OUT node tools/pack/boot-test.mjs"
