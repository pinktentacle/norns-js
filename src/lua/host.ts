// E1-02 — the Lua host: a state with norns' own `lua/core` in it, unmodified.
//
// R-01 is "upstream `lua/core/*` runs **unmodified**", so nothing here patches
// a norns file. Everything norns expects from its environment is supplied
// around it instead: a module searcher, the `_norns` table, and the few pieces
// of the standard library Fengari does not ship.
//
// Sources are passed in as a map rather than read from disk, because the same
// host has to work in a browser where there is no filesystem. `loadNornsLua`
// in `host-node.ts` is the Node-side way to build that map.

import {
  lua,
  lauxlib,
  lualib,
  to_luastring,
  doString,
  type LuaState,
} from "./lua.js";
import { installNorns } from "../norns/install.js";
import { NornsRegistry } from "../norns/registry.js";
import { installVfsPrimitives, LUA_IO_PRELUDE } from "../fs/lua-io.js";
import { COMPAT_PRELOAD_LUA } from "./compat.js";
import type { Vfs } from "../fs/vfs.js";

/** `require` path prefixes, mirroring `core/config.lua`'s package.path. */
const PREFIXES = ["", "core/", "engine/", "core/params/", "lib/", "softcut/"];

export interface HostOptions {
  /** module name without `.lua` (e.g. `core/norns`) → source text. */
  readonly sources: ReadonlyMap<string, string>;
  /** Where `os.getenv("HOME")` points. norns hardcodes `/home/we`. */
  readonly home?: string;
  /** Receives everything Lua `print`s. */
  readonly onPrint?: (line: string) => void;
  readonly registry?: NornsRegistry;
  /**
   * The dust tree. Without one, `io.open` reports that nothing exists, which
   * norns handles as a first boot. With one, Lua gets a real `io` and
   * `loadfile` over it (E6-02).
   */
  readonly vfs?: Vfs;
  /**
   * A shell command a SCRIPT issued and the recogniser would not run.
   *
   * Separate from the registry's own `onRefused`, which covers the calls
   * norns core makes through `_norns.execute`. This is the other door — a
   * script's own `os.execute` and `io.popen` — and it used to be silent.
   */
  readonly onShellRefused?: (command: string, reason: string) => void;
  /** E9-37 — a `git clone`, `wget -O` or `curl -o` for the host to run. */
  readonly onShellFetch?: (fetch: { kind: "repo" | "file"; url: string; dest: string }) => void;
}

export interface Host {
  readonly L: LuaState;
  readonly registry: NornsRegistry;
  /** Run a chunk. Returns the Lua error message, or null. */
  run(code: string, chunkName?: string): string | null;
  /** Everything `print`ed so far. */
  readonly output: string[];
}

/** A Lua string literal, escaped so any byte survives being embedded. */
function luaStr(s: string): string {
  return (
    '"' +
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\0/g, "\\0") +
    '"'
  );
}

