-- nianfo
-- a wall of loop boxes
--
-- E1 choose a box
-- E2 pitch   E3 volume
-- K2 next loop   K3 on / off
-- K1 + E1 edition
-- K1 + E2 pan
-- K1 + K2 previous loop
-- K1 + K3 next view:
--   the wall, one box, effects
--
-- effects: E1 choose,
-- E2 / E3 turn, K2 reset
--
-- grid (optional): every box's
-- switch, loops, pitch, volume

engine.name = "Nianfo"

local LOOPS = include("lib/loops")
local DATA = _path.data .. "nianfo/"
local N = 8

-- each edition's box: its grey and its finish (its name is the machine's number)
local LOOK = {
  { tone = 11, finish = "plain" },
  { tone = 4, finish = "plain" },
  { tone = 7, finish = "wood" },
  { tone = 9, finish = "speckle" },
  { tone = 5, finish = "rivets" },
  { tone = 10, finish = "brushed" },
}

-- the effects, as knobs: param, label, centred
local KNOBS = {
  { "speaker", "SPKR" }, { "crush", "CRSH" }, { "wobble", "WOBL" }, { "battery", "BATT" },
  { "filter", "FILT", true }, { "echo", "ECHO" }, { "space", "SPCE" }, { "drift", "DRFT" },
}

-- ---------------------------------------------------------------- state

local view = "wall" -- "wall" | "box" | "fx"
local VIEWS = { "wall", "box", "fx" }
local sel, fx_sel = 1, 1
local shift = false
local amp, pos = {}, {}
for i = 1, N do
  amp[i] = {}
  for k = 1, 8 do amp[i][k] = 0 end
  pos[i] = 0
end
local tip, tip_until = nil, 0
local ready = false
local last_t = 0
local redraw_metro = nil
local g = grid.connect()

local function pid(i, name) return "b" .. i .. "_" .. name end
local function on(i) return params:get(pid(i, "on")) == 2 end
local function ed(i) return params:get(pid(i, "ed")) end
local function lp(i) return params:get(pid(i, "loop")) end
local function index_of(e, n) return (e - 1) * 9 + n end
local function count(i) return #LOOPS[ed(i)].loops end
local function cur(i) return math.min(lp(i), count(i)) end
local function loop_info(i) return LOOPS[ed(i)].loops[math.min(lp(i), count(i))] end

local function show(text)
  tip, tip_until = text, util.time() + 1.2
end

-- a box starts its loop from the top, or falls silent
local function restart(i)
  if not ready then return end
  if lp(i) > count(i) then
    params:set(pid(i, "loop"), count(i))
    return
  end
  if on(i) then
    engine.play(i, index_of(ed(i), lp(i)), norns.state.path .. "samples/" .. ed(i) .. "/" .. lp(i) .. ".wav")
    pos[i] = 0
  else
    engine.stop(i)
  end
end

-- ---------------------------------------------------------------- drawing: letters

-- three by five: no font norns has is that small
local FONT3 = {
  A = "010101111101101", B = "110101110101110", C = "011100100100011", D = "110101101101110",
  E = "111100110100111", F = "111100110100100", G = "011100101101011", H = "101101111101101",
  I = "111010010010111", K = "101101110101101", L = "100100100100111", M = "101111111101101",
  N = "110101101101101", O = "010101101101010", P = "110101110100100", Q = "010101101110011",
  R = "110101110101101", S = "011100010001110", T = "111010010010010", U = "101101101101111",
  V = "101101101101010", W = "101101111111101", X = "101101010101101", Y = "101101010010010",
  ["0"] = "111101101101111", ["1"] = "010110010010111", ["2"] = "110001010100111",
  ["3"] = "110001010001110", ["4"] = "101101111001001", ["5"] = "111100110001110",
  ["6"] = "011100111101111", ["7"] = "111001010010010", ["8"] = "111101111101111",
  ["9"] = "111101111001110", ["-"] = "000000111000000", ["+"] = "000010111010000",
  ["."] = "000000000000010", ["/"] = "001001010100100",
}

