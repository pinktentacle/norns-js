#!/usr/bin/env bash
# E0-18 — build sclang for wasm from SuperCollider develop.
#
# Unlike the cairo spike, this one uses SuperCollider's own CMake build rather
# than hand-written em++ calls: sclang is ~45 translation units plus yaml-cpp,
# tlsf, oscpack and a Bison-generated parser, and the link step needs a precise
# set of emscripten flags (pthreads + wasm workers + embind + a preload-file
# package of the class library). Reproducing that by hand would be guesswork.
#
# Requires cmake and ninja in third_party/ (portable, no install).
#
#   bash tools/sclang/build.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMSDK="$ROOT/third_party/emsdk"
SC="$ROOT/third_party/supercollider"
BUILD="$SC/build-wasm"

# Prefer a system install on PATH over the portable copies in third_party:
# binaries unpacked from a downloaded archive inside the project tree are
# refused by the agent sandbox ("Code from External"), so a normal install is
# what lets this run unattended.
WINGET_PKGS="$LOCALAPPDATA/Microsoft/WinGet/Packages"
[ -d "$WINGET_PKGS" ] || WINGET_PKGS="/c/Users/$USERNAME/AppData/Local/Microsoft/WinGet/Packages"

# PATH first, then the usual install locations, then third_party. A shell
# started before the install will not have the new PATH, so do not rely on it.
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
# SuperCollider's tree still declares. Refuse early rather than fail deep in
# the configure with a confusing error.
CMVER="$("$CMAKE" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
case "$CMVER" in
  4.*|5.*) echo "cmake $CMVER is too new for SuperCollider - install 3.31.x"; exit 1 ;;
esac

TOOLCHAIN="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"
[ -f "$TOOLCHAIN" ] || { echo "emscripten toolchain file missing: $TOOLCHAIN"; exit 1; }

# cmake.exe and ninja.exe are native Windows binaries and cannot read the POSIX
# paths this script works in. Convert explicitly rather than relying on MSYS
# argument mangling, which does not fire for -DVAR=/path forms.
w() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

EMSDK_P="$EMSDK"   # POSIX copy: the exported one below is Windows-shaped
export EM_CONFIG="$(w "$EMSDK/.emscripten")"
export EMSDK="$(w "$EMSDK")"
# MSYS otherwise rewrites arguments that look like absolute POSIX paths.
export MSYS2_ARG_CONV_EXCL="*"

echo "cmake    : $CMAKE"
echo "ninja    : $NINJA"
echo "emsdk    : $(cat "$EMSDK_P/upstream/emscripten/emscripten-version.txt" 2>/dev/null)"
echo "sc       : $(cd "$SC" && git log --oneline -1)"
echo

# --- wait4 stub -------------------------------------------------------------
# emscripten 3.1.61 declares wait4() in <sys/wait.h> but ships no
# implementation; SC's CI pins 4.0.18, where it exists. Its only caller is
# sc_pclose() in common/sc_popen.cpp, unreachable under wasm (no fork).
# One extra object on the link line keeps third_party/supercollider unpatched.
EMCC=""
for c in emcc.bat emcc.exe emcc; do
  [ -f "$EMSDK_P/upstream/emscripten/$c" ] && { EMCC="$EMSDK_P/upstream/emscripten/$c"; break; }
done
[ -z "$EMCC" ] && { echo "no emcc found under $EMSDK_P"; exit 1; }

# --- sc3-plugins ------------------------------------------------------------
# wasm has no dlopen, so UGens that are not on the link line do not exist.
# 15 of the 51 .sc files under ~/dust/code reach one (Decimator, DFM1, SVF,
# MdaPiano). If the checkout is there, four of its UGen sets are compiled
# into scsynth; if it is not, the build is exactly what it was before.
#
#   git -C third_party clone --depth 1 #     https://github.com/supercollider/sc3-plugins.git sc3-plugins
# --- mi-UGens ---------------------------------------------------------------
# The Mutable Instruments ports, a SEPARATE pack from sc3-plugins:
#
#   git -C third_party clone --depth 1 #     https://github.com/v7b1/mi-UGens.git mi-UGens
#
# Five of its twelve are built (MiElements, MiRings, MiClouds, MiPlaits and
# MiBraids). MiBraids resamples with libsamplerate, which mi-UGens carries as
# a SUBMODULE -- a plain clone leaves it empty, and then MiBraids alone is
# dropped:
#
#   git -C third_party/mi-UGens submodule update --init --recursive
#
# Without the checkout at all the build is what it was, and the five mi-eng
# scripts come up with silent engines.
MI_UGENS=""
if [ -d "$ROOT/third_party/mi-UGens/eurorack" ]; then
  MI_UGENS="$(w "$ROOT/third_party/mi-UGens")"
  echo "mi-ugens : $MI_UGENS"