export function createHost(opts: HostOptions): Host {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  // A JS EXCEPTION INSIDE A LUA CALL MUST NOT BECOME THE NUMBER ZERO.
  //
  // fengari distinguishes an error raised through `luaD_throw` from a plain
  // JS `throw` that escapes a host function (`ldo.js:406`). With no
  // `atnativeerror` installed it cannot turn the second into an error
  // object, so `lj.status` stays `LUA_OK` and `pcall` returns
  // `false, 0` — the status code, as the message. The xpcall handler is
  // never called either, so there is no traceback.
  //
  // That is not a hypothetical: it cost an afternoon. A bug in one `_norns`
  // implementation surfaced as `norns.script.load` failing with the error
  // "0", from nowhere, on a different script each run. With this installed
  // the same bug reads as the JS message and a stack, which is the
  // difference between a fix and a shrug.
  lua.lua_atnativeerror(L, (S: LuaState): number => {
    const e = lua.lua_touserdata(S, 1) as unknown;
    const msg =
      e instanceof Error
        ? `${e.name}: ${e.message}`
        : `js error: ${String(e)}`;
    lua.lua_pushstring(S, to_luastring(msg));
    return 1;
  });

  const output: string[] = [];
  const registry = opts.registry ?? new NornsRegistry();

  // ---- the module searcher -------------------------------------------
  // norns `require`s by dotted name; config.lua sets package.path on hardware.
  // Here a searcher resolves against the injected sources, trying the same
  // prefixes config.lua lists, so `require('core/norns')` and
  // `require 'lib.util'` both work without touching the filesystem.
  const entries = [...opts.sources.entries()]
    .map(([name, src]) => `  [${luaStr(name)}] = ${luaStr(src)},`)
    .join("\n");

  const prelude = `
_NORNS_SRC = {
${entries}
}

-- package.cpath does not exist in fengari: there is no C loader to have a
-- path for. It still has to be a STRING, because scripts read it -- zxcvbn
-- line 25 calls string.find on it before appending its own entry, and
-- against nil that is an error in the main chunk, before the script has
-- done anything. Empty is the honest value: no C module will ever load,
-- and a search through no directories is what that looks like.
package.cpath = package.cpath or ''

local prefixes = { ${PREFIXES.map(luaStr).join(", ")} }
table.insert(package.searchers, 2, function(name)
  local n = name:gsub('%.', '/')
  for _, p in ipairs(prefixes) do
    local src = _NORNS_SRC[p .. n]
    if src then
      local chunk, err = load(src, '@' .. p .. n .. '.lua')
      if not chunk then error(err) end
      return chunk
    end
  end
  return '\\n\\tno injected source for ' .. name
end)
`;
  let err = doString(L, prelude, "=(norns-js prelude)");
  if (err) throw new Error(`prelude failed: ${err}`);

  // ---- print ----------------------------------------------------------
  lua.lua_pushcfunction(L, (S: LuaState) => {
    const n = lua.lua_gettop(S);
    const parts: string[] = [];
    for (let i = 1; i <= n; i++) {
      parts.push(lauxlib.luaL_tolstring(S, i, null) ? lua.lua_tojsstring(S, -1) : "");
      lua.lua_pop(S, 1);
    }
    const line = parts.join("\t");
    output.push(line);
    opts.onPrint?.(line);
    return 0;
  });
  lua.lua_setglobal(L, to_luastring("print"));

  // ---- the Lua 5.2 compatibility layer ----------------------------------
  //
  // `math.pow` is used **66 times** across norns and the community scripts,
  // and Lua 5.3 removed it. It works on hardware because norns' interpreter is
  // built with the standard `LUA_COMPAT_5_2` layer, which keeps these around;
  // Fengari implements 5.3 without it.
  //
  // So this is not a polyfill of something norns does not have — it is the
  // part of norns' own interpreter that Fengari leaves out, and without it
  // `core/controlspec.lua:32` raises and takes the whole boot gate with it.
  // Measured use across `lua/core` and the 35 community scripts: `math.pow`
  // 66, `math.log10` 4, `math.atan2` 1. The rest are here because they are
  // the same one-line definitions the C layer provides and a script that
  // reaches one should not meet a different failure from the same cause.
  err = doString(
    L,
    `
math.pow   = math.pow   or function(x, y) return x ^ y end
math.log10 = math.log10 or function(x) return math.log(x, 10) end
math.atan2 = math.atan2 or function(y, x) return math.atan(y, x) end
math.ldexp = math.ldexp or function(m, e) return m * (2.0 ^ e) end
math.cosh  = math.cosh  or function(x) return (math.exp(x) + math.exp(-x)) / 2 end
math.sinh  = math.sinh  or function(x) return (math.exp(x) - math.exp(-x)) / 2 end
math.tanh  = math.tanh  or function(x) return math.sinh(x) / math.cosh(x) end
math.frexp = math.frexp or function(x)
  if x == 0 then return 0.0, 0 end
  local e = math.floor(math.log(math.abs(x), 2)) + 1
  return x / (2.0 ^ e), e
end
`,
    "=(norns-js lua5.2 compat)",
  );
  if (err) throw new Error(`the 5.2 compat layer failed: ${err}`);

  // `bit32` and `cjson`: the rest of norns' Lua environment. See compat.ts.
  // They go in `package.preload` rather than into globals, because that is
  // where `require` looks first and it is what a script expects to be
  // requiring -- a global named `bit32` would be found by nothing.
  err = doString(L, COMPAT_PRELOAD_LUA, "=(norns-js bit32/cjson)");
  if (err) throw new Error(`bit32/cjson failed: ${err}`);

  // ---- collectgarbage ---------------------------------------------------
  //
  // Fengari raises "lua_gc not implemented". `core/script.lua:142` calls
  // `collectgarbage()` when a script is cleared, so without this the boot
  // gate dies there — after `math.pow`, the second thing between `/crone/ready`
  // and a running norns.
  //
  // JavaScript has no manual collector to drive, so "collect" and "step" can
  // only be no-ops; that is a real difference from hardware and is recorded
  // rather than hidden. "count" has to answer with a NUMBER, because
  // `norns.lua` formats it, and 0 is the honest unknown: `performance.memory`
  // is Chrome-only, unrelated to the Lua heap, and would be a worse lie than
  // zero.
  err = doString(
    L,
    `
_NORNS_GC_CALLS = 0
collectgarbage = function(opt, arg)
  _NORNS_GC_CALLS = _NORNS_GC_CALLS + 1
  opt = opt or 'collect'
  if opt == 'count' then return 0.0, 0 end
  if opt == 'isrunning' then return true end
  if opt == 'step' then return true end
  return 0
end
`,
    "=(norns-js gc)",
  );
  if (err) throw new Error(`the collectgarbage shim failed: ${err}`);

  // ---- os.getenv -------------------------------------------------------
  // norns reads HOME to build every path under ~/dust. Nothing else in
  // `lua/core` reads the environment.
  const home = opts.home ?? "/home/we";
  err = doString(
    L,
    `
local _getenv = os.getenv
os.getenv = function(k)
  if k == 'HOME' then return ${luaStr(home)} end
  return _getenv and _getenv(k) or nil
end
`,
    "=(norns-js env)",
  );
  if (err) throw new Error(`env shim failed: ${err}`);

  // ---- os.clock, os.tmpname --------------------------------------------
  //
  // E9-27. FENGARI'S `os.clock` IS `process.uptime()`, and a browser has no
  // `process`. It does not return a wrong number — it raises
  // `TypeError: process.uptime is not a function`, through Lua, as a crash:
  //
  //     ### SCRIPT ERROR: load fail
  //     TypeError: process.uptime is not a function
  //     [JS]: in function 'os.clock'
  //
  // found in `forge`, whose first line of `lib/test/luaunit.lua` calls it.
  // **Nineteen catalogue scripts call `os.clock`** (3d, QUENCE, Tetrabotis,
  // bounds, clockabout, combos, flora, midi-review, mosaic,
  // nameless-nightmare, nb_drumcrow, noize, noizeop, norns.online, otis,
  // randomizer_typhon, thirtythree, yggdrasil, zxcvbn) and every one of them
  // was one call away from that.
  //
  // WHAT IT NOW ANSWERS, and how that differs from hardware: C's `clock()`
  // is CPU time used by the process. There is no CPU-time clock in a
  // browser, so this is wall time — which is what fengari meant by `uptime`
  // too, and what a script measuring an elapsed interval wants. All
  // nineteen take a difference of two readings, and a difference is right.
  //
  // The zero is the FIRST CALL, not the boot, because `_norns` is installed
  // after this chunk runs and a baseline captured here would be epoch
  // seconds. An arbitrary origin is harmless: nothing can read a single
  // `os.clock()` and mean anything by it.
  //
  // `os.tmpname` is the other one fengari cannot do: it raises "unable to
  // generate a unique filename". One script wants it. A name under `/tmp`
  // costs nothing and the VFS is a real filesystem to `io.open`.
  err = doString(
    L,
    `
local _base = nil
os.clock = function()
  local s, u = _norns.get_time()
  local now = s + (u or 0) / 1000000
  if _base == nil then _base = now end
  return now - _base
end
local _tmp = 0
os.tmpname = function()
  _tmp = _tmp + 1
  return string.format('/tmp/lua_%06d', _tmp)
end
`,
    "=(norns-js clock)",
  );
  if (err) throw new Error(`the os.clock shim failed: ${err}`);

  // ---- io --------------------------------------------------------------
  // Fengari targets the browser: its io library has write/close/input/output
  // but **no open/read/lines**, and its `loadfile` reads through a Node `fs`
  // that is a shim here. Both are replaced.
  //
  // With a VFS, Lua gets a real `io.open` and `loadfile` over it (E6-02).
  // Without one, the old stub stands: every open reports "no such file",
  // which norns handles exactly as it handles a first boot on real hardware,
  // and `_NORNS_IO_STUBBED` counts how often that was reached.
  if (opts.vfs) {
    installVfsPrimitives(L, opts.vfs, opts.onShellRefused, opts.onShellFetch);
    err = doString(L, LUA_IO_PRELUDE, "=(norns-js io)");
    if (err) throw new Error(`io over the vfs failed: ${err}`);
    // The LAST entry of config.lua's package.path: `~/dust/code/?.lua`.
    //
    // Scripts use it constantly -- `require 'molly_the_poly/lib/..._engine'`
    // is how a script reaches its own lib directory, and ten of the bundled
    // thirty-five do exactly that -- but it only works once `loadfile` can
    // see the dust tree, so it is installed here rather than in the prelude.
    //
    // It goes AFTER the injected-source searcher, as it does on hardware: a
    // script directory called `lib` must not shadow `lua/lib`.
    err = doString(
      L,
      `
table.insert(package.searchers, 3, function(name)
  local n = name:gsub('%.', '/')
  local base = (_path and _path.code) or '/home/we/dust/code/'
  -- E9-46: AN ABSOLUTE MODULE NAME IS A PATH, not something to hang off
  -- the dust directory. \`bline/lib/classes/class_channel.lua:19\` does
  -- \`require\` on a full path, and every template in \`package.path\` then
  -- prefixes it -- \`/home/we/dust/code//home/we/dust/code/bline/...\` --
  -- so the script died in its main chunk with "module not found" and a
  -- page of paths that were all the same path with something in front.
  --
  -- Collapsing the double slash was tried first and is NOT the fix: it
  -- gives \`/home/we/dust/code/home/we/dust/...\`, which is concatenation
  -- with tidier punctuation. What the script asked for is the path it
  -- wrote.
  local p = n:sub(1, 1) == '/' and (n .. '.lua') or (base .. n .. '.lua')
  local chunk, e = loadfile(p)
  if chunk then return chunk end
  if e and not e:match('cannot open') and not e:match('no such file') then
    -- A syntax error in a file that EXISTS is not "module not found": say so
    -- here rather than letting require report every path it tried.
    error(e, 0)
  end
  return '\\n\\tno file ' .. p
end)
`,
      "=(norns-js dust searcher)",
    );
    if (err) throw new Error(`dust searcher failed: ${err}`);
  } else {
    err = doString(
      L,
      `
_NORNS_IO_STUBBED = 0
io = io or {}
io.open = function() _NORNS_IO_STUBBED = _NORNS_IO_STUBBED + 1 return nil, 'no filesystem (E6-01)' end
io.read = function() return nil end
io.lines = function() return function() return nil end end
io.close = io.close or function() end
`,
      "=(norns-js io)",
    );
    if (err) throw new Error(`io shim failed: ${err}`);
  }

  // ---- _norns ----------------------------------------------------------
  installNorns(L, registry);

  return {
    L,
    registry,
    output,
    run: (code: string, chunkName = "=(norns-js)") => doString(L, code, chunkName),
  };
}

