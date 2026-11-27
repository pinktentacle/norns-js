-- fireflies
-- a summer meadow where fireflies
-- learn to flash together
--
-- E1 the hour of the night
-- E2 coupling: how much they
--    listen to each other
-- E3 how many fireflies
-- K2 the lantern, on the beat
-- K3 a gust of wind
--
-- K1+E1 wind   K1+E2 reach
-- K1+E3 period
-- K1+K2 scatter them
-- K1+K3 change voice
--
-- grid (optional): the meadow
-- MIDI: notes out, calls in

engine.name = "Fireflies"

local musicutil = require "musicutil"
local Swarm = include "lib/swarm"
local SCENE = include "lib/scene"

local DATA = _path.data .. "fireflies/"
local DT = 1 / 30

local VOICES = { "glass", "bell", "kalimba", "breath", "pluck", "mixed" }
local PITCH_FROM = { "height", "column", "each its own" }
local CHORUS = { "off", "chord", "swell" }
local GUSTS = { "off", "rare", "sometimes", "often" }
local GUST_RATE = { 0, 1 / 90, 1 / 40, 1 / 15 }
local CYCLE = { "off", "10 min", "20 min", "30 min", "1 hour", "2 hours" }
local CYCLE_MIN = { 0, 10, 20, 30, 60, 120 }
local MOON = { "follows the swarm", "the real moon", "full", "new" }
local OWLS = { "off", "rare", "often" }
local LANTERN_DIV = { "1/4", "1/2", "1", "2", "4" }
local LANTERN_BEATS = { 0.25, 0.5, 1, 2, 4 }
local GRID_SHOWS = { "flashes", "flashes and fireflies" }

local swarm
local IMG = {}
local stars = {}
local grass = {}
local notes, scale_names = {}, {}
local held = { false, false, false }
local message, message_until = nil, 0
local banner_until = 0
local now_t, start_time = 0, 0
local sim
local lantern = { on = false, beat = 0, x = nil, y = nil, clock = nil }
local sync_shown = 0
local recent_notes = {}
local last_chorus = 0
local next_owl, next_bird = 0, 0
local shooting = nil
local ambience_at = 0
local gust_level, gust_dir = 0, 1
local chorus_glow = 0
local g = grid.connect()
local grid_down = {}
local midi_out, midi_in
local hanging = {} -- notes sounding on MIDI out, to stop at cleanup

local function P(id) return params:get(id) end
local function say(text) message, message_until = text, util.time() + 1.6 end

-- ------------------------------------------------------------ the night

-- the hour of the night is 0 at dusk (21:00) to 1 at dawn (05:30)
local function clock_text(t)
  local h = 21 + t * 8.5
  local hh = math.floor(h) % 24
  local mm = math.floor((h - math.floor(h)) * 60)
  return string.format("%02d:%02d", hh, mm)
end

local function phase_name(t)
  if t < 0.12 then return "dusk"
  elseif t < 0.3 then return "evening"
  elseif t < 0.62 then return "night"
  elseif t < 0.82 then return "late night"
  elseif t < 0.93 then return "first light"
  end
  return "dawn"
end

-- how many fireflies are out: a few at dusk, all of them in the first
-- hours, fewer after, almost none at dawn
local function activity(t)
  if t < 0.25 then return 0.3 + t / 0.25 * 0.7 end
  if t < 0.55 then return 1 end
  if t < 0.85 then return 1 - (t - 0.55) / 0.3 * 0.55 end
  return math.max(0.05, 0.45 - (t - 0.85) / 0.15 * 0.4)
end

local function starlight(t)
  return util.clamp(math.min((t - 0.06) / 0.22, (0.94 - t) / 0.14), 0, 1)
end

local function mistiness(t)
  return math.max(util.clamp(1 - t / 0.14, 0, 1) * 0.7, util.clamp((t - 0.8) / 0.15, 0, 1))
end

-- crickets sing through the night; frogs mostly in its first hours
local function crickets_now(t) return util.clamp(math.min(t / 0.12, (1 - t) / 0.12), 0.1, 1) end
local function frogs_now(t) return util.clamp(1 - math.abs(t - 0.28) / 0.35, 0, 1) end

-- Dolbear's law: a cricket chirps faster the warmer the night
local function cricket_rate() return math.max(0.4, (7 * P("temperature") - 30) / 60) end

-- fireflies flash faster when it is warm too
local function warmth() return (22 / P("temperature")) ^ 0.7 end