local function text3(s, x, y, level)
  screen.level(level)
  for i = 1, #s do
    local glyph = FONT3[s:sub(i, i)]
    if glyph then
      for k = 0, 14 do
        if glyph:sub(k + 1, k + 1) == "1" then screen.rect(x + (i - 1) * 4 + k % 3, y + math.floor(k / 3), 1, 1) end
      end
    end
  end
  screen.fill()
end

local function width3(s) return #s * 4 - 1 end

-- pressed into the plastic: dark below, light above
local function emboss3(s, cx, y, t)
  local x = math.floor(cx - width3(s) / 2 + 0.5)
  text3(s, x, y + 1, math.min(15, t + 2))
  text3(s, x, y, math.max(0, t - 3))
end

-- ---------------------------------------------------------------- drawing: the boxes

local function rrect(x, y, w, h, r)
  screen.move(x + r, y)
  screen.line(x + w - r, y)
  screen.arc(x + w - r, y + r, r, -math.pi / 2, 0)
  screen.line(x + w, y + h - r)
  screen.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
  screen.line(x + r, y + h)
  screen.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
  screen.line(x, y + r)
  screen.arc(x + r, y + r, r, math.pi, math.pi * 1.5)
  screen.close()
end

-- the finish of the plastic, inside the corners
local function finish(kind, x, y, w, h, t, big)
  local m = big and 4 or 2
  if kind == "wood" then
    screen.level(math.max(0, t - 1))
    for yy = y + m, y + h - m - 1, big and 3 or 2 do
      for xx = x + m, x + w - m - 1 do
        if (xx * 7 + yy * 13) % 9 < 5 then
          screen.rect(xx, yy + math.floor(math.sin(xx * 0.35 + yy * 0.7) * 0.7 + 0.5), 1, 1)
        end
      end
    end
    screen.fill()
  elseif kind == "speckle" then
    screen.level(math.max(0, t - 2))
    for k = 1, big and 70 or 16 do
      screen.rect(x + m + (k * 37) % (w - 2 * m), y + m + (k * 53) % (h - 2 * m), 1, 1)
    end
    screen.fill()
    screen.level(math.min(15, t + 2))
    for k = 1, big and 30 or 6 do
      screen.rect(x + m + (k * 71) % (w - 2 * m), y + m + (k * 29) % (h - 2 * m), 1, 1)
    end
    screen.fill()
  elseif kind == "brushed" then
    -- brushed metal: fine lines along it, broken here and there
    screen.level(math.min(15, t + 1))
    for yy = y + m, y + h - m - 1, 2 do
      for xx = x + m, x + w - m - 1 do
        if (xx * 5 + yy * 11) % 13 < 9 then screen.rect(xx, yy, 1, 1) end
      end
    end
    screen.fill()
    screen.level(math.max(0, t - 2))
    for yy = y + m + 1, y + h - m - 1, 4 do screen.rect(x + m, yy, w - 2 * m, 1) end
    screen.fill()
  elseif kind == "rivets" then
    local r = big and 4 or 2
    for _, c in ipairs({ { x + r, y + r }, { x + w - r - 1, y + r }, { x + r, y + h - r - 1 }, { x + w - r - 1, y + h - r - 1 } }) do
      screen.level(math.min(15, t + 5))
      screen.rect(c[1], c[2], 1, 1)
      screen.fill()
      if big then
        screen.level(math.max(0, t - 3))
        screen.rect(c[1] + 1, c[2] + 1, 1, 1)
        screen.fill()
      end
    end
    -- scratches
    screen.level(math.min(15, t + 1))
    for k = 1, big and 7 or 2 do
      local sx, sy = x + m + (k * 41) % (w - 2 * m - 4), y + m + (k * 23) % (h - 2 * m - 4)
      for j = 0, big and 4 or 2 do screen.rect(sx + j, sy + (j % 2), 1, 1) end
    end
    screen.fill()
  end
end

