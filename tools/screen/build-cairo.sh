#!/usr/bin/env bash
# P0 spike — build pixman + cairo for wasm32 from source, on the CURRENT emsdk.
#
# No ./configure, no make: the sandbox does not permit executing build scripts
# from downloaded archives, and we do not want to. Instead:
#   * config.h and cairo-features.h are hand-written in tools/screen/gen/
#   * the source list is parsed out of cairo's own Makefile.sources
#   * every translation unit is handed to emcc explicitly
#
# This is also why the result is not pinned to a toolchain version, unlike the
# emscripten-forge prebuilts, which need a patched emsdk 3.1.45.
#
# Run from the project root:  bash tools/screen/build-cairo.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMSDK="$ROOT/third_party/emsdk"
GEN="$ROOT/tools/screen/gen"
PXSRC="$ROOT/third_party/cairo-build/pixman-0.42.2/pixman"
CASRC="$ROOT/third_party/cairo-build/cairo-1.16.0/src"
BUILD="$ROOT/tools/screen/build"
LIB="$BUILD/lib"

export EM_CONFIG="$EMSDK/.emscripten"
EMCC=""
EMAR=""
for c in emcc.exe emcc.bat emcc; do
  if [ -f "$EMSDK/upstream/emscripten/$c" ]; then EMCC="$EMSDK/upstream/emscripten/$c"; break; fi
done
for c in emar.exe emar.bat emar; do
  if [ -f "$EMSDK/upstream/emscripten/$c" ]; then EMAR="$EMSDK/upstream/emscripten/$c"; break; fi
done
if [ -z "$EMCC" ]; then echo "no emcc found"; exit 1; fi

mkdir -p "$LIB" "$BUILD/cairo-obj"

# cairo applies its warn_unused_result macro to void functions, which modern
# clang flags. Harmless, and noisy enough to hide real errors.
QUIET="-Wno-ignored-attributes -Wno-unused-but-set-variable -Wno-unused-function -Wno-enum-conversion -Wno-parentheses -Wno-tautological-compare"

# CAIRO_NO_MUTEX: single-threaded build. cairo refuses to compile without an
# explicit acknowledgement here; cairo-mutex-impl-private.h says so directly.
CFLAGS="-O2 -DHAVE_CONFIG_H -DCAIRO_NO_MUTEX=1 -sUSE_FREETYPE=1 -sUSE_LIBPNG=1 $QUIET"
CAINC="-I $GEN/cairo -I $CASRC -I $PXSRC -I $GEN/pixman"

echo "emcc: $EMCC"

# --- pixman ---------------------------------------------------------------
# Explicit list rather than a glob: pixman ships per-ISA implementations
# (pixman-sse2.c, pixman-mmx.c, pixman-arm-neon.c, ...) that need arch flags
# and are useless for wasm. pixman-{arm,mips,ppc,x86}.c ARE wanted - those are
# the runtime dispatch stubs, not the SIMD kernels.
PIXMAN_SOURCES="pixman.c pixman-access.c pixman-access-accessors.c pixman-arm.c
pixman-bits-image.c pixman-combine32.c pixman-combine-float.c
pixman-conical-gradient.c pixman-edge.c pixman-edge-accessors.c
pixman-fast-path.c pixman-filter.c pixman-general.c pixman-glyph.c
pixman-gradient-walker.c pixman-image.c pixman-implementation.c
pixman-linear-gradient.c pixman-matrix.c pixman-mips.c pixman-noop.c
pixman-ppc.c pixman-radial-gradient.c pixman-region16.c pixman-region32.c
pixman-solid-fill.c pixman-timer.c pixman-trap.c pixman-utils.c pixman-x86.c"

mkdir -p "$BUILD/pixman-obj"
echo "--- compiling pixman ---"
pxok=0
pxfail=0
for f in $PIXMAN_SOURCES; do
  if [ ! -f "$PXSRC/$f" ]; then
    echo "  MISSING $f"
    pxfail=$((pxfail + 1))
    continue
  fi
  if "$EMCC" $CFLAGS -c "$PXSRC/$f" -o "$BUILD/pixman-obj/${f%.c}.o" \
      -I "$PXSRC" -I "$GEN/pixman" > "$BUILD/pixman-obj/${f%.c}.log" 2>&1; then
    pxok=$((pxok + 1))
  else
    pxfail=$((pxfail + 1))
    echo "  FAILED $f"
    grep -E "error:" "$BUILD/pixman-obj/${f%.c}.log" 2>/dev/null | head -2 | sed 's/^/      /'
  fi
done
echo "compiled: $pxok   failed: $pxfail"
[ "$pxfail" -gt 0 ] && exit 1

