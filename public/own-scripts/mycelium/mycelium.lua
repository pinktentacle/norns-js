-- mycelium
-- a fungus under the forest floor,
-- and what it carries
--
-- E1 the season
-- E2 / E3 move through the soil
-- K2 feed it: leaf litter here
-- K3 touch the network: it rings
--    (hold to keep tapping)
--
-- K1+K2 plant a spore here
-- K1+K3 cut it here (at the
--       surface: pick a mushroom)
-- K1+E1 growth   K1+E2 scale
-- K1+E3 root
--
-- grid (optional): the ground
-- MIDI: notes out, touches in

engine.name = "Mycelium"

local musicutil = require "musicutil"
local Net = include "lib/network"
local SCENE = include "lib/scene"

local DATA = _path.data .. "mycelium/"
local DT = 1 / 24

local VOICES = { "wood", "drop", "glass", "bow", "pluck", "each colony its own" }
local PITCH_FROM = { "depth in the soil", "distance along the net", "across" }
local SINGS = { "off", "a chord", "a swell" }
local RAIN = { "never", "now and then", "often", "always" }
local RAIN_RATE = { 0, 1 / 240, 1 / 90, 0 }
local BEATS = { "rare", "sometimes", "often", "off" }
local BEAT_RATE = { 0.08, 0.2, 0.5, 0 }
local YEAR = { "off", "5 min", "10 min", "20 min", "40 min", "80 min" }
local YEAR_MIN = { 0, 5, 10, 20, 40, 80 }
local SEASONS = { "spring", "summer", "autumn", "winter" }
local TAP_DIV = { "1/4", "1/2", "1" }
local TAP_BEATS = { 0.25, 0.5, 1 }
local GRID_SHOWS = { "signals", "signals and hyphae" }

local net
local IMG = {}
local notes, scale_names = {}, {}
local held = { false, false, false }
local cursor = { x = 64, y = 34, moved = 0 }
local message, message_until = nil, 0
local banner_until = 0
local now_t, start_time = 0, 0
local sim
local recent_notes = {}
local flakes = {} -- leaves in autumn, snow in winter, rain when it rains
local raining_until = 0
local tapping = nil
local g = grid.connect()
local grid_down = {}
local midi_out, midi_in
local hanging = {}
local earth_at = 0

local function P(id) return params:get(id) end
local function say(text) message, message_until = text, util.time() + 1.6 end

-- ----------------------------------------------------------------- the year

local function season_name(s)
  s = s % 4
  local i = math.floor(s)
  local u = s - i
  local part = u < 0.33 and "early " or (u > 0.66 and "late " or "")
  return part .. SEASONS[i + 1]
end

local function raining() return P("rain") == 4 or util.time() < raining_until end

-- ----------------------------------------------------------------- notes

local function build_notes()
  notes = musicutil.generate_scale(P("root"), scale_names[P("scale")], P("octaves"))
end

local function degree_of(nd)
  local n = #notes
  local mode = P("pitch_from")
  local u
  if mode == 1 then
    local gnd = net:ground(nd.x)
    u = 1 - util.clamp((nd.y - gnd) / (63 - gnd), 0, 1)
  elseif mode == 2 then
    return nd.hops % n
  else
    u = util.clamp(nd.x / 127, 0, 1)
  end
  return util.clamp(math.floor(u * (n - 1) + 0.5), 0, n - 1)
end

