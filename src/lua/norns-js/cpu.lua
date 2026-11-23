-- norns-js CPU and cost probe
--
-- E9-197 — WHAT DOES ONE UNIT OF WORK COST, AND WHAT DOES IT DEPEND ON.
--
-- The first version of this asked one question and answered it: a Pixel 9
-- Pro's cost per iteration falls FIVE TIMES as the page gets busier — 353 ns
-- at 1% duty, 70 ns at 42% — where this project's desktop is flat at 7-9 ns
-- over the same range. The twenty-four times was never the processor. It was
-- a page that is busy one per cent of the time being left on a little core.
--
-- That answer raised three more, and none of them can be had from `_bench`,
-- whose seven phases each run at ONE rate and are deliberately frozen so
-- that two releases can be compared.
--
--   1. WHERE IS THE FLOOR? The curve was still falling at the last level.
--      Two more levels go past the period, into real saturation.
--
--   2. DOES THE BOOST SURVIVE AN IDLE GAP? A sequencer is bursty by nature.
--      If a high clock persists through the quiet between bursts, every
--      low-duty number here is irrelevant to it; if it decays, every gap is
--      paid for twice. So the sweep goes up and then comes back DOWN to its
--      first level, and the two readings of the same work are compared.
--
--   3. DOES IT RAMP WITH TIME AS WELL AS LOAD? Every level reports its
--      first half and its second half apart. If they differ, a script's
--      first second is slower than its tenth.
--
-- AND WHAT THE REAL OPERATIONS COST, which is the number any optimisation
-- has to be judged against. A redraw, a grid refresh and a note, each at a
-- low rate and a high one — because the governor means a cost measured at
-- 2% duty is NOT what a busy script pays, and a saving measured there is
-- not what a busy script gets back.
--
-- THE SCREEN IS SPLIT THREE WAYS, which decides whether batching the screen
-- API is worth building: `screen.level` crosses into cairo and draws
-- nothing, `move+line+stroke` crosses and rasterises, `text` crosses and
-- shapes a font. The first is the crossing on its own. Nothing is counted in
-- the page for this — the probe knows how many calls it made.
--
-- It has NO MUSICAL VALUE. The note sweep makes sound; everything else does
-- not.

engine.name = "PolyPerc"

local TICK_HZ = 60
local LEVEL_SEC = 5
local g = grid.connect()

-- --- the work units ------------------------------------------------------

local sink = 0

-- E9-198 — NOTHING, which is the BASELINE FOR THE OTHER LEVELS and not
-- the floor under a metro.
--
-- It was added believing the mark's `metro` figure beside it would be the
-- cost of delivering a metro tick. It is not, and the number said so: it
-- reads about 13 us where a differential measurement — the same instrument,
-- a metro at 25 Hz against one at 200 Hz, the difference cancelling
-- whatever is constant per call — puts an empty callback at 1.43 us.
--
-- The other twelve are THIS PROBE'S OWN BODY: the globals it reads, the
-- two `util.time()` calls around the work, the table it indexes. Which is
-- exactly what this level is for — every other level carries the same
-- body, so subtracting this one leaves the work.
--
-- A metro tick costs 1.4 us. At a hundred a second that is 0.14 ms of a
-- second, and it is not worth optimising. Measured, so that nobody else
-- goes looking.
local function nothing(_n)
end

local function arith(n)
  local acc = 0
  for i = 1, n do
    acc = acc + i * 0.5
  end
  sink = sink + acc
end

-- A crossing into cairo that draws nothing. `screen.level` sets a number
-- and returns; whatever this costs is the boundary and not the drawing.
local function crossings(n)
  for i = 1, n do
    screen.level((i % 15) + 1)
  end
end

-- The same boundary, with a rasterised stroke behind it. Three calls an
-- iteration, so divide by three to compare with the line above.
local function strokes(n)
  for i = 1, n do
    screen.move(i % 120, 10)
    screen.line(i % 120, 50)
    screen.stroke()
  end
end

-- E9-197 — AND THE ONE THAT PAINTS THE WHOLE SURFACE. A redraw on this
-- desktop costs 80 us for about fifty calls, and the three probes above
-- account for a quarter of that. `screen.clear` fills 128x64 in cairo on
-- every redraw of every script, and nothing had ever put a number on it.
local function clears(n)
  for _ = 1, n do
    screen.clear()
  end
end

-- E9-197 — AND THE ONE THAT ENDS EVERY REDRAW. The four probes above
-- account for about 21 us of a redraw measured at 80; `screen.update` is
-- the only call left in it that nothing has put a number on.
local function updates(n)
  for _ = 1, n do
    screen.update()
  end
end