else
  echo "mi-ugens : absent - the MiElements/MiRings/MiClouds/MiPlaits/MiBraids UGens will be missing"
fi

# --- PortedPlugins ----------------------------------------------------------
# E9-35. The pack `amenbreak` tries to wget as a Raspberry Pi binary; this
# builds it from source instead.
#
#   curl -sLo third_party/emforge/dl/portedplugins.tar.gz #     https://codeload.github.com/schollz/portedplugins/tar.gz/refs/heads/main
#
# THE SHA256 IS THE PIN. That repository has no tags and no version in its
# tree, so PINS.md can name neither; the archive built here is
#
#   4df66a95fba94586aff0ad010d6a2744b4598b4c7ccc64374efb5e03c472333c
#
# and the copy kept in third_party/portedplugins/ is the same bytes.
#   mkdir -p third_party/portedplugins && tar xzf #     third_party/emforge/dl/portedplugins.tar.gz #     -C third_party/portedplugins --strip-components=1
# --- the single-plugin repositories -----------------------------------------
# E9-36/E9-40. One directory per upstream repository, all under
# third_party/sc-plugins-extra: the three PTR oscillators, vendored from
# robbielyman/{FormantTriPTR,pulseptr,triangleptr} - the account
# `ryleelyman` in the scripts' own URLs was renamed and now answers 404 -
# and ByteBeat, from midouest/bytebeat.
SC_EXTRA=""
if [ -d "$ROOT/third_party/sc-plugins-extra/PulsePTR" ]; then
  SC_EXTRA="$(w "$ROOT/third_party/sc-plugins-extra")"
  echo "extra    : $SC_EXTRA"
else
  echo "extra    : absent - PulsePTR, TrianglePTR, FormantTriPTR and ByteBeat will be missing"
fi

PORTED_PLUGINS=""
if [ -d "$ROOT/third_party/portedplugins/plugins" ]; then
  PORTED_PLUGINS="$(w "$ROOT/third_party/portedplugins/plugins")"
  echo "ported   : $PORTED_PLUGINS"
else
  echo "ported   : absent - AnalogTape, Fverb and the rest of PortedPlugins will be missing"
fi

# --- DaisySP and Eigen ------------------------------------------------------
# E9-58. Fourteen of PortedPlugins' plugins need one of these two and were
# left out of the build for it: thirteen want DaisySP (the drum and
# oscillator set -- AnalogBassDrum, StringVoice, ZOsc and the rest) and
# Werner wants Eigen, through ChowDSP's GenSVF. PortedPlugins' own CMake
# downloads both with CPM at configure time, which a cross-build cannot do.
#
#   git -C third_party clone --depth 1 #     https://github.com/electro-smith/DaisySP.git DaisySP
#   git -C third_party clone --depth 1 --branch 3.4.0 #     https://gitlab.com/libeigen/eigen.git eigen
#
# Without either one the build is exactly what it was: the plugins are not
# compiled and SC_StaticPlugins.h does not declare them.
DAISYSP=""
if [ -f "$ROOT/third_party/DaisySP/Source/daisysp.h" ]; then
  DAISYSP="$(w "$ROOT/third_party/DaisySP")"
  echo "daisysp  : $DAISYSP"
else
  echo "daisysp  : absent - thirteen PortedPlugins UGens will be missing"
fi

EIGEN=""
if [ -f "$ROOT/third_party/eigen/Eigen/Dense" ]; then
  EIGEN="$(w "$ROOT/third_party/eigen")"
  echo "eigen    : $EIGEN"
else
  echo "eigen    : absent - the Werner filter will be missing"
fi

