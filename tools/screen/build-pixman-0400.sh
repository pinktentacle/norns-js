#!/usr/bin/env bash
# E0-17c -- Proxy A for pixman: isolate the pixman VERSION.
#
# E0-17 established that norns (Debian bullseye) runs pixman 0.40.0 while
# norns-js builds 0.42.2, and that on top of that norns compiles the ARM NEON
# kernels while we compile none. Those are two variables. This script holds the
# SIMD path constant at "none" and changes only the version, by building
# pixman 0.40.0 to wasm with the same emcc, the same flags and the same
# 30-source selection as build-cairo.sh uses for 0.42.2, then relinking the
# identical fingerprint.c against it.
#
# Same shape as build-freetype-2104.sh (E0-17a). cairo is recompiled against
# 0.40.0's headers rather than reusing libcairo.a, so the result is honestly
# "cairo 1.16.0 built against pixman 0.40.0" -- even though the two pixman.h
# files were checked and differ only in const-qualification and whitespace of
# the region declarations, so cairo's object code is expected to be identical.
#
# No ./configure: config.h and pixman-version.h are hand-written in
# tools/screen/gen/pixman-0400/, derived entry by entry from 0.40.0's own
# config.h.in and pixman-version.h.in.
#
#   bash tools/screen/build-pixman-0400.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMSDK="$ROOT/third_party/emsdk"
GEN="$ROOT/tools/screen/gen"
PXSRC="$ROOT/third_party/pixman-0400/pixman-0.40.0/pixman"
PXGEN="$GEN/pixman-0400"
CASRC="$ROOT/third_party/cairo-build/cairo-1.16.0/src"
BUILD="$ROOT/tools/screen/build"
LIB="$BUILD/lib"
RES="$ROOT/third_party/norns/resources"
TTF="$RES/norns.ttf"

[ -d "$PXSRC" ] || { echo "pixman 0.40.0 not found at $PXSRC"; exit 1; }

export EM_CONFIG="$EMSDK/.emscripten"
EMCC=""; EMAR=""
for c in emcc.exe emcc.bat emcc; do [ -f "$EMSDK/upstream/emscripten/$c" ] && EMCC="$EMSDK/upstream/emscripten/$c" && break; done
for c in emar.exe emar.bat emar; do [ -f "$EMSDK/upstream/emscripten/$c" ] && EMAR="$EMSDK/upstream/emscripten/$c" && break; done
[ -z "$EMCC" ] && { echo "no emcc found"; exit 1; }

V=$(grep -hoE 'm4_define\(\[pixman_(major|minor|micro)\], *[0-9]+' \
      "$ROOT/third_party/pixman-0400/pixman-0.40.0/configure.ac" \
    | grep -oE '[0-9]+$' | paste -sd. -)
echo "pixman source tree : $V   ($PXSRC)"
echo "emcc               : $EMCC"
echo

mkdir -p "$LIB" "$BUILD/pixman0400-obj" "$BUILD/cairo-px0400-obj"

# --- 1. pixman 0.40.0 -------------------------------------------------------
# The SAME explicit list build-cairo.sh uses for 0.42.2. Verified: the two
# trees ship exactly the same set of .c files, so no adjustment is needed.
# Every per-ISA kernel (pixman-sse2.c, pixman-mmx.c, pixman-arm-neon.c,
# pixman-arm-simd.c, pixman-vmx.c, pixman-mips-dspr2.c) is excluded, as there.
# pixman-{arm,mips,ppc,x86}.c ARE included: those are the runtime dispatch
# stubs, which with every USE_* undefined return no implementation.
PIXMAN_SOURCES="pixman.c pixman-access.c pixman-access-accessors.c pixman-arm.c
pixman-bits-image.c pixman-combine32.c pixman-combine-float.c
pixman-conical-gradient.c pixman-edge.c pixman-edge-accessors.c
pixman-fast-path.c pixman-filter.c pixman-general.c pixman-glyph.c
pixman-gradient-walker.c pixman-image.c pixman-implementation.c
pixman-linear-gradient.c pixman-matrix.c pixman-mips.c pixman-noop.c
pixman-ppc.c pixman-radial-gradient.c pixman-region16.c pixman-region32.c
pixman-solid-fill.c pixman-timer.c pixman-trap.c pixman-utils.c pixman-x86.c"

QUIET="-Wno-ignored-attributes -Wno-unused-but-set-variable -Wno-unused-function -Wno-enum-conversion -Wno-parentheses -Wno-tautological-compare"
CFLAGS="-O2 -DHAVE_CONFIG_H -DCAIRO_NO_MUTEX=1 -sUSE_FREETYPE=1 -sUSE_LIBPNG=1 $QUIET"

# The ONE extra flag 0.40.0 needs that 0.42.2 does not. 0.40.0 declares
#   static const float dither_factor_blue_noise_64 (int, int)
# and takes its address as a `float (*)(int,int)`. A const-qualified return
# type on a non-class type is meaningless in C and generates identical code;
# 0.42.2 simply dropped the `const` (upstream commit between the two). Current
# clang promotes the resulting pointer mismatch from a warning to an error, so
# it is demoted back to a warning here. Nothing about the emitted code changes,
# and neither function is reachable: both are dither kernels, used only when
# pixman_image_set_dither() has been called, which cairo never does.
PXFLAGS="$CFLAGS -Wno-incompatible-function-pointer-types"