rm -f "$LIB/libpixman-1.a"
"$EMAR" rcs "$LIB/libpixman-1.a" "$BUILD"/pixman-obj/*.o || { echo "emar failed for pixman"; exit 1; }

echo "--- compiling cairo ---"
ok=0
fail=0
failed=""
for f in $(cat "$GEN/cairo-sources.txt"); do
  if [ ! -f "$CASRC/$f" ]; then
    echo "  MISSING $f"
    fail=$((fail+1))
    continue
  fi
  if "$EMCC" $CFLAGS -c "$CASRC/$f" -o "$BUILD/cairo-obj/${f%.c}.o" $CAINC > "$BUILD/cairo-obj/${f%.c}.log" 2>&1; then
    ok=$((ok+1))
  else
    fail=$((fail+1))
    failed="$failed $f"
  fi
done

echo "compiled: $ok   failed: $fail"
if [ "$fail" -gt 0 ]; then
  echo "--- first failures ---"
  n=0
  for f in $failed; do
    n=$((n+1))
    if [ "$n" -gt 4 ]; then break; fi
    echo "### $f"
    grep -E "error:" "$BUILD/cairo-obj/${f%.c}.log" 2>/dev/null | head -3 | sed 's/^/    /'
  done
  exit 1
fi

# Windows caps a command line at ~32k characters, and 118 object paths overflow
# it: `emar rcs` with the whole list fails with "The command line is too long."
# That failure is quiet - the stale archive stays on disk and the next link
# silently uses objects from whichever toolchain built it last. So archive in
# batches with `emar q`, then write the index once with `emar s`.
rm -f "$LIB/libcairo.a"
batch=()
n=0
for o in "$BUILD"/cairo-obj/*.o; do
  batch+=("$o")
  n=$((n + 1))
  if [ "${#batch[@]}" -ge 20 ]; then
    "$EMAR" q "$LIB/libcairo.a" "${batch[@]}" || { echo "emar q failed"; exit 1; }
    batch=()
  fi
done
if [ "${#batch[@]}" -gt 0 ]; then
  "$EMAR" q "$LIB/libcairo.a" "${batch[@]}" || { echo "emar q failed"; exit 1; }
fi
"$EMAR" s "$LIB/libcairo.a" || { echo "emar s failed"; exit 1; }
echo "archived $n objects"

ls -la "$LIB"/*.a | awk '{printf "  %-20s %7.0f KB\n", $9, $5/1024}'

# --- link the fidelity test ------------------------------------------------
# Against OUR libraries plus emscripten's own freetype and libpng ports. No
# fontconfig, no expat: cairo is configured without them, which is most of why
# this links to ~1.1 MB where the emscripten-forge prebuilts gave 3.2 MB.
echo
echo "--- linking screen-test ---"
RES="$ROOT/third_party/norns/resources"
TTF="$RES/norns.ttf"
[ -f "$TTF" ] || { echo "norns.ttf not found at $TTF"; exit 1; }

"$EMCC" -O2 \
  "$ROOT/tools/screen/screen-test.c" \
  -I "$GEN/cairo" -I "$CASRC" -I "$PXSRC" -I "$GEN/pixman" \
  "$LIB/libcairo.a" \
  "$LIB/libpixman-1.a" \
  -sUSE_FREETYPE=1 \
  -sUSE_LIBPNG=1 \
  -sSUPPORT_LONGJMP=emscripten \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=node \
  --embed-file "$TTF"@norns.ttf \
  -o "$BUILD/screen-test.mjs" || { echo "LINK FAILED"; exit 1; }

ls -la "$BUILD"/screen-test.wasm | awk '{printf "  screen-test.wasm  %7.0f KB\n", $5/1024}'

# --- link the fidelity fingerprint (E0-17) ---------------------------------
# Same libraries, but this binary mirrors screen.cc exactly and emits a
# deterministic transcript for diffing against a run on real hardware.
echo
echo "--- linking fingerprint ---"
"$EMCC" -O2 \
  "$ROOT/tools/screen/fingerprint.c" \
  -I "$GEN/cairo" -I "$CASRC" -I "$PXSRC" -I "$GEN/pixman" \
  "$LIB/libcairo.a" \
  "$LIB/libpixman-1.a" \
  -sUSE_FREETYPE=1 \
  -sUSE_LIBPNG=1 \
  -sSUPPORT_LONGJMP=emscripten \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=node \
  -sINVOKE_RUN=0 \
  -sEXIT_RUNTIME=1 \
  -sEXPORTED_RUNTIME_METHODS=callMain \
  --embed-file "$TTF"@norns.ttf \
  --embed-file "$RES/liquid.ttf"@liquid.ttf \
  --embed-file "$RES/Roboto-Regular.ttf"@Roboto-Regular.ttf \
  --embed-file "$RES/VeraMono.ttf"@VeraMono.ttf \
  -o "$BUILD/fingerprint.mjs" || { echo "FINGERPRINT LINK FAILED"; exit 1; }

ls -la "$BUILD"/fingerprint.wasm | awk '{printf "  fingerprint.wasm  %7.0f KB\n", $5/1024}'
echo
echo "now run:  node tools/screen/run.mjs"
echo "     or:  node tools/screen/fingerprint.mjs [--full] > fp-wasm.txt"
