-- norns-js profiling bench
--
-- E9-176 — A SCRIPT WHOSE ONLY PURPOSE IS TO BE MEASURED.
--
-- Every profile taken so far has been of a community script driven by
-- hand: `kolor` with somebody playing it, `molly_the_poly` with somebody
-- holding keys. Those tell you what that session cost and nothing more.
-- Two of them cannot be compared — not across machines, not across
-- builds, not even across two runs — because the thing being measured
-- was different each time.
--
-- This does the same work every time, at a known rate, for a known
-- length, and says how much of each it did. It has NO MUSICAL VALUE and
-- is not trying to have any.
--
-- ONE PHASE AT A TIME, because the instruments report one running total.
-- Screen, grid, engine, softcut and plain Lua callbacks all cost
-- something, and a run that does them together can only say what the
-- sum was. Each phase runs alone, and `_norns.profile_mark` prints the
-- account for that phase and clears it, so the log carries five
-- separate readings instead of one blended one. The last phase runs
-- everything together on purpose: the difference between it and the sum
-- of the others is the part that only appears under load.

engine.name = "PolyPerc"

local PHASE_SEC = 8
local g = grid.connect()

local phase = "boot"
local frame = 0
local counts = {}
local running = {}

local function bump(k)
  counts[k] = (counts[k] or 0) + 1
end

-- The report for a phase, and the line that clears the account for the
-- next one. Absent on a norns, where this script is meaningless anyway.
local function mark(label)
  if _norns and _norns.profile_mark then
    _norns.profile_mark(label)
  else
    print("mark: " .. label)
  end
end

