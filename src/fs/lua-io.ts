// E6-02 — `io.open` and `loadfile`, over the virtual filesystem.
//
// Implemented in LUA on top of four JS primitives, rather than in JavaScript
// against the interpreter's own C-level `liolib`. That is the smaller and the
// more honest choice, and E9-117 only sharpened it — `liolib` is now real C
// inside a wasm module rather than fengari's JavaScript:
//
//   * that io is a file-descriptor implementation either way. Replacing it
//     means reimplementing its FILE userdata, its metatable, its buffering and
//     its `__gc`. Replacing `io.open` in Lua means a table with five methods.
//   * norns uses exactly five operations across `lua/core` — `io.open`,
//     `:read`, `:write`, `:lines`, `:close`, plus `:seek("end")` for
//     `util.file_size`. Measured, not assumed.
//   * Lua is synchronous and so is the VFS. Going through JS would still be
//     synchronous, so nothing is gained by the longer route.
//
// `loadfile` is overridden for the same reason: fengari's reads through `fs`,
// which in a browser is a shim, and its failure mode confused a whole boot —
// a throw of the wrong shape became a Lua error whose entire message was a
// filename.

import { lua, to_luastring, readArgs, pushValue, type LuaState } from "../lua/lua.js";
import type { Vfs } from "./vfs.js";
import { runShell, type ShellFetch } from "./shell.js";
import type { NetReplies } from "./net-replies.js";