/**
 * Bring norns up: config, the core module, then the two startup globals.
 *
 * Stops at the first error and returns it, so a caller can report which step
 * failed rather than a stack from somewhere inside `require`.
 */
/**
 * E9-27 — `include` gets a case-insensitive last try, in `~/dust/code` only.
 *
 * `startup.lua:52` resolves an include against three directories with the
 * name exactly as written. Our installer lower-cases the folder it creates
 * and maiden does not, so a script that builds its own include path from
 * something capitalised misses by case alone:
 *
 *     Ygg.lua:28  include(engine.name .. '/lib/gen_sequence')
 *     ### MISSING INCLUDE: Ygg/lib/gen_sequence
 *
 * (the engine is `Ygg`, the folder here is `ygg`.) One script in 354 does
 * this today, which is not a reason to rename every folder already on
 * somebody's disk — and renaming would only move the mismatch, since it is
 * really between two spellings neither of which is wrong.
 *
 * So the fix goes where the lookup is, as a LAST resort: everything exact
 * is tried first, exactly as before, and only a name that found nothing is
 * matched case-insensitively against the entries of `code/`. It fixes the
 * other direction too — a script whose folder is capitalised asking for a
 * lower-case path.
 *
 * It wraps rather than replaces, so the message on a genuine miss is still
 * startup.lua's own.
 */
