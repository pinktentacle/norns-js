// E9-117 — PUC Lua 5.3 in wasm, wearing fengari's interface.
//
// `src/lua/lua.ts` is the only file in the project that knew which Lua this
// was; sixteen others import `lua`, `lauxlib`, `lualib` and `to_luastring`
// from it and use forty-eight names between them. So the port is this file:
// the same forty-eight, over the real interpreter.
//
// WHY AT ALL. `docs/13-CPU.md` measured `n.kria` at 152-214 ms/s — 60-85% of
// a phone's core — with 95% of it in the interpreter rather than in our code
// or the audio engine. `spike/lua-vm/` then measured the replacement against
// that number: 18.8x on the same function, 7.4x on `clock.resume`, 19x on
// `string.format`, 14x at the boundary, every coroutine check passing. And
// it is Lua 5.3, which is what ADR-02 exists for — fengari was chosen in E0
// BECAUSE it is 5.3 and wasmoon is 5.4, and that reason survives the change.
//
// WHAT IS DIFFERENT, and every caller has to be read with it in mind:
//
//   * STRINGS ARE BYTES IN A HEAP, not JavaScript strings. `to_luastring`
//     used to make a Uint8Array fengari held onto; here it copies into wasm
//     memory and the copy has to be freed. Everything that takes one does
//     that itself, so callers are unchanged — but a caller that held the
//     result and reused it would now be holding a freed pointer, and none
//     do.
//   * A HOST FUNCTION IS A TABLE INDEX. `lua_pushcfunction` registers the
//     JavaScript function with emscripten and pushes the index as a C
//     function pointer. The registration is permanent: these are installed
//     once at boot (178 of them) and live as long as the page.
//   * A JAVASCRIPT THROW BECOMES A LUA ERROR, here rather than through
//     fengari's `lua_atnativeerror`. The wrapper catches it and calls
//     `njs_raise`, which longjmps to the enclosing pcall. Without that a
//     throw unwinds through wasm and takes the module with it.
//   * INTEGERS ARE REAL. fengari needed `patches/fengari.patch` to carry
//     64-bit integers; 5.3's are native.

/* eslint-disable @typescript-eslint/no-explicit-any */
import luaFactory from "./lua53/lua53.mjs";

type Ptr = number;

interface LuaModule {
  _malloc(n: number): Ptr;
  _free(p: Ptr): void;
  addFunction(f: (...a: any[]) => any, sig: string): number;
  UTF8ToString(p: Ptr, max?: number): string;
  stringToUTF8(s: string, p: Ptr, max: number): void;
  lengthBytesUTF8(s: string): number;
  HEAPU8: Uint8Array;
  [k: string]: any;
}

let M: LuaModule | null = null;

/**
 * Bring the interpreter up. Must be awaited once before anything else.
 *
 * Asynchronous because instantiating wasm is: `WebAssembly.instantiate` is
 * the only form browsers will take for a module this size off the main
 * thread's critical path. fengari needed no such call, so this is the one
 * line every entry point gains — `main.ts` has it before `createHost`, and
 * the tests that build a state have it in a `beforeAll`.
 */
export async function initLua(): Promise<void> {
  if (M) return;
  M = (await (luaFactory as unknown as () => Promise<LuaModule>)()) as LuaModule;
}

/** True once `initLua` has resolved. */
export function luaReady(): boolean {
  return M !== null;
}

function mod(): LuaModule {
  if (!M) {
    throw new Error(
      "Lua is not up yet: await initLua() before creating a state. " +
        "(fengari needed no such call; wasm instantiation is asynchronous.)",
    );
  }
  return M;
}

// --------------------------------------------------------------- strings
//
// `to_luastring` is the project's name for "turn this into whatever the
// interpreter wants". For fengari that was a Uint8Array; here it is a
// pointer into the wasm heap, and the functions below free what they are
// given. A `LuaString` is therefore a value with an owner, and the owner is
// always the call it is passed to.

/** A NUL-terminated copy of `s` in wasm memory. The caller frees it. */
function cstr(s: string): Ptr {
  const m = mod();
  const n = m.lengthBytesUTF8(s) + 1;
  const p = m._malloc(n);
  m.stringToUTF8(s, p, n);
  return p;
}