SC3_PLUGINS=""
SC3_FAUST=""
if [ -d "$ROOT/third_party/sc3-plugins/source" ]; then
  SC3_PLUGINS="$(w "$ROOT/third_party/sc3-plugins/source")"
  echo "sc3      : $SC3_PLUGINS"
  SC3_FAUST="$(w "$ROOT/tools/sclang/sc3-faust")"
else
  echo "sc3      : absent - Decimator, DFM1, SVF and MdaPiano will be missing"
fi

# --- fftw3, single precision ------------------------------------------------
# E9-29. `PitchDetection` (Tartini, Qitch) and `NCAnalysisUGens` have only
# two FFT backends in their source, FFTW and Apple's vDSP, so there is no
# portable third path: without fftw they cannot be built at all. norns gets
# libfftw3 from Debian. Build ours with tools/sclang/build-fftw.sh.
FFTW3F_LIB=""
FFTW3F_INCLUDE=""
if [ -f "$ROOT/third_party/fftw3/build-wasm/libfftw3f.a" ]; then
  FFTW3F_LIB="$(w "$ROOT/third_party/fftw3/build-wasm/libfftw3f.a")"
  FFTW3F_INCLUDE="$(w "$ROOT/third_party/fftw3/api")"
  echo "fftw3f   : $FFTW3F_LIB"
else
  echo "fftw3f   : absent - Tartini, Qitch and the NCAnalysis UGens will be missing"
  echo "           (bash tools/sclang/build-fftw.sh)"
fi

# --- libsndfile ---------------------------------------------------------------
# E9-268. What lets scsynth WRITE sound files: Buffer.write, Recorder, and
# the DiskIO_UGens (DiskOut, DiskIn, VDiskIn), which SuperCollider compiles
# only when libsndfile is found. Reading does not go through it here (the
# page decodes, src/engine/buffers.ts). Build it with
# tools/sclang/build-sndfile.sh; without it the server is what it was,
# `-DNO_LIBSNDFILE`, and `/b_write` stays refused in sclang.
SNDFILE_OPTS=(-DNO_LIBSNDFILE=yes)
if [ -f "$ROOT/third_party/libsndfile/build-wasm/libsndfile.a" ]; then
  # E9-269 — and the codecs it was built with, after it on the link line
  # (a static library's dependencies come after it). Whichever are there.
  SNDFILE_LIBS="$(w "$ROOT/third_party/libsndfile/build-wasm/libsndfile.a")"
  for l in libFLAC libvorbisenc libvorbis libopus libogg libmpg123 libmp3lame; do
    f="$ROOT/third_party/libsndfile/deps-wasm/lib/$l.a"
    [ -f "$f" ] && SNDFILE_LIBS="$SNDFILE_LIBS;$(w "$f")"
  done
  SNDFILE_OPTS=(
    -DNO_LIBSNDFILE=no
    -DSNDFILE_INCLUDE_DIR="$(w "$ROOT/third_party/libsndfile/include")"
    -DSNDFILE_LIBRARY="$SNDFILE_LIBS"
  )
  echo "sndfile  : $SNDFILE_LIBS"
  # E9-269 — FindSndfile's SNDFILE_HAS_VORBIS/OPUS/MPEG are CACHED checks:
  # a build directory configured once with NO_LIBSNDFILE keeps them false
  # for ever, and SuperCollider then refuses "OGG" and "MPEG" as header
  # formats (measured: /b_write failed for .ogg, .opus and .mp3 with the
  # codecs linked). `-U` below drops them so every configure asks again.
else
  echo "sndfile  : absent - scsynth cannot write sound files, and DiskOut/DiskIn are missing"
  echo "           (bash tools/sclang/build-sndfile.sh)"
fi

STUB_OBJ="$ROOT/tools/sclang/build/wasm-stubs.o"
mkdir -p "$(dirname "$STUB_OBJ")"
if ! "$EMCC" -O2 -pthread -c "$(w "$ROOT/tools/sclang/wasm-stubs.c")" -o "$(w "$STUB_OBJ")"; then
  echo "failed to compile the wait4 stub"
  exit 1
fi
echo "stub     : $(w "$STUB_OBJ")"
echo