-- The dearest of the three on any machine: a glyph has to be shaped.
local function texts(n)
  for i = 1, n do
    screen.move(0, 20)
    screen.text("norns")
  end
end

local frame = 0

local function redraw_work()
  screen.clear()
  screen.level(15)
  screen.move(0, 8)
  screen.text("cpu probe")
  screen.move(0, 18)
  screen.text(tostring(frame))
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
  frame = frame + 1
end

local gstep = 0

local function grid_work()
  gstep = gstep + 1
  for x = 1, 16 do
    for y = 1, 8 do
      g:led(x, y, (x + y + gstep) % 4 == 0 and 15 or 0)
    end
  end
  g:refresh()
end

local note = 0

local function note_work()
  note = note + 1
  engine.hz(110 * (1 + (note % 8) / 4))
end

-- --- E9-200: the paths a real script takes that nothing above touches ----
--
-- The nineteen levels above measure a callback, the screen, the grid and
-- a note. A sequencer also runs its steps in clock coroutines, a looper
-- is fed sixty phase reports a second, every knob is an engine command
-- that makes no sound, and all of it allocates. Each of those reaches Lua
-- by a different road, and a level that only goes down one of them is
-- the only way to put a number on that road alone.
--
-- Some of these do their work OUTSIDE the tick — a coroutine, a poll —
-- so this script's own clock sees nothing and says `0 ms busy`. That is
-- right: the cost is in the mark that follows, under `clock`, `poll` or
-- `softcut_phase`, and the count that travels with the mark is how many
-- there were to divide it by.

-- A command that changes a number in sclang and sends nothing on. The
-- whole of what a parameter costs, with no synth behind it.
local function param_work()
  note = note + 1
  engine.cutoff(600 + (note % 50) * 20)
end

-- Garbage, at the rate a script that builds a table per step makes it.
local function churn(n)
  local keep = {}
  for i = 1, n do
    keep[i] = { i, i * 0.5, "x" }
  end
  sink = sink + #keep
end

