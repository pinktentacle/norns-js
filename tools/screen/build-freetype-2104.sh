#!/usr/bin/env bash
# E0-17a — Proxy A: isolate the FreeType version.
#
# E0-17 established that emsdk 4.0.18 ships FreeType 2.13.3 while norns runs
# 2.10.4 (Debian bullseye), and argued from the font binaries that the
# difference cannot reach norns.ttf at 8px. This TESTS that argument by
# building 2.10.4 to wasm and rendering the same fingerprint with it.
#
# The experiment holds EVERYTHING else constant - same emcc, same cairo
# sources, same pixman, same flags, same fonts, same scenes - and changes one
# variable. That is cleaner than any native comparison, which would also vary
# the compiler, the libc and the pixman SIMD path.
#
# Build recipe taken from emscripten's own port, so ours differs from the
# stock 2.13.3 build only in the source tree:
#   third_party/emsdk/upstream/emscripten/tools/ports/freetype.py
# `src/sdf/sdf.c` and `src/svg/svg.c` are dropped - they arrived in 2.11 and
# 2.12 and do not exist in 2.10.4.
#
# No ./configure: `builds/unix/ftsystem.c` with -DHAVE_UNISTD_H -DHAVE_FCNTL_H
# is exactly how the emscripten port avoids it.
#
#   bash tools/screen/build-freetype-2104.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMSDK="$ROOT/third_party/emsdk"
FT="$ROOT/third_party/freetype-2104/freetype-VER-2-10-4"
GEN="$ROOT/tools/screen/gen"
PXSRC="$ROOT/third_party/cairo-build/pixman-0.42.2/pixman"
CASRC="$ROOT/third_party/cairo-build/cairo-1.16.0/src"
BUILD="$ROOT/tools/screen/build"
LIB="$BUILD/lib"
RES="$ROOT/third_party/norns/resources"
TTF="$RES/norns.ttf"

[ -d "$FT" ] || { echo "FreeType 2.10.4 not found at $FT"; exit 1; }

export EM_CONFIG="$EMSDK/.emscripten"
EMCC=""; EMAR=""
for c in emcc.exe emcc.bat emcc; do [ -f "$EMSDK/upstream/emscripten/$c" ] && EMCC="$EMSDK/upstream/emscripten/$c" && break; done
for c in emar.exe emar.bat emar; do [ -f "$EMSDK/upstream/emscripten/$c" ] && EMAR="$EMSDK/upstream/emscripten/$c" && break; done
[ -z "$EMCC" ] && { echo "no emcc found"; exit 1; }

V=$(grep -hoE '#define FREETYPE_(MAJOR|MINOR|PATCH) +[0-9]+' "$FT/include/freetype/freetype.h" | awk '{printf "%s.", $3}' | sed 's/\.$//')
echo "freetype source tree : $V   ($FT)"
echo "emcc                 : $EMCC"
echo

mkdir -p "$BUILD/ft2104-obj" "$BUILD/cairo-ft2104-obj" "$LIB"

# --- 1. FreeType 2.10.4 ------------------------------------------------------
FT_SRCS="builds/unix/ftsystem.c src/autofit/autofit.c src/base/ftbase.c
src/base/ftbbox.c src/base/ftbdf.c src/base/ftbitmap.c src/base/ftcid.c
src/base/ftdebug.c src/base/ftfstype.c src/base/ftgasp.c src/base/ftglyph.c
src/base/ftgxval.c src/base/ftinit.c src/base/ftmm.c src/base/ftotval.c
src/base/ftpatent.c src/base/ftpfr.c src/base/ftstroke.c src/base/ftsynth.c
src/base/fttype1.c src/base/ftwinfnt.c src/bdf/bdf.c src/bzip2/ftbzip2.c
src/cache/ftcache.c src/cff/cff.c src/cid/type1cid.c src/gzip/ftgzip.c
src/lzw/ftlzw.c src/pcf/pcf.c src/pfr/pfr.c src/psaux/psaux.c
src/pshinter/pshinter.c src/psnames/psnames.c src/raster/raster.c
src/sfnt/sfnt.c src/smooth/smooth.c src/truetype/truetype.c src/type1/type1.c
src/type42/type42.c src/winfonts/winfnt.c"

FTFLAGS="-O2 -DFT2_BUILD_LIBRARY -DFT_CONFIG_OPTION_SYSTEM_ZLIB -DHAVE_UNISTD_H -DHAVE_FCNTL_H
 -I $FT/include -sUSE_ZLIB=1 -Wno-unused-function -Wno-unused-but-set-variable"

