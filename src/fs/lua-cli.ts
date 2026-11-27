// E9-276 — `lua`, the command: a standalone Lua 5.3, as a process.
//
// Two catalogue scripts hand their real work to it. makebreakbeat runs
//
//   lua /home/we/dust/code/makebreakbeat/lib/dnb.lua … -o <file> &
//
// and sampswap runs `cd …/sampswap/lib/ && lua sampswap.lua … &`. Each is a
// long program that shells out to sox a hundred times, writes a progress
// file the script reads back with `tail -n1`, and ends by writing a WAV. On
// a norns that is a second process; here it is a second lua_State in the
// interpreter matron already uses (src/lua/wasm53.ts) — the same PUC Lua
// 5.3, so what runs is the program as written, not a reading of it.
//
// WHAT A PROCESS HAS, and this gives it:
//
//   * its own globals and the standard libraries, `arg` as lua.c builds it
//     (arg[0] the script, arg[1…] its arguments, the interpreter and its
//     options at negative indices), and the arguments as `...` too;
//   * a working directory: a leading `cd X &&` on the line, else /home/we.
//     Relative paths in its own `io.open` and in every command it runs are
//     read from there (vfs.ts `withCwd`);
//   * stdout: `print`, `io.write`, `io.stdout` and the output of what it runs
//     with `os.execute`. A foreground run returns it, as `util.os_capture`
//     wants; a background one sends it to the log line by line, which is
//     where a child of matron's writes on a norns (maiden's REPL). `> file`
//     and `>> file` send it to a file instead;
//   * the page's files, through the same `io` the matron prelude gives
//     scripts (lua-io.ts), but byte for byte;
//   * `os.exit`, `os.getenv` (HOME, USER, PATH, PWD), `os.tmpname`, and
//     `require` that finds modules in the page's files.
//
// AND IT DOES NOT HOLD THE PAGE. A real process runs beside matron; a lua
// state here runs on the page's only thread. So the program runs inside a
// coroutine, and `os.execute` and `io.popen` YIELD to the driver below,
// which carries the command out and resumes it. In the background (`&`)
// the driver gives the page its turn between commands, and `sleep 0.1` —
// sampswap polls a file that way — is a timer, not a busy loop. Each sox
// run is still synchronous, as every command here is; the page stops for
// that long, and not for the whole program.
//
// What it cannot be is interrupted in the middle of pure Lua: a background
// program that loops without ever running a command would hold the page,
// because nothing can stop a wasm call from outside. Neither catalogue
// program does; a foreground run is stopped after ten seconds and says so.

import { lua, lauxlib, luaReady, luaVersion, pushValue, readArg, type LuaState, type LuaValue } from "../lua/lua.js";
import { LUA_IO_PRELUDE } from "./lua-io.js";
import { normalise, withCwd, basename, type Vfs } from "./vfs.js";
import { runShell, type ShellResult } from "./shell.js";

/** What programs.ts lends a run: its process table and the log. */
export interface LuaProcessHost {
  spawn(name: string, cmdline: string, stop: () => void): number;
  exit(pid: number): void;
  log(line: string): void;
}

/** A foreground run is stopped after this long: it holds the page meanwhile. */
let FOREGROUND_MS = 10_000;

/** For tests: a shorter limit, or null for the real one. */
export function setLuaForegroundLimit(ms: number | null): void {
  FOREGROUND_MS = ms ?? 10_000;
}
/** A background run gives the page its turn after this much work. */
const SLICE_MS = 12;

interface Run {
  readonly vfs: Vfs;
  readonly cwd: string;
  /** arg[0], for messages. */
  readonly script: string;
  readonly background: boolean;
  readonly redirect: { path: string; append: boolean } | null;
  /** What a `>>` redirect's file held before the run. */
  readonly redirectBase: string;
  readonly host: LuaProcessHost;
  L: LuaState | null;
  /** Standard output not yet handed on. */
  out: string;
  /** All of it, when it goes to a file. */
  written: string;
  err: string;
  done: boolean;
  code: number;
  /** os.exit was called where it could not yield: the run ends at the next return. */
  exitCode: number | null;
  /** Inside one of its own steps right now: closing the state must wait. */
  inside: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  pid: number | null;
  readonly refused: Set<string>;
}