-- What a redraw full of numbers does before it draws any of them.
local function strings(n)
  local t = {}
  for i = 1, n do
    t[#t + 1] = string.format("%d:%.2f", i, i * 0.25)
  end
  sink = sink + #table.concat(t, ",")
end

local seen = 0

local coros = {}

local function clocks_start()
  seen = 0
  -- Two that wait on the beat and two that wait on the clock, because a
  -- script uses both and they are scheduled by different arithmetic.
  for i = 1, 2 do
    coros[#coros + 1] = clock.run(function()
      while true do
        clock.sync(1 / 8)
        seen = seen + 1
      end
    end)
    coros[#coros + 1] = clock.run(function()
      while true do
        clock.sleep(1 / 30)
        seen = seen + 1
      end
    end)
  end
end

local function clocks_stop()
  for i = 1, #coros do clock.cancel(coros[i]) end
  coros = {}
end

local function softcut_start()
  seen = 0
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
    softcut.phase_quant(i, 1 / 30)
  end
  softcut.event_phase(function(_i, _pos) seen = seen + 1 end)
  softcut.poll_start_phase()
end

local function softcut_stop()
  softcut.poll_stop_phase()
  for i = 1, 6 do
    softcut.play(i, 0)
    softcut.enable(i, 0)
  end
end

local vu = {}

local function vu_start()
  seen = 0
  for _, name in ipairs({ "amp_out_l", "amp_out_r" }) do
    local p = poll.set(name, function(_v) seen = seen + 1 end)
    p.time = 1 / 30
    p:start()
    vu[#vu + 1] = p
  end
end

local function vu_stop()
  for i = 1, #vu do vu[i]:stop() end
  vu = {}
end

-- The page times sclang from outside it; see `profile_probe` in main.ts.
local function probe(what, n, text)
  if _norns and _norns.profile_probe then _norns.profile_probe(what, n, text) end
end

local function flood_work()
  probe("sclang_flood", 2000, "cutoff")
end

local function scbench_work()
  probe("sclang_bench", 200000, "")
end

-- The interpreter with a hook on it, against the same arithmetic without.
-- Whatever the ratio is, it is what `&lua` costs on this machine.
local sampling_was_on = false

local function sampled_start()
  sampling_was_on = _njs_prof ~= nil and _njs_prof.on
  if _njs_prof ~= nil then _njs_prof.start() end
end

local function sampled_stop()
  if _njs_prof ~= nil and not sampling_was_on then _njs_prof.stop() end
end

-- --- the levels ----------------------------------------------------------
--
-- `every` is in master ticks: 1 is every tick (60/s), 4 is 15/s. `n` is how
-- many work units per acting tick. `unit` names what one of them is, so the
-- report divides by the right thing.

local LEVELS = {
  -- The governor sweep, going up.
  { name = "empty callback", fn = nothing, n = 1,   every = 1, unit = "callback" },
  { name = "arith 500",      fn = arith, n = 500,    every = 1, unit = "iteration" },
  { name = "arith 2k",       fn = arith, n = 2000,   every = 1, unit = "iteration" },
  { name = "arith 10k",      fn = arith, n = 10000,  every = 1, unit = "iteration" },
  { name = "arith 40k",      fn = arith, n = 40000,  every = 1, unit = "iteration" },
  { name = "arith 120k",     fn = arith, n = 120000, every = 1, unit = "iteration" },
  { name = "arith 400k",     fn = arith, n = 400000, every = 1, unit = "iteration" },
  -- E9-197 (2) — AND BACK DOWN TO WHERE IT STARTED. Same work as level 1.
  -- A different answer here than there is hysteresis, and it decides
  -- whether any of the low-duty numbers apply to a bursty script.
  { name = "arith 500 again", fn = arith, n = 500,   every = 1, unit = "iteration" },

  -- The screen boundary, three ways.
  { name = "screen level",  fn = crossings, n = 400, every = 1, unit = "call" },
  { name = "screen stroke", fn = strokes,   n = 150, every = 1, unit = "stroke, 3 calls" },
  { name = "screen text",   fn = texts,     n = 100, every = 1, unit = "text, 2 calls" },
  { name = "screen clear",  fn = clears,    n = 100, every = 1, unit = "clear" },
  { name = "screen update", fn = updates,   n = 100, every = 1, unit = "update" },

  -- The real operations, slow and fast.
  { name = "redraw 15/s", fn = redraw_work, n = 1, every = 4, unit = "redraw" },
  { name = "redraw 60/s", fn = redraw_work, n = 1, every = 1, unit = "redraw" },
  { name = "grid 15/s",   fn = grid_work,   n = 1, every = 4, unit = "refresh" },
  { name = "grid 60/s",   fn = grid_work,   n = 1, every = 1, unit = "refresh" },
  { name = "notes 10/s",  fn = note_work,   n = 1, every = 6, unit = "note" },
  { name = "notes 60/s",  fn = note_work,   n = 1, every = 1, unit = "note" },

  -- E9-200 — APPENDED, never inserted: the nineteen above keep their
  -- numbers, so a run of this build can be laid beside a run of the last.
  { name = "params 60/s",   fn = param_work, n = 1,    every = 1, unit = "command" },
  { name = "clock coroutines", fn = nothing, n = 1,    every = 1, unit = "tick",
    start = clocks_start, stop = clocks_stop, counted = "resumes" },
  { name = "softcut phase polls", fn = nothing, n = 1, every = 1, unit = "tick",
    start = softcut_start, stop = softcut_stop, counted = "phase reports" },
  { name = "amp polls 30/s", fn = nothing, n = 1,      every = 1, unit = "tick",
    start = vu_start, stop = vu_stop, counted = "poll values" },
  { name = "table churn",   fn = churn,   n = 2000,    every = 1, unit = "table" },
  { name = "string format", fn = strings, n = 500,     every = 1, unit = "string" },
  { name = "arith 40k sampled", fn = arith, n = 40000, every = 1, unit = "iteration",
    start = sampled_start, stop = sampled_stop },
  { name = "sclang flood",  fn = flood_work,   n = 1,  every = 60, unit = "flood of 2000" },
  { name = "sclang bench",  fn = scbench_work, n = 1,  every = 60, unit = "bench" },
}

-- --- the run -------------------------------------------------------------

local level_i = 0
local ticks = 0
local timer = nil

-- Two halves, kept apart. See (3) above.
local busy = { 0, 0 }
local units = { 0, 0 }
local acts = { 0, 0 }

local function mark(label)
  if _norns and _norns.profile_mark then
    _norns.profile_mark(label)
  else
    print("mark: " .. label)
  end
end

function redraw()
  screen.clear()
  screen.level(15)
  screen.move(0, 10)
  screen.text("norns-js cpu probe")
  screen.move(0, 24)
  local l = LEVELS[level_i]
  screen.text(level_i == 0 and "starting" or (level_i .. "/" .. #LEVELS .. " " .. (l and l.name or "")))
  screen.move(0, 38)
  screen.text((acts[1] + acts[2]) .. " acts")
  screen.update()
end

local function report()
  local l = LEVELS[level_i]
  if l == nil then return end
  local totalBusy = busy[1] + busy[2]
  local totalUnits = units[1] + units[2]
  local totalActs = acts[1] + acts[2]
  if totalActs == 0 then return end
  local duty = (totalBusy / (LEVEL_SEC * 1000.0)) * 100.0
  -- THE SAME UNBIASED TRICK crone uses on the audio thread: `util.time()`
  -- is millisecond-resolution and one act is far below that, but the
  -- truncation falls either side of the boundary in proportion to the part
  -- being lost, so a sum over hundreds of acts is unbiased. `profile_mark`
  -- prints the same span from the page's own fine clock beside it.
  local per = totalUnits > 0 and (totalBusy * 1000.0) / totalUnits or 0
  local half1 = units[1] > 0 and (busy[1] * 1000.0) / units[1] or 0
  local half2 = units[2] > 0 and (busy[2] * 1000.0) / units[2] or 0

  -- MICROSECONDS OR NANOSECONDS, whichever the number actually is. One
  -- iteration of the arithmetic costs single-digit nanoseconds on a
  -- desktop and printed as `0.0 us`, which is not a reading.
  local function say_per(v)
    if v < 1.0 then return string.format("%.1f ns", v * 1000.0) end
    return string.format("%.2f us", v)
  end

  -- HOW MUCH THE CLOCK ACTUALLY SAW. `util.time()` resolves a
  -- millisecond and the estimator is unbiased, but its error falls as
  -- the square root of how many whole milliseconds were counted: 12 ms
  -- over a level is about thirty per cent, and that has to be on the
  -- line rather than left for the reader to work out. The fine answer
  -- for the same span is `metro` in the mark below, which is timed with
  -- `performance.now()` on the page's side.
  local coarse = ""
  if totalBusy < 60 then
    coarse = string.format("  [COARSE: only %.0f ms on a 1 ms clock — read `metro` in the mark]", totalBusy)
  end

  print(string.format(
    "cpu %d %s: %d acts x %d %s, %.0f ms busy of %d (%.1f%% duty), %s/%s  [halves %s / %s]%s",
    level_i, l.name, totalActs, l.n, l.unit, totalBusy, LEVEL_SEC * 1000, duty,
    say_per(per), l.unit, say_per(half1), say_per(half2), coarse))
  -- The act count travels with the mark so `metro X ms over N` can be
  -- divided by the right thing without counting back up the log. And for
  -- a level whose work happens outside the tick, how much of it there was.
  local extra = l.counted and string.format(", %d %s", seen, l.counted) or ""
  mark(string.format("cpu %s — %d acts, %.0f%% duty%s", l.name, totalActs, duty, extra))
end

-- A level that sets something up says so here, and one that fails to is
-- named and skipped rather than taking the rest of the run with it.
local function around(l, which)
  if l == nil or l[which] == nil then return end
  local ok, err = pcall(l[which])
  if not ok then print("cpu: " .. l.name .. " could not " .. which .. " — " .. tostring(err)) end
end

local function start_level(i)
  local l = LEVELS[i]
  if l == nil then
    print("cpu: finished.")
    print("cpu: arith 500 against 'arith 500 again' is the hysteresis:")
    print("cpu: the same if the boost decays, far cheaper if it does not.")
    print("cpu: screen level is the crossing alone; stroke and text add cairo.")
    if timer then timer:stop() end
    for i2 = 1, 6 do softcut.play(i2, 0) end
    redraw()
    return
  end
  busy = { 0, 0 }
  units = { 0, 0 }
  acts = { 0, 0 }
  around(l, "start")
  redraw()
end

function init()
  screen.aa(0)
  print("cpu: " .. #LEVELS .. " levels of " .. LEVEL_SEC .. " s at " .. TICK_HZ .. "/s")
  mark("cpu probe start")

  timer = metro.init()
  timer.time = 1 / TICK_HZ
  timer.event = function()
    ticks = ticks + 1
    local l = LEVELS[level_i]
    if l ~= nil and (ticks % l.every) == 0 then
      -- Which half of the level this act belongs to.
      local h = ticks <= (LEVEL_SEC * TICK_HZ) / 2 and 1 or 2
      local t0 = util.time()
      l.fn(l.n)
      busy[h] = busy[h] + (util.time() - t0) * 1000.0
      units[h] = units[h] + l.n
      acts[h] = acts[h] + 1
    end

    if ticks >= LEVEL_SEC * TICK_HZ then
      ticks = 0
      -- Stopped BEFORE the report, so the mark that closes this level is
      -- not also the first span of whatever it left running.
      around(l, "stop")
      report()
      level_i = level_i + 1
      start_level(level_i)
    end
  end
  timer:start()
  level_i = 1
  start_level(1)
end

function key(n, z)
  if n == 3 and z == 1 then
    if timer then timer:stop() end
    print("cpu: stopped by hand")
  end
end

function enc() end

function cleanup()
  if timer then timer:stop() end
  around(LEVELS[level_i], "stop")
  if sink == 1e308 then print("unreachable") end
end