-- the grille's rings: radius and holes, small and large
local RINGS_S = { { 0, 1 }, { 3, 6 }, { 5, 12 }, { 7, 16 } }
local RINGS_L = { { 0, 1 }, { 4, 8 }, { 8, 14 }, { 12, 20 }, { 16, 26 } }

-- how much a ring is lit: the level of a moment ago, more ago further out
local function ring_light(i, k)
  if not on(i) then return 0 end
  return util.clamp((amp[i][k] or 0) * 7, 0, 1)
end

local function grille(i, cx, cy, rings, t, size)
  local base = math.max(0, t - 6)
  for k, ring in ipairs(rings) do
    local lit = ring_light(i, k)
    screen.level(math.floor(base + (15 - base) * lit + 0.5))
    local r, n = ring[1], ring[2]
    for h = 0, n - 1 do
      local a = (h / n) * 2 * math.pi + (k % 2) * math.pi / n
      screen.rect(math.floor(cx + r * math.cos(a) + 0.5), math.floor(cy + r * math.sin(a) + 0.5), size, size)
    end
    screen.fill()
  end
end

local function led_level(i)
  if not on(i) then return 1 end
  local bat = params:get("battery")
  local l = 15 - math.floor(bat * 9 * math.random() ^ 4)
  return util.clamp(l, 3, 15)
end

-- a box on the wall, in its cell of 32 by 32
local function draw_small(i, x0, y0)
  local look = LOOK[ed(i)]
  local t = on(i) and look.tone or math.max(1, look.tone - 1)
  local bx, by, bw, bh = x0 + 5, y0 + 2, 21, 27
  screen.aa(1)
  screen.level(0)
  rrect(bx + 2, by + 1, bw, bh, 3)
  screen.fill()
  screen.level(t)
  rrect(bx, by, bw, bh, 3)
  screen.fill()
  screen.aa(0)
  finish(look.finish, bx, by, bw, bh, t, false)
  -- light along the top and the left, shade along the bottom and the right
  screen.level(math.min(15, t + 3))
  screen.rect(bx + 3, by, bw - 6, 1)
  screen.rect(bx, by + 3, 1, bh - 6)
  screen.fill()
  screen.level(math.max(0, t - 3))
  screen.rect(bx + 3, by + bh - 1, bw - 6, 1)
  screen.rect(bx + bw - 1, by + 3, 1, bh - 6)
  screen.fill()
  -- the LED, the loop's window, the grille, the numeral
  screen.level(led_level(i))
  screen.rect(bx + 3, by + 3, 2, 2)
  screen.fill()
  screen.level(0)
  screen.rect(bx + 15, by + 1, 5, 6)
  screen.fill()
  text3(tostring(cur(i)), bx + 16, by + 1, on(i) and 13 or 4)
  grille(i, bx + 10, by + 12, RINGS_S, t, 1)
  emboss3(LOOPS[ed(i)].name, bx + 10.5, by + 20, t)
  -- the volume wheel on the side, its ridges turned by the volume
  local turn = math.floor(params:get(pid(i, "vol")) * 12)
  for yy = 0, 11 do
    screen.level(((yy + turn) % 3 == 0) and 2 or 6)
    screen.rect(bx + bw, by + 8 + yy, 2, 1)
    screen.fill()
  end
end

local function brackets(x0, y0, x1, y1, level)
  screen.level(level)
  for _, c in ipairs({ { x0, y0, 1, 1 }, { x1, y0, -1, 1 }, { x0, y1, 1, -1 }, { x1, y1, -1, -1 } }) do
    local x, y, dx, dy = c[1], c[2], c[3], c[4]
    screen.rect(math.min(x, x + 2 * dx), y, 3, 1)
    screen.rect(x, math.min(y, y + 2 * dy), 1, 3)
  end
  screen.fill()
end

