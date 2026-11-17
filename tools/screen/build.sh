#!/usr/bin/env bash
# RETIRED 2026-11-06. Do not use.
#
# This was the option-2 script: it linked the PREBUILT cairo/pixman/freetype/
# fontconfig from the emscripten-forge conda channel in third_party/emforge.
# That route was abandoned because those prebuilts reference saveSetjmp and
# testSetjmp - emscripten's legacy JS setjmp runtime, removed in 4.x - so they
# need a patched emsdk 3.1.45. See research/screen.md.
#
# Keeping it runnable was a trap: it looks like the obvious script to run and
# fails with an error that has nothing to do with the code under test.
#
# The real build is from source, needs no toolchain pin, and now includes
# pixman and the final link:
#
#     bash tools/screen/build-cairo.sh
#     node tools/screen/run.mjs

echo "tools/screen/build.sh is retired - it linked the emscripten-forge prebuilts."
echo "Use instead:"
echo "    bash tools/screen/build-cairo.sh"
echo "    node tools/screen/run.mjs"
exit 1
