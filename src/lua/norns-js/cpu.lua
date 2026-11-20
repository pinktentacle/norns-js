-- norns-js CPU probe
--
-- E9-191 — WHY IS THE PHONE TWENTY-FOUR TIMES SLOWER?
--
-- `_bench` measured a Lua callback at 18.8 us on a desktop and 462 us on a
-- Pixel 9 Pro: a factor of twenty-four, for pure arithmetic on a handful of
-- locals. Drawing, on the same two machines, is a factor of three.
--
-- Raw processor power does not explain it. Geekbench 6 single-core puts the
-- i9-14900 at about 2947 and the Tensor G4 at about 1927 — roughly 1.5x,
-- and this code is strictly single-threaded, so the desktop's twenty-four
-- cores are not in the comparison at all. Something is taking another
-- factor of sixteen.
--
-- THE LIKELIEST CANDIDATE IS THE SCHEDULER. A page that is busy 8.8% of the
-- time never asks for a big core, and Android is free to leave it on an
-- efficiency one — a Cortex-A520 against a Cortex-X4 is several times over,
-- before clocks. Canvas work would not care, because it is not the CPU
-- doing it, which is exactly the shape of what was measured.
--
-- SO THIS SWEEPS THE DUTY CYCLE AND LEAVES EVERYTHING ELSE ALONE. The work
-- unit is identical at every level — the same loop, the same arithmetic,
-- the same number of locals — and only how much of it happens per callback
-- changes. If the cost per iteration is flat, the phone is simply that slow
-- and the governor is innocent. If it falls as the page gets busier, it is
-- not the processor that was being measured, it is what the processor was
-- allowed to do.
--
-- It has NO MUSICAL VALUE and makes no sound.

local LEVEL_SEC = 6
local TICK_HZ = 50

-- The unit, unchanged at every level. Deliberately the same shape as
-- `bench.lua`'s `lua callbacks` phase so the two can be read together.
local function work(n)
  local acc = 0
  for i = 1, n do
    acc = acc + i * 0.5
  end
  return acc
end

-- How many of those per callback. At 50 Hz on a Pixel, 500 is under one
-- per cent of the thread and 40000 is about half of it; the last level is
-- meant to overrun, because a callback that cannot finish in its period is
-- the loudest way to ask for a fast core.
local LEVELS = { 500, 2000, 10000, 40000, 120000 }

local level_i = 0
local ticks = 0
local iters = 0
local callbacks = 0
local busy_ms = 0
local sink = 0
local timer = nil

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
  screen.text(level_i == 0 and "starting" or ("level " .. level_i .. " of " .. #LEVELS))
  if level_i > 0 and level_i <= #LEVELS then
    screen.move(0, 36)
    screen.text(LEVELS[level_i] .. " iterations x " .. TICK_HZ .. "/s")
    screen.move(0, 48)
    screen.text(callbacks .. " callbacks")
  end
  screen.update()
end

local function report()
  local n = LEVELS[level_i]
  if n == nil or callbacks == 0 then return end
  -- THE SAME ESTIMATOR crone uses on the audio thread, and for the same
  -- reason: `util.time()` is millisecond-resolution and one callback is
  -- far below that, but the truncation falls either side of the boundary
  -- in proportion to the part being lost, so a sum over hundreds of
  -- callbacks is unbiased. `profile_mark` prints the same span from the
  -- page's own fine clock, so the two answers sit side by side and have
  -- to agree.
  local ns = (busy_ms * 1000000.0) / iters
  local duty = (busy_ms / (LEVEL_SEC * 1000.0)) * 100.0
  print(string.format(
    "cpu %d: %d iter x %d callbacks = %d, %.1f ms busy of %d (%.1f%% duty), %.1f ns/iteration",
    level_i, n, callbacks, iters, busy_ms, LEVEL_SEC * 1000, duty, ns))
  mark(string.format("cpu level %d — %d iterations a callback, %.0f%% duty", level_i, n, duty))
end

local function start_level(i)
  local n = LEVELS[i]
  if n == nil then
    print("cpu: finished. Compare the ns/iteration down the levels:")
    print("cpu: flat means the processor, falling means the scheduler.")
    if timer then timer:stop() end
    redraw()
    return
  end
  iters = 0
  callbacks = 0
  busy_ms = 0
  redraw()
end

function init()
  screen.aa(0)
  print("cpu: " .. #LEVELS .. " levels of " .. LEVEL_SEC .. " s at " .. TICK_HZ .. "/s")
  print("cpu: the work unit is the same at every level; only how much of it")
  print("cpu: happens per callback changes.")
  mark("cpu probe start")

  timer = metro.init()
  timer.time = 1 / TICK_HZ
  timer.event = function()
    local n = LEVELS[level_i]
    if n ~= nil then
      local t0 = util.time()
      sink = sink + work(n)
      busy_ms = busy_ms + (util.time() - t0) * 1000.0
      iters = iters + n
      callbacks = callbacks + 1
    end

    ticks = ticks + 1
    if ticks >= LEVEL_SEC * TICK_HZ then
      ticks = 0
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
  if sink == 1e308 then print("unreachable") end
end