/** Install `_vfs_*` as globals. The Lua prelude below is written against them. */
export function installVfsPrimitives(
  L: LuaState,
  vfs: Vfs,
  onShellRefused?: (command: string, reason: string) => void,
  /**
   * E9-37 — a download the shell recognised and cannot do itself.
   *
   * Handed up rather than attempted here: this call is synchronous and a
   * download is not. The host starts it; the script is told, through the
   * refusal beside this, that the files are not there YET.
   */
  onShellFetch?: (fetch: ShellFetch) => void,
  /** E9-203 — where a `curl` whose output is being read goes to be answered. */
  net?: NetReplies,
): void {
  const fn = (name: string, impl: (args: unknown[]) => unknown): void => {
    lua.lua_pushcfunction(L, (S: LuaState) => {
      const out = impl(readArgs(S) as unknown[]);
      if (out === undefined) return 0;
      pushValue(S, out as never);
      return 1;
    });
    lua.lua_setglobal(L, to_luastring(name));
  };

  fn("_vfs_read", (a) => vfs.readText(String(a[0] ?? "")) ?? undefined);
  fn("_vfs_write", (a) => {
    vfs.write(String(a[0] ?? ""), String(a[1] ?? ""));
    return true;
  });
  fn("_vfs_exists", (a) => vfs.exists(String(a[0] ?? "")));
  fn("_vfs_isdir", (a) => vfs.isDir(String(a[0] ?? "")));
  /**
   * The file is DECLARED and its bytes have not arrived.
   *
   * A sound file a script ships is fetched the first time something plays
   * it, so between the manifest and the first note it exists without being
   * readable. `util.file_exists` is nothing but an `io.open`, so without
   * this it answered FALSE about a file sitting right there — and a script
   * guarding its own work with it did nothing, in silence.
   */
  fn("_vfs_declared", (a) => vfs.remoteAt(String(a[0] ?? "")) !== null);
  fn("_vfs_remove", (a) => vfs.remove(String(a[0] ?? "")));
  /**
   * Move a file, BYTES AND ALL.
   *
   * `os.rename` could have been written in the prelude as read-then-write,
   * and `_vfs_read` hands Lua a STRING: a `.wav` round-tripped through one
   * comes back damaged. Twelve scripts call `os.rename`, several of them on
   * a recording. So the move happens here, where the bytes are bytes.
   *
   * The source is dropped only once the destination holds it, so a failure
   * leaves the original where it was.
   */
  fn("_vfs_rename", (a) => {
    const from = String(a[0] ?? "");
    const to = String(a[1] ?? "");
    const data = vfs.read(from);
    if (data === null) return false;
    vfs.write(to, data);
    vfs.remove(from);
    return true;
  });

  // THE SHELL LUA'S OWN `os.execute` AND `io.popen` REACH.
  //
  // fengari implements both through Node's `child_process`, which a browser
  // does not have — the failure is `child_process.execSync is not a
  // function`, thrown from inside the script that called it, naming nothing
  // useful. `amen` hits it in its `init`, at
  // `os.execute("mkdir -p " .. _path.audio .. "amen")`.
  //
  // The same interpreter `_norns.system_cmd` and `_norns.execute` use
  // (src/fs/shell.ts): a small set of commands run against the VFS, and
  // anything else refused by name. A script that shells out for `mkdir` or
  // `cp` gets what it asked for; one that shells out for `nmcli` is refused.
  //
  // AND THE REFUSAL IS REPORTED, which this did not do and the comment here
  // used to claim it did — "a refusal it can see". The only thing a script
  // could see was a false return value, and nothing was written anywhere at
  // all. `_norns.execute` has always reported; this is the door a SCRIPT's
  // own `os.execute` comes through, and it was the silent one.
  //
  // What that silence cost, measured: `amenbreak` checks for a native
  // SuperCollider extension with `test -n "$(find …)"`, which cannot be
  // answered here, then "installs" it with
  // `wget … && tar … && sudo rsync …`, which cannot be run here, and then
  // asks for a restart. All three refusals were invisible, so the script sat
  // on "please restart norns." for ever and the page had nothing to say
  // about why — it looked like SYSTEM > RESTART was broken.
  fn("_vfs_shell", (a) => {
    const cmd = String(a[0] ?? "");
    const r = runShell(vfs, cmd);
    // E9-203 — a reply the caller wants to READ (`io.popen`, which says so
    // with its second argument; `os.execute` throws the output away and
    // has nothing to wait for). A third value is the token to wait on.
    if (r.request !== undefined && a[1] === true && net !== undefined) {
      const ready = net.take(cmd);
      if (ready !== null) return [ready, true] as unknown;
      return ["", false, net.start(cmd, r.request)] as unknown;
    }
    if (r.fetch !== undefined) onShellFetch?.(r.fetch);
    for (const f of r.more ?? []) onShellFetch?.(f);
    if (!r.ok && r.failed !== true) onShellRefused?.(cmd, r.refused ?? "unsupported");
    // Two values: the output, and whether it ran. Lua's `os.execute` wants a
    // boolean and `io.popen` wants the text, and they are the same call.
    return [r.out, r.ok] as unknown;
  });
  fn("_vfs_net_poll", (a) => {
    const p = net?.poll(Number(a[0])) ?? { done: true, body: "" };
    return [p.body, p.done] as unknown;
  });
  fn("_vfs_net_leave", (a) => {
    net?.leave(Number(a[0]));
    return true;
  });
}

/**
 * Lua-side `io`, `loadfile` and `dofile`.
 *
 * Files are strings in memory. A read handle keeps a position; a write handle
 * accumulates and flushes on `close`, which is what `tabutil.save` and every
 * PSET write expect — they write many small pieces and close once.
 */