local function allowed(now)
  local keep = {}
  for _, t in ipairs(recent_notes) do
    if now - t < 1 then keep[#keep + 1] = t end
  end
  recent_notes = keep
  if #recent_notes >= P("density") then return false end
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
  engine.note(voice, musicutil.note_num_to_freq(note), amp * 1.4 * P("level"),
    util.linlin(0, 127, -0.85, 0.85, x) * P("width"), bright, decay)
  local vmin, vmax = P("midi_vel_min"), P("midi_vel_max")
  midi_note(note, math.floor(util.clamp(vmin + (vmax - vmin) * math.min(1, amp / 0.18), 1, 127)))
end

local function voice_of(colony)
  local v = P("voice")
  if v < 6 then return v end
  return ((colony and colony.id or 1) - 1) % 5 + 1
end

local function play_node(nd, strength, kind)
  if not allowed(util.time()) then return end
  local note = notes[degree_of(nd) + 1]
  if note == nil then return end
  local amp = 0.15 * (0.35 + 0.65 * strength)
  if kind == "beat" then amp = amp * 0.7 end
  sound(voice_of(nd.colony), note, amp, nd.x, P("timbre") * (0.5 + strength * 0.5), P("decay"))
end

-- a mushroom opening: a chord from the note under it
local function bloom(m)
  local mode = P("sings")
  if mode == 1 then return end
  local d = degree_of(m.node)
  local n = #notes
  for k, step in ipairs({ 0, 2, 4 }) do
    local note = notes[util.clamp(d + step, 0, n - 1) + 1]
    if note then
      if mode == 2 then
        sound(6, note - 12, 0.06, m.x + (k - 2) * 10, P("timbre"), P("decay"))
      else
        sound(6, note - 12, 0.05, m.x + (k - 2) * 10, 0.05, P("decay") * 2)
      end
    end
  end
end

-- ---------------------------------------------------------------- the net

local function env()
  return {
    speed = P("growth"),
    branch = P("branching") / 100,
    sense = P("sense"),
    crowd = P("crowd"),
    max_nodes = P("max_hyphae"),
    decay = P("reach"),
    pulse_speed = P("pulse_speed"),
    season_value = P("season"),
    rain = raining(),
    die = P("dieback"),
    fruit = P("fruiting"),
    spores = P("spores") / 100,
    wind = P("wind") * 0.6,
    heartbeat = BEAT_RATE[P("heartbeat")],
    max_colonies = P("colonies"),
    max_mushrooms = P("max_mushrooms"),
    trickle = 0.04,
  }
end

local function handle(events)
  for _, e in ipairs(events) do
    if e.kind == "note" then
      play_node(e.node, e.strength, e.wave)
    elseif e.kind == "fuse" then
      if allowed(util.time()) then
        local note = notes[math.min(#notes, degree_of(e.node) + 3)]
        if note then sound(3, note + 12, 0.05, e.node.x, 0.8, 0.8) end
      end
    elseif e.kind == "root" then
      -- the first root a colony reaches: a low bowed note, and a word
      if e.first then
        local note = notes[1]
        if note then sound(4, note - 12, 0.07, e.node.x, 0.3, 1.2) end
        say("it reaches the oak")
      elseif allowed(util.time()) then
        local note = notes[1]
        if note then sound(4, note, 0.04, e.node.x, 0.3, 0.8) end
      end
    elseif e.kind == "open" then
      bloom(e.mushroom)
    elseif e.kind == "feed" then
      -- food found: the net carries the news (once in a while per patch)
      local f = e.food
      if f.rang == nil or net.time - f.rang > 5 then
        f.rang = net.time
        net:wave(e.node, 0.7, "feed", env())
      end
    elseif e.kind == "meet" then
      local note = notes[1]
      if note and allowed(util.time()) then sound(1, note, 0.05, e.node.x, 0.2, 0.7) end
    elseif e.kind == "pin" then
      local note = notes[#notes]
      if note and allowed(util.time()) then sound(2, note + 12, 0.03, e.node.x, 0.4, 0.5) end
    elseif e.kind == "colony" then
      local note = notes[#notes]
      if note then sound(2, note, 0.06, e.node.x, 0.6, 1) end
    end
  end
end

local function touch(x, y, strength)
  local nd = net:pluck(x, y, 14, strength or 1, env())
  if nd then
    handle(net.pending)
    net.pending = {}
  end
  return nd
end

local function tap_loop()
  while true do
    clock.sync(TAP_BEATS[P("tap_div")])
    if held[3] and not held[1] then touch(cursor.x, cursor.y, 0.9) end
  end
end

-- a touch from a MIDI keyboard: a node whose note is the note played
local function midi_touch(note, vel)
  local want = nil
  local best = {}
  for _, nd in ipairs(net.nodes) do
    if not nd.gone and Net.sings(nd) then
      local nn = notes[degree_of(nd) + 1]
      if nn == note then best[#best + 1] = nd end
      if want == nil or (nn and math.abs(nn - note) < math.abs((notes[degree_of(want) + 1] or 0) - note)) then want = nd end
    end
  end
  local nd = (#best > 0) and best[math.random(#best)] or want
  if nd then
    net:wave(nd, 0.4 + vel / 127 * 0.6, "pluck", env())
    handle(net.pending)
    net.pending = {}
  end
end

-- ------------------------------------------------------------- the scene

local function load_images()
  local function load(name)
    local ok, im = pcall(screen.load_png, norns.state.path .. "img/" .. name .. ".png")
    if ok and im then IMG[name] = im end
  end
  for _, s in ipairs(SEASONS) do load("surface_" .. s) end
  load("soil")
  load("mushrooms")
end

local function img(name, x, y)
  local i = IMG[name]
  if i then screen.display_image(i, x or 0, y or 0) end
end

-- a pile of leaf litter rotting: a speckled patch, smaller as it is eaten
local litter = { {}, {}, {}, {} }
local function draw_food()
  for l = 1, 4 do local b = litter[l] for i = #b, 1, -1 do b[i] = nil end end
  for _, f in ipairs(net.food) do
    local r = 1 + f.amount * 0.45
    local x0, y0 = math.floor(f.x), math.floor(f.y)
    for dy = -math.ceil(r), math.ceil(r) do
      for dx = -math.ceil(r * 1.3), math.ceil(r * 1.3) do
        local d = (dx / 1.3) ^ 2 + dy * dy
        if d <= r * r then
          local h = ((x0 + dx) * 73 + (y0 + dy) * 31 + math.floor(f.born * 10)) % 7
          local lvl = (h < 2) and 4 or ((h < 4) and 3 or 2)
          if f.lasting then lvl = lvl - 1 end
          if lvl > 0 then
            local b = litter[lvl]
            b[#b + 1] = x0 + dx
            b[#b + 1] = y0 + dy
          end
        end
      end
    end
  end
  for l = 1, 4 do
    local b = litter[l]
    if #b > 0 then
      screen.level(l)
      for i = 1, #b, 2 do screen.rect(b[i], b[i + 1], 1, 1) end
      screen.fill()
    end
  end
end

-- the hyphae: every segment, bucketed by brightness, one stroke a bucket
local buckets = {}
local function draw_hyphae(t)
  for l = 1, 12 do buckets[l] = buckets[l] or {} local b = buckets[l] for i = #b, 1, -1 do b[i] = nil end end
  local winter = math.max(0, 1 - math.abs(((t % 4) - 3.2)) / 0.8)
  for _, nd in ipairs(net.nodes) do
    local p = nd.parent
    if p and (not nd.gone or (nd.fade and nd.fade > 0)) then
      -- the older the thread (the more hangs from it), the thicker and whiter
      local base = 4 + math.min(6, math.floor(math.log(nd.desc + 1) * 1.4))
      if nd.gone then base = math.floor(base * nd.fade) end
      base = base - math.floor(winter * 2 + 0.5)
      local lvl = util.clamp(base, 1, 12)
      local b = buckets[lvl]
      b[#b + 1] = p.x b[#b + 1] = p.y b[#b + 1] = nd.x b[#b + 1] = nd.y
    end
    if not nd.gone then
      for _, l in ipairs(nd.links) do
        if not l.gone and l.id < nd.id then
          local b = buckets[7]
          b[#b + 1] = l.x b[#b + 1] = l.y b[#b + 1] = nd.x b[#b + 1] = nd.y
        end
      end
    end
  end
  -- crisp one-pixel threads: antialiasing smears them at this size
  screen.aa(0)
  screen.line_width(1)
  local fl = math.floor
  for lvl = 1, 12 do
    local b = buckets[lvl]
    if #b > 0 then
      screen.level(lvl)
      for i = 1, #b, 4 do
        screen.move(fl(b[i]) + 0.5, fl(b[i + 1]) + 0.5)
        screen.line(fl(b[i + 2]) + 0.5, fl(b[i + 3]) + 0.5)
      end
      screen.stroke()
    end
  end
end

local function draw_signals()
  screen.blend_mode("add")
  -- nodes a wave has just passed
  for _, nd in ipairs(net.nodes) do
    if not nd.gone and nd.glow > 0.08 then
      local lvl = math.floor(nd.glow * 9 + 0.5)
      if lvl > 0 then
        screen.level(lvl)
        screen.pixel(math.floor(nd.x), math.floor(nd.y))
        screen.fill()
      end
    end
  end
  -- waves on their way
  screen.aa(1)
  for _, p in ipairs(net.pulses) do
    local u = p.t / p.dur
    local x = p.from.x + (p.to.x - p.from.x) * u
    local y = p.from.y + (p.to.y - p.from.y) * u
    if p.s > 0.45 then
      screen.level(math.floor(p.s * 3 + 0.5))
      screen.circle(x + 0.5, y + 0.5, 1.8)
      screen.fill()
    end
    screen.level(math.min(15, math.floor(5 + p.s * 10)))
    screen.rect(math.floor(x), math.floor(y), 1, 1)
    screen.fill()
  end
  screen.aa(0)
  screen.blend_mode("over")
  -- the growing tips
  for _, t in ipairs(net.tips) do
    screen.level(10 + math.floor(3 * math.sin(now_t * 6 + t.x)))
    screen.pixel(math.floor(t.x), math.floor(t.y))
    screen.fill()
  end
end

local function draw_seeps()
  for _, s in ipairs(net.seeps) do
    screen.level(math.max(1, math.floor(3 * s.life)))
    screen.pixel(math.floor(s.x), math.floor(s.y))
    screen.fill()
  end
end

-- a mushroom stands on the surface, joined to its node by a cord
local function draw_mushrooms_below()
  for _, m in ipairs(net.mushrooms) do
    if m.node and not m.node.gone then
      local gnd = net:ground(m.x)
      screen.level(m.stage >= 3 and 6 or 4)
      screen.move(m.node.x + 0.5, m.node.y)
      screen.line(m.x + 0.5, gnd + 1)
      screen.stroke()
    end
  end
end

local function draw_mushrooms()
  local M = SCENE.mushroom
  if IMG.mushrooms == nil then return end
  for _, m in ipairs(net.mushrooms) do
    local stage = math.min(4, math.floor(m.stage))
    local f = (m.kind - 1) * 5 + stage
    local gnd = net:ground(m.x)
    screen.display_image_region(IMG.mushrooms, f * M[1], 0, M[1], M[2], m.x - 5, gnd - M[2] + 1)
  end
end

local function draw_spores()
  for _, s in ipairs(net.spores) do
    screen.level(math.max(2, math.floor(8 * s.life)))
    screen.pixel(math.floor(s.x), math.floor(s.y))
    screen.fill()
  end
end

-- the weather above: leaves falling in autumn, snow in winter, rain
local function step_flakes(t)
  local s = (t % 4)
  local kind = nil
  if raining() then kind = "rain"
  elseif s > 2.15 and s < 2.95 then kind = "leaf"
  elseif s > 3.05 and s < 3.9 then kind = "snow" end
  local rate = kind == "rain" and 12 or (kind == "leaf" and 0.5 or 1.5)
  if kind and math.random() < rate * DT * 4 then
    flakes[#flakes + 1] = { kind = kind, x = math.random() * 136 - 4, y = -1, ph = math.random() * 6.28,
      v = kind == "rain" and (40 + math.random() * 20) or (kind == "leaf" and (4 + math.random() * 4) or (3 + math.random() * 3)) }
  end
  local keep = {}
  for _, f in ipairs(flakes) do
    f.y = f.y + f.v * DT
    f.x = f.x + (P("wind") * 6 + (f.kind ~= "rain" and math.sin(now_t * 2 + f.ph) * 3 or 2)) * DT
    if f.y < net:ground(f.x) then keep[#keep + 1] = f end
  end
  flakes = keep
end

local function draw_flakes()
  for _, f in ipairs(flakes) do
    local x, y = math.floor(f.x), math.floor(f.y)
    if f.kind == "rain" then
      screen.level(6 + math.floor(f.ph) % 3)
      screen.move(x + 0.5, y)
      screen.line(x - 0.5, y + 4)
      screen.stroke()
    elseif f.kind == "snow" then
      screen.level(12)
      screen.pixel(x, y)
      screen.fill()
    else
      screen.level(6 + math.floor(math.sin(now_t * 4 + f.ph) * 2))
      screen.pixel(x, y)
      screen.pixel(x + ((math.sin(now_t * 3 + f.ph) > 0) and 1 or -1), y)
      screen.fill()
    end
  end
end

local function draw_cursor()
  local idle = util.time() - cursor.moved
  local lvl = idle < 2 and 10 or 4
  local x, y = math.floor(cursor.x), math.floor(cursor.y)
  screen.level(lvl)
  if y <= net:ground(x) + 1 then
    -- at the surface: an arrow pointing down at a mushroom
    screen.move(x - 1.5, y - 3) screen.line(x + 0.5, y - 1) screen.line(x + 2.5, y - 3) screen.stroke()
    return
  end
  for _, c in ipairs({ { -3, -3, 1, 1 }, { 3, -3, -1, 1 }, { -3, 3, 1, -1 }, { 3, 3, -1, -1 } }) do
    screen.move(x + c[1] + 0.5, y + c[2] + 0.5 + c[4])
    screen.line(x + c[1] + 0.5, y + c[2] + 0.5)
    screen.line(x + c[1] + 0.5 + c[3], y + c[2] + 0.5)
    screen.stroke()
  end
end

local function draw_text()
  local now = util.time()
  screen.font_face(1)
  screen.font_size(8)
  if now < banner_until then
    local a = util.clamp((banner_until - now) / 0.8, 0, 1)
    if a > 0.5 then
      screen.level(0)
      screen.rect(30, 32, 68, 21)
      screen.fill()
    end
    screen.level(math.floor(11 * a + 1))
    screen.move(64, 40)
    screen.text_center("mycelium")
    screen.level(math.floor(5 * a + 1))
    screen.move(64, 50)
    screen.text_center("K2 feed  K3 touch")
  end
  if message and now < message_until then
    local a = util.clamp((message_until - now) / 0.5, 0, 1)
    -- on a dark band, so the sky does not eat the letters
    local w = screen.text_extents(message)
    screen.level(0)
    screen.rect(0, 0, w + 4, 9)
    screen.fill()
    screen.level(math.floor(12 * a + 1))
    screen.move(2, 7)
    screen.text(message)
  end
end

function redraw()
  local t = P("season")
  screen.clear()
  screen.aa(0)
  screen.line_width(1)
  img("soil")
  draw_food()
  draw_seeps()
  draw_hyphae(t)
  draw_mushrooms_below()
  draw_signals()
  img("surface_" .. SEASONS[math.floor(t % 4) + 1])
  draw_mushrooms()
  draw_spores()
  draw_flakes()
  draw_cursor()
  draw_text()
  screen.update()
end

-- a spore the player plants: the kind of mushroom least seen in the soil
local function new_kind()
  local seen = { 0, 0, 0 }
  for _, c in ipairs(net.colonies) do seen[c.kind] = (seen[c.kind] or 0) + 1 end
  local best, least = {}, math.huge
  for k = 1, 3 do
    if seen[k] < least then best, least = { k }, seen[k]
    elseif seen[k] == least then best[#best + 1] = k end
  end
  return best[math.random(#best)]
end

-- ------------------------------------------------------------------ grid

local GRID_TOP = 16

local function cell_of(x, y)
  local cx = util.clamp(math.floor(x / 8) + 1, 1, 16)
  local cy = util.clamp(math.floor((y - GRID_TOP) / ((64 - GRID_TOP) / 8)) + 1, 1, 8)
  return cx, cy
end

local function cell_center(cx, cy)
  return (cx - 0.5) * 8, GRID_TOP + (cy - 0.5) * (64 - GRID_TOP) / 8
end

local function grid_redraw()
  if g.device == nil then return end
  local lv = {}
  local show_net = P("grid_shows") == 2
  for _, nd in ipairs(net.nodes) do
    if not nd.gone then
      local cx, cy = cell_of(nd.x, nd.y)
      local k = (cy - 1) * 16 + cx
      local l = show_net and 2 or 0
      if nd.glow > 0.08 then l = math.max(l, math.floor(3 + nd.glow * 12)) end
      if l > (lv[k] or 0) then lv[k] = l end
    end
  end
  for _, f in ipairs(net.food) do
    local cx, cy = cell_of(f.x, f.y)
    local k = (cy - 1) * 16 + cx
    lv[k] = math.max(lv[k] or 0, 4)
  end
  for _, m in ipairs(net.mushrooms) do
    local cx = cell_of(m.x, 20)
    lv[cx] = math.max(lv[cx] or 0, m.stage >= 3 and 12 or 6)
  end
  for y = 1, 8 do
    for x = 1, 16 do g:led(x, y, util.clamp(lv[(y - 1) * 16 + x] or 0, 0, 15)) end
  end
  g:refresh()
end

-- tap: touch the net there (or feed it, where there is none); hold: a spore
g.key = function(x, y, z)
  local k = x .. "," .. y
  if z == 1 then grid_down[k] = util.time() return end
  local t0 = grid_down[k]
  grid_down[k] = nil
  if t0 == nil then return end
  local px, py = cell_center(x, y)
  if util.time() - t0 >= 0.6 then
    if #net.colonies < P("colonies") and net:colony_at(px, py, new_kind()) then say("a spore takes") end
    return
  end
  if not touch(px, py, 1) then
    if not net:blocked(px, py) then net:feed(px, py, 5) say("leaf litter") end
  end
end

-- ------------------------------------------------------------------ midi

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
      midi_touch(msg.note, msg.vel)
    end
  end
end

local function all_notes_off()
  if midi_out == nil then return end
  for _, n in pairs(hanging) do midi_out:note_off(n[1], 0, n[2]) end
  hanging = {}
end

-- -------------------------------------------------------------- controls

function enc(n, d)
  if held[1] then
    if n == 1 then
      params:delta("growth", d)
      say(string.format("growth %.2f", P("growth")))
    elseif n == 2 then
      params:delta("scale", d)
      say(scale_names[P("scale")])
    else
      params:delta("root", d)
      say("root " .. musicutil.note_num_to_name(P("root"), true))
    end
    return
  end
  if n == 1 then
    params:delta("season", d)
    say(season_name(P("season")))
  elseif n == 2 then
    cursor.x = util.clamp(cursor.x + d * 1.5, 2, 125)
    cursor.moved = util.time()
  else
    cursor.y = util.clamp(cursor.y - d * 1.5, 6, 61)
    cursor.moved = util.time()
  end
end

function key(n, z)
  held[n] = (z == 1)
  if z == 0 then return end
  local x, y = cursor.x, cursor.y
  local in_soil = y > net:ground(x) + 1
  if held[1] and n == 2 then
    if #net.colonies >= P("colonies") then say("the soil is full of fungi")
    elseif net:colony_at(x, math.max(y, net:ground(x) + 3), new_kind()) then say("a spore takes")
    else say("nothing grows on stone") end
  elseif held[1] and n == 3 then
    if in_soil then
      local c = net:cut(x, y, 4)
      say(c > 0 and "cut" or "nothing to cut here")
    else
      local m = net:harvest(x, 6)
      if m then bloom(m) say("a mushroom picked") else say("no mushroom here") end
    end
  elseif n == 2 then
    if in_soil and not net:blocked(x, y) then
      net:feed(x, y, 6)
      local note = notes[math.max(1, #notes - 2)]
      if note then sound(2, note, 0.05, x, 0.5, 0.8) end
      say("leaf litter")
    else
      say(in_soil and "a stone" or "feed it under the ground")
    end
  elseif n == 3 then
    if not touch(x, y, 1) then say("nothing to touch here") end
  end
end

-- ---------------------------------------------------------------- params

local function add_params()
  for i, s in ipairs(musicutil.SCALES) do scale_names[i] = s.name end
  local start_scale = 1
  for i, n in ipairs(scale_names) do
    if n == "Minor Pentatonic" then start_scale = i end
  end
  local midi_names = { "off" }
  for i = 1, 16 do
    local d = midi.vports[i]
    midi_names[#midi_names + 1] = i .. ": " .. ((d and d.name and d.name ~= "none") and d.name or "-")
  end

  params:add_separator("mycelium", "mycelium")
  params:add_control("season", "season", controlspec.new(0, 4, "lin", 0, 1.55, "", 0.005, true),
    function(p) return season_name(p:get()) end)
  params:add_option("year", "the year goes by in", YEAR, 4)
  params:add_control("growth", "growth", controlspec.new(0.1, 3, "exp", 0, 0.6))
  params:add_number("branching", "branching", 2, 60, 35, function(p) return p:get() .. "%" end)
  params:add_number("sense", "smell", 4, 40, 18, function(p) return p:get() .. " px" end)
  params:add_number("crowd", "crowding", 2, 10, 5)
  params:add_number("max_hyphae", "most hyphae", 100, 1200, 500)
  params:add_control("dieback", "dying back", controlspec.new(0, 3, "lin", 0.01, 1))
  params:add_number("colonies", "most colonies", 1, 8, 5)
  params:add_number("spores", "spores take", 0, 100, 25, function(p) return p:get() .. "%" end)
  params:add_control("fruiting", "fruiting", controlspec.new(0.1, 3, "exp", 0, 1))
  params:add_number("max_mushrooms", "most mushrooms", 0, 8, 4)

  params:add_separator("mycelium_signals", "signals")
  params:add_control("pulse_speed", "signal speed", controlspec.new(5, 120, "exp", 0, 30, "px/s"))
  params:add_control("reach", "signal reach", controlspec.new(0.7, 0.98, "lin", 0.01, 0.92))
  params:add_option("heartbeat", "signals by themselves", BEATS, 2)
  params:add_option("tap_div", "holding K3 taps every", TAP_DIV, 2)

  params:add_separator("mycelium_weather", "weather")
  params:add_option("rain", "rain", RAIN, 2)
  params:add_control("wind", "wind", controlspec.new(0, 1, "lin", 0.01, 0.2))

  params:add_separator("mycelium_music", "music")
  params:add_option("scale", "scale", scale_names, start_scale)
  params:set_action("scale", build_notes)
  params:add_number("root", "root", 36, 72, 50, function(p) return musicutil.note_num_to_name(p:get(), true) end)
  params:set_action("root", build_notes)
  params:add_number("octaves", "octaves", 1, 4, 3)
  params:set_action("octaves", build_notes)
  params:add_option("pitch_from", "pitch from", PITCH_FROM, 1)
  params:add_option("voice", "voice", VOICES, 6)
  params:add_control("timbre", "brightness", controlspec.new(0, 1, "lin", 0.01, 0.5))
  params:add_control("decay", "decay", controlspec.new(0.3, 2.5, "exp", 0, 1))
  params:add_number("density", "notes a second", 1, 30, 8)
  params:add_option("sings", "a mushroom opens with", SINGS, 2)
  params:add_control("level", "network level", controlspec.new(0, 2, "lin", 0.01, 1))
  params:add_control("width", "stereo width", controlspec.new(0, 1, "lin", 0.01, 0.8))

  params:add_separator("mycelium_ground", "the ground")
  params:add_control("drone", "drone", controlspec.new(0, 1, "lin", 0.01, 0.5))
  params:add_control("crackle", "life in the soil", controlspec.new(0, 1, "lin", 0.01, 0.35))
  params:add_control("rain_sound", "rain", controlspec.new(0, 1, "lin", 0.01, 0.6))

  params:add_separator("mycelium_space", "space")
  params:add_control("space", "space", controlspec.new(0, 1, "lin", 0.01, 0.4))
  params:set_action("space", function(v) engine.space(v) end)
  params:add_control("echo_level", "echo level", controlspec.new(0, 1, "lin", 0.01, 0.3))
  params:set_action("echo_level", function(v) engine.emix(v) end)
  params:add_control("echo_fb", "echo feedback", controlspec.new(0, 0.85, "lin", 0.01, 0.4))
  params:set_action("echo_fb", function(v) engine.efb(v) end)
  params:add_control("echo_time", "echo time", controlspec.new(0.08, 1.5, "exp", 0, 0.36, "s"))
  params:set_action("echo_time", function(v) engine.etime(v) end)
  params:add_control("volume", "volume", controlspec.new(0, 1.5, "lin", 0.01, 1))
  params:set_action("volume", function(v) engine.level(v) end)

  params:add_separator("mycelium_midi", "midi")
  params:add_option("midi_out", "notes out to", midi_names, 1)
  params:set_action("midi_out", function() all_notes_off() connect_midi() end)
  params:add_number("midi_out_ch", "out channel", 1, 16, 1)
  params:add_control("midi_len", "note length", controlspec.new(0.05, 2, "exp", 0, 0.3, "s"))
  params:add_number("midi_vel_min", "softest", 1, 127, 40)
  params:add_number("midi_vel_max", "loudest", 1, 127, 110)
  params:add_option("midi_in", "touches in from", midi_names, 1)
  params:set_action("midi_in", connect_midi)
  params:add_option("midi_in_ch", "in channel", { "all", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16" }, 1)

  params:add_separator("mycelium_grid", "grid")
  params:add_option("grid_shows", "grid shows", GRID_SHOWS, 2)
end

-- ------------------------------------------------------------------ life

local function step()
  local now = util.time()
  now_t = now - start_time
  local ym = YEAR_MIN[P("year")]
  if ym > 0 then
    local s = P("season") + DT * 4 / (ym * 60)
    if s >= 4 then s = s - 4 end
    params:set("season", s, true)
  end
  local t = P("season")
  -- a shower, now and then
  local rr = RAIN_RATE[P("rain")]
  if rr > 0 and now > raining_until and math.random() < rr * DT then
    raining_until = now + 20 + math.random() * 50
    say("rain")
  end
  handle(net:step(DT, env()))
  step_flakes(t)
  if now - earth_at > 0.3 then
    earth_at = now
    local alive = net:alive_count()
    engine.earth(P("drone"), musicutil.note_num_to_freq(P("root") - 24), math.min(1, alive / P("max_hyphae")),
      P("crackle") * (0.4 + 0.6 * Net.season_at(t).grow))
    engine.rain(raining() and P("rain_sound") or 0)
  end
end

local function first_colony()
  -- bonnets by the log, where there is food that lasts; fly agarics by the
  -- oak, whose roots they trade with
  net:colony_at(46, 25, 1)
  for x = SCENE.log[1] + 2, SCENE.log[2] - 2, 6 do net:feed(x, net:ground(x) + 2, 3, true) end
  net:colony_at(96, 40, 3)
end

function init()
  math.randomseed(os.time())
  start_time = util.time()
  net = Net.new(SCENE, math.random)
  add_params()
  util.make_dir(DATA)
  if util.file_exists(DATA .. "state.pset") then params:read(DATA .. "state.pset") end
  params:bang()
  build_notes()
  load_images()
  first_colony()
  connect_midi()
  banner_until = util.time() + 3

  sim = metro.init(function()
    step()
    redraw()
    grid_redraw()
  end, DT)
  sim:start()
  tapping = clock.run(tap_loop)
end

function cleanup()
  params:write(DATA .. "state.pset")
  if sim then sim:stop() end
  if tapping then clock.cancel(tapping) end
  all_notes_off()
  engine.earth(0, 55, 0, 0)
  engine.rain(0)
end