/** Bytes in wasm memory, with their length. For binary strings. */
function cbytes(b: Uint8Array): { p: Ptr; n: number } {
  const m = mod();
  const p = m._malloc(b.length + 1);
  m.HEAPU8.set(b, p);
  m.HEAPU8[p + b.length] = 0;
  return { p, n: b.length };
}

/**
 * What callers pass where fengari wanted a `Uint8Array`.
 *
 * Kept as the JavaScript string: every consumer below converts at the point
 * of use, which is the only place that knows whether the copy can be freed
 * immediately. Returning a pointer here would make the caller the owner,
 * and 175 call sites would each have to free it.
 */
export function to_luastring(s: string): any {
  return s;
}

/** A string or a Uint8Array, as the callers of `lua_pushstring` pass. */
type Stringish = string | Uint8Array | any;

// ---------------------------------------------------------------- the API

/** An opaque lua_State. A pointer, but nothing outside here may assume it. */
export type LuaState = unknown;

const LUA_OK = 0;
const LUA_MULTRET = -1;
const LUA_REGISTRYINDEX = -1001000; // LUAI_MAXSTACK is 1000000 in 5.3

/**
 * Host functions, kept alive for the life of the page.
 *
 * `addFunction` grows the wasm table and never shrinks it; nothing here is
 * ever unregistered because the bindings are installed once at boot and
 * norns has no way to remove one. MEASURED rather than assumed, because
 * "it only happens at boot" is exactly the kind of claim that is true
 * until a script load makes it false: 187 after boot, and still 187 after
 * thirty load-and-clear cycles of a script, with the wasm heap flat at
 * its initial 16 MB throughout.
 */
const installed: Array<(L: Ptr) => number> = [];