export const LUA_IO_PRELUDE = `
local function split_lines(s)
  local out, pos = {}, 1
  while pos <= #s do
    local nl = s:find('\\n', pos, true)
    if nl then out[#out+1] = s:sub(pos, nl - 1); pos = nl + 1
    else out[#out+1] = s:sub(pos); pos = #s + 1 end
  end
  return out
end

local File = {}
File.__index = File

function File:read(...)
  -- EISDIR: the open succeeded, the read does not.
  if self.isdir then return nil, self.path .. ': Is a directory', 21 end
  -- The file exists and its bytes have not been fetched. Sound files are
  -- read by softcut and the engine, which fetch; a Lua read of one is a
  -- script doing something no norns script needs to, and it gets a reason
  -- rather than an empty string.
  if self.pending then
    return nil, self.path .. ': not fetched yet (sound files load through softcut)', 11
  end
  if self.mode ~= 'r' then return nil end
  local fmts = {...}
  if #fmts == 0 then fmts = {'l'} end
  local results = {}
  for i, fmt in ipairs(fmts) do
    if type(fmt) == 'number' then
      if self.pos > #self.data then results[i] = nil
      else
        results[i] = self.data:sub(self.pos, self.pos + fmt - 1)
        self.pos = self.pos + fmt
      end
    else
      -- ONE CHARACTER OF THE FORMAT, which is what Lua reads. liolib.c's
      -- g_read skips an optional '*' and then switches on the single byte
      -- that follows, so '*a' and '*all' are the same format and always
      -- have been -- '*all' is the Lua 5.1 spelling and it is still the
      -- commoner one in the catalogue. Matching the whole string meant
      -- '*all' fell through to the line branch: pirate-radio read the
      -- FIRST LINE of its station list, '{', and cjson said
      --
      --     Expected value at character 2 of 1
      --
      -- which names neither the file nor the read. Thirteen uses across
      -- seven of the fifty-two scripts installed here (amen, mx.samples,
      -- oooooo, pirate-radio, pitter-patter, ygg, zxcvbn).
      fmt = tostring(fmt):gsub('^%*', ''):sub(1, 1)
      if fmt == 'a' then
        results[i] = self.data:sub(self.pos)
        self.pos = #self.data + 1
      elseif fmt == 'n' then
        local num = self.data:match('^%s*(-?%d+%.?%d*)', self.pos)
        if num then self.pos = self.pos + #num; results[i] = tonumber(num) end
      else -- 'l' or 'L'
        if self.pos > #self.data then results[i] = nil
        else
          local nl = self.data:find('\\n', self.pos, true)
          local stop = nl and (nl - 1) or #self.data
          results[i] = self.data:sub(self.pos, fmt == 'L' and (nl or #self.data) or stop)
          self.pos = (nl or #self.data) + 1
        end
      end
    end
  end
  return table.unpack(results, 1, #fmts)
end

function File:write(...)
  if self.mode == 'r' and not self.update then return nil, 'file opened for reading' end
  for _, v in ipairs({...}) do self.buf[#self.buf+1] = tostring(v) end
  return self
end

function File:lines(...)
  local fmt = ... or 'l'
  return function() return self:read(fmt) end
end

-- util.file_size does f:seek("end"), which returns the resulting position.
function File:seek(whence, offset)
  whence, offset = whence or 'cur', offset or 0
  if whence == 'set' then self.pos = offset + 1
  elseif whence == 'cur' then self.pos = self.pos + offset
  elseif whence == 'end' then self.pos = #self.data + 1 + offset end
  return self.pos - 1
end

function File:close()
  if (self.mode ~= 'r' or self.update) and self.path then
    _vfs_write(self.path, table.concat(self.buf))
  end
  self.closed = true
  return true
end

io = io or {}

io.open = function(path, mode)
  mode = (mode or 'r'):gsub('b', '')
  -- THE UPDATE MODES ARE NOT OPTIONAL. core/state.lua:108 opens
  -- system.state with "w+", and refusing it meant io.open returned nil, the
  -- io.output(nil) that followed left the default stream where it was, and
  -- every io.write in save_state went to the LOG. norns' system state --
  -- the vport bindings, the mixer, the clock source -- has been printed
  -- rather than written for as long as this file has existed.
  --
  -- The + is "also the other direction". Mapped rather than implemented
  -- in full: this File reads from data and writes into buf, so a handle
  -- that interleaves the two would need them to be one buffer. Nothing in
  -- norns or the 35 bundled scripts interleaves -- measured -- so the
  -- faithful-enough reading is that w+ truncates and writes, a+ appends,
  -- and r+ reads from a file that must already exist.
  local update = mode:find('%+') ~= nil
  mode = mode:gsub('%+', '')
  if mode == 'r' then
    local data = _vfs_read(path)
    if data == nil then
      -- A DIRECTORY OPENS. On Linux fopen(dir, 'r') succeeds and the first
      -- read fails with EISDIR, so util.file_exists -- which is nothing but
      -- an io.open -- answers TRUE for a directory. Scripts rely on it:
      -- cheat_codes_2 line 15 tests for its bundled nb by opening
      -- .../nb/lib/, and a host where that opens nil sends the script into
      -- its dependency-missing fail state with every file present.
      if _vfs_isdir(path) then
        return setmetatable(
          { path = path, data = '', pos = 1, mode = 'r', buf = {}, isdir = true }, File)
      end
      -- A DECLARED FILE OPENS, for the same reason a directory does: it is
      -- THERE. Its bytes arrive the first time something plays it, and
      -- until then io.open is the only thing that would call it missing.
      -- The open succeeds and the READ fails, which is the honest pair --
      -- the alternative, empty data, would hand a reader silence and call
      -- it the file's contents.
      if _vfs_declared(path) then
        return setmetatable(
          { path = path, data = '', pos = 1, mode = 'r', buf = {}, pending = true }, File)
      end
      return nil, path .. ': No such file or directory', 2
    end
    -- r+ keeps the contents readable AND lets writes through; a write then
    -- replaces the file on close, which is what every r+ caller in norns
    -- does with it.
    return setmetatable(
      { path = path, data = data, pos = 1, mode = 'r', update = update, buf = { data } }, File)
  elseif mode == 'w' or mode == 'a' then
    local existing = mode == 'a' and (_vfs_read(path) or '') or ''
    return setmetatable(
      { path = path, data = existing, pos = 1, mode = mode, buf = { existing } }, File)
  end
  return nil, 'unsupported mode: ' .. mode
end

io.lines = function(path, fmt)
  local f, err = io.open(path, 'r')
  if not f then error(err) end
  return function()
    local line = f:read(fmt or 'l')
    if line == nil then f:close() end
    return line
  end
end

io.close = function(f)
  if f then return f:close() end
  if _io_default_out then return _io_default_out:close() end
  return true
end

-- The DEFAULT STREAMS: io.input, io.output, and the io.read / io.write that
-- go through them.
--
-- These are not an extra: norns reads two files this way and only this way --
-- the version file at core/norns.lua:178, and pset-last.txt at
-- core/script.lua:205 -- and both do io.input(f) then io.read(). fengari's
-- own io.input survives being left in place and then fails with "FILE*
-- expected, got table" the first time it is handed one of the File tables
-- above, which is a confusing way to learn that a version file exists.
--
-- io.read with no current input returns nil rather than reading a terminal.
-- There is no stdin here, and a script that blocks waiting for one would
-- hang the only thread the page has.
_io_default_in = nil
_io_default_out = nil

io.input = function(f)
  if f == nil then return _io_default_in end
  if type(f) == 'string' then
    local h, err = io.open(f, 'r')
    if not h then error(err, 2) end
    _io_default_in = h
  else
    _io_default_in = f
  end
  return _io_default_in
end

io.output = function(f)
  if f == nil then return _io_default_out end
  if type(f) == 'string' then
    local h, err = io.open(f, 'w')
    if not h then error(err, 2) end
    _io_default_out = h
  else
    _io_default_out = f
  end
  return _io_default_out
end

io.read = function(...)
  if _io_default_in == nil then return nil end
  return _io_default_in:read(...)
end

io.write = function(...)
  if _io_default_out == nil then
    -- Upstream writes to stdout. The host's print is where that goes here.
    local t = {}
    for i = 1, select('#', ...) do t[i] = tostring((select(i, ...))) end
    print(table.concat(t))
    return true
  end
  return _io_default_out:write(...)
end

-- os.execute and io.popen, over the same shell _norns.system_cmd uses.
--
-- fengari implements both through Node's child_process, which a browser does
-- not have: the failure is "child_process.execSync is not a function",
-- thrown inside whatever called it and naming nothing useful. 'amen' hits it
-- in its init, at os.execute("mkdir -p " .. _path.audio .. "amen").
os = os or {}

os.execute = function(cmd)
  -- No argument asks "is a shell available". There is one, of a sort, and
  -- saying no here makes callers take a path meant for systems with no shell
  -- at all.
  if cmd == nil then return true end
  local r = _vfs_shell(cmd)
  -- Lua 5.3 returns true|nil, "exit"|"signal", code. The three-value shape
  -- matters: 'local ok = os.execute(...)' reads the first, and code that
  -- does 'if os.execute(x) == 0' reads the third.
  if r[2] then return true, 'exit', 0 end
  return nil, 'exit', 1
end

os.remove = function(path)
  if _vfs_remove(path) then return true end
  return nil, path .. ': No such file or directory'
end

-- E9-27. os.rename was the one left pointing at fengari, and fengari's
-- goes through a browser fs shim that answers every write with
--
--     nil   EROFS: read-only file system, rename
--
-- which is a lie in a tree the user owns. TWELVE CATALOGUE SCRIPTS CALL
-- IT: cheat_codes_2, clipper, ekombi, flora, gematria, krill,
-- less_concepts, midarto, pitfalls, splnkr, twins, yggdrasil -- mostly to
-- keep a backup of a pset or a data file before overwriting it, which is
-- exactly the moment to not lose the old one.
--
-- The move is done by _vfs_rename and not by read-then-write here, because
-- _vfs_read hands Lua a STRING and several of the twelve rename a
-- recording: a .wav through a string comes back damaged.
--
-- (No backticks in here. This string is a TEMPLATE LITERAL, and a backtick
-- in a comment ends it -- which is how this same edit broke the build
-- once already, and how the Electron probe broke before that.)
os.rename = function(from, to)
  if _vfs_rename(from, to) then return true end
  return nil, from .. ': No such file or directory'
end

-- E9-203. A reply from the network that a script is asking to read.
--
-- Nothing here can stop and wait for it. A CLOCK COROUTINE CAN SLEEP,
-- though, and every catalogue script that reads a service does it from
-- one: so the coroutine sleeps a fiftieth of a second at a time until the
-- reply is in, and the rest of the page never notices. Anywhere else the
-- answer is the one a download gets -- nothing now, and the reply the next
-- time the same thing is asked.
function _njs_await_reply(token)
  local co, is_main = coroutine.running()
  local clk = rawget(_G, 'clock')
  local can_sleep = false
  if not is_main and type(clk) == 'table' and type(clk.threads) == 'table' then
    for _, th in pairs(clk.threads) do
      if th == co then can_sleep = true break end
    end
  end
  if not can_sleep then
    _vfs_net_leave(token)
    return ''
  end
  while true do
    local r = _vfs_net_poll(token)
    if r[2] then return r[1] or '' end
    clk.sleep(0.02)
  end
end

io.popen = function(cmd, mode)
  -- The command has already run by the time this returns, which is what
  -- 'execSync' did too. A read handle over its output is the whole of what
  -- scripts use popen for: 'local f = io.popen(c) local s = f:read('a')'.
  local r = _vfs_shell(cmd, true)
  local data = r[1] or ''
  if r[3] ~= nil then data = _njs_await_reply(r[3]) end
  return setmetatable({ path = nil, data = data, pos = 1, mode = 'r', buf = {} }, File)
end

-- loadfile and dofile, because fengari's read through the browser fs shim and
-- their failure turns into a Lua error whose only content is a filename.
loadfile = function(path, _mode, env)
  local src = _vfs_read(path)
  if src == nil then return nil, 'cannot open ' .. tostring(path) end
  if env ~= nil then return load(src, '@' .. path, 't', env) end
  return load(src, '@' .. path)
end

dofile = function(path)
  local chunk, err = loadfile(path)
  if not chunk then error(err, 2) end
  return chunk()
end
`;

/**
 * E9-203 — `_norns.execute`, taught to wait for a reply.
 *
 * `util.os_capture` is `_norns.execute`, which is a function of the page's
 * and cannot sleep. Wrapped in Lua it can: the page answers with a token
 * when the command is a `curl` whose output is wanted, and the wrapper
 * waits on it the way `io.popen` does. Run after `_norns` exists.
 */
export const LUA_NET_PRELUDE = `
local raw_execute = _norns.execute
_norns.execute = function(cmd)
  local out, token = raw_execute(cmd)
  if token == nil then return out end
  return _njs_await_reply(token)
end
`;