local function tally()
  local parts = {}
  for k, v in pairs(counts) do
    parts[#parts + 1] = k .. " " .. v
  end
  table.sort(parts)
  return table.concat(parts, ", ")
end

-- --- the work each phase does ------------------------------------------

-- A screen a norns script would plausibly draw: some text, sixteen
-- lines, six filled rectangles. Deterministic, so two runs draw exactly
-- the same pixels.
function redraw()
  screen.clear()
  screen.level(15)
  screen.move(0, 8)
  screen.text("norns-js bench")
  screen.move(0, 18)
  screen.text(phase .. " " .. frame)
  for i = 1, 16 do
    screen.level(2 + (i * 3) % 14)
    screen.move(i * 8 - 4, 24)
    screen.line(i * 8 - 4, 24 + (i * 7) % 30)
    screen.stroke()
  end
  for i = 1, 6 do
    screen.level(4 + i)
    screen.rect(i * 20 - 16, 54, 14, 8)
    screen.fill()
  end
  screen.update()
  bump("redraws")
end

-- Three surfaces, because they cost different amounts: an unlit grid is
-- the cheap case, a fully lit one the dear one, and a playhead over a
-- sparse background is what a sequencer actually looks like.
local function surface(step)
  local kind = step % 3
  for x = 1, 16 do
    for y = 1, 8 do
      local v
      if kind == 0 then
        v = 0
      elseif kind == 1 then
        v = 15
      elseif x == (step // 3) % 16 + 1 then
        v = 15
      elseif (x + y) % 4 == 0 then
        v = 3
      else
        v = 0
      end
      g:led(x, y, v)
    end
  end
  g:refresh()
  bump("refreshes")
end

local function stop_all()
  for name, m in pairs(running) do
    if name ~= "__timer" then m:stop() end
  end
  local timer = running["__timer"]
  running = {}
  if timer then running["__timer"] = timer end
  for i = 1, 6 do
    softcut.play(i, 0)
    softcut.enable(i, 0)
  end
end

local function every(name, hz, fn)
  local m = metro.init()
  m.time = 1 / hz
  m.event = fn
  m:start()
  running[name] = m
end

-- --- the phases ---------------------------------------------------------

local phases = {}

phases[#phases + 1] = {
  name = "idle",
  -- The floor. Whatever this costs, every other phase costs on top of
  -- it: the CPU meter's own timer, the stat poll, the tape poll, the VU.
  start = function() end,
}

phases[#phases + 1] = {
  name = "screen 30fps",
  start = function()
    every("screen", 30, function()
      frame = frame + 1
      redraw()
    end)
  end,
}

phases[#phases + 1] = {
  name = "grid 30fps",
  start = function()
    local step = 0
    every("grid", 30, function()
      step = step + 1
      surface(step)
    end)
  end,
}

phases[#phases + 1] = {
  name = "engine 20/s",
  start = function()
    local n = 0
    every("engine", 20, function()
      n = n + 1
      engine.hz(110 * (1 + (n % 8) / 4))
      bump("notes")
    end)
  end,
}

phases[#phases + 1] = {
  name = "softcut 6 voices",
  start = function()
    -- The 808 kit is synthesised into the build, so it is on every
    -- machine this can run on — no install, no download, no catalogue.
    softcut.buffer_clear()
    softcut.buffer_read_mono("/home/we/dust/audio/common/808/808-BD.wav", 0, 0, -1, 1, 1)
    for i = 1, 6 do
      softcut.enable(i, 1)
      softcut.buffer(i, 1)
      softcut.level(i, 0.15)
      softcut.loop(i, 1)
      softcut.loop_start(i, 0)
      softcut.loop_end(i, 0.35)
      softcut.position(i, 0)
      softcut.rate(i, 1 + i * 0.03)
      softcut.fade_time(i, 0.01)
      softcut.play(i, 1)
      bump("voices")
    end
  end,
}

phases[#phases + 1] = {
  name = "lua callbacks 100/s",
  start = function()
    -- Nothing but the crossing and some arithmetic, so the cost of a
    -- callback can be told apart from the cost of what callbacks
    -- usually do.
    every("lua", 100, function()
      local acc = 0
      for i = 1, 2000 do
        acc = acc + i * 0.5
      end
      bump("callbacks")
      if acc < 0 then print("unreachable") end
    end)
  end,
}

phases[#phases + 1] = {
  name = "everything at once",
  start = function()
    local step = 0
    every("screen", 30, function()
      frame = frame + 1
      redraw()
    end)
    every("grid", 30, function()
      step = step + 1
      surface(step)
    end)
    local n = 0
    every("engine", 20, function()
      n = n + 1
      engine.hz(110 * (1 + (n % 8) / 4))
      bump("notes")
    end)
    for i = 1, 6 do
      softcut.play(i, 1)
      softcut.enable(i, 1)
    end
  end,
}

-- --- the run -------------------------------------------------------------
--
-- E9-177 — THE PHASES ARE COUNTED IN TICKS, NOT SLEPT THROUGH.
--
-- The first version advanced with `clock.sleep(PHASE_SEC)`, which on a
-- page the browser is not painting arrives about half a second late —
-- `clock.sleep(1)` measured at 1.5 s and `clock.sleep(2)` at 2.49 s, by
-- two clocks that agree. A phase whose length depends on that is not
-- comparable with one measured anywhere else, which is the single thing
-- this script exists to provide.
--
-- Metros were measured on the same page and are exact: fifty ticks in
-- 2.5 s at 20 Hz. So one metro counts the phases out and nothing here
-- sleeps. The lateness is still worth fixing where it lives, and it is
-- this script that found it.

local TICK_HZ = 10
local phase_i = 0
local ticks = 0

local function start_phase(i)
  local p = phases[i]
  if p == nil then
    phase = "done"
    print("bench: finished. Nothing is running now.")
    redraw()
    return
  end
  counts = {}
  phase = p.name
  p.start()
end

local function finish_phase(i)
  local p = phases[i]
  if p == nil then return end
  stop_all()
  local what = tally()
  mark(p.name .. (what == "" and "" or " — " .. what))
end

function init()
  screen.aa(0)
  print("bench: " .. #phases .. " phases of " .. PHASE_SEC .. " s each")
  mark("bench start")
  local timer = metro.init()
  timer.time = 1 / TICK_HZ
  timer.event = function()
    ticks = ticks + 1
    if ticks >= PHASE_SEC * TICK_HZ then
      ticks = 0
      finish_phase(phase_i)
      phase_i = phase_i + 1
      start_phase(phase_i)
      if phases[phase_i] == nil then timer:stop() end
    end
  end
  timer:start()
  running["__timer"] = timer
  phase_i = 1
  start_phase(1)
end

function key(n, z)
  if n == 3 and z == 1 then
    local timer = running["__timer"]
    if timer then timer:stop() end
    stop_all()
    print("bench: stopped by hand")
  end
end

function enc() end

function cleanup()
  local timer = running["__timer"]
  if timer then timer:stop() end
  stop_all()
end
