// Fengari access and the marshalling helpers everything else uses.
//
// Fengari is Lua 5.3 reimplemented in JavaScript (MIT). It is the runtime
// because norns is 5.3 and wasmoon is 5.4: E0 recorded that accepting the
// mismatch means a script using 5.4-only syntax works in the browser and then
// fails on hardware, which is the one failure mode this project exists to
// avoid. See research/lua-runtime.md.
//
// Fengari ships as CommonJS. A default import is still the right way in: both
// Vite and Vitest convert it, and `createRequire` — which the spike used —
// is a Node builtin that Vite externalises, so the page died on the first
// line with "Module node:module has been externalized for browser
// compatibility". The same file has to work in both places.

/* eslint-disable @typescript-eslint/no-explicit-any */
import fengariDefault from "fengari";

const fengari: any = fengariDefault;

export const lua = fengari.lua;
export const lauxlib = fengari.lauxlib;
export const lualib = fengari.lualib;
export const to_luastring: (s: string) => Uint8Array = fengari.to_luastring;

/** An opaque Fengari lua_State. */
export type LuaState = unknown;

/** The value types we move across the boundary. */
export type LuaValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | Uint8Array
  | LuaValue[]
  | { __luaTable: Record<string, LuaValue> };

/**
 * Push one JS value and return the number of Lua values pushed (always 1).
 *
 * `undefined` and `null` both push `nil`. That is deliberate: a stub that has
 * nothing to say should push nothing at all rather than nil, and the only way
 * to express that is to not call this function. See `pushReturns`.
 */
export function pushValue(L: LuaState, v: LuaValue): number {
  if (v === null || v === undefined) {
    lua.lua_pushnil(L);
  } else if (typeof v === "boolean") {
    lua.lua_pushboolean(L, v);
  } else if (typeof v === "number") {
    // Lua 5.3 distinguishes integers from floats, and so must we: `platform()`
    // returns an enum that is compared with `==`, and a float 1.0 is equal to
    // 1 in Lua, but `screen_peek`'s byte values and metro indices are indexed
    // with, so an accidental float there is a different key.
    if (Number.isInteger(v)) lua.lua_pushinteger(L, v);
    else lua.lua_pushnumber(L, v);
  } else if (typeof v === "string") {
    lua.lua_pushliteral ? lua.lua_pushstring(L, to_luastring(v)) : lua.lua_pushstring(L, to_luastring(v));
  } else if (v instanceof Uint8Array) {
    // A binary string, byte for byte. `screen_peek` returns exactly w*h bytes
    // valued 0-15; encoding that as UTF-8 text would corrupt every byte above
    // 0x7f, and `screen_poke` consumes the same format.
    lua.lua_pushstring(L, v);
  } else if (Array.isArray(v)) {
    lua.lua_createtable(L, v.length, 0);
    v.forEach((item, i) => {
      pushValue(L, item);
      lua.lua_seti(L, -2, i + 1); // Lua arrays are 1-based
    });
  } else if (typeof v === "object" && "__luaTable" in v) {
    const entries = Object.entries(v.__luaTable);
    lua.lua_createtable(L, 0, entries.length);
    for (const [k, item] of entries) {
      pushValue(L, item);
      lua.lua_setfield(L, -2, to_luastring(k));
    }
  } else {
    throw new TypeError(`cannot push ${typeof v} into Lua`);
  }
  return 1;
}

/**
 * Push a function's return values and give back the count for the C contract.
 *
 * An empty array pushes nothing and returns 0 — which is what 149 of the 178
 * bindings do, and the default this project insists on. Returning `0` the
 * *number* instead would be the `platform_factory` bug: in Lua, 0 is truthy.
 */
export function pushReturns(L: LuaState, values: readonly LuaValue[]): number {
  for (const v of values) pushValue(L, v);
  return values.length;
}

/** Read argument `i` (1-based, as Lua counts) as a JS value. */
export function readArg(L: LuaState, i: number): LuaValue {
  const t = lua.lua_type(L, i);
  switch (t) {
    case lua.LUA_TNIL:
    case lua.LUA_TNONE:
      return null;
    case lua.LUA_TBOOLEAN:
      return lua.lua_toboolean(L, i);
    case lua.LUA_TNUMBER:
      return lua.lua_tonumber(L, i);
    case lua.LUA_TSTRING:
      return lua.lua_tojsstring(L, i);
    case lua.LUA_TTABLE: {
      // Sequence part only. Every table argument in the 178 is a sequence:
      // midi_send's bytes, osc_send's {host, port} and its args.
      const n = lua.lua_rawlen(L, i);
      const out: LuaValue[] = [];
      for (let k = 1; k <= n; k++) {
        lua.lua_rawgeti(L, i, k);
        out.push(readArg(L, -1));
        lua.lua_pop(L, 1);
      }
      return out;
    }
    case lua.LUA_TLIGHTUSERDATA:
    case lua.LUA_TUSERDATA:
      // The opaque device handle. Lua only stores and returns it; we are free
      // to choose its representation but NOT to change it between
      // `_norns.<class>.add(...)` and use.
      return lua.lua_touserdata(L, i) as LuaValue;
    default:
      return null;
  }
}

/** Every argument the caller passed, as JS values. */
export function readArgs(L: LuaState): LuaValue[] {
  const n = lua.lua_gettop(L);
  const out: LuaValue[] = [];
  for (let i = 1; i <= n; i++) out.push(readArg(L, i));
  return out;
}

/** Run a chunk, returning an error message or null. */
export function doString(L: LuaState, code: string, chunkName = "=(norns-js)"): string | null {
  const status = lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring(chunkName));
  if (status !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    return err;
  }
  const call = lua.lua_pcall(L, 0, lua.LUA_MULTRET, 0);
  if (call !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    return err;
  }
  return null;
}