# "clean" wipes the build dir. Needed after switching emscripten versions:
# the toolchain path is unchanged (emsdk swaps what upstream/ points at), so
# CMake cannot tell the compiler moved underneath it.
if [ "${1:-}" = "clean" ]; then
  echo "wiping $BUILD"
  rm -rf "$BUILD"
fi

mkdir -p "$BUILD"

# Invoking cmake directly with the toolchain file rather than through emcmake:
# emcmake is a Python wrapper that re-execs cmake, and passing the toolchain
# explicitly is what the SC README documents for the CLion setup anyway.
# E9-223 — scsynth's heap is FIXED (shared with the audio worklet, so it
# cannot grow), and every buffer a script allocates lives in it. 128 MB was
# the old size and it was not enough: eastwind allocates two 300 s stereo
# buffers (~115 MB each) and scsynth aborted the moment it loaded, and a
# session of a few scripts filled it with what their engines had left
# behind. A norns shield has 1 GB for everything; 512 MB is the server's
# share of that. The memory is reserved up front; a device that refuses it
# gets the old 128 MB server instead (public/scsynth-small, see host.ts).
SCSYNTH_MEMORY="${SCSYNTH_MEMORY:-536870912}"

"$CMAKE" -S "$(w "$SC")" -B "$(w "$BUILD")" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$(w "$NINJA")" \
  -DCMAKE_TOOLCHAIN_FILE="$(w "$TOOLCHAIN")" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXE_LINKER_FLAGS="$(w "$STUB_OBJ") -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8" \
  -DSC_EL=no \
  -DSC_VIM=no \
  -DSC_ED=no \
  -DSC_IDE=no \
  -DSC_QT=no \
  -DSUPERNOVA=no \
  -DSC_HIDAPI=no \
  "${SNDFILE_OPTS[@]}" \
  -U "SNDFILE_HAS_*" \
  -DSTATIC_PLUGINS=yes \
  -DSC3_PLUGINS_DIR="$SC3_PLUGINS" \
  -DSC3_FAUST_WRAPPER_DIR="$SC3_FAUST" \
  -DMI_UGENS_DIR="$MI_UGENS" \
  -DFFTW3F_LIB="$FFTW3F_LIB" \
  -DPORTED_PLUGINS_DIR="$PORTED_PLUGINS" \
  -DDAISYSP_DIR="$DAISYSP" \
  -DEIGEN_DIR="$EIGEN" \
  -DSC_EXTRA_DIR="$SC_EXTRA" \
  -DFFTW3F_INCLUDE="$FFTW3F_INCLUDE" \
  -DSC_WASM_INITIAL_MEMORY="$SCSYNTH_MEMORY" \
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

# Both targets, each into its own complete wasm-dist/<name>/ directory.
# NOT the `webeditor` target: it bundles the two into one directory for its
# own demo page, which we do not use, and its POST_BUILD copy list is a fixed
# set of filenames - fragile if emscripten's output ever changes. Building the
# targets themselves keeps whatever each one actually emits.
rc=0
for target in sclang scsynth; do
  echo
  echo "--- building target: $target ---"
  LOG="$BUILD/build-$target.log"
  if "$CMAKE" --build "$(w "$BUILD")" --target "$target" > "$LOG" 2>&1; then
    tail -4 "$LOG"
  else
    rc=1
    tail -25 "$LOG"
    echo
    echo "--- first errors in $LOG ---"
    grep -n -i -m 15 "error:\|undefined symbol\|emcc: error\|wasm-ld:" "$LOG" | cut -c1-220
    break
  fi
done

DIST="$BUILD/wasm-dist"
echo
missing=""
[ -f "$DIST/sclang/sclang.js" ]   || missing="$missing sclang.js"
[ -f "$DIST/scsynth/scsynth.js" ] || missing="$missing scsynth.js"

if [ -z "$missing" ] && [ "$rc" -eq 0 ]; then
  echo "BUILD OK"
  for d in sclang scsynth; do
    echo "  wasm-dist/$d/"
    ls -la "$DIST/$d" | awk '$5 > 0 {printf "    %-24s %9.0f KB\n", $9, $5/1024}'
  done
  echo
  echo "E0-18:  node tools/sclang/osc-test.mjs"
  echo "E0-19:  npm run dev   (the page is the host now)"
else
  echo "BUILD FAILED - missing:$missing"
  exit 1
fi