let current: Run | null = null;

function cur(): Run {
  if (current === null) throw new Error("no lua process is running");
  return current;
}

function str(S: LuaState, i: number): string {
  const t = lua.lua_type(S, i);
  return t === lua.LUA_TSTRING || t === lua.LUA_TNUMBER ? lua.lua_tojsstring(S, i) : "";
}

/** A path as the process names it, made absolute from its directory. */
function at(r: Run, p: string): string {
  return withCwd(r.cwd, () => normalise(p, r.vfs.home));
}

const decoder = new TextDecoder();

// --- stdout and stderr ---------------------------------------------------------

/** Escape sequences are for a terminal; the log is not one (dnb.lua clears the screen). */
const plain = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][A-Za-z0-9]/g, "");

function emit(r: Run, text: string): void {
  if (text === "") return;
  r.out += text;
  if (r.redirect !== null) r.written += text;
  if (r.background) flush(r, false);
}

/** Hand complete lines on: to the redirect's file, or to the log. */
function flush(r: Run, all: boolean): void {
  if (r.redirect !== null) {
    writeRedirect(r);
    r.out = "";
    return;
  }
  if (!r.background) return;
  let nl = r.out.lastIndexOf("\n");
  if (all && r.out !== "") nl = r.out.length;
  if (nl < 0) return;
  const lines = r.out.slice(0, nl).split("\n");
  r.out = r.out.slice(nl + 1);
  for (const line of lines) {
    const p = plain(line).replace(/\r/g, "");
    if (p.trim() !== "") r.host.log(p);
  }
}

/** The file holds what was there (for `>>`) and everything written since. */
function writeRedirect(r: Run): void {
  r.vfs.write(r.redirect!.path, r.redirectBase + r.written);
}

/** stderr goes to the log in either mode, as a child's stderr does on a norns. */
function emitErr(r: Run, text: string): void {
  r.err += text;
  for (const line of plain(text).split("\n")) if (line.trim() !== "") r.host.log(line);
}

// --- what the process runs -------------------------------------------------------

interface Ran {
  readonly ok: boolean;
  readonly code: number;
  readonly out: string;
  /** `sleep N`: how long the process asked to wait. */
  readonly sleepMs?: number;
}

function execute(r: Run, cmd: string): Ran {
  const sl = /^\s*sleep\s+(\d*\.?\d+)\s*$/.exec(cmd);
  if (sl !== null) return { ok: true, code: 0, out: "", sleepMs: Number(sl[1]) * 1000 };
  let res: ShellResult;
  try {
    res = withCwd(r.cwd, () => runShell(r.vfs, cmd));
  } catch (e) {
    refuse(r, cmd, (e as Error).message);
    return { ok: false, code: 1, out: "" };
  }
  if (res.fetch !== undefined || res.request !== undefined || res.more !== undefined) {
    refuse(r, cmd, "a download or a network reply, which a lua process here does not start");
    return { ok: false, code: 1, out: res.out };
  }
  if (!res.ok && res.failed !== true) {
    refuse(r, cmd, res.refused ?? "unsupported");
    // What sh says for a command it cannot run.
    return { ok: false, code: 127, out: res.out };
  }
  return { ok: res.ok, code: res.ok ? 0 : 1, out: res.out };
}

/** Once per run and reason: sampswap asks the same thing a hundred times. */
function refuse(r: Run, cmd: string, why: string): void {
  const head = cmd.trim().split(/\s+/)[0] ?? cmd;
  const key = `${head}\u0000${why}`;
  if (r.refused.has(key)) return;
  r.refused.add(key);
  r.host.log(`lua ${basename(r.script)}: ${head}: ${why}`);
}

