-- fireflies: the swarm
--
-- Each firefly is a pulse-coupled oscillator (Mirollo & Strogatz, 1990): a
-- phase that climbs from 0 to 1 and flashes at 1. When one flashes, every
-- firefly within reach that is past its refractory moment is nudged ahead
-- along a concave curve; one nudged to the top flashes in the same instant,
-- and is absorbed into the flash. Nobody leads, and the meadow comes to
-- blink together, in waves first, then as one.
--
-- Pure Lua, no norns: the script asks it to step and draws what it says.

local Swarm = {}
Swarm.__index = Swarm

local B = 3 -- how concave the response: higher syncs faster
local EB = math.exp(B) - 1

local function f(phi) return math.log(1 + EB * phi) / B end
local function finv(x) return (math.exp(B * x) - 1) / EB end

local TRAIL = 9

-- how hard a flash pushes, at full coupling and point blank: small, so the
-- meadow takes minutes to come together and not seconds
Swarm.K = 0.016

-- the air they fly in: the near ones anywhere between the treetops and the
-- grass; the far ones over the far meadow only, between the oak and the
-- reeds -- behind the oak's leaves their glow would show through the gaps
-- as a ring of dots
Swarm.REGION = { x0 = -6, x1 = 133, near_top = 20, bottom = 60,
  far_x0 = 52, far_x1 = 100, far_top = 31, far_bottom = 46 }

function Swarm.new(rand)
  local s = setmetatable({}, Swarm)
  s.rand = rand or math.random
  s.flies = {}
  s.recent = {} -- times of the last flashes, for telling a chorus
  s.time = 0
  s.calls = {} -- rings left by a lantern or a call
  return s
end