local function tooltip(cx, cy)
  if not tip or util.time() > tip_until then return end
  screen.font_face(1)
  screen.font_size(8)
  local w = screen.text_extents(tip)
  local x = util.clamp(math.floor(cx - w / 2 - 3), 0, 127 - w - 6)
  screen.level(0)
  screen.rect(x, cy - 5, w + 6, 9)
  screen.fill()
  screen.level(9)
  screen.rect(x + 0.5, cy - 4.5, w + 5, 8)
  screen.stroke()
  screen.level(15)
  screen.move(x + 3, cy + 2)
  screen.text(tip)
end

local function draw_wall()
  screen.level(2)
  screen.rect(0, 0, 128, 64)
  screen.fill()
  -- the boards behind
  screen.level(1)
  for x = 15, 127, 16 do screen.rect(x, 0, 1, 64) end
  screen.fill()
  for row = 0, 1 do
    local y = row * 32
    -- the shelf
    screen.level(8)
    screen.rect(0, y + 29, 128, 1)
    screen.fill()
    screen.level(4)
    screen.rect(0, y + 30, 128, 1)
    screen.fill()
    screen.level(0)
    screen.rect(0, y + 31, 128, 1)
    screen.fill()
    for col = 0, 3 do
      draw_small(row * 4 + col + 1, col * 32, y)
    end
  end
  local c, r = (sel - 1) % 4, math.floor((sel - 1) / 4)
  brackets(c * 32 + 1, r * 32, c * 32 + 30, r * 32 + 28, 15)
  tooltip(c * 32 + 15, r * 32 + 16)
end

-- ---------------------------------------------------------------- drawing: one box, close

-- seven segments in a window: top, top left, bottom left, middle, top right, bottom right, bottom
local SEG = {
  [1] = { 0, 0, 0, 0, 1, 1, 0 }, [2] = { 1, 0, 1, 1, 1, 0, 1 }, [3] = { 1, 0, 0, 1, 1, 1, 1 },
  [4] = { 0, 1, 0, 1, 1, 1, 0 }, [5] = { 1, 1, 0, 1, 0, 1, 1 }, [6] = { 1, 1, 1, 1, 0, 1, 1 },
  [7] = { 1, 0, 0, 0, 1, 1, 0 }, [8] = { 1, 1, 1, 1, 1, 1, 1 }, [9] = { 1, 1, 0, 1, 1, 1, 1 },
}
local SEG_R = { { 1, 0, 4, 1 }, { 0, 1, 1, 3 }, { 0, 5, 1, 3 }, { 1, 4, 4, 1 }, { 5, 1, 1, 3 }, { 5, 5, 1, 3 }, { 1, 8, 4, 1 } }

local function digit7(d, x, y, lit)
  local map = SEG[d]
  for pass = 0, 1 do
    screen.level(pass == 0 and 2 or (lit and 15 or 5))
    for s = 1, 7 do
      if (map[s] == 1) == (pass == 1) then
        local r = SEG_R[s]
        screen.rect(x + r[1], y + r[2], r[3], r[4])
      end
    end
    screen.fill()
  end
end