// --- host functions ----------------------------------------------------------------
//
// Module constants, so that every run's state gets the same table slots
// (wasm53.ts reuses a function's index when it is pushed again). Each finds
// its run through `current`, which the driver sets around every step.

const H: Record<string, (S: LuaState) => number> = {
  _vfs_read: (S) => {
    const r = cur();
    const b = r.vfs.read(at(r, str(S, 1)));
    if (b === null) return 0;
    lua.lua_pushstring(S, b);
    return 1;
  },
  _vfs_write: (S) => {
    const r = cur();
    r.vfs.write(at(r, str(S, 1)), lua.lua_tobytes(S, 2) ?? new Uint8Array(0));
    lua.lua_pushboolean(S, true);
    return 1;
  },
  _vfs_exists: (S) => {
    const r = cur();
    lua.lua_pushboolean(S, r.vfs.exists(at(r, str(S, 1))));
    return 1;
  },
  _vfs_isdir: (S) => {
    const r = cur();
    lua.lua_pushboolean(S, r.vfs.isDir(at(r, str(S, 1))));
    return 1;
  },
  _vfs_declared: (S) => {
    const r = cur();
    lua.lua_pushboolean(S, r.vfs.remoteAt(at(r, str(S, 1))) !== null);
    return 1;
  },
  _vfs_remove: (S) => {
    const r = cur();
    lua.lua_pushboolean(S, r.vfs.remove(at(r, str(S, 1))));
    return 1;
  },
  _vfs_rename: (S) => {
    const r = cur();
    const from = at(r, str(S, 1));
    const to = at(r, str(S, 2));
    const data = r.vfs.read(from);
    if (data === null) {
      lua.lua_pushboolean(S, false);
      return 1;
    }
    r.vfs.write(to, data);
    r.vfs.remove(from);
    lua.lua_pushboolean(S, true);
    return 1;
  },
  _cli_out: (S) => {
    const b = lua.lua_tobytes(S, 1);
    if (b !== null) emit(cur(), decoder.decode(b));
    return 0;
  },
  _cli_err: (S) => {
    const b = lua.lua_tobytes(S, 1);
    if (b !== null) emitErr(cur(), decoder.decode(b));
    return 0;
  },
  /** os.execute where it cannot yield (inside a coroutine of the program's own). */
  _cli_shell: (S) => {
    const r = cur();
    const x = execute(r, str(S, 1));
    emit(r, x.out);
    lua.lua_pushboolean(S, x.ok);
    lua.lua_pushinteger(S, x.code);
    return 2;
  },
  _cli_popen: (S) => {
    const x = execute(cur(), str(S, 1));
    lua.lua_pushstring(S, x.out);
    return 1;
  },
  _cli_exit: (S) => {
    const r = cur();
    r.exitCode = lua.lua_tointeger(S, 1);
    return 0;
  },
  _cli_tmpname: (S) => {
    const r = cur();
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let name = "";
    do {
      name = "/tmp/lua_";
      for (let i = 0; i < 6; i++) name += chars[Math.floor(Math.random() * chars.length)];
    } while (r.vfs.exists(name));
    // mkstemp makes the file, which is what keeps the name from being taken.
    r.vfs.write(name, "");
    lua.lua_pushstring(S, name);
    return 1;
  },
};

