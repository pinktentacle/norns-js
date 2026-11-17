#!/usr/bin/env bash
# E0-17c step 1 -- MEASURE which pixman entry points and which composite fast
# paths cairo 1.16.0 actually reaches for the norns 128x64 ARGB32 surface.
#
# Builds an INSTRUMENTED copy of pixman 0.42.2 (a copy under tools/screen/build;
# third_party is never modified), identical to the shipped build except for
# printf()s at:
#   pixman_image_composite32 / pixman_fill / pixman_blt
#   pixman_composite_glyphs / pixman_composite_glyphs_no_mask
#   pixman_add_traps / pixman_rasterize_trapezoid / pixman_add_triangles
#   _pixman_implementation_lookup_composite  (which fast path was selected)
# plus a one-shot dump of every fast-path table, so a selected func pointer can
# be resolved back to its table entry.
#
# It relinks the SAME fingerprint.c against the SAME libcairo.a, so the only
# thing that changes is the pixman archive. The trace goes to stderr; the
# transcript on stdout is unaffected and is diffed against fp-wasm.txt to prove
# the instrumentation changed no pixels.
#
#   bash tools/screen/trace-pixman.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMSDK="$ROOT/third_party/emsdk"
GEN="$ROOT/tools/screen/gen"
SRC0="$ROOT/third_party/cairo-build/pixman-0.42.2/pixman"
CASRC="$ROOT/third_party/cairo-build/cairo-1.16.0/src"
BUILD="$ROOT/tools/screen/build"
LIB="$BUILD/lib"
PX="$BUILD/pixman-instr-src"
RES="$ROOT/third_party/norns/resources"
TTF="$RES/norns.ttf"

export EM_CONFIG="$EMSDK/.emscripten"
EMCC=""; EMAR=""
for c in emcc.exe emcc.bat emcc; do [ -f "$EMSDK/upstream/emscripten/$c" ] && EMCC="$EMSDK/upstream/emscripten/$c" && break; done
for c in emar.exe emar.bat emar; do [ -f "$EMSDK/upstream/emscripten/$c" ] && EMAR="$EMSDK/upstream/emscripten/$c" && break; done
[ -z "$EMCC" ] && { echo "no emcc found"; exit 1; }