const INCLUDE_CASE_FALLBACK = `
local _include = include
function include(file)
  local dirs = { norns.state.path, _path.code, _path.extn }
  for _, dir in ipairs(dirs) do
    if util.file_exists(dir .. file .. '.lua') then return _include(file) end
  end
  -- Nothing matched exactly. Try the first segment against code/, folded.
  local head, rest = string.match(file, '^([^/]+)(/.*)$')
  if head ~= nil then
    local want = string.lower(head)
    for _, entry in ipairs(util.scandir(_path.code) or {}) do
      local name = string.gsub(entry, '/$', '')
      if string.lower(name) == want and name ~= head then
        local p = _path.code .. name .. rest .. '.lua'
        if util.file_exists(p) then
          print('including ' .. p .. '  (matched ' .. head .. ' by case)')
          return dofile(p)
        end
      end
    end
  end
  return _include(file)
end
`;

/**
 * E9-55 — `norns.try` keeps its own `debug.traceback`, so that ONE script
 * cannot silence every error reported after it.
 *
 * `core/norns.lua:153` writes the message handler as
 *
 *     local handler = function (err) return err .. "\\n" .. debug.traceback() end
 *
 * and reads `debug` out of the globals every time it runs. Two scripts in
 * the catalogue assign to that name:
 *
 *     pitfalls/lib/functions.lua:6        debug = bool
 *     pirate-radio/pirate-radio.lua:24    debug=false
 *
 * `Script.clear` sandboxes a script's globals behind a `_G` metatable, but
 * `__newindex` only fires for a key `_G` does NOT already have, and `debug`
 * is a standard library that is always there — so the write lands in `_G`
 * itself and survives every later `Script.clear`. From the moment one of
 * those two runs, the handler indexes a boolean, the handler itself raises,
 * and Lua replaces the error with its own LUA_ERRERR string:
 *
 *     ### SCRIPT ERROR: init
 *     error in error handling
 *
 * No message, no file, no line, no traceback — for the rest of the session.
 * MEASURED: after `pitfalls` ran, eight scripts in a row reported exactly
 * that, and all eight named a real error (a missing file, a nil engine
 * command, a module that is not installed) the moment the handler stopped
 * reading the global. It is also what three of the five `load fail` rows in
 * the catalogue sweep were hiding.
 *
 * The fix is the smallest one that cannot be undone from Lua: capture
 * `debug.traceback` in an upvalue now, at boot, and `tostring` the error so
 * that an error OBJECT — a table, which norns' own `err .. "\\n"` cannot
 * concatenate either — prints as well. For a string error with the library
 * where it belongs the output is byte-for-byte what upstream prints.
 *
 * It does not restore the clobbered global. A script that writes `debug`
 * and reads it back still sees its own value, exactly as on hardware; what
 * changes is only that norns can still say what went wrong.
 */