// --- the process, in Lua --------------------------------------------------------------
//
// Appended to LUA_IO_PRELUDE in ONE chunk, so `File` (local there) is in
// scope for io.popen. No backticks in here: this is a template literal.
const CLI_PRELUDE = `
local out, err = _cli_out, _cli_err
local main = nil

local function yieldable()
  return main ~= nil and coroutine.running() == main and coroutine.isyieldable()
end

print = function(...)
  local t = {}
  for i = 1, select('#', ...) do t[i] = tostring((select(i, ...))) end
  out(table.concat(t, '\\t') .. '\\n')
end

local function pieces(where, ...)
  local t = {}
  for i = 1, select('#', ...) do
    local v = select(i, ...)
    local k = type(v)
    if k ~= 'string' and k ~= 'number' then
      error(string.format("bad argument #%d to '%s' (string expected, got %s)", i, where, k), 3)
    end
    t[i] = tostring(v)
  end
  return table.concat(t)
end

local Std = {}
Std.__index = Std
function Std:write(...) self.sink(pieces('write', ...)) return self end
function Std:flush() return self end
function Std:setvbuf() return true end
function Std:close() return nil, 'cannot close standard file' end
function Std:read() return nil end
function Std:lines() return function() return nil end end
function Std:seek() return nil, 'Illegal seek', 29 end
io.stdout = setmetatable({ sink = out }, Std)
io.stderr = setmetatable({ sink = err }, Std)
io.stdin = setmetatable({ sink = function() end }, Std)

io.write = function(...)
  if _io_default_out == nil then out(pieces('write', ...)) return io.stdout end
  return _io_default_out:write(...)
end

os.execute = function(cmd)
  if cmd == nil then return true end
  local ok, code
  if yieldable() then ok, code = coroutine.yield('exec', cmd)
  else ok, code = _cli_shell(cmd) end
  if ok then return true, 'exit', 0 end
  return nil, 'exit', code or 1
end

io.popen = function(cmd, mode)
  mode = mode or 'r'
  if mode:find('w') then
    return nil, 'io.popen for writing: there is no stdin to give a command here'
  end
  local data
  if yieldable() then data = coroutine.yield('popen', cmd) else data = _cli_popen(cmd) end
  return setmetatable({ path = nil, data = data or '', pos = 1, mode = 'r', buf = {} }, File)
end

os.exit = function(code)
  local c = 0
  if code == false then c = 1
  elseif type(code) == 'number' then c = math.tointeger(code) or 1 end
  if yieldable() then coroutine.yield('exit', c) end
  _cli_exit(c)
  error('os.exit', 0)
end

local env = _cli_env
_cli_env = nil
os.getenv = function(name) return env[name] end
os.tmpname = function() return _cli_tmpname() end

-- require, from the page's files. The C searchers stay: they look for a .so
-- and find none, which is the answer.
package.searchers[2] = function(name)
  local p = name:gsub('%.', '/')
  local tried = {}
  for template in package.path:gmatch('[^;]+') do
    local f = template:gsub('%?', p)
    local src = _vfs_read(f)
    if src ~= nil then
      local chunk, e = load(src, '@' .. f)
      if not chunk then
        error(string.format("error loading module '%s' from file '%s':\\n\\t%s", name, f, e), 2)
      end
      return chunk, f
    end
    tried[#tried + 1] = "\\n\\tno file '" .. f .. "'"
  end
  return table.concat(tried)
end

-- A load failure is reported without a traceback, as lua.c reports it.
local LoadError = {}
LoadError.__tostring = function(e) return e.msg end

function _cli_start(steps, script, ...)
  local args = table.pack(...)
  main = coroutine.create(function()
    for _, s in ipairs(steps) do
      if s[1] == 'e' then
        local f, e = load(s[2], '=(command line)')
        if not f then error(setmetatable({ msg = e }, LoadError)) end
        f()
      else
        _G[s[2]] = require(s[2])
      end
    end
    if script ~= nil then
      local src = _vfs_read(script)
      if src == nil then error(setmetatable({ msg = 'cannot open ' .. script }, LoadError)) end
      -- luaL_loadfile skips a first line that starts with '#' (a shebang),
      -- keeping its newline so the line numbers stay true.
      if src:sub(1, 1) == '#' then src = src:gsub('^[^\\n]*', '', 1) end
      local f, e = load(src, '@' .. script)
      if not f then error(setmetatable({ msg = e }, LoadError)) end
      f(table.unpack(args, 1, args.n))
    end
  end)
end

function _cli_step(...)
  local r = table.pack(coroutine.resume(main, ...))
  if not r[1] then
    local e = r[2]
    if getmetatable(e) == LoadError then return 'error', e.msg end
    local msg
    if type(e) == 'string' or type(e) == 'number' then msg = tostring(e)
    else
      local mt = getmetatable(e)
      if mt and mt.__tostring then msg = tostring(e)
      else msg = '(error object is a ' .. type(e) .. ' value)' end
    end
    return 'error', debug.traceback(main, msg)
  end
  if coroutine.status(main) == 'dead' then return 'done' end
  return table.unpack(r, 2, r.n)
end
`;

