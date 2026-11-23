-- norns-js Lua profiler
--
-- E9-200 — WHICH LUA FUNCTION, WHICH LINE.
--
-- Every other instrument on this page stops at the edge of the
-- interpreter. `metro 380 ms over 300` says a callback is dear and
-- nothing about why, and the browser's sampler sees one wasm function
-- where a script has forty. On a community script that is the whole
-- question: nobody here wrote it, and reading a thousand lines of
-- somebody else's sequencer to guess at the hot one is the method this
-- replaces.
--
-- A COUNT HOOK, because it is the only clock Lua has. `debug.sethook`
-- with a count fires every N virtual-machine instructions and this
-- records where the interpreter was. So the unit is INSTRUCTIONS, not
-- time: a line that calls into C — every `screen.*`, every `_norns.*` —
-- is one instruction however long the C took. The bridge account on the
-- page's side times those; this ranks the Lua between them. Read
-- together they cover a callback; either alone covers half.
--
-- IT SLOWS THE INTERPRETER, and that is why it is off unless asked for.
-- With any hook set the VM leaves its fast path and checks a counter on
-- every instruction. `_cpu` runs the same arithmetic with and without
-- it so the slowdown on the machine in hand is a measured number; until
-- that is read, a per-call cost taken with this on is the cost of a
-- slower Lua.
--
-- HOOKS ARE PER COROUTINE. A hook set on the main thread sees nothing a
-- `clock.run` does, and most sequencers do all their work there. So
-- `coroutine.create` is wrapped for as long as this file is loaded —
-- which is only under `?profile` — and every coroutine made through it
-- gets the hook when the profiler is on. `coroutine.wrap` is left as it
-- is: reproducing how it re-raises an error is not worth getting subtly
-- wrong for the few iterators that use it, and what they execute is the
-- part of a script this does not count.

local getinfo, sethook = debug.getinfo, debug.sethook
local create = coroutine.create

-- The main thread, taken now because this file is run from the page on
-- the main state. From inside a coroutine there is no way to name it.
local main = coroutine.running()

-- One sample every this many instructions. A redraw is a few thousand,
-- so it is sampled two or three times; sixty a second is a couple of
-- hundred samples and each costs a few microseconds.
local EVERY = 1000

local P = {
  on = false,
  n = 0,
  fn = {},      -- function -> samples with it running
  with = {},    -- function -> samples with it anywhere on the stack
  line = {},    -- line -> samples
  name = {},    -- function -> what Lua calls it, when it knows
  stamp = {},   -- function -> the sample that last counted it
  threads = setmetatable({}, { __mode = "k" }),
}

-- This file, as the interpreter names it, so that the report printing
-- itself is not ranked among the things it reports on.
local SELF = getinfo(1, "S").short_src

local function hook()
  local info = getinfo(2, "Sl")
  if info == nil then return end
  local src = info.short_src
  if src == SELF then return end
  local n = P.n + 1
  P.n = n
  local f = src .. ":" .. info.linedefined
  P.fn[f] = (P.fn[f] or 0) + 1
  local l = src .. ":" .. info.currentline
  P.line[l] = (P.line[l] or 0) + 1
  if P.name[f] == nil then
    local who = getinfo(2, "n")
    P.name[f] = (who and who.name) or "?"
  end
  -- Up the stack, each Lua function once a sample. The stamp is the
  -- sample number, so nothing is allocated to remember what was seen.
  P.stamp[f] = n
  P.with[f] = (P.with[f] or 0) + 1
  local level = 3
  while level < 26 do
    local up = getinfo(level, "S")
    if up == nil then break end
    if up.what ~= "C" then
      local k = up.short_src .. ":" .. up.linedefined
      if P.stamp[k] ~= n then
        P.stamp[k] = n
        P.with[k] = (P.with[k] or 0) + 1
        -- Asked once a function, the first time it is seen on a stack.
        if P.name[k] == nil then
          local who = getinfo(level, "n")
          P.name[k] = (who and who.name) or "?"
        end
      end
    end
    level = level + 1
  end
end

coroutine.create = function(f)
  local co = create(f)
  P.threads[co] = true
  if P.on then sethook(co, hook, "", EVERY) end
  return co
end

local function clear()
  P.n = 0
  P.fn = {}
  P.with = {}
  P.line = {}
  P.stamp = {}
end

function P.start()
  if P.on then return end
  P.on = true
  clear()
  sethook(main, hook, "", EVERY)
  for co in pairs(P.threads) do sethook(co, hook, "", EVERY) end
end

function P.stop()
  if not P.on then return end
  P.on = false
  sethook(main)
  -- Every one, finished or not: a hook left on a coroutine that has ended
  -- costs nothing, but "stopped" should mean there is none anywhere.
  for co in pairs(P.threads) do sethook(co) end
end

-- The tail of a path, because `short_src` keeps sixty characters and a
-- dust path spends forty of them on `/home/we/dust/code/`.
local function short(key)
  local path, line = key:match("^(.*):(%-?%d+)$")
  if path == nil then return key end
  local tail = path:match("([^/]+/[^/]+)$") or path
  return tail .. ":" .. line
end

local function top(t, k)
  local rows = {}
  for key, v in pairs(t) do rows[#rows + 1] = { key, v } end
  table.sort(rows, function(a, b)
    if a[2] ~= b[2] then return a[2] > b[2] end
    return a[1] < b[1]
  end)
  local out = {}
  for i = 1, math.min(k, #rows) do out[i] = rows[i] end
  return out
end

local function heap()
  if _norns_js_heap_kb == nil then return "" end
  return string.format("lua heap %.0f KB", _norns_js_heap_kb())
end

-- What has been seen since the last report, and a clean slate.
function P.report()
  if not P.on then
    print("  lua: " .. heap() .. " — not sampled (add &lua to the address to rank functions and lines)")
    return
  end
  local n = P.n
  if n == 0 then
    print("  lua: " .. heap() .. " — no samples, under " .. EVERY .. " instructions ran")
    clear()
    return
  end
  print(string.format(
    "  lua: %d samples, one every %d instructions, so about %.1f million ran — %s",
    n, EVERY, n * EVERY / 1e6, heap()))
  print("  lua functions, self% / with callees%:")
  for _, row in ipairs(top(P.fn, 12)) do
    local f, c = row[1], row[2]
    print(string.format("    %5.1f  %5.1f  %s  %s",
      c * 100 / n, (P.with[f] or c) * 100 / n, P.name[f] or "?", short(f)))
  end
  local lines = {}
  for _, row in ipairs(top(P.line, 10)) do
    lines[#lines + 1] = string.format("%s %.1f%%", short(row[1]), row[2] * 100 / n)
  end
  print("  lua lines: " .. table.concat(lines, " · "))
  -- Callers that are not themselves hot but carry the hot ones: a
  -- function at nought self and ninety with callees is the entry point.
  local carriers = {}
  for _, row in ipairs(top(P.with, 8)) do
    local f = row[1]
    carriers[#carriers + 1] = string.format("%s %s %.0f%%", P.name[f] or "?", short(f), row[2] * 100 / n)
  end
  print("  lua, most often on the stack: " .. table.concat(carriers, " · "))
  clear()
end

_njs_prof = P

-- A mark reports this too, after the page has said its part. Done here
-- rather than from the page because a mark is called from inside Lua —
-- sometimes from inside a coroutine — and the page calling back in on
-- the main state from there is the kind of re-entry worth not needing.
if _norns ~= nil and _norns.profile_mark ~= nil then
  local mark = _norns.profile_mark
  _norns.profile_mark = function(label)
    mark(label)
    P.report()
  end
end
