-- remous
-- three pools of small creatures
-- that make music as you play
-- with them
--
-- K1+E1 change pool
-- E1 the current
-- E2 / E3 move the cursor
--
-- stones   K2 stone   K3 swimmer
-- jellies  K2 food    K3 jelly
-- bubbles  K2 vent    hold K3 blow
--
-- K1+E2 scale   K1+E3 root
-- K1+K2 / K1+K3 clear the pool
--
-- grid (optional): the pool, 16x8

engine.name = "Remous"

local musicutil = require "musicutil"

local DATA = _path.data .. "remous/"
local DT = 1 / 30
local SURF, FLOOR = 8, 57
local X0, X1 = 2, 125
local DEGREES = 15
local V = { bell = 1, wood = 2, glass = 3, pluck = 4, jelly = 5, bubble = 6 }
local OCTAVE = { 12, 0, 12, 0, 0, 12 }
local STONE_KINDS = { "bell", "wood", "glass", "pluck" }
local POOLS = { "stones", "jellies", "bubbles" }

local cursor = { x = 64, y = 32 }
local held = { false, false, false }
local scale_names, notes = {}, {}
local recent = {}
local message, message_until = nil, 0
local banner_until = 0
local cursor_moved = 0
local start_time = 0
local now_t = 0
local ripples, sparks = {}, {}
local dust, pebbles = {}, {}
local pools = {}
local pool = nil
local sim, beat_clock = nil, nil
local drone_at = 0
local g = grid.connect()

-- ---------------------------------------------------------------- notes

local function build_notes()
  notes = musicutil.generate_scale(params:get("root"), scale_names[params:get("scale")], 3)
end

local function degree_at(y)
  return util.clamp(math.floor((FLOOR - y) / (FLOOR - SURF) * (DEGREES - 1) + 0.5), 0, DEGREES - 1)
end

local function note_num(degree, voice)
  return notes[util.clamp(degree, 0, DEGREES - 1) + 1] + OCTAVE[voice]
end

local function pan_at(x) return util.linlin(0, 127, -0.8, 0.8, x) end

local function say(text) message, message_until = text, util.time() + 1.4 end