// --- the command line ------------------------------------------------------------------

const USAGE =
  "usage: lua [options] [script [args]]\n" +
  "Available options are:\n" +
  "  -e stat  execute string 'stat'\n" +
  "  -i       enter interactive mode after executing 'script'\n" +
  "  -l name  require library 'name'\n" +
  "  -v       show version information\n" +
  "  -E       ignore environment variables\n" +
  "  --       stop handling options\n" +
  "  -        stop handling options and execute stdin\n";

interface Parsed {
  steps: Array<["e" | "l", string]>;
  script: string | null;
  args: string[];
  /** Everything before the script, for arg's negative indices. */
  pre: string[];
  version: boolean;
  interactive: boolean;
  stdin: boolean;
  error?: string;
}

function parse(argv: readonly string[]): Parsed {
  const p: Parsed = { steps: [], script: null, args: [], pre: [], version: false, interactive: false, stdin: false };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) break;
    if (a === "--") {
      p.pre.push(a);
      i++;
      break;
    }
    if (a === "-") {
      p.stdin = true;
      break;
    }
    const o = a[1];
    if (o === "e" || o === "l") {
      const v = a.length > 2 ? a.slice(2) : argv[++i];
      if (v === undefined) return { ...p, error: `'${a}' needs argument` };
      p.pre.push(a);
      if (a.length === 2) p.pre.push(v);
      p.steps.push([o, v]);
      continue;
    }
    if (a === "-v") p.version = true;
    else if (a === "-i") p.interactive = true;
    else if (a === "-E") {
      /* there is no LUA_INIT to ignore */
    } else return { ...p, error: `unrecognized option '${a}'` };
    p.pre.push(a);
  }
  if (!p.stdin && i < argv.length) {
    p.script = argv[i]!;
    p.args = argv.slice(i + 1);
  }
  return p;
}

/** `> file`, `>> file`, `>file`, `1> file`: where stdout goes instead. */
function takeRedirect(argv: readonly string[], cwd: string, home: string): { argv: string[]; redirect: Run["redirect"] } {
  const rest: string[] = [];
  let redirect: Run["redirect"] = null;
  for (let i = 0; i < argv.length; i++) {
    const m = /^1?(>>?)(.*)$/.exec(argv[i]!);
    if (m === null) {
      rest.push(argv[i]!);
      continue;
    }
    const target = m[2] !== "" ? m[2]! : argv[++i];
    if (target === undefined) break;
    redirect = { path: withCwd(cwd, () => normalise(target, home)), append: m[1] === ">>" };
  }
  return { argv: rest, redirect };
}

// --- the driver -----------------------------------------------------------------------

type Request = { kind: "done" } | { kind: "error"; msg: string } | { kind: "exit"; code: number } | { kind: "exec" | "popen"; cmd: string };

function step(r: Run, reply: readonly LuaValue[]): Request {
  const L = r.L!;
  const prev = current;
  current = r;
  r.inside = true;
  try {
    const base = lua.lua_gettop(L);
    lua.lua_getglobal(L, "_cli_step");
    for (const v of reply) pushValue(L, v);
    const status = lua.lua_pcall(L, reply.length, lua.LUA_MULTRET, 0);
    if (status !== lua.LUA_OK) {
      const msg = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, base);
      return { kind: "error", msg };
    }
    const kind = String(readArg(L, base + 1) ?? "done");
    const a = readArg(L, base + 2);
    lua.lua_settop(L, base);
    if (r.exitCode !== null) return { kind: "exit", code: r.exitCode };
    switch (kind) {
      case "error":
        return { kind: "error", msg: String(a ?? "") };
      case "exit":
        return { kind: "exit", code: Number(a ?? 0) | 0 };
      case "exec":
      case "popen":
        return { kind, cmd: String(a ?? "") };
      default:
        return { kind: "done" };
    }
  } finally {
    r.inside = false;
    current = prev;
    // It was killed from inside this step (a program that pkills itself):
    // the state could not be closed then, and can now.
    if (r.done && r.L !== null) {
      lua.lua_close(r.L);
      r.L = null;
    }
  }
}