rm -rf "$PX"; mkdir -p "$PX" "$BUILD/pixman-instr-obj" "$LIB"
cp "$SRC0"/*.c "$SRC0"/*.h "$PX"/
mkdir -p "$PX/dither"; cp "$SRC0"/dither/*.h "$PX/dither"/ 2>/dev/null
cp "$ROOT/tools/screen/trace/pixtrace.c" "$ROOT/tools/screen/trace/pixtrace.h" "$PX"/

# insert a statement immediately after the opening brace of a top-level function
ins() { # ins <file> <funcname> <code>
  awk -v fn="$2" -v code="$3" '
    { print }
    $0 ~ "^"fn" \\(" { want = 1 }
    want && /^\{$/   { print code; want = 0 }
  ' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}
addinc() {
  sed -i '0,/^#include "pixman-private.h"/s//#include "pixman-private.h"\n#include "pixtrace.h"/' "$1"
}

# --- the implementation struct gains a name, set by each creator ------------
sed -i '/^    pixman_implementation_t \*\ttoplevel;/i\    const char *                imp_name;' "$PX/pixman-private.h"

addinc "$PX/pixman-implementation.c"
sed -i 's/^\tmemset (imp, 0, sizeof \*imp);/&\n\timp->imp_name = "?";/' "$PX/pixman-implementation.c"
sed -i 's/^update_cache:$/update_cache:\n    pixtrace_lookup (*out_imp, (const void *)*out_func, op, src_format, mask_format, dest_format, src_flags, mask_flags, dest_flags);/' "$PX/pixman-implementation.c"

addinc "$PX/pixman-general.c"
sed -i 's/^    pixman_implementation_t \*imp = _pixman_implementation_create (NULL, general_fast_path);/&\n    imp->imp_name = "general"; pixtrace_table ("general", general_fast_path);/' "$PX/pixman-general.c"

addinc "$PX/pixman-fast-path.c"
sed -i 's/^    pixman_implementation_t \*imp = _pixman_implementation_create (fallback, c_fast_paths);/&\n    imp->imp_name = "fast"; pixtrace_table ("fast", c_fast_paths);/' "$PX/pixman-fast-path.c"

addinc "$PX/pixman-noop.c"
sed -i 's/^\t_pixman_implementation_create (fallback, noop_fast_paths);/&\n    imp->imp_name = "noop"; pixtrace_table ("noop", noop_fast_paths);/' "$PX/pixman-noop.c"

# --- entry points -----------------------------------------------------------
addinc "$PX/pixman.c"
sed -i 's|^    _pixman_implementation_lookup_composite ($|    pixtrace_entry ("composite32", info.op, width, height, src_format, mask_format, dest_format);\n&|' "$PX/pixman.c"
ins "$PX/pixman.c" pixman_fill '    pixtrace_entry ("pixman_fill", -1, width, height, bpp, 0, 0);'
ins "$PX/pixman.c" pixman_blt  '    pixtrace_entry ("pixman_blt", -2, width, height, src_bpp, 0, dst_bpp);'

addinc "$PX/pixman-glyph.c"
ins "$PX/pixman-glyph.c" pixman_composite_glyphs         '    pixtrace_entry ("composite_glyphs", op, width, height, 0, mask_format, 0);'
ins "$PX/pixman-glyph.c" pixman_composite_glyphs_no_mask '    pixtrace_entry ("composite_glyphs_no_mask", op, n_glyphs, 0, 0, 0, 0);'

addinc "$PX/pixman-trap.c"
ins "$PX/pixman-trap.c" pixman_add_traps            '    pixtrace_entry ("add_traps", -3, ntrap, 0, 0, 0, 0);'
ins "$PX/pixman-trap.c" pixman_rasterize_trapezoid  '    pixtrace_entry ("rasterize_trapezoid", -4, 0, 0, 0, 0, 0);'
ins "$PX/pixman-trap.c" pixman_add_triangles        '    pixtrace_entry ("add_triangles", -5, n_tris, 0, 0, 0, 0);'
ins "$PX/pixman-trap.c" pixman_composite_trapezoids '    pixtrace_entry ("composite_trapezoids", op, n_traps, 0, 0, 0, 0);'

# --- compile ----------------------------------------------------------------
QUIET="-Wno-ignored-attributes -Wno-unused-but-set-variable -Wno-unused-function -Wno-enum-conversion -Wno-parentheses -Wno-tautological-compare"
CFLAGS="-O2 -DHAVE_CONFIG_H -DCAIRO_NO_MUTEX=1 -sUSE_FREETYPE=1 -sUSE_LIBPNG=1 $QUIET"

PIXMAN_SOURCES="pixman.c pixman-access.c pixman-access-accessors.c pixman-arm.c
pixman-bits-image.c pixman-combine32.c pixman-combine-float.c
pixman-conical-gradient.c pixman-edge.c pixman-edge-accessors.c
pixman-fast-path.c pixman-filter.c pixman-general.c pixman-glyph.c
pixman-gradient-walker.c pixman-image.c pixman-implementation.c
pixman-linear-gradient.c pixman-matrix.c pixman-mips.c pixman-noop.c
pixman-ppc.c pixman-radial-gradient.c pixman-region16.c pixman-region32.c
pixman-solid-fill.c pixman-timer.c pixman-trap.c pixman-utils.c pixman-x86.c
pixtrace.c"

echo "--- compiling instrumented pixman ---"
ok=0; fail=0
for f in $PIXMAN_SOURCES; do
  if "$EMCC" $CFLAGS -c "$PX/$f" -o "$BUILD/pixman-instr-obj/${f%.c}.o" \
      -I "$PX" -I "$GEN/pixman" > "$BUILD/pixman-instr-obj/${f%.c}.log" 2>&1; then
    ok=$((ok+1))
  else
    fail=$((fail+1)); echo "  FAILED $f"
    grep -E "error:" "$BUILD/pixman-instr-obj/${f%.c}.log" | head -3 | sed 's/^/      /'
  fi
done
echo "compiled: $ok   failed: $fail"
[ "$fail" -gt 0 ] && exit 1

rm -f "$LIB/libpixman-1-instr.a"
"$EMAR" rcs "$LIB/libpixman-1-instr.a" "$BUILD"/pixman-instr-obj/*.o || exit 1

echo "--- linking fingerprint against instrumented pixman ---"
"$EMCC" -O2 \
  "$ROOT/tools/screen/fingerprint.c" \
  -I "$GEN/cairo" -I "$CASRC" -I "$SRC0" -I "$GEN/pixman" \
  "$LIB/libcairo.a" "$LIB/libpixman-1-instr.a" \
  -sUSE_FREETYPE=1 -sUSE_LIBPNG=1 -sSUPPORT_LONGJMP=emscripten \
  -sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=node \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sEXPORTED_RUNTIME_METHODS=callMain \
  --embed-file "$TTF"@norns.ttf \
  --embed-file "$RES/liquid.ttf"@liquid.ttf \
  --embed-file "$RES/Roboto-Regular.ttf"@Roboto-Regular.ttf \
  --embed-file "$RES/VeraMono.ttf"@VeraMono.ttf \
  -o "$BUILD/fingerprint-pxtrace.mjs" || { echo "LINK FAILED"; exit 1; }

echo
echo "now run:  node tools/screen/fingerprint.mjs --pxtrace > fp.txt 2> trace.txt"