export const lua = {
  LUA_OK,
  LUA_MULTRET,
  LUA_REGISTRYINDEX,
  LUA_TNONE: -1,
  LUA_TNIL: 0,
  LUA_TBOOLEAN: 1,
  LUA_TLIGHTUSERDATA: 2,
  LUA_TNUMBER: 3,
  LUA_TSTRING: 4,
  LUA_TTABLE: 5,
  LUA_TFUNCTION: 6,
  LUA_TUSERDATA: 7,
  LUA_TTHREAD: 8,

  // --- stack ------------------------------------------------------------
  lua_gettop: (L: LuaState): number => mod()._lua_gettop(L as Ptr),
  lua_settop: (L: LuaState, i: number): void => void mod()._lua_settop(L as Ptr, i),
  /** `lua_pop` is a macro over `lua_settop`; lua.h:343. */
  lua_pop: (L: LuaState, n: number): void => void mod()._lua_settop(L as Ptr, -n - 1),
  lua_pushvalue: (L: LuaState, i: number): void => void mod()._lua_pushvalue(L as Ptr, i),
  /** `lua_remove` is `lua_rotate` then `lua_pop`; lua.h:346. */
  lua_remove: (L: LuaState, i: number): void => {
    const m = mod();
    m._lua_rotate(L as Ptr, i, -1);
    m._lua_settop(L as Ptr, -2);
  },

  // --- reading ----------------------------------------------------------
  lua_type: (L: LuaState, i: number): number => mod()._lua_type(L as Ptr, i),
  lua_toboolean: (L: LuaState, i: number): boolean => mod()._lua_toboolean(L as Ptr, i) !== 0,
  /** `lua_tonumber` is `lua_tonumberx(L, i, NULL)`; lua.h:331. */
  lua_tonumber: (L: LuaState, i: number): number => mod()._lua_tonumberx(L as Ptr, i, 0),
  /**
   * E9-117 — 64-BIT MEANS BIGINT AT THE BOUNDARY.
   *
   * `lua_Integer` is `long long`, and emscripten maps a 64-bit parameter or
   * return to a JavaScript BigInt. fengari had no such seam — it carried
   * 64-bit integers in a pair of JS numbers and needed
   * `patches/fengari.patch` to do it — so this conversion is new, and it
   * is the one thing in this file a caller could trip over by passing a
   * float where Lua wants an integer.
   *
   * Everything norns pushes as an integer is small; `Number` and `BigInt`
   * are exact either way below 2^53, and nothing here is near it.
   */
  lua_tointeger: (L: LuaState, i: number): number =>
    Number(mod()._lua_tointegerx(L as Ptr, i, 0)),
  lua_rawlen: (L: LuaState, i: number): number => mod()._njs_rawlen(L as Ptr, i),
  lua_touserdata: (L: LuaState, i: number): unknown => mod()._lua_touserdata(L as Ptr, i),
  /**
   * The value at `i` as a JavaScript string.
   *
   * Two calls rather than one with an out-parameter: `lua_tolstring` returns
   * the length through a `size_t *`, and allocating a cell for it on every
   * read is the cost this avoids. The value stays on the stack between them.
   */
  lua_tojsstring: (L: LuaState, i: number): string => {
    const m = mod();
    const n = m._njs_tostring_len(L as Ptr, i);
    if (n < 0) return "";
    const p = m._njs_tostring_ptr(L as Ptr, i);
    return m.UTF8ToString(p, n);
  },

  // --- pushing ----------------------------------------------------------
  lua_pushnil: (L: LuaState): void => void mod()._lua_pushnil(L as Ptr),
  lua_pushboolean: (L: LuaState, b: boolean): void =>
    void mod()._lua_pushboolean(L as Ptr, b ? 1 : 0),
  lua_pushnumber: (L: LuaState, n: number): void => void mod()._lua_pushnumber(L as Ptr, n),
  lua_pushinteger: (L: LuaState, n: number): void =>
    void mod()._lua_pushinteger(L as Ptr, BigInt(Math.trunc(n))),
  lua_pushlightuserdata: (L: LuaState, p: number): void =>
    void mod()._lua_pushlightuserdata(L as Ptr, p),
  /**
   * A string, which may be bytes.
   *
   * `screen_peek` hands back w*h bytes valued 0-15 and `screen_poke` eats the
   * same, so this must not go through UTF-8. A Uint8Array is copied raw with
   * its length; a JavaScript string is encoded.
   */
  lua_pushstring: (L: LuaState, s: Stringish): void => {
    const m = mod();
    if (s instanceof Uint8Array) {
      const { p, n } = cbytes(s);
      m._lua_pushlstring(L as Ptr, p, n);
      m._free(p);
      return;
    }
    const p = cstr(String(s));
    m._lua_pushstring(L as Ptr, p);
    m._free(p);
  },
  lua_pushliteral: (L: LuaState, s: string): void => lua.lua_pushstring(L, s),
  /**
   * A JavaScript function Lua can call.
   *
   * The throw-to-error conversion lives here. fengari had
   * `lua_atnativeerror` for it; without the equivalent a JS exception
   * unwinds through wasm and aborts the module, where `host.ts` wants a
   * catchable message — see the comment there about an error that read
   * "0", from nowhere.
   */
  lua_pushcfunction: (L: LuaState, fn: (S: LuaState) => number): void => {
    const m = mod();
    const wrapped = (S: Ptr): number => {
      try {
        return fn(S);
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : `js error: ${String(e)}`;
        const p = cstr(msg);
        // Does not return: njs_raise longjmps to the enclosing pcall. The
        // pointer is deliberately not freed — freeing it would be dead code
        // after the jump, and it is one allocation per crash.
        m._njs_raise(S, p);
        return 0;
      }
    };
    installed.push(wrapped as (L: Ptr) => number);
    const idx = m.addFunction(wrapped, "ii");
    m._lua_pushcclosure(L as Ptr, idx, 0);
  },

  // --- tables -----------------------------------------------------------
  lua_createtable: (L: LuaState, narr: number, nrec: number): void =>
    void mod()._lua_createtable(L as Ptr, narr, nrec),
  lua_getglobal: (L: LuaState, k: Stringish): number => {
    const m = mod();
    const p = cstr(String(k));
    const t = m._lua_getglobal(L as Ptr, p);
    m._free(p);
    return t;
  },
  lua_setglobal: (L: LuaState, k: Stringish): void => {
    const m = mod();
    const p = cstr(String(k));
    m._lua_setglobal(L as Ptr, p);
    m._free(p);
  },
  lua_getfield: (L: LuaState, i: number, k: Stringish): number => {
    const m = mod();
    const p = cstr(String(k));
    const t = m._lua_getfield(L as Ptr, i, p);
    m._free(p);
    return t;
  },
  lua_setfield: (L: LuaState, i: number, k: Stringish): void => {
    const m = mod();
    const p = cstr(String(k));
    m._lua_setfield(L as Ptr, i, p);
    m._free(p);
  },
  lua_rawgeti: (L: LuaState, i: number, n: number): number =>
    mod()._lua_rawgeti(L as Ptr, i, BigInt(Math.trunc(n))),
  lua_seti: (L: LuaState, i: number, n: number): void =>
    void mod()._lua_seti(L as Ptr, i, BigInt(Math.trunc(n))),
  lua_setmetatable: (L: LuaState, i: number): number => mod()._lua_setmetatable(L as Ptr, i),

  // --- calling ----------------------------------------------------------
  /** `lua_pcall` is `lua_pcallk(L, na, nr, ef, 0, NULL)`; lua.h:275. */
  lua_pcall: (L: LuaState, na: number, nr: number, ef: number): number =>
    mod()._lua_pcallk(L as Ptr, na, nr, ef, 0, 0),
  lua_error: (L: LuaState): number => mod()._lua_error(L as Ptr),

  /**
   * fengari's hook for a JavaScript throw escaping a host function.
   *
   * Kept as a no-op that records nothing, because the conversion happens in
   * `lua_pushcfunction` above where the throw actually is. `host.ts` still
   * calls this; leaving it defined keeps that file the same in both.
   */
  lua_atnativeerror: (_L: LuaState, _fn: unknown): void => {},
};