local function draw_box()
  local i = sel
  local look = LOOK[ed(i)]
  local t = on(i) and look.tone or math.max(1, look.tone - 2)
  local bx, by, bw, bh = 4, 4, 52, 56
  screen.level(1)
  screen.rect(0, 0, 128, 64)
  screen.fill()
  -- its shadow on the wall, the body
  screen.aa(1)
  screen.level(0)
  rrect(bx + 3, by + 3, bw, bh, 7)
  screen.fill()
  screen.level(t)
  rrect(bx, by, bw, bh, 7)
  screen.fill()
  screen.aa(0)
  finish(look.finish, bx, by, bw, bh, t, true)
  screen.level(math.min(15, t + 3))
  screen.rect(bx + 7, by, bw - 14, 1)
  screen.rect(bx, by + 7, 1, bh - 14)
  screen.fill()
  screen.level(math.max(0, t - 3))
  screen.rect(bx + 7, by + bh - 1, bw - 14, 1)
  screen.rect(bx + bw - 1, by + 7, 1, bh - 14)
  screen.fill()
  -- the loop switch on the top, its lever where the loop is
  screen.level(math.max(0, t - 3))
  screen.rect(bx + 14, by - 2, 14, 2)
  screen.fill()
  screen.level(14)
  screen.rect(bx + 14 + math.floor((cur(i) - 1) * 1.5), by - 3, 2, 3)
  screen.fill()
  -- the LED, glowing
  local led = led_level(i)
  screen.aa(1)
  if on(i) then
    screen.level(math.floor(led / 4))
    screen.circle(bx + 8, by + 7, 3.2)
    screen.fill()
    screen.level(math.floor(led / 2))
    screen.circle(bx + 8, by + 7, 2.2)
    screen.fill()
  end
  screen.level(led)
  screen.circle(bx + 8, by + 7, 1.3)
  screen.fill()
  screen.aa(0)
  -- the loop's window
  screen.level(math.max(0, t - 4))
  screen.rect(bx + 37, by + 2, 11, 12)
  screen.fill()
  screen.level(0)
  screen.rect(bx + 38, by + 3, 9, 10)
  screen.fill()
  digit7(cur(i), bx + 40, by + 3, on(i))
  -- the grille: a pressed ring round it, the holes lit from the middle outward
  local gx, gy = bx + 26, by + 29
  screen.aa(1)
  screen.line_width(1)
  screen.level(math.min(15, t + 2))
  screen.circle(gx + 0.5, gy + 0.5, 19.5)
  screen.stroke()
  screen.level(math.max(0, t - 3))
  screen.circle(gx - 0.5, gy - 0.5, 19.5)
  screen.stroke()
  screen.aa(0)
  grille(i, gx - 1, gy - 1, RINGS_L, t, 2)
  emboss3(LOOPS[ed(i)].name, bx + bw / 2, by + bh - 7, t)
  -- the volume wheel, standing out of the right side
  local turn = math.floor(params:get(pid(i, "vol")) * 20)
  screen.level(2)
  screen.rect(bx + bw, by + 16, 4, 26)
  screen.fill()
  for yy = 0, 25 do
    local shade = 1 - math.abs(yy - 12.5) / 13
    local ridge = (yy + turn) % 2 == 0
    screen.level(math.floor((ridge and 3 or 8) * (0.4 + 0.6 * shade) + 0.5))
    screen.rect(bx + bw + 1, by + 16 + yy, 2, 1)
    screen.fill()
  end

  -- the panel on the right
  local x = 64
  local info = loop_info(i)
  screen.font_face(1)
  screen.font_size(8)
  screen.level(15)
  screen.move(x, 8)
  screen.text(LOOPS[ed(i)].name)
  screen.level(6)
  screen.move(127, 8)
  screen.text_right("BOX " .. i)
  screen.level(11)
  screen.move(x, 18)
  screen.text(info.name)
  screen.level(5)
  screen.move(127, 18)
  screen.text_right(cur(i) .. "/" .. count(i))
  -- where the loop is
  screen.level(3)
  screen.rect(x, 21, 64, 2)
  screen.fill()
  screen.level(on(i) and 12 or 5)
  screen.rect(x, 21, math.floor(64 * pos[i] + 0.5), 2)
  screen.fill()
  text3(string.format("%.1f", info.len) .. "S", x, 25, 6)
  text3(on(i) and "ON" or "OFF", 128 - width3(on(i) and "ON" or "OFF"), 25, on(i) and 15 or 4)
  -- pitch: a ruler from two octaves down to one up
  local pitch = params:get(pid(i, "pitch"))
  local function px(st) return x + 1 + math.floor((st + 24) / 36 * 61 + 0.5) end
  screen.level(4)
  screen.rect(x, 41, 64, 1)
  screen.fill()
  for st = -24, 12, 3 do
    screen.level(st % 12 == 0 and 9 or 4)
    screen.rect(px(st), st % 12 == 0 and 38 or 39, 1, st % 12 == 0 and 3 or 2)
    screen.fill()
  end
  screen.level(15)
  local mx = px(pitch)
  screen.rect(mx - 1, 43, 3, 1)
  screen.rect(mx, 42, 1, 1)
  screen.fill()
  text3("PITCH", x, 32, 6)
  local ps = string.format("%+.1f", pitch)
  text3(ps, 128 - width3(ps), 32, 12)
  -- volume and pan
  text3("VOL", x, 47, 6)
  screen.level(3)
  screen.rect(x + 14, 47, 50, 5)
  screen.fill()
  screen.level(12)
  screen.rect(x + 14, 47, math.floor(50 * params:get(pid(i, "vol")) + 0.5), 5)
  screen.fill()
  -- the wall in small: which boxes are on, and which one this is
  for k = 1, N do
    local c, r = (k - 1) % 4, math.floor((k - 1) / 4)
    local wx, wy = x + c * 8, 54 + r * 5
    screen.level(on(k) and LOOK[ed(k)].tone or 2)
    screen.rect(wx, wy, 6, 4)
    screen.fill()
    if k == i then
      screen.level(15)
      screen.rect(wx, wy + 4, 6, 1)
      screen.fill()
    end
  end
  text3("PAN", x + 36, 55, 6)
  local pan = params:get(pid(i, "pan"))
  screen.level(3)
  screen.rect(x + 36, 62, 28, 1)
  screen.fill()
  screen.level(15)
  screen.rect(x + 36 + math.floor((pan + 1) / 2 * 26 + 0.5), 60, 2, 3)
  screen.fill()