local function moon_fraction()
  local m = P("moon")
  if m == 1 then return sync_shown end
  if m == 3 then return 1 end
  if m == 4 then return 0 end
  -- the real moon: days since a known new moon, over the synodic month
  local age = ((os.time() - 947182440) / 86400) % 29.530589
  return (1 - math.cos(2 * math.pi * age / 29.530589)) / 2
end

-- ------------------------------------------------------------- the notes

local function build_notes()
  notes = musicutil.generate_scale(P("root"), scale_names[P("scale")], P("octaves"))
end

local function degree_of(fl)
  local n = #notes
  local mode = P("pitch_from")
  local u
  if mode == 1 then
    u = 1 - util.clamp((fl.y - 18) / 42, 0, 1)
  elseif mode == 2 then
    u = util.clamp(fl.x / 127, 0, 1)
  else
    fl.degree = fl.degree or fl.seed
    u = fl.degree
  end
  return util.clamp(math.floor(u * (n - 1) + 0.5), 0, n - 1)
end

-- no more notes a second than the density allows: a crowded meadow stays music
local function allowed(now, burst)
  local keep = {}
  for _, t in ipairs(recent_notes) do
    if now - t < 1 then keep[#keep + 1] = t end
  end
  recent_notes = keep
  if #recent_notes >= P("density") then return false end
  -- and in a chorus, only a few of them: the chord says the rest
  if burst then
    local close = 0
    for _, t in ipairs(recent_notes) do
      if now - t < 0.15 then close = close + 1 end
    end
    if close >= 4 then return false end
  end
  recent_notes[#recent_notes + 1] = now
  return true
end

local function midi_note(note, vel)
  if midi_out == nil or P("midi_out") == 1 then return end
  local ch = P("midi_out_ch")
  midi_out:note_on(note, vel, ch)
  hanging[note .. ":" .. ch] = { note, ch }
  clock.run(function()
    clock.sleep(P("midi_len"))
    if midi_out then midi_out:note_off(note, 0, ch) end
    hanging[note .. ":" .. ch] = nil
  end)
end

local function sound(voice, note, amp, x, bright, decay)
  if note == nil then return end
  local freq = musicutil.note_num_to_freq(note)
  engine.flash(voice, freq, amp * P("level"), util.linlin(0, 127, -0.85, 0.85, x) * P("width"), bright, decay)
  local vmin, vmax = P("midi_vel_min"), P("midi_vel_max")
  midi_note(note, math.floor(util.clamp(vmin + (vmax - vmin) * math.min(1, amp / 0.2), 1, 127)))
end

local function voice_of(fl)
  local v = P("voice")
  if v < 6 then return v end
  fl.voice = fl.voice or (math.floor(fl.seed * 1000) % 5) + 1
  return fl.voice
end

local function play_flash(fl, burst)
  if not allowed(util.time(), burst) then return end
  local d = degree_of(fl)
  local amp = 0.16 * (0.4 + fl.z * 0.6)
  sound(voice_of(fl), notes[d + 1], amp, fl.x, P("timbre") * (0.55 + fl.z * 0.45), P("decay"))
end

-- most of the meadow lit at once: a chord under it
local function chorus(events)
  local mode = P("chorus")
  chorus_glow = 1
  if mode == 1 then return end
  local sum = 0
  for _, fl in ipairs(events) do sum = sum + degree_of(fl) end
  local d = math.floor(sum / math.max(1, #events) + 0.5)
  local n = #notes
  local steps = { 0, 2, 4, 7 }
  for k, s in ipairs(steps) do
    local deg = util.clamp(d - 4 + s, 0, n - 1)
    local note = notes[deg + 1]
    if note then
      if mode == 2 then
        sound(4, note - 12, 0.05, 30 + k * 20, P("timbre") * 0.6, P("decay") * 1.2)
      else
        sound(4, note - 12, 0.045, 30 + k * 20, 0.05, P("decay") * 2.2)
      end
    end
  end
end

-- ------------------------------------------------------------ the swarm

local function env()
  return {
    coupling = P("coupling"),
    reach = P("reach"),
    period = P("period") * warmth(),
    spread = P("spread") / 100,
    refractory = 0.12,
    drift = P("drift"),
    wind = P("wind") * 2 + gust_level * gust_dir * 3,
    activity = activity(P("night")),
    glow_time = P("glow"),
  }
end

local function handle(events, now)
  if #events == 0 then return end
  local _, active = swarm:sync()
  local burst = swarm:recent_count() >= math.max(4, math.ceil(active * 0.45))
  for _, fl in ipairs(events) do play_flash(fl, burst) end
  if burst and now - last_chorus > P("period") * 0.6 then
    last_chorus = now
    chorus(events)
  end
end

local function blow(strength)
  gust_dir = math.random() < 0.8 and 1 or -1
  gust_level = math.max(gust_level, strength)
  swarm:gust(strength, gust_dir)
  engine.gust(strength)
end

-- the lantern, on the clock's beat: a light that never wavers, and that the
-- fireflies near it come to follow
local function lantern_where()
  if lantern.x then return lantern.x, lantern.y end
  return SCENE.hook[1], SCENE.hook[2] + 9
end

local function lantern_loop()
  while true do
    clock.sync(LANTERN_BEATS[P("lantern_div")])
    if lantern.on then
      lantern.beat = 1
      local x, y = lantern_where()
      local ev = swarm:pulse(x, y, 1, env())
      handle(ev, util.time())
      if P("lantern_sound") == 2 then
        local note = notes[1]
        if note then sound(1, note + 12, 0.08, x, 0.3, 0.6) end
      end
    end
  end
end

-- a call: a note from a MIDI keyboard flashes a light the fireflies answer
local function call(note, vel)
  local lo, hi = P("root"), P("root") + 12 * P("octaves")
  local x = util.linlin(lo, hi, 8, 120, util.clamp(note, lo, hi))
  local y = util.linlin(0, 127, 52, 26, vel)
  local ev = swarm:pulse(x, y, 0.4 + vel / 127 * 0.8, env())
  handle(ev, util.time())
  if P("midi_in_sound") == 2 then
    local v = P("voice")
    sound(v == 6 and 1 or v, note, 0.12 * vel / 127 + 0.03, x, P("timbre"), P("decay"))
  end
end

-- ------------------------------------------------------------- the scene

local function load_images()
  local function load(name)
    local ok, im = pcall(screen.load_png, norns.state.path .. "img/" .. name .. ".png")
    if ok and im then IMG[name] = im end
  end
  for i = 0, 11 do load(string.format("sky_%02d", i)) end
  for _, n in ipairs({ "far", "near", "mist", "moon", "lantern" }) do load(n) end
end

local function img(name, x, y)
  local i = IMG[name]
  if i then screen.display_image(i, x or 0, y or 0) end
end

local function init_scenery()
  for i = 1, 46 do
    -- only where there is sky: the oak's crown reaches the top of the screen
    local x = math.random(0, 127)
    while SCENE.skyline[x + 1] < 4 do x = math.random(0, 127) end
    local y = math.random(0, SCENE.skyline[x + 1] - 2)
    local bright = math.random() < 0.12
    stars[i] = { x = x, y = y, base = bright and (5 + math.random() * 3) or (1.5 + math.random() * 2.5),
      ph = math.random() * 6.28, sp = 0.6 + math.random() * 2.4, big = bright }
  end
  -- grass in front of everything: thicker at the edges, a little gap in the middle
  for i = 1, 52 do
    local x = math.random(-2, 129)
    if math.abs(x - 72) < 14 and math.random() < 0.6 then x = x + 28 end
    local col = util.clamp(math.floor(x) + 1, 1, 128)
    grass[i] = { x = x, y = 63 + math.random(0, 2), h = 4 + math.random() * (x < 40 and 9 or 7),
      ph = math.random() * 6.28, stiff = 0.6 + math.random() * 0.8, lit = math.random() < 0.4, base = SCENE.ground[col] }
  end
end

local function draw_stars(t)
  local light = starlight(t)
  if light <= 0 then return end
  for _, s in ipairs(stars) do
    local tw = 0.65 + 0.35 * math.sin(now_t * s.sp + s.ph)
    local lvl = math.floor(s.base * tw * light + 0.5)
    if lvl > 0 then
      screen.level(lvl)
      screen.pixel(s.x, s.y)
      screen.fill()
      if s.big and tw > 0.9 and lvl > 4 then
        screen.level(math.max(1, lvl - 4))
        screen.pixel(s.x - 1, s.y) screen.pixel(s.x + 1, s.y)
        screen.pixel(s.x, s.y - 1) screen.pixel(s.x, s.y + 1)
        screen.fill()
      end
    end
  end
end

local function draw_shooting(t)
  if shooting == nil then
    if starlight(t) > 0.6 and math.random() < DT / 70 then
      shooting = { x = math.random(30, 120), y = math.random(1, 8), life = 1, dx = -(1.6 + math.random()), dy = 0.6 + math.random() * 0.4 }
      local note = notes[#notes]
      if note and P("sky_sound") == 2 then sound(1, note + 12, 0.03, shooting.x, 0.9, 1.4) end
    end
    return
  end
  local s = shooting
  screen.blend_mode("add")
  for k = 0, 7 do
    local lvl = math.floor((8 - k) * 1.6 * s.life)
    if lvl > 0 then
      screen.level(math.min(15, lvl))
      screen.pixel(math.floor(s.x - s.dx * k * 0.9), math.floor(s.y - s.dy * k * 0.9))
      screen.fill()
    end
  end
  screen.blend_mode("over")
  s.x, s.y, s.life = s.x + s.dx * 2.2, s.y + s.dy * 2.2, s.life - 0.06
  if s.life <= 0 or s.x < 0 or s.y > (SCENE.skyline[util.clamp(math.floor(s.x) + 1, 1, 128)] or 30) then shooting = nil end
end

local function draw_moon(t)
  if IMG.moon == nil then return end
  local frac = moon_fraction()
  local frame = util.clamp(math.floor(frac * 8 + 0.5), 0, 8)
  local mx = math.floor(util.linlin(0, 1, 104, 72, t))
  local my = math.floor(10 - math.sin(t * math.pi) * 5)
  local M = SCENE.moon
  -- a halo, wider the more the moon is full: crisp steps, not soft edges
  -- (a soft edge one level above a dithered sky reads as a dotted ring)
  if frac > 0.45 then
    screen.aa(0)
    screen.blend_mode("add")
    screen.level(1)
    screen.circle(mx + 6.5, my + 6.5, 6 + frac * 5)
    screen.fill()
    if frac > 0.8 then
      screen.circle(mx + 6.5, my + 6.5, 8)
      screen.fill()
    end
    screen.blend_mode("over")
  end
  screen.display_image_region(IMG.moon, frame * M, 0, M, M, mx, my)
end

local function draw_mist(t)
  local m = mistiness(t)
  if m < 0.2 or IMG.mist == nil then return end
  local ox = math.floor(now_t * 2) % 128
  screen.display_image_region(IMG.mist, ox, 0, 128 - ox, 16, 0, 34)
  if ox > 0 then screen.display_image_region(IMG.mist, 0, 0, ox, 16, 128 - ox, 34) end
  if m > 0.6 then
    local o2 = (ox + 64) % 128
    screen.display_image_region(IMG.mist, o2, 0, 128 - o2, 16, 0, 39)
    if o2 > 0 then screen.display_image_region(IMG.mist, 0, 0, o2, 16, 128 - o2, 39) end
  end
end

local function draw_fly(fl)
  if fl.glow <= 0.02 and #fl.trail == 0 then return end
  local x, y, gl, z = fl.x, fl.y, fl.glow, fl.z
  screen.blend_mode("add")
  -- the trail of a flash: the J it drew in the air, as one fading streak
  -- (dots, at this size, read as a broken ring)
  if P("trails") == 2 and #fl.trail > 1 then
    for k = 1, #fl.trail - 1 do
      local a, b = fl.trail[k], fl.trail[k + 1]
      local lvl = math.floor((1 - k / #fl.trail) * 6 * z * (gl + 0.35) + 0.5)
      if lvl > 0 and math.abs(a[1] - b[1]) < 6 and math.abs(a[2] - b[2]) < 6 then
        screen.level(lvl)
        screen.move(a[1] + 0.5, a[2] + 0.5)
        screen.line(b[1] + 0.5, b[2] + 0.5)
        screen.stroke()
      end
    end
  end
  if gl > 0.02 then
    screen.aa(1)
    local r = 1.2 + 2.6 * z
    local outer = math.floor(2.4 * gl * (0.5 + z * 0.5) + 0.5)
    if outer > 0 then
      screen.level(outer)
      screen.circle(x, y, r + 1.6)
      screen.fill()
    end
    local inner = math.floor(5.5 * gl + 0.5)
    if inner > 0 then
      screen.level(inner)
      screen.circle(x, y, r * 0.7)
      screen.fill()
    end
    screen.aa(0)
    screen.level(math.min(15, math.floor(15 * gl * (0.6 + z * 0.4) + 1)))
    screen.pixel(math.floor(x), math.floor(y))
    if z > 0.8 and gl > 0.5 then screen.pixel(math.floor(x) + 1, math.floor(y)) end
    screen.fill()
  end
  screen.blend_mode("over")
end

local function draw_flies(far)
  for _, fl in ipairs(swarm.flies) do
    if (fl.z < 0.55) == far then draw_fly(fl) end
  end
end

local function draw_calls()
  screen.aa(1)
  screen.blend_mode("add")
  for _, c in ipairs(swarm.calls) do
    local lvl = math.floor(c.life * 4 * c.strength + 0.5)
    if lvl > 0 then
      screen.level(lvl)
      screen.move(c.x + c.r, c.y)
      screen.circle(c.x, c.y, c.r)
      screen.stroke()
    end
  end
  screen.blend_mode("over")
  screen.aa(0)
end

local function draw_lantern()
  local x, y = lantern_where()
  local hangs = (lantern.x == nil)
  local lx, ly = math.floor(x) - 3, math.floor(y) - 4
  if hangs then
    screen.level(3)
    screen.move(SCENE.hook[1] + 0.5, SCENE.hook[2])
    screen.line(SCENE.hook[1] + 0.5, ly)
    screen.stroke()
  else
    -- a stake planted in the meadow
    screen.level(2)
    screen.move(lx + 3.5, ly + 9)
    screen.line(lx + 3.5, math.min(63, ly + 20))
    screen.stroke()
  end
  img("lantern", lx, ly)
  if not lantern.on then return end
  local e = lantern.beat
  screen.aa(1)
  screen.blend_mode("add")
  screen.level(math.max(1, math.floor(2 * e + 1)))
  screen.circle(lx + 3.5, ly + 4.5, 7 + e * 3)
  screen.fill()
  screen.level(math.floor(4 * e + 2))
  screen.circle(lx + 3.5, ly + 4.5, 3.2)
  screen.fill()
  screen.blend_mode("over")
  screen.aa(0)
  screen.level(math.min(15, math.floor(7 + 8 * e)))
  screen.rect(lx + 2, ly + 3, 3, 4)
  screen.fill()
end

local function draw_grass(t)
  local sway_amp = 0.5 + P("wind") * 2.4
  local lit = (t < 0.15 or t > 0.85) and 4 or 2
  for _, b in ipairs(grass) do
    local sway = math.sin(now_t * (1.1 + P("wind")) * b.stiff + b.ph + b.x * 0.09) * sway_amp
      + gust_level * gust_dir * 5 * b.stiff
    local tipx = b.x + sway
    local tipy = b.y - b.h
    local midx = b.x + sway * 0.35
    local midy = b.y - b.h * 0.55
    screen.level(b.lit and lit or 1)
    screen.move(b.x + 0.5, b.y)
    screen.line(midx + 0.5, midy)
    screen.line(tipx + 0.5, tipy)
    screen.stroke()
  end
end

local function draw_text()
  local now = util.time()
  if now < banner_until then
    local a = util.clamp((banner_until - now) / 0.8, 0, 1)
    screen.level(math.floor(10 * a + 1))
    screen.font_face(1)
    screen.font_size(8)
    screen.move(64, 30)
    screen.text_center("fireflies")
    screen.level(math.floor(4 * a + 1))
    screen.move(64, 39)
    screen.text_center("K2 lantern  K3 wind")
  end
  if message and now < message_until then
    local a = util.clamp((message_until - now) / 0.5, 0, 1)
    screen.level(math.floor(11 * a + 1))
    screen.font_face(1)
    screen.font_size(8)
    screen.move(2, 7)
    screen.text(message)
  end
end

function redraw()
  local t = P("night")
  screen.clear()
  screen.aa(0)
  screen.line_width(1)
  img(string.format("sky_%02d", util.clamp(math.floor(t * 11 + 0.5), 0, 11)))
  draw_stars(t)
  draw_shooting(t)
  draw_moon(t)
  img("far")
  draw_mist(t)
  draw_flies(true)
  img("near")
  draw_lantern()
  draw_calls()
  draw_flies(false)
  draw_grass(t)
  if chorus_glow > 0.05 then
    screen.blend_mode("add")
    screen.level(math.floor(chorus_glow * 1.5 + 0.5))
    screen.rect(0, 0, 128, 64)
    screen.fill()
    screen.blend_mode("over")
  end
  draw_text()
  screen.update()
end

-- ----------------------------------------------------------------- grid

local GRID_TOP, GRID_BOTTOM = 14, 62

local function cell_of(x, y)
  local cx = util.clamp(math.floor(x / 128 * 16) + 1, 1, 16)
  local cy = util.clamp(math.floor((y - GRID_TOP) / (GRID_BOTTOM - GRID_TOP) * 8) + 1, 1, 8)
  return cx, cy
end

local function cell_center(cx, cy)
  return (cx - 0.5) * 8, GRID_TOP + (cy - 0.5) * (GRID_BOTTOM - GRID_TOP) / 8
end

local function grid_redraw()
  if g.device == nil then return end
  local lv = {}
  local base = math.floor(chorus_glow * 3)
  local show_all = P("grid_shows") == 2
  for _, fl in ipairs(swarm.flies) do
    local cx, cy = cell_of(fl.x, fl.y)
    local k = (cy - 1) * 16 + cx
    local l = 0
    if fl.glow > 0.03 then l = math.floor(3 + fl.glow * 12 * (0.6 + fl.z * 0.4)) end
    if show_all and fl.active and l < 2 then l = 2 end
    if l > (lv[k] or 0) then lv[k] = l end
  end
  if lantern.on then
    local x, y = lantern_where()
    local cx, cy = cell_of(x, y)
    local k = (cy - 1) * 16 + cx
    lv[k] = math.max(lv[k] or 0, math.floor(4 + lantern.beat * 11))
  end
  for y = 1, 8 do
    for x = 1, 16 do
      g:led(x, y, util.clamp(math.max(base, lv[(y - 1) * 16 + x] or 0), 0, 15))
    end
  end
  g:refresh()
end

-- tap: a firefly there, or away if there is one; hold: the lantern goes there
g.key = function(x, y, z)
  local k = x .. "," .. y
  if z == 1 then
    grid_down[k] = util.time()
    return
  end
  local t0 = grid_down[k]
  grid_down[k] = nil
  if t0 == nil then return end
  local px, py = cell_center(x, y)
  if util.time() - t0 >= 0.6 then
    lantern.x, lantern.y = px, py
    lantern.on = true
    say("lantern here")
    return
  end
  local near = nil
  for _, fl in ipairs(swarm.flies) do
    local cx, cy = cell_of(fl.x, fl.y)
    if cx == x and cy == y then near = fl break end
  end
  if near then
    swarm:remove_near(near.x, near.y, 2)
    params:set("count", #swarm.flies, true)
  elseif #swarm.flies < 64 then
    local fl = swarm:spawn(px + (math.random() - 0.5) * 4, py, 0.6 + math.random() * 0.4)
    fl.phase = math.random()
    params:set("count", #swarm.flies, true)
  end
end

-- ----------------------------------------------------------------- midi

local function connect_midi()
  midi_out = (P("midi_out") > 1) and midi.connect(P("midi_out") - 1) or nil
  if midi_in then midi_in.event = nil end
  midi_in = (P("midi_in") > 1) and midi.connect(P("midi_in") - 1) or nil
  if midi_in then
    midi_in.event = function(data)
      local msg = midi.to_msg(data)
      if msg.type ~= "note_on" or msg.vel == 0 then return end
      local ch = P("midi_in_ch")
      if ch > 1 and msg.ch ~= ch - 1 then return end
      call(msg.note, msg.vel)
    end
  end
end

local function all_notes_off()
  if midi_out == nil then return end
  for _, n in pairs(hanging) do midi_out:note_off(n[1], 0, n[2]) end
  hanging = {}
end

-- --------------------------------------------------------------- controls

function enc(n, d)
  if held[1] then
    if n == 1 then
      params:delta("wind", d)
      say(string.format("wind %.2f", P("wind")))
    elseif n == 2 then
      params:delta("reach", d)
      say(string.format("reach %d", P("reach")))
    else
      params:delta("period", d)
      say(string.format("period %.2f s", P("period")))
    end
    return
  end
  if n == 1 then
    params:delta("night", d)
    say(clock_text(P("night")) .. "  " .. phase_name(P("night")))
  elseif n == 2 then
    params:delta("coupling", d)
    say(string.format("coupling %.2f", P("coupling")))
  else
    params:delta("count", d)
    say(P("count") .. " fireflies")
  end
end

function key(n, z)
  held[n] = (z == 1)
  if z == 0 then return end
  if held[1] and n == 2 then
    swarm:scatter()
    say("scattered")
  elseif held[1] and n == 3 then
    params:delta("voice", 1)
    say("voice: " .. VOICES[P("voice")])
  elseif n == 2 then
    lantern.on = not lantern.on
    say(lantern.on and ("lantern on, every " .. LANTERN_DIV[P("lantern_div")]) or "lantern off")
  elseif n == 3 then
    blow(P("gust_strength"))
    say("a gust of wind")
  end
end

-- ------------------------------------------------------------- the params

local function add_params()
  for i, s in ipairs(musicutil.SCALES) do scale_names[i] = s.name end
  local start_scale = 1
  for i, n in ipairs(scale_names) do
    if n == "Major Pentatonic" then start_scale = i end
  end
  local midi_names = { "off" }
  for i = 1, 16 do
    local d = midi.vports[i]
    midi_names[#midi_names + 1] = i .. ": " .. ((d and d.name and d.name ~= "none") and d.name or "-")
  end

  params:add_separator("fireflies", "fireflies")
  -- no step: the night going by on its own moves it a little every frame,
  -- and a step would round that back each time; E1 moves it by the quantum
  params:add_control("night", "hour of the night", controlspec.new(0, 1, "lin", 0, 0.16, "", 0.004),
    function(p) return clock_text(p:get()) .. " " .. phase_name(p:get()) end)
  params:add_option("cycle", "the night goes by", CYCLE, 4)
  params:add_number("count", "fireflies", 4, 64, 32)
  params:set_action("count", function(n) if swarm then swarm:resize(n) end end)
  params:add_control("coupling", "coupling", controlspec.new(0, 1, "lin", 0.01, 0.5))
  params:add_number("reach", "reach", 10, 128, 45, function(p) return p:get() .. " px" end)
  params:add_control("period", "period", controlspec.new(0.6, 4, "exp", 0, 1.6, "s"))
  params:add_number("spread", "tempo spread", 0, 40, 10, function(p) return p:get() .. "%" end)
  params:add_control("drift", "drift", controlspec.new(0, 1, "lin", 0.01, 0.4))
  params:add_control("glow", "flash length", controlspec.new(0.1, 1.5, "exp", 0, 0.42, "s"))
  params:add_option("trails", "trails", { "off", "on" }, 2)
  params:add_option("moon", "moon", MOON, 1)

  params:add_separator("fireflies_weather", "weather")
  params:add_control("wind", "wind", controlspec.new(0, 1, "lin", 0.01, 0.2))
  params:add_option("gusts", "gusts", GUSTS, 3)
  params:add_control("gust_strength", "gust strength", controlspec.new(0.05, 1, "lin", 0.01, 0.6))
  params:add_number("temperature", "temperature", 12, 32, 22, function(p) return p:get() .. " C" end)

  params:add_separator("fireflies_music", "music")
  params:add_option("scale", "scale", scale_names, start_scale)
  params:set_action("scale", build_notes)
  params:add_number("root", "root", 36, 84, 64, function(p) return musicutil.note_num_to_name(p:get(), true) end)
  params:set_action("root", build_notes)
  params:add_number("octaves", "octaves", 1, 4, 2)
  params:set_action("octaves", build_notes)
  params:add_option("pitch_from", "pitch from", PITCH_FROM, 1)
  params:add_option("voice", "voice", VOICES, 1)
  params:add_control("timbre", "brightness", controlspec.new(0, 1, "lin", 0.01, 0.5))
  params:add_control("decay", "decay", controlspec.new(0.3, 2.5, "exp", 0, 1))
  params:add_number("density", "notes a second", 1, 30, 9)
  params:add_option("chorus", "when they flash as one", CHORUS, 2)
  params:add_option("lantern_div", "lantern every", LANTERN_DIV, 3, nil)
  params:add_option("lantern_sound", "lantern rings", { "no", "yes" }, 1)
  params:add_control("level", "fireflies level", controlspec.new(0, 2, "lin", 0.01, 1))
  params:add_control("width", "stereo width", controlspec.new(0, 1, "lin", 0.01, 0.8))

  params:add_separator("fireflies_night", "the meadow")
  params:add_control("crickets", "crickets", controlspec.new(0, 1, "lin", 0.01, 0.5))
  params:add_control("frogs", "frogs", controlspec.new(0, 1, "lin", 0.01, 0.4))
  params:add_control("wind_sound", "wind in the grass", controlspec.new(0, 1, "lin", 0.01, 0.4))
  params:add_option("owls", "owls", OWLS, 2)
  params:add_option("birds", "birds at dawn", { "off", "on" }, 2)
  params:add_option("sky_sound", "shooting stars ring", { "no", "yes" }, 2)

  params:add_separator("fireflies_space", "space")
  params:add_control("space", "space", controlspec.new(0, 1, "lin", 0.01, 0.45))
  params:set_action("space", function(v) engine.space(v) end)
  params:add_control("echo_level", "echo level", controlspec.new(0, 1, "lin", 0.01, 0.35))
  params:set_action("echo_level", function(v) engine.emix(v) end)
  params:add_control("echo_fb", "echo feedback", controlspec.new(0, 0.85, "lin", 0.01, 0.4))
  params:set_action("echo_fb", function(v) engine.efb(v) end)
  params:add_control("echo_time", "echo time", controlspec.new(0.08, 1.5, "exp", 0, 0.48, "s"))
  params:set_action("echo_time", function(v) engine.etime(v) end)
  params:add_control("volume", "volume", controlspec.new(0, 1.5, "lin", 0.01, 1))
  params:set_action("volume", function(v) engine.level(v) end)

  params:add_separator("fireflies_midi", "midi")
  params:add_option("midi_out", "notes out to", midi_names, 1)
  params:set_action("midi_out", function() all_notes_off() connect_midi() end)
  params:add_number("midi_out_ch", "out channel", 1, 16, 1)
  params:add_control("midi_len", "note length", controlspec.new(0.05, 2, "exp", 0, 0.25, "s"))
  params:add_number("midi_vel_min", "softest", 1, 127, 40)
  params:add_number("midi_vel_max", "loudest", 1, 127, 110)
  params:add_option("midi_in", "calls in from", midi_names, 1)
  params:set_action("midi_in", connect_midi)
  params:add_option("midi_in_ch", "in channel", { "all", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16" }, 1)
  params:add_option("midi_in_sound", "calls ring", { "no", "yes" }, 2)

  params:add_separator("fireflies_grid", "grid")
  params:add_option("grid_shows", "grid shows", GRID_SHOWS, 2)
end

-- ------------------------------------------------------------------- life

local function step()
  local now = util.time()
  now_t = now - start_time
  -- the night goes by on its own, if asked
  local cyc = CYCLE_MIN[P("cycle")]
  if cyc > 0 then
    local t = P("night") + DT / (cyc * 60)
    if t > 1 then t = 0 end
    params:set("night", t, true)
  end
  local t = P("night")

  -- gusts, now and then
  if math.random() < GUST_RATE[P("gusts")] * DT then
    blow(P("gust_strength") * (0.5 + math.random() * 0.5))
  end
  gust_level = math.max(0, gust_level - DT * 0.45)

  handle(swarm:step(DT, env()), now)
  local R = swarm:sync()
  sync_shown = sync_shown + (R - sync_shown) * 0.02
  lantern.beat = math.max(0, lantern.beat - DT * 3)
  chorus_glow = math.max(0, chorus_glow - DT * 4)

  -- the meadow's own sounds, a few times a second
  if now - ambience_at > 0.25 then
    ambience_at = now
    engine.night(P("crickets") * crickets_now(t), cricket_rate(), P("frogs") * frogs_now(t), P("wind_sound") * (0.3 + P("wind")))
  end
  -- an owl in the depth of the night
  if P("owls") > 1 and t > 0.25 and t < 0.85 then
    if next_owl == 0 then next_owl = now + 10 + math.random() * 30 end
    if now > next_owl then
      engine.owl(0.12 + math.random() * 0.08, (math.random() - 0.5) * 1.4)
      next_owl = now + (P("owls") == 3 and 12 or 45) * (0.5 + math.random())
    end
  end
  -- and the first birds, when the sky pales
  if P("birds") == 2 and t > 0.86 then
    if now > next_bird then
      engine.bird(0.04 + math.random() * 0.05, (math.random() - 0.5) * 1.6)
      next_bird = now + (1.2 + math.random() * 6) * (1.05 - (t - 0.86) / 0.14)
    end
  end
end

function init()
  math.randomseed(os.time())
  start_time = util.time()
  swarm = Swarm.new(math.random)
  add_params()
  util.make_dir(DATA)
  if util.file_exists(DATA .. "state.pset") then params:read(DATA .. "state.pset") end
  params:bang()
  build_notes()
  swarm:resize(P("count"))
  load_images()
  init_scenery()
  connect_midi()
  banner_until = util.time() + 3

  sim = metro.init(function()
    step()
    redraw()
    grid_redraw()
  end, DT)
  sim:start()
  lantern.clock = clock.run(lantern_loop)
end

function cleanup()
  params:write(DATA .. "state.pset")
  if sim then sim:stop() end
  if lantern.clock then clock.cancel(lantern.clock) end
  all_notes_off()
  engine.night(0, 1, 0, 0)
end