function Swarm:spawn(x, y, z)
  local r = self.rand
  local R = Swarm.REGION
  z = z or (0.35 + r() * 0.65)
  local far = z < 0.55
  local top = far and R.far_top or R.near_top
  local bottom = far and R.far_bottom or R.bottom
  local fly = {
    x = x or (far and (R.far_x0 + r() * (R.far_x1 - R.far_x0)) or (r() * 128)),
    y = y or (top + r() * (bottom - top)),
    z = z,
    vx = (r() - 0.5) * 2, vy = (r() - 0.5),
    phase = r(),
    tempo = 1 + (r() - 0.5) * 2, -- scaled by the spread
    rank = r(), -- who wakes first as the night comes
    glow = 0, flash = 0, dir = (r() < 0.5) and -1 or 1,
    trail = {}, degree = nil, voice = nil, seed = r(),
  }
  self.flies[#self.flies + 1] = fly
  return fly
end

function Swarm:resize(n)
  while #self.flies < n do self:spawn() end
  while #self.flies > n do table.remove(self.flies, math.floor(self.rand() * #self.flies) + 1) end
end

function Swarm:remove_near(x, y, within)
  local best, bd = nil, within or 1e9
  for i, fl in ipairs(self.flies) do
    local d = math.abs(fl.x - x) + math.abs(fl.y - y) * 1.5
    if d < bd then best, bd = i, d end
  end
  if best then table.remove(self.flies, best) return true end
  return false
end

-- Scatter: everyone's clock to a random place. The meadow starts over.
function Swarm:scatter()
  for _, fl in ipairs(self.flies) do fl.phase = self.rand() end
end

-- A gust: phases jostled in proportion, and everyone pushed downwind.
function Swarm:gust(strength, dir)
  for _, fl in ipairs(self.flies) do
    fl.phase = (fl.phase + (self.rand() - 0.5) * strength * 0.9) % 1
    fl.vx = fl.vx + dir * strength * (3 + self.rand() * 5) * fl.z
    fl.vy = fl.vy + (self.rand() - 0.6) * strength * 2
  end
end

-- How together they are: the length of the mean of their phases on the
-- circle (Kuramoto's order parameter), 0 scattered, 1 as one.
function Swarm:sync()
  local c, s, n = 0, 0, 0
  for _, fl in ipairs(self.flies) do
    if fl.active then
      c = c + math.cos(fl.phase * 2 * math.pi)
      s = s + math.sin(fl.phase * 2 * math.pi)
      n = n + 1
    end
  end
  if n < 2 then return 0, n end
  return math.sqrt(c * c + s * s) / n, n
end

-- One flash, and its push on the others. `queue` collects whoever it
-- pushes over the top, who flash in the same instant.
local function nudge(self, sx, sy, eps0, reach, refractory, fired, queue)
  for _, fl in ipairs(self.flies) do
    if fl.active and not fired[fl] and fl.phase > refractory then
      local dx, dy = fl.x - sx, (fl.y - sy) * 1.6
      local d = math.sqrt(dx * dx + dy * dy)
      if d < reach then
        local eps = eps0 * math.sqrt(1 - d / reach)
        local x = f(fl.phase) + eps
        if x >= 1 then
          fired[fl] = true
          queue[#queue + 1] = fl
        else
          fl.phase = finv(x)
        end
      end
    end
  end
end

local function light(self, fl, events, glow_time)
  fl.phase = 0
  fl.glow = 1
  fl.flash = 1
  fl.flash_len = glow_time * (0.8 + fl.seed * 0.4)
  fl.trail = {}
  self.recent[#self.recent + 1] = self.time
  events[#events + 1] = fl
end

-- A light from outside the swarm: the lantern on the beat, a call from a
-- MIDI keyboard. It pushes like a flash, harder, and leaves a ring.
function Swarm:pulse(x, y, strength, env)
  local events, fired, queue = {}, {}, {}
  nudge(self, x, y, env.coupling * Swarm.K * 2.5 * strength, env.reach * 1.25, env.refractory, fired, queue)
  local i = 1
  while i <= #queue do
    local fl = queue[i]
    light(self, fl, events, env.glow_time)
    nudge(self, fl.x, fl.y, env.coupling * Swarm.K, env.reach, env.refractory, fired, queue)
    i = i + 1
  end
  self.calls[#self.calls + 1] = { x = x, y = y, r = 1, life = 1, strength = strength }
  return events
end

-- Step the meadow by dt seconds. env: coupling, reach, period, spread,
-- refractory, drift, wind, activity, glow_time. Returns the fireflies that
-- flashed, in the order they lit.
function Swarm:step(dt, env)
  self.time = self.time + dt
  local r = self.rand
  local R = Swarm.REGION
  local events, fired, queue = {}, {}, {}

  for _, fl in ipairs(self.flies) do
    fl.active = fl.rank < env.activity
    -- movement: a slow wander, the wind, and the J of a flash (down, then up)
    -- while it flashes it flies its J and hardly wanders, so the trail it
    -- leaves is the J and not a scribble
    local wander = env.drift * (fl.flash > 0 and 0.15 or 1)
    fl.vx = fl.vx * 0.96 + (r() - 0.5) * wander * 0.9 + env.wind * 0.03 * fl.z
    fl.vy = fl.vy * 0.94 + (r() - 0.5) * wander * 0.6
    local top = fl.z < 0.55 and R.far_top or R.near_top
    local bottom = fl.z < 0.55 and R.far_bottom or R.bottom
    if fl.y < top then fl.vy = fl.vy + 0.08 elseif fl.y > bottom then fl.vy = fl.vy - 0.08 end
    local jx, jy = 0, 0
    if fl.flash > 0 then
      -- Photinus pyralis: a dip, then a climb, while the light is on
      local u = 1 - fl.flash
      jy = (0.42 - u) * 60 * fl.z
      jx = fl.dir * 8 * fl.z
    end
    local speed = 4 * (0.4 + fl.z * 0.6)
    fl.x = fl.x + (fl.vx * speed + jx) * dt
    fl.y = fl.y + (fl.vy * speed + jy) * dt
    local x0, x1 = R.x0, R.x1
    if fl.z < 0.55 then x0, x1 = R.far_x0, R.far_x1 end
    -- off one edge, back at the other: a new firefly, as far as anyone can
    -- tell, so its trail goes (or the streak would cross the whole meadow)
    if fl.x > x1 then fl.x = x0 + 1; fl.y = top + r() * (bottom - top); fl.trail = {} end
    if fl.x < x0 then fl.x = x1 - 1; fl.y = top + r() * (bottom - top); fl.trail = {} end

    -- the glow dies away; the trail keeps where it was while lit
    if fl.flash > 0 then
      fl.flash = math.max(0, fl.flash - dt / (fl.flash_len or env.glow_time))
      table.insert(fl.trail, 1, { fl.x, fl.y })
      if #fl.trail > TRAIL then fl.trail[#fl.trail] = nil end
    elseif #fl.trail > 0 then
      fl.trail[#fl.trail] = nil
    end
    fl.glow = fl.flash > 0 and (fl.flash ^ 0.6) or 0

    -- the clock
    if fl.active then
      local period = env.period * (1 + fl.tempo * env.spread)
      fl.phase = fl.phase + dt / period
      if fl.phase >= 1 and not fired[fl] then
        fired[fl] = true
        queue[#queue + 1] = fl
      end
    end
  end

  -- flashes, and the flashes they cause, in one instant
  local i = 1
  while i <= #queue do
    local fl = queue[i]
    light(self, fl, events, env.glow_time)
    nudge(self, fl.x, fl.y, env.coupling * Swarm.K, env.reach, env.refractory, fired, queue)
    i = i + 1
  end

  -- rings left by the lantern and calls
  for k = #self.calls, 1, -1 do
    local c = self.calls[k]
    c.r = c.r + dt * 26
    c.life = c.life - dt * 1.4
    if c.life <= 0 then table.remove(self.calls, k) end
  end

  -- forget flashes older than a moment
  local keep = {}
  for _, t in ipairs(self.recent) do
    if self.time - t < 0.18 then keep[#keep + 1] = t end
  end
  self.recent = keep
  return events
end

-- How many flashed in the last moment: a chorus is most of them at once.
function Swarm:recent_count() return #self.recent end

return Swarm
