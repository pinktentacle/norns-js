#!/usr/bin/env bash
# E9-29 — fftw3, single precision, for wasm.
#
# WHY AT ALL. `sc3-plugins/source/PitchDetection` is the one set this build
# could not have, and it carries `Tartini` — the pitch tracker three
# catalogue scripts use (acrostic, splnkr, caliper). Its code has exactly
# two backends:
#
#     #if SC_FFT_FFTW   ... fftwf_plan_r2r_1d(...)
#     #elif SC_FFT_VDSP ... vDSP_fft3_zop(...)
#
# vDSP is Apple's Accelerate, so there is no portable third path to fall
# back on. norns gets libfftw3 from Debian; a browser has to bring its own.
# `NCAnalysisUGens/SMS.cpp` wants it too.
#
# WHAT IS ACTUALLY USED is six functions — `fftwf_malloc`, `fftwf_free`,
# `fftwf_plan_r2r_1d`, `fftwf_execute`, `fftwf_destroy_plan` and the
# `fftwf_plan` type — which is why single precision alone is built and the
# long-double and double variants are not.
#
# CMAKE RATHER THAN AUTOTOOLS. fftw ships both; `./configure` under MSYS
# with a cross compiler is a long argument about which `conftest` may be
# run, and the rest of this project already builds through CMake + Ninja
# with the emscripten toolchain file. Same toolchain, same shape as
# tools/sclang/build.sh.
#
#   bash tools/sclang/build-fftw.sh
#
# Produces third_party/fftw3/build-wasm/libfftw3f.a, which
# tools/sclang/build.sh then puts on scsynth's link line.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMSDK="$ROOT/third_party/emsdk"
FFTW="$ROOT/third_party/fftw3"
BUILD="$FFTW/build-wasm"

[ -f "$FFTW/CMakeLists.txt" ] || {
  echo "no fftw checkout at $FFTW"
  echo "  curl -sLo third_party/emforge/dl/fftw-3.3.10.tar.gz https://www.fftw.org/fftw-3.3.10.tar.gz"
  echo "  mkdir -p third_party/fftw3 && tar xzf third_party/emforge/dl/fftw-3.3.10.tar.gz -C third_party/fftw3 --strip-components=1"
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
[ -z "$CMAKE" ] && { echo "no cmake"; exit 1; }
[ -z "$NINJA" ] && { echo "no ninja"; exit 1; }

TOOLCHAIN="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"
[ -f "$TOOLCHAIN" ] || { echo "emscripten toolchain file missing: $TOOLCHAIN"; exit 1; }

w() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
export EM_CONFIG="$(w "$EMSDK/.emscripten")"

[ "${1:-}" = "clean" ] && { echo "wiping $BUILD"; rm -rf "$BUILD"; }
mkdir -p "$BUILD"

# EVERY SIMD SET OFF. The toolchain would happily accept `-msse2` and
# emscripten can even emulate it, but fftw picks its codelets from the
# compile-time flags and the result is a library whose fast paths are
# emulated — slower than the scalar ones it would otherwise have chosen.
# Threads off for the same reason the server's own FFT is single-threaded
# here: this runs inside one audio thread.
"$CMAKE" -S "$(w "$FFTW")" -B "$(w "$BUILD")" -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$(w "$NINJA")" \
  -DCMAKE_TOOLCHAIN_FILE="$(w "$TOOLCHAIN")" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-O3 -pthread" \
  -DENABLE_FLOAT=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DENABLE_THREADS=OFF \
  -DWITH_COMBINED_THREADS=OFF \
  -DENABLE_OPENMP=OFF \
  -DENABLE_SSE=OFF \
  -DENABLE_SSE2=OFF \
  -DENABLE_AVX=OFF \
  -DENABLE_AVX2=OFF \
  -DDISABLE_FORTRAN=ON \
  -DBUILD_TESTS=OFF \
  -Wno-dev > "$BUILD/configure.log" 2>&1; tail -8 "$BUILD/configure.log"

[ -f "$BUILD/build.ninja" ] || { echo; echo "CONFIGURE FAILED"; exit 1; }

echo
echo "--- building fftw3f ---"
if "$CMAKE" --build "$(w "$BUILD")" --target fftw3f > "$BUILD/build.log" 2>&1; then
  tail -3 "$BUILD/build.log"
else
  tail -20 "$BUILD/build.log"
  echo
  grep -n -i -m 10 "error:" "$BUILD/build.log" | cut -c1-200
  exit 1
fi

LIB="$(find "$BUILD" -name 'libfftw3f.a' | head -1)"
if [ -n "$LIB" ]; then
  echo
  echo "BUILD OK  $LIB  $(du -k "$LIB" | cut -f1) KB"
else
  echo "BUILD FAILED - no libfftw3f.a"
  exit 1
fi