end

-- ---------------------------------------------------------------- drawing: the effects

local function draw_fx()
  screen.level(0)
  screen.rect(0, 0, 128, 64)
  screen.fill()
  local a0, sweep = math.pi * 0.75, math.pi * 1.5
  for k, kn in ipairs(KNOBS) do
    local c, r = (k - 1) % 4, math.floor((k - 1) / 4)
    local cx, cy, rad = 16 + c * 32, 13 + r * 31, 9
    local v = params:get(kn[1])
    local frac = kn[3] and (v + 1) / 2 or v
    local chosen = k == fx_sel
    screen.aa(1)
    screen.line_width(2)
    screen.level(2)
    screen.arc(cx, cy, rad, a0, a0 + sweep)
    screen.stroke()
    screen.level(chosen and 15 or 9)
    if kn[3] then
      local mid = a0 + sweep / 2
      local to = a0 + sweep * frac
      screen.arc(cx, cy, rad, math.min(mid, to), math.max(mid, to) + 0.001)
    else
      screen.arc(cx, cy, rad, a0, a0 + sweep * frac + 0.001)
    end
    screen.stroke()
    screen.line_width(1)
    -- the knob: a cap, lit from above, and its pointer
    screen.level(chosen and 6 or 4)
    screen.circle(cx, cy, 5.5)
    screen.fill()
    screen.level(chosen and 9 or 6)
    screen.circle(cx - 1, cy - 1, 3)
    screen.fill()
    local a = a0 + sweep * frac
    screen.level(15)
    screen.move(cx + math.cos(a) * 1.5, cy + math.sin(a) * 1.5)
    screen.line(cx + math.cos(a) * 5.5, cy + math.sin(a) * 5.5)
    screen.stroke()
    screen.aa(0)
    local label = kn[2]
    if chosen and tip and util.time() < tip_until then label = tip end
    text3(label, cx - math.floor(width3(label) / 2), cy + rad + 3, chosen and 15 or 5)
  end
end

function redraw()
  screen.clear()
  if view == "wall" then
    draw_wall()
  elseif view == "box" then
    draw_box()
  else
    draw_fx()
  end
  screen.update()
end

-- ---------------------------------------------------------------- grid (optional)