-- No more notes a second than the density allows: a crowded pool stays music.
local function allowed(now)
  local keep = {}
  for _, t in ipairs(recent) do
    if now - t < 1 then keep[#keep + 1] = t end
  end
  recent = keep
  if #recent >= params:get("density") then return false end
  recent[#recent + 1] = now
  return true
end

local function play(voice, degree, amp, x, bright)
  if not allowed(util.time()) then return false end
  engine.strike(voice, musicutil.note_num_to_freq(note_num(degree, voice)), amp, pan_at(x), bright)
  return true
end

-- ---------------------------------------------------------------- the water

local function ripple(x, y, size, flat)
  ripples[#ripples + 1] = { x = x, y = y, r = 1, max = size or 12, life = 1, flat = flat }
end

local function splash(x, n)
  for _ = 1, n do
    sparks[#sparks + 1] = { x = x, y = SURF, vx = (math.random() - 0.5) * 1.4, vy = -0.5 - math.random() * 0.9, life = 1 }
  end
end

local function surface_y(x)
  return SURF + math.sin(x * 0.11 + now_t * 1.5) * 0.7 + math.sin(x * 0.043 - now_t * 0.6) * 0.6
end

local function current() return params:get("current") end

-- A circle that starts where it is drawn, not joined to the last point.
local function ring(x, y, r)
  screen.move(x + r, y)
  screen.circle(x, y, r)
end

local function init_water()
  for i = 1, 18 do
    dust[i] = { x = math.random() * 128, y = SURF + 2 + math.random() * (FLOOR - SURF - 4), z = math.random(1, 3), ph = math.random() * 6.28 }
  end
  for i = 1, 24 do
    pebbles[i] = { x = math.random(0, 127), y = math.random(FLOOR + 3, 63), l = math.random(3, 5) }
  end
end

local function step_water()
  for _, d in ipairs(dust) do
    d.x = d.x + current() * 0.25 * d.z / 3 + math.sin(now_t * 0.7 + d.ph) * 0.05
    d.y = d.y + math.sin(now_t * 0.5 + d.ph * 2) * 0.04
    if d.x < 0 then d.x = 127 elseif d.x > 127 then d.x = 0 end
  end
  for i = #ripples, 1, -1 do
    local r = ripples[i]
    r.r = r.r + r.max * 0.04
    r.life = r.life - 0.04
    if r.life <= 0 then table.remove(ripples, i) end
  end
  for i = #sparks, 1, -1 do
    local s = sparks[i]
    s.x, s.y, s.vy, s.life = s.x + s.vx, s.y + s.vy, s.vy + 0.09, s.life - 0.035
    if s.life <= 0 or s.y > SURF + 1 then table.remove(sparks, i) end
  end
end

local function draw_water()
  screen.aa(0)
  -- light from above, in slow shafts
  screen.level(1)
  for i = 0, 2 do
    local x = 14 + i * 44 + math.sin(now_t * 0.23 + i * 2.1) * 9
    screen.move(x, SURF + 1)
    screen.line(x + 9, SURF + 1)
    screen.line(x + 24, FLOOR + 1)
    screen.line(x + 8, FLOOR + 1)
    screen.close()
    screen.fill()
  end
  -- the sand, with its pebbles
  screen.level(2)
  screen.move(0, 64)
  for x = 0, 128, 8 do screen.line(x, FLOOR + 2 + math.sin(x * 0.09) * 1.2) end
  screen.line(128, 64)
  screen.close()
  screen.fill()
  for l = 3, 5 do
    screen.level(l)
    for _, p in ipairs(pebbles) do
      if p.l == l then screen.rect(p.x, p.y, 1, 1) end
    end
    screen.fill()
  end
  -- specks in the water, nearer ones brighter
  for z = 1, 3 do
    screen.level(z)
    for _, d in ipairs(dust) do
      if d.z == z then screen.rect(math.floor(d.x), math.floor(d.y), 1, 1) end
    end
    screen.fill()
  end
  -- the surface, never still
  screen.aa(1)
  screen.level(8)
  screen.move(0, surface_y(0))
  for x = 4, 128, 4 do screen.line(x, surface_y(x)) end
  screen.stroke()
  screen.level(2)
  screen.move(0, SURF + 2 + math.sin(-now_t * 1.1) * 0.6)
  for x = 6, 128, 6 do screen.line(x, SURF + 2 + math.sin(x * 0.07 - now_t * 1.1) * 0.6) end
  screen.stroke()
end

local function draw_effects()
  screen.aa(1)
  for _, r in ipairs(ripples) do
    screen.level(math.max(1, math.floor(r.life * 8)))
    if r.flat then
      for side = -1, 1, 2 do
        local x = r.x + side * r.r
        local sy = surface_y(x)
        screen.move(x - 2, sy + 0.5)
        screen.line(x, sy - 1.2)
        screen.line(x + 2, sy + 0.5)
        screen.stroke()
      end
    else
      ring(r.x, r.y, r.r)
      screen.stroke()
    end
  end
  screen.aa(0)
  for _, s in ipairs(sparks) do
    screen.level(math.max(1, math.floor(s.life * 13)))
    screen.rect(math.floor(s.x), math.floor(s.y), 1, 1)
    screen.fill()
  end
end

local function draw_cursor()
  local lit = (util.time() - cursor_moved < 2) and 12 or 4
  local x, y = math.floor(cursor.x) + 0.5, math.floor(cursor.y) + 0.5
  screen.aa(1)
  screen.level(lit)
  ring(x, y, 3.5)
  screen.stroke()
  screen.aa(0)
  screen.rect(x - 7.5, y - 0.5, 2, 1)
  screen.rect(x + 5.5, y - 0.5, 2, 1)
  screen.rect(x - 0.5, y - 7.5, 1, 2)
  screen.rect(x - 0.5, y + 5.5, 1, 2)
  screen.fill()
end

-- ---------------------------------------------------------------- pool: stones
--
-- Swimmers drift with the current and with each other; a stone they brush
-- rings and sends them away. They feed on the notes they make, split when
-- full, and fade when hungry, so the pool breathes around a population set
-- by how many stones there are to feed on.

local S = { name = "stones", hint = "K2 stone   K3 swimmer", stones = {}, fish = {}, empty_since = nil }
pools.stones = S

local HIT_R, FEED, FEW = 4.5, 0.16, 2

function S:add_fish(x, y, heading, energy)
  if #self.fish >= params:get("swimmers") then return nil end
  local h = heading or math.random() * 2 * math.pi
  local m = {
    x = x, y = y, heading = h, cruise = 0.35 + math.random() * 0.55, energy = energy or 0.6,
    cool = {}, fade = 0, ph = math.random() * 6.28,
  }
  m.vx, m.vy = math.cos(h) * m.cruise, math.sin(h) * m.cruise
  self.fish[#self.fish + 1] = m
  return m
end

function S:stone_at(x, y, r)
  for i, st in ipairs(self.stones) do
    local dx, dy = st.x - x, st.y - y
    if dx * dx + dy * dy <= r * r then return i end
  end
end

function S:sound(st, speed)
  st.glow = 9
  ripple(st.x, st.y, 14)
  play(st.kind, degree_at(st.y), util.linlin(0, 1.8, 0.12, 0.45, speed), st.x, util.clamp(speed / 1.5, 0.15, 1))
end

-- K2 on a stone gives it the next voice; after the last it is lifted.
function S:touch(x, y)
  local i = self:stone_at(x, y, 5)
  if i then
    local st = self.stones[i]
    if st.kind < #STONE_KINDS then
      st.kind = st.kind + 1
      self:sound(st, 1)
      say(STONE_KINDS[st.kind])
    else
      table.remove(self.stones, i)
      say("lifted")
    end
  elseif #self.stones < 24 then
    local st = { x = x, y = y, kind = 1, glow = 0 }
    self.stones[#self.stones + 1] = st
    self:sound(st, 1)
    say(STONE_KINDS[1])
  end
end

function S:alive()
  local n = 0
  for _, m in ipairs(self.fish) do
    if m.fade == 0 then n = n + 1 end
  end
  return n
end

local function whirl(x, y)
  local dx, dy = x - 64, (y - (SURF + FLOOR) / 2) * 2
  local r = math.sqrt(dx * dx + dy * dy) + 10
  return -dy / r * current() * 0.7, dx / r * current() * 0.35
end

function S:step_fish(m, now, crowd)
  if m.fade > 0 then
    m.fade = m.fade + 1
    return
  end
  m.heading = m.heading + (math.random() - 0.5) * 0.45
  local dvx, dvy = math.cos(m.heading) * m.cruise, math.sin(m.heading) * m.cruise
  local cx, cy, ax, ay, sx, sy, n = 0, 0, 0, 0, 0, 0, 0
  for _, o in ipairs(self.fish) do
    if o ~= m and o.fade == 0 then
      local dx, dy = o.x - m.x, o.y - m.y
      local d2 = dx * dx + dy * dy
      if d2 < 196 then
        n = n + 1
        cx, cy, ax, ay = cx + o.x, cy + o.y, ax + o.vx, ay + o.vy
        if d2 < 25 and d2 > 0 then sx, sy = sx - dx / d2, sy - dy / d2 end
      end
    end
  end
  if n > 0 then
    dvx = dvx + (cx / n - m.x) * 0.012 + (ax / n) * 0.06
    dvy = dvy + (cy / n - m.y) * 0.012 + (ay / n) * 0.06
  end
  dvx, dvy = dvx + sx * 0.8, dvy + sy * 0.8
  local fx, fy = whirl(m.x, m.y)
  m.vx = m.vx + (dvx + fx - m.vx) * 0.08
  m.vy = m.vy + (dvy + fy - m.vy) * 0.08
  local speed = math.sqrt(m.vx * m.vx + m.vy * m.vy)
  if speed > 1.8 then m.vx, m.vy, speed = m.vx / speed * 1.8, m.vy / speed * 1.8, 1.8 end
  m.x, m.y = m.x + m.vx, m.y + m.vy
  if m.x < X0 then m.x, m.vx = X0, math.abs(m.vx) end
  if m.x > X1 then m.x, m.vx = X1, -math.abs(m.vx) end
  if m.y < SURF + 3 then m.y, m.vy = SURF + 3, math.abs(m.vy) end
  if m.y > FLOOR - 1 then m.y, m.vy = FLOOR - 1, -math.abs(m.vy) end
  for _, st in ipairs(self.stones) do
    local dx, dy = m.x - st.x, m.y - st.y
    local d2 = dx * dx + dy * dy
    if d2 < HIT_R * HIT_R then
      local d = math.sqrt(d2) + 1e-6
      local nx, ny = dx / d, dy / d
      local dot = m.vx * nx + m.vy * ny
      if dot < 0 then m.vx, m.vy = m.vx - 2 * dot * nx, m.vy - 2 * dot * ny end
      m.x, m.y = st.x + nx * HIT_R, st.y + ny * HIT_R
      if now - (m.cool[st] or 0) > 0.3 then
        m.cool[st] = now
        self:sound(st, speed)
        m.energy = m.energy + FEED
      end
    end
  end
  m.heading = math.atan(m.vy, m.vx)
  m.energy = m.energy - params:get("hunger") * crowd * DT
  if m.energy >= 1 then
    local child = self:add_fish(m.x, m.y, m.heading + math.pi / 2 + (math.random() - 0.5), 0.5)
    m.energy = child and 0.5 or 0.8
  elseif m.energy <= 0 then
    m.fade = 1
  end
end

function S:step(now)
  local crowd = 1 + self:alive() / 10
  for _, m in ipairs(self.fish) do self:step_fish(m, now, crowd) end
  for i = #self.fish, 1, -1 do
    if self.fish[i].fade > 18 then table.remove(self.fish, i) end
  end
  for _, st in ipairs(self.stones) do
    if st.glow > 0 then st.glow = st.glow - 0.6 end
  end
  if self:alive() < FEW and #self.stones > 0 and params:get("arrivals") == 2 then
    self.empty_since = self.empty_since or now
    if now - self.empty_since > 4 then
      self:add_fish(X0 + 1, math.random(SURF + 6, FLOOR - 4), 0, 0.7)
      self.empty_since = nil
    end
  else
    self.empty_since = nil
  end
end

local function shape(kind, x, y, r)
  if kind == 1 then
    ring(x, y, r)
  elseif kind == 2 then
    screen.rect(x - r, y - r, r * 2, r * 2)
  elseif kind == 3 then
    screen.move(x, y - r - 1)
    screen.line(x + r + 1, y)
    screen.line(x, y + r + 1)
    screen.line(x - r - 1, y)
    screen.close()
  else
    screen.move(x, y - r - 1)
    screen.line(x + r + 1, y + r)
    screen.line(x - r - 1, y + r)
    screen.close()
  end
  screen.fill()
end

function S:draw()
  screen.aa(1)
  for _, st in ipairs(self.stones) do
    local x, y = st.x, st.y
    if st.glow > 4 then
      screen.level(math.floor(st.glow - 3))
      ring(x, y, 7)
      screen.stroke()
    end
    screen.level(math.floor(util.clamp(3 + st.glow * 0.7, 0, 15)))
    shape(st.kind, x + 0.5, y + 0.8, 3.3)
    screen.level(math.floor(util.clamp(7 + st.glow, 0, 15)))
    shape(st.kind, x - 0.3, y - 0.3, 2.2)
    screen.level(15)
    screen.rect(math.floor(x) - 1, math.floor(y) - 2, 1, 1)
    screen.fill()
  end
  -- the swimmers: a bright head and a tail that beats as they go
  for _, m in ipairs(self.fish) do
    local fade = 1 - m.fade / 18
    local sp = math.sqrt(m.vx * m.vx + m.vy * m.vy) + 1e-6
    local dx, dy = m.vx / sp, m.vy / sp
    local px, py = -dy, dx
    local len = 3 + util.clamp(m.energy, 0, 1) * 3.5
    local w = math.sin(now_t * 14 + m.ph) * (0.5 + sp * 0.6)
    screen.level(math.max(1, math.floor(6 * fade)))
    screen.move(m.x, m.y)
    screen.line(m.x - dx * len * 0.5 + px * w * 0.4, m.y - dy * len * 0.5 + py * w * 0.4)
    screen.line(m.x - dx * len + px * w * 1.3, m.y - dy * len + py * w * 1.3)
    screen.stroke()
    screen.level(math.max(1, math.floor((9 + util.clamp(m.energy, 0, 1) * 6) * fade)))
    ring(m.x, m.y, 1.2)
    screen.fill()
  end
end

function S:key(n, z, alt)
  if z ~= 1 then return end
  if n == 2 then
    if alt then
      self.stones = {}
      say("every stone lifted")
    else
      self:touch(cursor.x, cursor.y)
    end
  elseif n == 3 then
    if alt then
      for _, m in ipairs(self.fish) do
        if m.fade == 0 then m.fade = 1 end
      end
      say("the swimmers have gone")
    elseif not self:add_fish(cursor.x, cursor.y, nil, 0.7) then
      say("no room for another")
    end
  end
end

local function cell(x, y, rows)
  return util.clamp(math.floor(x / 8) + 1, 1, 16) + (util.clamp(math.floor(y / 8) + 1, 1, rows or 8) - 1) * 16
end

function S:grid()
  local cells = {}
  for _, st in ipairs(self.stones) do
    local k = cell(st.x, st.y)
    cells[k] = math.max(cells[k] or 0, math.floor(6 + st.glow))
  end
  for _, m in ipairs(self.fish) do
    if m.fade == 0 then
      local k = cell(m.x, m.y)
      cells[k] = math.max(cells[k] or 0, 3)
    end
  end
  return cells
end

function S:gkey(x, y)
  self:touch(util.clamp((x - 0.5) * 8, X0, X1), util.clamp((y - 0.5) * 8, SURF + 3, FLOOR - 1))
end

function S:population() return self:alive(), 8 end

function S:note_at_cursor() return note_num(degree_at(cursor.y), V.bell) end

-- ---------------------------------------------------------------- pool: jellies
--
-- Each jellyfish pulses on its own count of sixteenths — a small one every
-- four, a large one every ten — so a few of them make a polyrhythm. A pulse
-- is a note, pitched by how high it swims, and pushes it up; it sinks back
-- to the depth it likes. Fed, it grows, slows and deepens; too big, it
-- splits in two small quick ones.

local J = { name = "jellies", hint = "K2 food   K3 jelly", jellies = {}, food = {}, empty_since = nil }
pools.jellies = J

function J:add(x, y, size)
  if #self.jellies >= 10 then return nil end
  local j = { x = x, y = y, home = y, vx = 0, vy = 0, size = size or 4, count = math.random(0, 3), pulse = 0, ph = math.random() * 6.28 }
  self.jellies[#self.jellies + 1] = j
  return j
end

function J:period(j) return j.size + 1 end

function J:pulse(j)
  j.count = 0
  j.pulse = 1
  j.vy = j.vy - (0.25 + j.size * 0.015)
  local amp = util.linlin(3, 10, 0.22, 0.42, j.size)
  if play(V.jelly, degree_at(j.y), amp, j.x, util.linlin(3, 10, 0.85, 0.3, j.size)) then
    ripple(j.x, j.y - j.size * 0.4, j.size + 6)
  end
end

function J:beat()
  for _, j in ipairs(self.jellies) do
    j.count = j.count + 1
    if j.count >= self:period(j) then self:pulse(j) end
  end
end

function J:step(now)
  for _, j in ipairs(self.jellies) do
    -- pulled back to the depth it likes: a pulse lifts it two notes or so,
    -- and it settles again before the next
    j.vy = (j.vy + (j.home - j.y) * 0.002 + 0.006) * 0.96
    j.vx = j.vx * 0.95 + current() * 0.02 + math.sin(now_t * 0.3 + j.ph) * 0.008
    j.x, j.y = j.x + j.vx, j.y + j.vy
    if j.x < -10 then j.x = 137 elseif j.x > 137 then j.x = -10 end
    local top = SURF + j.size + 2
    if j.y < top then j.y, j.vy = top, math.abs(j.vy) * 0.3 end
    if j.y > FLOOR - 3 then j.y, j.vy = FLOOR - 3, 0 end
    if j.pulse > 0 then j.pulse = math.max(0, j.pulse - DT * 2.5) end
  end
  for i = #self.food, 1, -1 do
    local f = self.food[i]
    if f.y < FLOOR + 1 then
      f.y = f.y + 0.22
      f.x = f.x + math.sin(now_t * 2 + f.ph) * 0.15 + current() * 0.1
    else
      f.rest = (f.rest or 0) + DT
    end
    local eaten = false
    for _, j in ipairs(self.jellies) do
      local dx, dy = f.x - j.x, f.y - (j.y + j.size * 0.6)
      if not eaten and dx * dx + dy * dy < (j.size + 2) ^ 2 then
        eaten = true
        j.size = j.size + 1
        ripple(j.x, j.y, 6)
        if j.size > 9 then
          j.size = 4
          j.x = j.x - 4
          local twin = self:add(j.x + 8, j.y, 4)
          if twin then
            twin.home = util.clamp(j.home - 8, SURF + 8, FLOOR - 6)
            self:pulse(twin)
          end
          self:pulse(j)
          say("a jelly split in two")
        end
      end
    end
    if eaten or (f.rest or 0) > 4 then table.remove(self.food, i) end
  end
  if #self.jellies == 0 and params:get("arrivals") == 2 then
    self.empty_since = self.empty_since or now
    if now - self.empty_since > 5 then
      local j = self:add(-8, math.random(SURF + 12, FLOOR - 10), 4)
      if j then j.vx = 0.4 end
      self.empty_since = nil
    end
  else
    self.empty_since = nil
  end
end

function J:draw()
  screen.aa(1)
  screen.level(7)
  for _, f in ipairs(self.food) do screen.rect(math.floor(f.x), math.floor(f.y), 1, 1) end
  screen.fill()
  for _, j in ipairs(self.jellies) do
    local r = j.size * (1 + j.pulse * 0.2)
    local x, y = j.x, j.y
    -- tentacles, gathered in by a pulse and trailing after it
    local n = j.size >= 6 and 4 or 3
    local len = j.size * 1.7 * (1 - j.pulse * 0.35) + 2
    screen.level(4)
    for k = 1, n do
      local bx = x - r * 0.6 + (k - 1) * (r * 1.2 / (n - 1))
      screen.move(bx, y + 0.5)
      for s = 1, 4 do
        local f = s / 4
        screen.line(bx + math.sin(now_t * 2.6 + j.ph + k * 1.3 + s) * f * 1.8, y + len * f)
      end
      screen.stroke()
    end
    if j.pulse > 0.3 then
      screen.level(math.floor(j.pulse * 6))
      ring(x, y - r * 0.4, r + 3)
      screen.stroke()
    end
    -- the bell, a darker heart, a frilled rim and a glint
    screen.level(math.floor(5 + j.pulse * 9))
    screen.move(x - r, y)
    screen.arc(x, y, r, math.pi, 2 * math.pi)
    screen.close()
    screen.fill()
    screen.level(2)
    screen.move(x - r * 0.45, y)
    screen.arc(x, y, r * 0.45, math.pi, 2 * math.pi)
    screen.close()
    screen.fill()
    screen.level(math.floor(7 + j.pulse * 6))
    for k = -2, 2 do screen.rect(math.floor(x + k * r * 0.4), math.floor(y), 1, 1) end
    screen.fill()
    screen.level(13)
    screen.rect(math.floor(x - r * 0.5), math.floor(y - r * 0.65), 1, 1)
    screen.fill()
    -- how far it is through its count, as a little line above it
    screen.level(3)
    screen.move(x - 2, y - r - 3)
    screen.line(x - 2 + 4 * j.count / self:period(j), y - r - 3)
    screen.stroke()
  end
end

function J:nearest(x, y, within)
  local best, bi = within * within, nil
  for i, j in ipairs(self.jellies) do
    local d = (j.x - x) ^ 2 + (j.y - y) ^ 2
    if d < best then best, bi = d, i end
  end
  return bi
end

function J:key(n, z, alt)
  if z ~= 1 then return end
  if n == 2 then
    if alt then
      local i = self:nearest(cursor.x, cursor.y, 12)
      if i then
        table.remove(self.jellies, i)
        say("let go")
      end
    elseif #self.food < 30 then
      self.food[#self.food + 1] = { x = cursor.x, y = cursor.y, ph = math.random() * 6.28 }
    end
  elseif n == 3 then
    if alt then
      self.jellies, self.food = {}, {}
      say("the jellies have gone")
    elseif not self:add(cursor.x, cursor.y, 4) then
      say("no room for another")
    end
  end
end

function J:grid()
  local cells = {}
  for _, j in ipairs(self.jellies) do
    local k = cell(j.x, j.y)
    cells[k] = math.max(cells[k] or 0, math.floor(5 + j.pulse * 10))
  end
  for _, f in ipairs(self.food) do
    local k = cell(f.x, f.y)
    cells[k] = math.max(cells[k] or 0, 2)
  end
  return cells
end

-- A press on a jelly feeds it; anywhere else a new jelly is let go.
function J:gkey(x, y)
  local px, py = util.clamp((x - 0.5) * 8, X0, X1), util.clamp((y - 0.5) * 8, SURF + 6, FLOOR - 3)
  local i = self:nearest(px, py, 7)
  if i then
    local j = self.jellies[i]
    self.food[#self.food + 1] = { x = j.x, y = j.y + j.size * 0.6, ph = 0 }
  elseif not self:add(px, py, 4) then
    say("no room for another")
  end
end

function J:population() return #self.jellies, 5 end

function J:note_at_cursor() return note_num(degree_at(cursor.y), V.jelly) end

-- ---------------------------------------------------------------- pool: bubbles
--
-- Vents in the sand breathe out bubbles, each vent on its own count of
-- sixteenths. Bubbles rise — the big ones faster — wobble, and merge when
-- they touch; at the surface they break, and the note is their size: the
-- bigger, the lower. Hold K3 to blow one yourself, as big as you like.

local B = { name = "bubbles", hint = "K2 vent   hold K3 blow", vents = {}, bubbles = {}, blowing = nil, next_period = 1 }
pools.bubbles = B

local PERIODS = { 3, 4, 5, 6, 8 }
local MAX_R = 7

function B:emit(x, y, r)
  if #self.bubbles >= 40 then return end
  self.bubbles[#self.bubbles + 1] = { x = x, y = y, r = r, vy = 0, ph = math.random() * 6.28 }
end

function B:beat()
  for _, v in ipairs(self.vents) do
    v.count = v.count + 1
    if v.count >= v.period then
      v.count, v.puff = 0, 1
      self:emit(v.x + (math.random() - 0.5) * 2, FLOOR - 1, 0.8 + math.random() * 1.6)
    end
  end
end

function B:pop(b)
  local degree = math.floor((MAX_R - b.r) / (MAX_R - 0.8) * (DEGREES - 1) + 0.5)
  play(V.bubble, degree, util.linlin(0.8, MAX_R, 0.14, 0.42, b.r), b.x, util.linlin(0.8, MAX_R, 0.9, 0.3, b.r))
  ripple(b.x, SURF, 6 + b.r * 2, true)
  splash(b.x, math.floor(1 + b.r * 0.6))
end

function B:step()
  for _, v in ipairs(self.vents) do
    if v.puff > 0 then v.puff = math.max(0, v.puff - DT * 3) end
  end
  if self.blowing then
    self.blowing.r = math.min(MAX_R, self.blowing.r + 0.06)
    self.blowing.x, self.blowing.y = cursor.x, cursor.y
  end
  for _, b in ipairs(self.bubbles) do
    b.vy = b.vy + (-(0.25 + b.r * 0.12) - b.vy) * 0.08
    b.y = b.y + b.vy
    b.x = util.clamp(b.x + math.sin(now_t * 2.2 + b.ph) * 0.18 + current() * 0.3, X0, X1)
  end
  -- touching bubbles become one, as big as both together
  local i = 1
  while i <= #self.bubbles do
    local a = self.bubbles[i]
    local merged = false
    for k = i + 1, #self.bubbles do
      local b = self.bubbles[k]
      local dx, dy = a.x - b.x, a.y - b.y
      if dx * dx + dy * dy < (a.r + b.r - 0.6) ^ 2 then
        local wa, wb = a.r * a.r, b.r * b.r
        a.x, a.y = (a.x * wa + b.x * wb) / (wa + wb), (a.y * wa + b.y * wb) / (wa + wb)
        a.r = math.min(MAX_R, math.sqrt(wa + wb))
        a.vy = math.min(a.vy, b.vy)
        table.remove(self.bubbles, k)
        merged = true
        break
      end
    end
    if not merged then i = i + 1 end
  end
  for k = #self.bubbles, 1, -1 do
    local b = self.bubbles[k]
    if b.y - b.r <= surface_y(b.x) then
      self:pop(b)
      table.remove(self.bubbles, k)
    end
  end
end

local function draw_bubble(x, y, r)
  if r < 1.3 then
    screen.level(10)
    screen.rect(math.floor(x), math.floor(y), 1, 1)
    screen.fill()
    return
  end
  screen.level(1)
  ring(x, y, r)
  screen.fill()
  screen.level(10)
  ring(x, y, r)
  screen.stroke()
  screen.level(15)
  screen.rect(math.floor(x - r * 0.45), math.floor(y - r * 0.45), 1, 1)
  screen.fill()
end

function B:draw()
  for _, v in ipairs(self.vents) do
    local x = v.x
    screen.aa(1)
    screen.level(math.floor(4 + v.puff * 8))
    screen.move(x - 4, FLOOR + 2)
    screen.arc(x, FLOOR + 2, 4, math.pi, 2 * math.pi)
    screen.close()
    screen.fill()
    screen.level(0)
    screen.move(x, FLOOR - 1)
    screen.line(x, FLOOR + 2)
    screen.stroke()
    -- its count, as dots in the sand
    screen.aa(0)
    for k = 1, v.period do
      screen.level(k - 1 == v.count and 12 or 4)
      screen.rect(math.floor(x - v.period + k * 2 - 1), 62, 1, 1)
      screen.fill()
    end
  end
  screen.aa(1)
  for _, b in ipairs(self.bubbles) do
    draw_bubble(b.x, b.y, b.r + math.sin(now_t * 6 + b.ph) * 0.15)
  end
  if self.blowing then
    local b = self.blowing
    draw_bubble(b.x, b.y, b.r + math.sin(now_t * 9) * 0.3)
  end
  -- where a vent would go
  screen.aa(0)
  screen.level(3)
  screen.rect(math.floor(cursor.x) - 1, FLOOR + 5, 3, 1)
  screen.fill()
end

function B:toggle_vent(x)
  for i, v in ipairs(self.vents) do
    if math.abs(v.x - x) < 6 then
      table.remove(self.vents, i)
      say("vent closed")
      return
    end
  end
  if #self.vents >= 8 then
    say("no room for another vent")
    return
  end
  local p = PERIODS[self.next_period]
  self.next_period = self.next_period % #PERIODS + 1
  self.vents[#self.vents + 1] = { x = x, period = p, count = 0, puff = 1 }
  say("a vent, every " .. p)
end

function B:key(n, z, alt)
  if n == 2 and z == 1 then
    if alt then
      self.vents = {}
      say("every vent closed")
    else
      self:toggle_vent(cursor.x)
    end
  elseif n == 3 then
    if z == 1 then
      if alt then
        self.bubbles = {}
        say("the water is still")
      else
        self.blowing = { x = cursor.x, y = cursor.y, r = 1 }
      end
    elseif self.blowing then
      self:emit(self.blowing.x, self.blowing.y, self.blowing.r)
      self.blowing = nil
    end
  end
end

function B:grid()
  local cells = {}
  for _, b in ipairs(self.bubbles) do
    local k = cell(b.x, b.y, 7)
    cells[k] = math.max(cells[k] or 0, math.floor(3 + b.r))
  end
  for _, v in ipairs(self.vents) do
    local k = util.clamp(math.floor(v.x / 8) + 1, 1, 16) + 7 * 16
    cells[k] = math.max(cells[k] or 0, math.floor(6 + v.puff * 9))
  end
  return cells
end

-- The bottom row opens and closes vents; anywhere else lets a bubble go,
-- bigger the lower it starts.
function B:gkey(x, y)
  local px = util.clamp((x - 0.5) * 8, X0, X1)
  if y == 8 then
    self:toggle_vent(px)
  else
    self:emit(px, util.clamp((y - 0.5) * 8, SURF + 4, FLOOR - 2), 1 + (y - 1) * 0.8)
  end
end

function B:population() return #self.vents * 2, 6 end

-- ---------------------------------------------------------------- drawing

local function draw_hud()
  local t = util.time()
  screen.aa(0)
  if t < banner_until then
    local fade = util.clamp((banner_until - t) / 0.4, 0, 1)
    screen.font_size(16)
    local w = screen.text_extents(pool.name)
    screen.level(0)
    screen.rect(64 - w / 2 - 6, 18, w + 12, 27)
    screen.fill()
    screen.level(math.floor(15 * fade))
    screen.move(64, 33)
    screen.text_center(pool.name)
    screen.font_size(8)
    screen.level(math.floor(6 * fade))
    screen.move(64, 42)
    screen.text_center(pool.hint)
  elseif message and t < message_until then
    screen.font_size(8)
    local w = screen.text_extents(message) + 6
    screen.level(0)
    screen.rect(0, 0, w, 8)
    screen.fill()
    screen.level(15)
    screen.move(2, 6)
    screen.text(message)
  end
end

function redraw()
  screen.clear()
  screen.font_face(1)
  screen.font_size(8)
  screen.line_width(1)
  draw_water()
  draw_effects()
  pool:draw()
  draw_cursor()
  draw_hud()
  screen.update()
end

local function grid_redraw()
  g:all(0)
  for k, lvl in pairs(pool:grid()) do
    g:led((k - 1) % 16 + 1, math.floor((k - 1) / 16) + 1, util.clamp(lvl, 0, 15))
  end
  g:refresh()
end

g.key = function(x, y, z)
  if z == 1 then pool:gkey(x, y) end
end

-- ---------------------------------------------------------------- controls

function enc(n, d)
  if held[1] then
    if n == 1 then
      params:delta("pool", d)
    elseif n == 2 then
      params:delta("scale", d)
      say(scale_names[params:get("scale")])
    else
      params:delta("root", d)
      say("root " .. musicutil.note_num_to_name(params:get("root"), true))
    end
    return
  end
  if n == 1 then
    params:delta("current", d)
    local c = current()
    say(string.format("current %s %.2f", c < 0 and "<<" or ">>", math.abs(c)))
  elseif n == 2 then
    cursor.x = util.clamp(cursor.x + d * 1.5, X0, X1)
    cursor_moved = util.time()
  else
    cursor.y = util.clamp(cursor.y - d * 1.5, SURF + 3, FLOOR - 1)
    cursor_moved = util.time()
    if pool.note_at_cursor then say(musicutil.note_num_to_name(pool:note_at_cursor(), true)) end
  end
end

function key(n, z)
  held[n] = (z == 1)
  if n > 1 then pool:key(n, z, held[1]) end
end

-- ---------------------------------------------------------------- state

local function defaults()
  S.stones, S.fish = {}, {}
  for _, s in ipairs({ { 22, 44, 2 }, { 38, 22, 1 }, { 52, 50, 4 }, { 64, 16, 3 },
                       { 76, 38, 2 }, { 92, 20, 1 }, { 104, 48, 4 }, { 116, 30, 3 } }) do
    S.stones[#S.stones + 1] = { x = s[1], y = s[2], kind = s[3], glow = 0 }
  end
  J.jellies, J.food = {}, {}
  J:add(30, 28, 3)
  J:add(66, 40, 5)
  J:add(100, 22, 7)
  B.vents, B.bubbles = {}, {}
  for _, v in ipairs({ { 26, 3 }, { 64, 4 }, { 98, 6 } }) do
    B.vents[#B.vents + 1] = { x = v[1], period = v[2], count = 0, puff = 0 }
  end
end

local function save_state(path)
  util.make_dir(DATA)
  local st, je, ve = {}, {}, {}
  for i, s in ipairs(S.stones) do st[i] = { x = s.x, y = s.y, kind = s.kind } end
  for i, j in ipairs(J.jellies) do je[i] = { x = j.x, y = j.y, home = j.home, size = j.size } end
  for i, v in ipairs(B.vents) do ve[i] = { x = v.x, period = v.period } end
  tab.save({ stones = st, jellies = je, vents = ve }, path)
end

local function num(v, lo, hi, default)
  v = tonumber(v)
  if v == nil then return default end
  return util.clamp(v, lo, hi)
end

-- What an earlier version of remous saved (stones only) is read too.
local function load_state(path)
  if not util.file_exists(path) then return false end
  local t = tab.load(path)
  if type(t) ~= "table" then return false end
  defaults()
  if type(t.stones) == "table" then
    S.stones = {}
    for _, s in ipairs(t.stones) do
      if type(s) == "table" then
        S.stones[#S.stones + 1] = {
          x = num(s.x, X0, X1, 64), y = num(s.y, SURF + 3, FLOOR - 1, 32),
          kind = math.floor(num(s.kind, 1, #STONE_KINDS, 1)), glow = 0,
        }
      end
    end
  end
  if type(t.jellies) == "table" then
    J.jellies = {}
    for _, j in ipairs(t.jellies) do
      if type(j) == "table" then
        local made = J:add(num(j.x, 0, 127, 64), num(j.y, SURF + 6, FLOOR - 3, 32), math.floor(num(j.size, 3, 9, 4)))
        if made then made.home = num(j.home, SURF + 6, FLOOR - 3, made.y) end
      end
    end
  end
  if type(t.vents) == "table" then
    B.vents = {}
    for _, v in ipairs(t.vents) do
      if type(v) == "table" then
        B.vents[#B.vents + 1] = { x = num(v.x, X0, X1, 64), period = math.floor(num(v.period, 2, 12, 4)), count = 0, puff = 0 }
      end
    end
  end
  return true
end

local function add_params()
  for i, s in ipairs(musicutil.SCALES) do scale_names[i] = s.name end
  local start_scale = 1
  for i, n in ipairs(scale_names) do
    if n == "Major Pentatonic" then start_scale = i end
  end

  params:add_separator("remous", "remous")
  params:add_option("pool", "pool", POOLS, 1)
  params:set_action("pool", function(i)
    pool = pools[POOLS[i]]
    banner_until = util.time() + 2.2
    ripples, sparks = {}, {}
  end)
  params:add_option("scale", "scale", scale_names, start_scale)
  params:set_action("scale", build_notes)
  params:add_number("root", "root", 36, 72, 50, function(p) return musicutil.note_num_to_name(p:get(), true) end)
  params:set_action("root", build_notes)
  params:add_control("current", "current", controlspec.new(-1, 1, "lin", 0.01, 0.25))

  params:add_separator("remous_life", "life")
  params:add_number("swimmers", "most swimmers", 1, 40, 16)
  params:add_control("hunger", "hunger", controlspec.new(0.005, 0.2, "lin", 0.005, 0.025))
  params:add_number("density", "notes a second", 2, 40, 14)
  params:add_option("arrivals", "arrivals", { "off", "on" }, 2)

  params:add_separator("remous_sound", "sound")
  params:add_control("drone", "drone", controlspec.new(0, 1, "lin", 0.01, 0.5))
  params:add_control("space", "space", controlspec.new(0, 1, "lin", 0.01, 0.35))
  params:set_action("space", function(v) engine.space(v) end)
  params:add_control("echo_level", "echo level", controlspec.new(0, 1, "lin", 0.01, 0.45))
  params:set_action("echo_level", function(v) engine.emix(v) end)
  params:add_control("echo_fb", "echo feedback", controlspec.new(0, 0.85, "lin", 0.01, 0.45))
  params:set_action("echo_fb", function(v) engine.efb(v) end)
  params:add_control("echo_time", "echo time", controlspec.new(0.08, 1.5, "exp", 0, 0.42, "s"))
  params:set_action("echo_time", function(v) engine.etime(v) end)
  params:add_control("volume", "volume", controlspec.new(0, 1.5, "lin", 0.01, 1))
  params:set_action("volume", function(v) engine.level(v) end)

  params.action_write = function(filename, name, number) save_state(DATA .. number .. ".data") end
  params.action_read = function(filename, silent, number) load_state(DATA .. number .. ".data") end
  params.action_delete = function(filename, name, number) os.remove(DATA .. number .. ".data") end
end

-- ---------------------------------------------------------------- life

local function step()
  local now = util.time()
  now_t = now - start_time
  pool:step(now)
  step_water()
  if now - drone_at > 0.5 then
    drone_at = now
    local have, full = pool:population()
    engine.drone(params:get("drone") * math.min(1, have / full), musicutil.note_num_to_freq(params:get("root") - 24))
  end
end

function init()
  start_time = util.time()
  pool = pools.stones
  add_params()
  params:bang()
  build_notes()
  if not load_state(DATA .. "state.data") then defaults() end
  for _ = 1, 6 do S:add_fish(math.random(20, 108), math.random(SURF + 6, FLOOR - 6), nil, 0.6) end
  init_water()

  sim = metro.init(function()
    step()
    redraw()
    grid_redraw()
  end, DT)
  sim:start()

  beat_clock = clock.run(function()
    while true do
      clock.sync(1 / 4)
      if pool.beat then pool:beat() end
    end
  end)
end

function cleanup()
  save_state(DATA .. "state.data")
  if sim then sim:stop() end
  if beat_clock then clock.cancel(beat_clock) end
  engine.drone(0, 55)
end