const TRY_KEEPS_ITS_TRACEBACK = `
local traceback = debug.traceback
norns.try = function(f, msg)
  local handler = function (err) return tostring(err) .. "\\n" .. traceback() end
  local status, err = xpcall(f, handler)
  if not status then
    norns.scripterror(msg)
    print(err)
  end
  return status
end
`;

/**
 * E9-55 — `Script.clear` gives the next script its libraries back.
 *
 * The sandbox cannot hold a name that `_G` already has: `__newindex` fires
 * only for a key that is absent, so `debug = false` in one script's `init`
 * writes into `_G` and stays there for the session. The next script to
 * READ that library gets the boolean —
 *
 *     pitter-patter/lib/nb/lib/nb.lua:1
 *       local mydir = debug.getinfo(1).source:match(…)
 *       ### SCRIPT ERROR: load fail
 *       attempt to index a boolean value (global 'debug')
 *
 * — and `nb` is carried by a long list of scripts, so one `pitfalls` run
 * poisons all of them until the page is reloaded. MEASURED: that exact row
 * appeared in a twelve-script sweep purely because `pitfalls` ran third.
 *
 * This is upstream's own remedy, applied to one more name. `Script.clear`
 * already ends with
 *
 *     -- reset embedded modules
 *     json = _json
 *
 * because scripts clobber `json` and the next script must still have it;
 * the standard libraries are the same problem with a longer list. They are
 * taken from `package.loaded`, which a script cannot reach by assigning a
 * global, and restored BEFORE the rest of the clear runs — `Script.clear`
 * is itself written in `string`, `table` and `math`, and a script that took
 * one of those names would otherwise bring the reset down with it.
 *
 * It SAYS so, once per name per clear. A library coming back is a fact
 * about the script that just ran, and the script after it would otherwise
 * be the one that looked broken.
 */