echo "--- compiling pixman $V ---"
ok=0; fail=0
for f in $PIXMAN_SOURCES; do
  if [ ! -f "$PXSRC/$f" ]; then echo "  MISSING $f"; fail=$((fail+1)); continue; fi
  if "$EMCC" $PXFLAGS -c "$PXSRC/$f" -o "$BUILD/pixman0400-obj/${f%.c}.o" \
      -I "$PXSRC" -I "$PXGEN" > "$BUILD/pixman0400-obj/${f%.c}.log" 2>&1; then
    ok=$((ok+1))
  else
    fail=$((fail+1)); echo "  FAILED $f"
    grep -E "error:" "$BUILD/pixman0400-obj/${f%.c}.log" 2>/dev/null | head -3 | sed 's/^/      /'
  fi
done
echo "compiled: $ok   failed: $fail"
[ "$fail" -gt 0 ] && exit 1

rm -f "$LIB/libpixman-1-0400.a"
"$EMAR" rcs "$LIB/libpixman-1-0400.a" "$BUILD"/pixman0400-obj/*.o || { echo "emar failed"; exit 1; }

# --- 2. cairo, against 0.40.0's headers -------------------------------------
CAINC="-I $GEN/cairo -I $CASRC -I $PXSRC -I $PXGEN"
echo "--- compiling cairo against pixman $V ---"
ok=0; fail=0; failed=""
for f in $(cat "$GEN/cairo-sources.txt"); do
  [ -f "$CASRC/$f" ] || { fail=$((fail+1)); continue; }
  if "$EMCC" $CFLAGS -c "$CASRC/$f" -o "$BUILD/cairo-px0400-obj/${f%.c}.o" $CAINC > "$BUILD/cairo-px0400-obj/${f%.c}.log" 2>&1; then
    ok=$((ok+1))
  else
    fail=$((fail+1)); failed="$failed $f"
  fi
done
echo "compiled: $ok   failed: $fail"
if [ "$fail" -gt 0 ]; then
  n=0
  for f in $failed; do
    n=$((n+1)); [ "$n" -gt 4 ] && break
    echo "### $f"; grep -E "error:" "$BUILD/cairo-px0400-obj/${f%.c}.log" 2>/dev/null | head -3 | sed 's/^/    /'
  done
  exit 1
fi

# Batched archive: the Windows command line cannot take 118 object paths.
rm -f "$LIB/libcairo-px0400.a"
batch=(); n=0
for o in "$BUILD"/cairo-px0400-obj/*.o; do
  batch+=("$o"); n=$((n+1))
  if [ "${#batch[@]}" -ge 20 ]; then "$EMAR" q "$LIB/libcairo-px0400.a" "${batch[@]}" || exit 1; batch=(); fi
done
[ "${#batch[@]}" -gt 0 ] && { "$EMAR" q "$LIB/libcairo-px0400.a" "${batch[@]}" || exit 1; }
"$EMAR" s "$LIB/libcairo-px0400.a" || exit 1
echo "archived $n objects"

# --- 3. a one-line probe, so the transcript below is attributable -----------
# fingerprint.c prints cairo and FreeType versions but not pixman's, and it is
# deliberately left untouched so fp-wasm.txt stays a valid reference. This
# probe is how we show which archive got linked.
PROBE="$BUILD/pixver.c"
cat > "$PROBE" <<'EOF'
#include <pixman.h>
#include <stdio.h>
int main (void) { printf ("pixman_version_string %s\n", pixman_version_string ()); return 0; }
EOF
for v in "0400:$PXSRC:$PXGEN:$LIB/libpixman-1-0400.a" \
         "0422:$ROOT/third_party/cairo-build/pixman-0.42.2/pixman:$GEN/pixman:$LIB/libpixman-1.a"; do
  tag="${v%%:*}"; rest="${v#*:}"
  inc="${rest%%:*}"; rest="${rest#*:}"
  gen="${rest%%:*}"; ar="${rest#*:}"
  [ -f "$ar" ] || continue
  "$EMCC" -O2 "$PROBE" -I "$inc" -I "$gen" "$ar" -sENVIRONMENT=node \
      -o "$BUILD/pixver-$tag.cjs" >/dev/null 2>&1 \
      && printf "  %-20s -> " "$(basename "$ar")" && node "$BUILD/pixver-$tag.cjs"
done

# --- 4. the same fingerprint, linked against 0.40.0 -------------------------
echo
echo "--- linking fingerprint against pixman $V ---"
"$EMCC" -O2 \
  "$ROOT/tools/screen/fingerprint.c" \
  -I "$GEN/cairo" -I "$CASRC" -I "$PXSRC" -I "$PXGEN" \
  "$LIB/libcairo-px0400.a" \
  "$LIB/libpixman-1-0400.a" \
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
  -o "$BUILD/fingerprint-pixman0400.mjs" || { echo "LINK FAILED"; exit 1; }

ls -la "$BUILD"/fingerprint-pixman0400.wasm | awk '{printf "  fingerprint-pixman0400.wasm  %7.0f KB\n", $5/1024}'
echo
echo "now run:  node tools/screen/fingerprint.mjs --pixman0400 > tools/screen/fp-pixman0400.txt"
echo "     and: diff -u tools/screen/fp-wasm.txt tools/screen/fp-pixman0400.txt"