echo "--- compiling freetype $V ---"
ok=0; fail=0; failed=""
for f in $FT_SRCS; do
  o="$BUILD/ft2104-obj/$(echo "$f" | tr '/' '_' | sed 's/\.c$/.o/')"
  if "$EMCC" $FTFLAGS -c "$FT/$f" -o "$o" > "$o.log" 2>&1; then ok=$((ok+1)); else fail=$((fail+1)); failed="$failed $f"; fi
done
echo "compiled: $ok   failed: $fail"
if [ "$fail" -gt 0 ]; then
  for f in $failed; do
    echo "### $f"
    grep -E "error:" "$BUILD/ft2104-obj/$(echo "$f" | tr '/' '_' | sed 's/\.c$/.o/').log" 2>/dev/null | head -3 | sed 's/^/    /'
  done
  exit 1
fi
rm -f "$LIB/libfreetype-2104.a"
"$EMAR" rcs "$LIB/libfreetype-2104.a" "$BUILD"/ft2104-obj/*.o || { echo "emar failed"; exit 1; }

# --- 2. cairo, against 2.10.4's headers --------------------------------------
# Same sources and flags as build-cairo.sh, with -sUSE_FREETYPE=1 swapped for
# an explicit include of the 2.10.4 tree. Separate object directory so the
# 2.13.3 build stays intact and both can be compared.
QUIET="-Wno-ignored-attributes -Wno-unused-but-set-variable -Wno-unused-function -Wno-enum-conversion -Wno-parentheses -Wno-tautological-compare"
CFLAGS="-O2 -DHAVE_CONFIG_H -DCAIRO_NO_MUTEX=1 -I $FT/include -sUSE_ZLIB=1 -sUSE_LIBPNG=1 $QUIET"
CAINC="-I $GEN/cairo -I $CASRC -I $PXSRC -I $GEN/pixman"

echo "--- compiling cairo against freetype $V ---"
ok=0; fail=0; failed=""
for f in $(cat "$GEN/cairo-sources.txt"); do
  [ -f "$CASRC/$f" ] || { fail=$((fail+1)); continue; }
  if "$EMCC" $CFLAGS -c "$CASRC/$f" -o "$BUILD/cairo-ft2104-obj/${f%.c}.o" $CAINC > "$BUILD/cairo-ft2104-obj/${f%.c}.log" 2>&1; then
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
    echo "### $f"; grep -E "error:" "$BUILD/cairo-ft2104-obj/${f%.c}.log" 2>/dev/null | head -3 | sed 's/^/    /'
  done
  exit 1
fi

# Batched archive: the Windows command line cannot take 118 object paths.
rm -f "$LIB/libcairo-ft2104.a"
batch=(); n=0
for o in "$BUILD"/cairo-ft2104-obj/*.o; do
  batch+=("$o"); n=$((n+1))
  if [ "${#batch[@]}" -ge 20 ]; then "$EMAR" q "$LIB/libcairo-ft2104.a" "${batch[@]}" || exit 1; batch=(); fi
done
[ "${#batch[@]}" -gt 0 ] && { "$EMAR" q "$LIB/libcairo-ft2104.a" "${batch[@]}" || exit 1; }
"$EMAR" s "$LIB/libcairo-ft2104.a" || exit 1
echo "archived $n objects"

# --- 3. the same fingerprint, linked against 2.10.4 --------------------------
echo
echo "--- linking fingerprint against freetype $V ---"
"$EMCC" -O2 \
  "$ROOT/tools/screen/fingerprint.c" \
  -I "$GEN/cairo" -I "$CASRC" -I "$PXSRC" -I "$GEN/pixman" -I "$FT/include" \
  "$LIB/libcairo-ft2104.a" \
  "$LIB/libpixman-1.a" \
  "$LIB/libfreetype-2104.a" \
  -sUSE_ZLIB=1 \
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
  -o "$BUILD/fingerprint-ft2104.mjs" || { echo "LINK FAILED"; exit 1; }

ls -la "$BUILD"/fingerprint-ft2104.wasm | awk '{printf "  fingerprint-ft2104.wasm  %7.0f KB\n", $5/1024}'
echo
echo "now run:  node tools/screen/fingerprint.mjs --ft2104 > fp-ft2104.txt"
echo "     and: diff -u tools/screen/fp-wasm.txt tools/screen/fp-ft2104.txt"