function finish(r: Run, code: number): void {
  if (r.done) return;
  r.done = true;
  r.code = code;
  if (r.timer !== null) clearTimeout(r.timer);
  r.timer = null;
  flush(r, true);
  if (r.L !== null && !r.inside) {
    lua.lua_close(r.L);
    r.L = null;
  }
  if (r.pid !== null) r.host.exit(r.pid);
}

/**
 * Carry out one request and say what to resume with. A sleep comes back as
 * a wait: the foreground does not wait (nothing else could happen meanwhile),
 * the background waits on a timer.
 */
function carry(r: Run, q: Request): { reply: LuaValue[]; waitMs: number } | null {
  switch (q.kind) {
    case "done":
      finish(r, 0);
      return null;
    case "exit":
      finish(r, q.code);
      return null;
    case "error":
      emitErr(r, `lua: ${q.msg}\n`);
      finish(r, 1);
      return null;
    case "exec": {
      const x = execute(r, q.cmd);
      emit(r, x.out);
      return { reply: [x.ok, x.code], waitMs: x.sleepMs ?? 0 };
    }
    case "popen": {
      const x = execute(r, q.cmd);
      return { reply: [x.out], waitMs: x.sleepMs ?? 0 };
    }
  }
}

function pump(r: Run, reply: LuaValue[]): void {
  r.timer = null;
  const t0 = performance.now();
  let next: LuaValue[] = reply;
  while (!r.done) {
    const c = carry(r, step(r, next));
    if (c === null || r.done) return;
    next = c.reply;
    if (c.waitMs > 0) {
      r.timer = setTimeout(() => pump(r, next), c.waitMs);
      return;
    }
    if (performance.now() - t0 > SLICE_MS) {
      r.timer = setTimeout(() => pump(r, next), 0);
      return;
    }
  }
}

/** Make the state and load the program into its coroutine. Null and a message when it cannot start. */
function start(r: Run, p: Parsed): string | null {
  const L = lauxlib.luaL_newstate();
  r.L = L;
  const prev = current;
  current = r;
  try {
    for (const [name, fn] of Object.entries(H)) {
      lua.lua_pushcfunction(L, fn);
      lua.lua_setglobal(L, name);
    }
    pushValue(L, {
      __luaTable: {
        HOME: r.vfs.home,
        USER: "we",
        LOGNAME: "we",
        SHELL: "/bin/bash",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        PWD: r.cwd,
        LANG: "en_GB.UTF-8",
      },
    });
    lua.lua_setglobal(L, "_cli_env");
    const prelude = lauxlib.luaL_loadbuffer(L, LUA_IO_PRELUDE + CLI_PRELUDE, null, "=(lua)");
    if (prelude !== lua.LUA_OK || lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
      const msg = lua.lua_tojsstring(L, -1);
      return `lua: the process could not be set up: ${msg}`;
    }
    // arg, as lua.c's createargtable: the script at 0, what came before it
    // below, its arguments above. With no script, the interpreter is at 0.
    const all = ["lua", ...p.pre, ...(p.script !== null ? [p.script, ...p.args] : [])];
    const zero = p.script !== null ? p.pre.length + 1 : 0;
    lua.lua_createtable(L, Math.max(0, all.length - zero - 1), zero + 1);
    all.forEach((a, k) => {
      lua.lua_pushstring(L, a);
      lua.lua_seti(L, -2, k - zero);
    });
    lua.lua_setglobal(L, "arg");

    lua.lua_getglobal(L, "_cli_start");
    lua.lua_createtable(L, p.steps.length, 0);
    p.steps.forEach(([k, v], n) => {
      pushValue(L, [k, v]);
      lua.lua_seti(L, -2, n + 1);
    });
    pushValue(L, p.script);
    for (const a of p.args) pushValue(L, a);
    if (lua.lua_pcall(L, 2 + p.args.length, 0, 0) !== lua.LUA_OK) {
      return `lua: ${lua.lua_tojsstring(L, -1)}`;
    }
    return null;
  } finally {
    current = prev;
  }
}