const CLEAR_RESTORES_THE_LIBRARIES = `
local LIBS = { 'debug', 'string', 'table', 'math', 'io', 'os', 'coroutine', 'utf8' }
local _clear = norns.script.clear
norns.script.clear = function(...)
  for _, name in ipairs(LIBS) do
    local lib = package.loaded[name]
    if lib ~= nil and rawget(_G, name) ~= lib then
      rawset(_G, name, lib)
      print('# restored the ' .. name .. ' library, which the last script replaced')
    end
  end
  return _clear(...)
end
`;

export function boot(host: Host, configSource: string): { step: string; error: string } | null {
  const steps: Array<[string, string]> = [
    ["config.lua", configSource],
    ["require core/norns", `require('core/norns')`],
    // `norns.try` is defined by `core/norns`, and `_startup()` is already
    // run THROUGH it, so the replacement goes between the two.
    // The label is the CHUNK NAME, and this chunk's frame is the top line
    // of every script traceback norns prints, so it is kept short and says
    // where it comes from rather than what it is for.
    ["norns-js try", TRY_KEEPS_ITS_TRACEBACK],
    ["norns-js clear", CLEAR_RESTORES_THE_LIBRARIES],
    ["_startup()", `_startup()`],
    // `include` is defined by `_startup()`, so the wrapper cannot go any
    // earlier than this.
    ["include case fallback", INCLUDE_CASE_FALLBACK],
    ["_post_startup()", `_post_startup()`],
  ];
  for (const [step, code] of steps) {
    const e = host.run(code, `=(${step})`);
    if (e) return { step, error: e };
  }
  return null;
}