-- Two columns a box: its switch on top, its nine loops below (the tenth key
-- is the next edition), pitch down and up, volume down and up.
local function grid_redraw()
  g:all(0)
  for i = 1, N do
    local x = (i - 1) * 2 + 1
    local lit = on(i) and (5 + math.floor(util.clamp(amp[i][1] * 7, 0, 1) * 10)) or 2
    g:led(x, 1, lit)
    g:led(x + 1, 1, lit)
    for n = 1, count(i) do
      g:led(x + (n - 1) % 2, 2 + math.floor((n - 1) / 2), n == cur(i) and (on(i) and 15 or 8) or 3)
    end
    g:led(x + 1, 6, 6)
    g:led(x, 7, 4)
    g:led(x + 1, 7, 4)
    g:led(x, 8, 3)
    g:led(x + 1, 8, 3)
    if i == sel then g:led(x, 6, 9) end
  end
  g:refresh()
end

local function next_edition(i, d)
  params:set(pid(i, "ed"), (ed(i) - 1 + d) % #LOOPS + 1)
  show(LOOPS[ed(i)].name)
end

g.key = function(x, y, z)
  if z == 0 then return end
  local i = math.floor((x - 1) / 2) + 1
  local right = (x - 1) % 2 == 1
  if i > N then return end
  sel = i
  if y == 1 then
    params:set(pid(i, "on"), on(i) and 1 or 2)
  elseif y <= 6 then
    local n = (y - 2) * 2 + (right and 2 or 1)
    if n <= count(i) then
      params:set(pid(i, "loop"), n)
      if not on(i) then params:set(pid(i, "on"), 2) end
    elseif right then
      next_edition(i, 1)
    end
  elseif y == 7 then
    params:set(pid(i, "pitch"), util.clamp(params:get(pid(i, "pitch")) + (right and 1 or -1), -24, 12))
  elseif y == 8 then
    params:set(pid(i, "vol"), util.clamp(params:get(pid(i, "vol")) + (right and 0.05 or -0.05), 0, 1))
  end
end

-- ---------------------------------------------------------------- controls

function enc(n, d)
  if view == "fx" then
    if n == 1 then
      fx_sel = util.clamp(fx_sel + d, 1, #KNOBS)
    else
      local kn = KNOBS[fx_sel]
      local lo = kn[3] and -1 or 0
      params:set(kn[1], util.clamp(params:get(kn[1]) + d * (n == 2 and 0.02 or 0.005), lo, 1))
      show(string.format("%.2f", params:get(kn[1])))
    end
    return
  end
  if n == 1 then
    if shift then
      next_edition(sel, d)
    else
      sel = util.clamp(sel + d, 1, N)
    end
  elseif n == 2 then
    if shift then
      params:set(pid(sel, "pan"), util.clamp(params:get(pid(sel, "pan")) + d * 0.05, -1, 1))
      local pan = params:get(pid(sel, "pan"))
      show(pan == 0 and "C" or string.format("%s%d", pan < 0 and "L" or "R", math.floor(math.abs(pan) * 100 + 0.5)))
    else
      local step = params:get("pitch_steps") == 2 and 1 or 0.1
      params:set(pid(sel, "pitch"), util.clamp(params:get(pid(sel, "pitch")) + d * step, -24, 12))
      show(string.format("%+.1f", params:get(pid(sel, "pitch"))))
    end
  elseif n == 3 then
    params:set(pid(sel, "vol"), util.clamp(params:get(pid(sel, "vol")) + d * 0.02, 0, 1))
    show(string.format("VOL %d", math.floor(params:get(pid(sel, "vol")) * 100 + 0.5)))
  end
end

function key(n, z)
  if n == 1 then
    shift = z == 1
    return
  end
  if z == 0 then return end
  if shift and n == 3 then
    local k = 1
    for j, v in ipairs(VIEWS) do
      if v == view then k = j end
    end
    view = VIEWS[k % #VIEWS + 1]
    return
  end
  if view == "fx" then
    if n == 2 then
      local kn = KNOBS[fx_sel]
      params:set(kn[1], params:lookup_param(kn[1]).controlspec.default)
      show(string.format("%.2f", params:get(kn[1])))
    end
    return
  end
  if n == 2 then
    local d = shift and -1 or 1
    params:set(pid(sel, "loop"), (math.min(lp(sel), count(sel)) - 1 + d) % count(sel) + 1)
    show(loop_info(sel).name)
  elseif n == 3 then
    params:set(pid(sel, "on"), on(sel) and 1 or 2)
  end
end

-- ---------------------------------------------------------------- life

local function tick()
  local now = util.time()
  local dt = math.min(0.2, now - last_t)
  last_t = now
  for i = 1, N do
    if on(i) then
      pos[i] = (pos[i] + dt * 2 ^ (params:get(pid(i, "pitch")) / 12) / loop_info(i).len) % 1
    end
  end
  redraw()
  grid_redraw()
end

function init()
  local names = {}
  for e, edition in ipairs(LOOPS) do names[e] = edition.name end

  params:add_separator("nianfo", "nianfo")
  for i = 1, N do
    params:add_group("box " .. i, 6)
    params:add_option(pid(i, "on"), "switch", { "off", "on" }, i == 1 and 2 or 1)
    params:set_action(pid(i, "on"), function() restart(i) end)
    params:add_option(pid(i, "ed"), "edition", names, (i - 1) % #LOOPS + 1)
    params:set_action(pid(i, "ed"), function() if on(i) then restart(i) end end)
    params:add_number(pid(i, "loop"), "loop", 1, 9, 1)
    params:set_action(pid(i, "loop"), function() if on(i) then restart(i) end end)
    params:add_control(pid(i, "pitch"), "pitch", controlspec.new(-24, 12, "lin", 0.01, 0, "st"))
    params:set_action(pid(i, "pitch"), function(v) engine.rate(i, 2 ^ (v / 12)) end)
    params:add_control(pid(i, "vol"), "volume", controlspec.new(0, 1, "lin", 0.01, 0.7))
    params:set_action(pid(i, "vol"), function(v) engine.amp(i, v * v) end)
    params:add_control(pid(i, "pan"), "pan", controlspec.new(-1, 1, "lin", 0.01, ((i - 1) % 4 - 1.5) * 0.3))
    params:set_action(pid(i, "pan"), function(v) engine.pan(i, v) end)
  end
  params:add_group("effects", 11)
  local function fx(id, name, lo, hi, default)
    params:add_control(id, name, controlspec.new(lo, hi, "lin", 0.005, default))
    params:set_action(id, function(v) engine[id](v) end)
  end
  fx("speaker", "speaker", 0, 1, 0.25)
  fx("crush", "crush", 0, 1, 0)
  fx("wobble", "wobble", 0, 1, 0.15)
  fx("battery", "battery", 0, 1, 0)
  fx("filter", "filter", -1, 1, 0)
  fx("echo", "echo", 0, 1, 0.15)
  params:add_control("echo_time", "echo time", controlspec.new(0.05, 1.5, "exp", 0.01, 0.43, "s"))
  params:set_action("echo_time", function(v) engine.echo_time(v) end)
  fx("space", "space", 0, 1, 0.35)
  fx("drift", "drift", 0, 1, 0.2)
  params:add_control("level", "level", controlspec.new(0, 1.5, "lin", 0.01, 1))
  params:set_action("level", function(v) engine.level(v) end)
  params:add_option("pitch_steps", "pitch steps", { "free", "semitones" }, 1)

  util.make_dir(DATA)
  if util.file_exists(DATA .. "state.pset") then params:read(DATA .. "state.pset") end
  params:bang()
  ready = true
  for i = 1, N do restart(i) end

  for i = 1, N do
    local ok, p = pcall(poll.set, "amp" .. i, function(v)
      table.insert(amp[i], 1, v)
      amp[i][9] = nil
    end)
    if ok and p then p:start() end
  end

  last_t = util.time()
  redraw_metro = metro.init(tick, 1 / 24)
  redraw_metro:start()
end

function cleanup()
  if redraw_metro then redraw_metro:stop() end
  util.make_dir(DATA)
  params:write(DATA .. "state.pset")
end