/**
 * `lua [options] [script [args]]`. `cmdline` is the whole line, for `ps` and
 * `pkill -f`; the working directory is the one the shell has right now.
 */
export function luaCommand(
  vfs: Vfs,
  argvIn: readonly string[],
  background: boolean,
  cmdline: string,
  cwd: string,
  host: LuaProcessHost,
): ShellResult {
  if (!luaReady()) return { out: "", ok: false, refused: "lua: the interpreter is not up yet" };
  const { argv, redirect } = takeRedirect(argvIn, cwd, vfs.home);
  const p = parse(argv);
  const fail = (why: string): ShellResult => {
    for (const line of why.split("\n")) if (line.trim() !== "") host.log(line);
    return { out: "", ok: false, failed: true };
  };
  if (p.error !== undefined) return fail(`lua: ${p.error}\n${USAGE}`);
  const version = `${luaVersion()}  Copyright (C) 1994-2020 Lua.org, PUC-Rio\n`;
  if (p.interactive) {
    return { out: "", ok: false, refused: "lua -i: the interactive interpreter needs a terminal, and there is none here" };
  }
  if (p.stdin) {
    return { out: "", ok: false, refused: "lua -: a program from stdin needs a pipe, and there is none here" };
  }
  if (p.script === null && p.steps.length === 0) {
    if (p.version) return { out: version, ok: true };
    return { out: "", ok: false, refused: "lua: a program from stdin needs a terminal or a pipe, and neither is here" };
  }
  const r: Run = {
    vfs,
    cwd,
    script: p.script ?? "lua",
    background,
    redirect,
    redirectBase: redirect !== null && redirect.append ? (vfs.readText(redirect.path) ?? "") : "",
    host,
    L: null,
    out: p.version ? version : "",
    written: p.version && redirect !== null ? version : "",
    err: "",
    done: false,
    code: 0,
    exitCode: null,
    inside: false,
    timer: null,
    pid: null,
    refused: new Set(),
  };
  const bad = start(r, p);
  if (bad !== null) {
    finish(r, 1);
    return fail(bad);
  }

  if (background) {
    r.pid = host.spawn("lua", cmdline, () => {
      // pkill: the run ends where it is. From inside its own step (a program
      // that kills itself) the state is closed once that step returns.
      const inside = r.inside;
      r.done = true;
      if (r.timer !== null) clearTimeout(r.timer);
      r.timer = null;
      if (r.L !== null && !inside) {
        lua.lua_close(r.L);
        r.L = null;
      }
    });
    if (r.out !== "") flush(r, false);
    r.timer = setTimeout(() => pump(r, []), 0);
    return { out: "", ok: true };
  }

  // The foreground: to the end, here and now.
  const t0 = performance.now();
  let reply: LuaValue[] = [];
  while (!r.done) {
    if (performance.now() - t0 > FOREGROUND_MS) {
      emitErr(r, `lua: ${basename(r.script)} was stopped after ${FOREGROUND_MS / 1000} s: a lua run without & holds the whole page, and nothing it waits for can happen meanwhile\n`);
      finish(r, 1);
      break;
    }
    const c = carry(r, step(r, reply));
    if (c === null) break;
    reply = c.reply;
  }
  if (r.redirect !== null) writeRedirect(r);
  const out = r.redirect !== null ? "" : r.out;
  // Its stderr is in the log already.
  return r.code !== 0 ? { out, ok: false, failed: true } : { out, ok: true };
}
