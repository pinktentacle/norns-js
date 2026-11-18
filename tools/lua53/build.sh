#!/usr/bin/env bash
# E9-117 — PUC Lua 5.3 to wasm. The interpreter norns runs, in the browser.
#
#   bash tools/lua53/build.sh            build if the source is there
#   bash tools/lua53/build.sh clean      and start from nothing
#
# Writes `src/lua/lua53/lua53.mjs` and `.wasm`, which `src/lua/wasm53.ts`
# imports. In `src/` rather than `public/` because it is 233 KB that the page
# cannot start without: a fetch for it would be one more round trip in front
# of the first frame, and E9-106 spent a commit taking those out.
#
# WHY, when fengari works: `docs/13-CPU.md` measured n.kria at 152-214 ms/s,
# 60-85% of a phone's core, and found 95% of it to be the interpreter.
# E9-114/115/116 spiked the replacement against that number and got 18.8x on
# the same function, 7.4x on `clock.resume`, 19x on `string.format`, with
# every coroutine check passing. And it is 5.3, which is what ADR-02 is for.
#
# Source and hash live in `PINS.md`, with the other upstreams.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMSDK_P="$ROOT/third_party/emsdk"
SRC="$ROOT/third_party/lua53/src"
OUT="$ROOT/src/lua/lua53"
VERSION="5.3.6"
SHA256="fc5fd69bb8736323f026672b1b7235da613d7177e72558893a0bdcd320466d60"
URL="https://www.lua.org/ftp/lua-$VERSION.tar.gz"

[ "${1:-}" = "clean" ] && rm -rf "$OUT" "$ROOT/third_party/lua53"

# --- the source -------------------------------------------------------------
# Fetched here rather than by `tools/fetch-third-party.ps1` because it is one
# tarball with one hash and no patches, and because a build that can fetch its
# own source is a build somebody can run without reading a runbook first.
if [ ! -d "$SRC" ]; then
  echo "fetching $URL"
  mkdir -p "$ROOT/third_party/lua53-dl"
  curl -sSL -o "$ROOT/third_party/lua53-dl/lua.tar.gz" "$URL" || { echo "download failed"; exit 1; }
  got="$(sha256sum "$ROOT/third_party/lua53-dl/lua.tar.gz" | cut -d' ' -f1)"
  if [ "$got" != "$SHA256" ]; then
    echo "sha256 mismatch:"
    echo "  wanted $SHA256"
    echo "  got    $got"
    exit 1
  fi
  mkdir -p "$ROOT/third_party/lua53"
  tar -xzf "$ROOT/third_party/lua53-dl/lua.tar.gz" -C "$ROOT/third_party/lua53" --strip-components=1
  rm -rf "$ROOT/third_party/lua53-dl"
fi
[ -d "$SRC" ] || { echo "no source at $SRC"; exit 1; }

# --- emscripten -------------------------------------------------------------
w() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
export EM_CONFIG="$(w "$EMSDK_P/.emscripten")"
export EMSDK="$(w "$EMSDK_P")"
export MSYS2_ARG_CONV_EXCL="*"

EMCC=""
for c in emcc.bat emcc.exe emcc; do
  [ -f "$EMSDK_P/upstream/emscripten/$c" ] && { EMCC="$EMSDK_P/upstream/emscripten/$c"; break; }
done
[ -z "$EMCC" ] && { echo "no emcc under $EMSDK_P — see docs/12-PUBLISHING.md §0.6"; exit 1; }
echo "emsdk : $(cat "$EMSDK_P/upstream/emscripten/emscripten-version.txt" 2>/dev/null)"
echo "lua   : $VERSION"

if [ -f "$OUT/lua53.wasm" ] && [ "${1:-}" != "clean" ]; then
  echo "already built: $OUT/lua53.wasm — pass 'clean' to rebuild"
  exit 0
fi
mkdir -p "$OUT"

# Every .c but the two mains: `lua.c` is the standalone interpreter and
# `luac.c` the bytecode compiler. Neither belongs in a library.
FILES=()
for f in "$SRC"/*.c; do
  b="$(basename "$f")"
  [ "$b" = "lua.c" ] && continue
  [ "$b" = "luac.c" ] && continue
  FILES+=("$(w "$f")")
done

# THE EXPORT LIST IS THE API, and it is short on purpose: `src/lua/wasm53.ts`
# rebuilds the macros over these, where a reader can check each one against
# lua.h. Everything prefixed `njs_` is from `shim.c` and is there because it
# needs C — see that file.
EXPORTS="_malloc,_free"
EXPORTS="$EXPORTS,_njs_newstate,_njs_raise,_njs_loadbuffer,_njs_tostring_len,_njs_tostring_ptr"
EXPORTS="$EXPORTS,_njs_rawlen,_njs_tolstring_any,_njs_version"
EXPORTS="$EXPORTS,_lua_close,_lua_settop,_lua_gettop,_lua_pushvalue,_lua_rotate,_lua_type"
EXPORTS="$EXPORTS,_lua_toboolean,_lua_tonumberx,_lua_tointegerx,_lua_touserdata"
EXPORTS="$EXPORTS,_lua_pushnil,_lua_pushnumber,_lua_pushinteger,_lua_pushlstring,_lua_pushstring"
EXPORTS="$EXPORTS,_lua_pushboolean,_lua_pushcclosure,_lua_pushlightuserdata"
EXPORTS="$EXPORTS,_lua_getglobal,_lua_gettable,_lua_getfield,_lua_rawgeti,_lua_createtable"
EXPORTS="$EXPORTS,_lua_setglobal,_lua_settable,_lua_setfield,_lua_seti,_lua_rawseti"
EXPORTS="$EXPORTS,_lua_setmetatable,_lua_pcallk,_lua_callk,_lua_error,_lua_next"
EXPORTS="$EXPORTS,_luaL_ref,_luaL_unref,_luaL_openlibs,_luaL_newstate,_luaL_loadbufferx"

"$EMCC" \
  -O3 \
  -DLUA_USE_POSIX \
  -I"$(w "$SRC")" \
  "${FILES[@]}" \
  "$(w "$ROOT/tools/lua53/shim.c")" \
  -o "$(w "$OUT/lua53.mjs")" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=node,web,worker \
  -sALLOW_TABLE_GROWTH=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=16MB \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,addFunction,removeFunction,UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  2>&1 | tail -12

if [ -f "$OUT/lua53.wasm" ] && [ -f "$OUT/lua53.mjs" ]; then
  echo
  echo "built : $(du -h "$OUT/lua53.wasm" | cut -f1) wasm, $(du -h "$OUT/lua53.mjs" | cut -f1) glue"
  echo "        -> $OUT"
else
  echo "build FAILED: no $OUT/lua53.wasm"
  exit 1
fi