export const lauxlib = {
  luaL_newstate: (): LuaState => {
    const L = mod()._njs_newstate();
    if (!L) throw new Error("luaL_newstate returned null (out of memory?)");
    return L;
  },
  /** `luaL_loadbuffer` is `luaL_loadbufferx` with mode NULL; lauxlib.h:138. */
  luaL_loadbuffer: (L: LuaState, code: Stringish, _sz: unknown, name: Stringish): number => {
    const m = mod();
    const isBytes = code instanceof Uint8Array;
    const { p, n } = isBytes ? cbytes(code) : { p: cstr(String(code)), n: 0 };
    const len = isBytes ? n : m.lengthBytesUTF8(String(code));
    const np = cstr(String(name));
    const rc = m._njs_loadbuffer(L as Ptr, p, len, np);
    m._free(p);
    m._free(np);
    return rc;
  },
  luaL_ref: (L: LuaState, t: number): number => mod()._luaL_ref(L as Ptr, t),
  luaL_unref: (L: LuaState, t: number, ref: number): void =>
    void mod()._luaL_unref(L as Ptr, t, ref),
  /**
   * The value at `i` as a string, PUSHED ON THE STACK and also returned.
   *
   * Leaving it there is not a convenience, it is the C contract
   * (`lauxlib.c`: it pushes the result and returns the pointer), and
   * `host.ts`'s `print` depends on it exactly:
   *
   *     parts.push(luaL_tolstring(S, i, null) ? lua_tojsstring(S, -1) : "");
   *     lua_pop(S, 1);
   *
   * The first draft of this popped it here as well. `print(42)` still
   * worked, because the number was converted before the damage; `print(nil)`
   * and `print(true)` came out empty and `print(1, true)` lost its second
   * argument, because the `lua_pop` that follows was then taking something
   * else off the stack. Four tests in `integers.test.ts` caught it.
   */
  luaL_tolstring: (L: LuaState, i: number, _len: unknown): string => {
    const m = mod();
    const p = m._njs_tolstring_any(L as Ptr, i);
    return m.UTF8ToString(p);
  },
  /**
   * Raise a formatted error.
   *
   * The project calls this with an already-built message, so no formatting
   * is done: `%` in a script's own text would otherwise be read as a
   * directive by `luaL_error` and the message would be about the wrong
   * thing.
   */
  luaL_error: (L: LuaState, msg: Stringish): number => {
    const m = mod();
    const p = cstr(String(msg));
    m._njs_raise(L as Ptr, p);
    return 0;
  },
};

export const lualib = {
  /** `njs_newstate` already opened them; doing it twice is harmless but idle. */
  luaL_openlibs: (_L: LuaState): void => {},
};

/** Which interpreter this is, for the about panel and the boot log. */
/** Bytes of wasm memory the interpreter holds. Zero before it is up. E9-200. */
export function luaHeapBytes(): number {
  return M?.HEAPU8.length ?? 0;
}

export function luaVersion(): string {
  return mod().UTF8ToString(mod()._njs_version());
}
