-- mycelium: the network
--
-- Hyphal tips walk through the soil: a persistent random walk, turned
-- toward food they can smell and away from stones. Every few pixels a tip
-- lays down a node; now and then it forks. A tip that meets its own colony
-- fuses with it (anastomosis, a loop in the net); one that meets another
-- colony stops. A tip that finds no food tires and dies; the colony grows
-- new ones from what it has eaten.
--
-- Signals run along the net: a wave starts at a node and spreads to every
-- neighbour, hop by hop, at the speed of the pulse, weaker at each hop; a
-- node a wave reaches is lit, and the ones that matter (forks, fusions,
-- tips, a root) are where the script plays a note. Food found, the oak's
-- sugar through its roots, a mushroom opening and a player's touch all
-- start one.
--
-- Pure Lua, no norns: the script asks it to step and draws what it says.

local Net = {}
Net.__index = Net

local SEG = 3       -- pixels between nodes
local CELL = 4      -- the spatial hash's cell
local TAU = 2 * math.pi

Net.SEG = SEG

local function clamp(v, a, b) return v < a and a or (v > b and b or v) end

-- what a season does to the fungus: growth, forking, fruiting, dying back
local SEASON = {
  { grow = 1.3, branch = 1.25, fruit = 0.25, die = 0.4, litter = 0.1 },  -- spring
  { grow = 1.0, branch = 1.0, fruit = 0.6, die = 0.6, litter = 0.15 },   -- summer
  { grow = 0.75, branch = 0.85, fruit = 1.7, die = 0.9, litter = 1.0 },  -- autumn
  { grow = 0.22, branch = 0.35, fruit = 0.0, die = 1.8, litter = 0.0 },  -- winter
}

local function season_at(s)
  s = s % 4
  local i = math.floor(s)
  local u = s - i
  local a, b = SEASON[i + 1], SEASON[(i + 1) % 4 + 1]
  local out = {}
  for k, v in pairs(a) do out[k] = v + (b[k] - v) * u end
  return out
end
Net.season_at = season_at

function Net.new(scene, rand)
  local n = setmetatable({}, Net)
  n.rand = rand or math.random
  n.scene = scene
  n.nodes, n.tips, n.food, n.pulses = {}, {}, {}, {}
  n.colonies, n.mushrooms, n.spores, n.seeps = {}, {}, {}, {}
  n.hash = {}
  n.time = 0
  n.next_id = 1
  n.next_wave = 1
  n.waves = {}
  n.pending = {}
  return n
end

-- ---------------------------------------------------------------- the soil

function Net:ground(x)
  local g = self.scene.ground
  return g[math.max(1, math.min(#g, math.floor(x) + 1))]
end

function Net:blocked(x, y)
  if x < 0 or x > 127.5 or y > 63.5 then return true end
  if y < self:ground(x) + 2 then return true end
  local row = self.scene.stones[math.floor(y) + 1]
  if row and row:byte(math.floor(x) + 1) == 49 then return true end -- "1"
  return false
end

local function key(x, y) return math.floor(x / CELL) * 64 + math.floor(y / CELL) end

function Net:near(x, y, r, fn)
  local cx0, cx1 = math.floor((x - r) / CELL), math.floor((x + r) / CELL)
  local cy0, cy1 = math.floor((y - r) / CELL), math.floor((y + r) / CELL)
  local r2 = r * r
  for cx = cx0, cx1 do
    for cy = cy0, cy1 do
      local b = self.hash[cx * 64 + cy]
      if b then
        for _, nd in ipairs(b) do
          if not nd.gone then
            local dx, dy = nd.x - x, nd.y - y
            if dx * dx + dy * dy <= r2 then
              if fn(nd, dx * dx + dy * dy) == false then return end
            end
          end
        end
      end
    end
  end
end

function Net:crowd(x, y)
  local b = self.hash[key(x, y)]
  if not b then return 0 end
  local c = 0
  for _, nd in ipairs(b) do if not nd.gone then c = c + 1 end end
  return c
end

-- ---------------------------------------------------------------- nodes

local function node(self, x, y, parent, colony)
  local nd = {
    id = self.next_id, x = x, y = y, parent = parent, kids = {}, links = {},
    colony = colony, desc = 0, born = self.time, glow = 0, hops = parent and (parent.hops + 1) or 0,
  }
  self.next_id = self.next_id + 1
  self.nodes[#self.nodes + 1] = nd
  local k = key(x, y)
  local b = self.hash[k]
  if not b then b = {} self.hash[k] = b end
  b[#b + 1] = nd
  if parent then
    parent.kids[#parent.kids + 1] = nd
    local p = parent
    local guard = 0
    while p and guard < 400 do
      p.desc = p.desc + 1
      p = p.parent
      guard = guard + 1
    end
  end
  colony.count = colony.count + 1
  return nd
end

function Net:alive_count()
  local c = 0
  for _, nd in ipairs(self.nodes) do if not nd.gone then c = c + 1 end end
  return c
end

-- the neighbours a signal can travel to
local function neighbours(nd)
  local out = {}
  if nd.parent and not nd.parent.gone then out[#out + 1] = nd.parent end
  for _, k in ipairs(nd.kids) do if not k.gone then out[#out + 1] = k end end
  for _, l in ipairs(nd.links) do if not l.gone then out[#out + 1] = l end end
  return out
end
Net.neighbours = neighbours

-- does a note sound here: a fork, a fusion, a tip, a root, a fruiting point
function Net.sings(nd)
  local k = 0
  for _, c in ipairs(nd.kids) do if not c.gone then k = k + 1 end end
  return k ~= 1 or #nd.links > 0 or nd.root or nd.fruit
end

-- ---------------------------------------------------------------- colonies

local function tip(self, nd, a, colony, life)
  local t = { x = nd.x, y = nd.y, a = a, node = nd, colony = colony, run = 0, stuck = 0,
    life = life or 16, maxlife = 16, young = 3 }
  self.tips[#self.tips + 1] = t
  return t
end

function Net:colony_at(x, y, kind)
  if self:blocked(x, y) then
    -- find soil near: a spore lands on the surface and goes down
    for dy = 0, 8 do
      if not self:blocked(x, y + dy) then y = y + dy break end
    end
    if self:blocked(x, y) then return nil end
  end
  local c = { id = #self.colonies + 1, x = x, y = y, energy = 6, count = 0,
    kind = kind or ((#self.colonies % 3) + 1), roots = 0, born = self.time }
  self.colonies[#self.colonies + 1] = c
  local nd = node(self, x, y, nil, c)
  nd.origin = true
  for k = 1, 3 do tip(self, nd, (k - 1) / 3 * TAU + self.rand() * 0.8, c, 22) end
  return c, nd
end

-- ---------------------------------------------------------------- food

function Net:feed(x, y, amount, lasting)
  local f = { x = x, y = y, amount = amount or 6, max = amount or 6, lasting = lasting, born = self.time }
  self.food[#self.food + 1] = f
  return f
end

local function nearest_food(self, x, y, r)
  local best, bd = nil, r * r
  for _, f in ipairs(self.food) do
    -- food the net already covers no longer draws it: it goes exploring
    if f.amount > 0.05 and (f.near or 0) < 7 then
      local dx, dy = f.x - x, f.y - y
      local d = dx * dx + dy * dy
      if d < bd then best, bd = f, d end
    end
  end
  return best, bd
end

local function nearest_root(self, x, y, r)
  local best, bd = nil, r * r
  for _, p in ipairs(self.scene.roots) do
    local dx, dy = p[1] - x, p[2] - y
    local d = dx * dx + dy * dy
    if d < bd then best, bd = p, d end
  end
  return best, bd
end

-- ---------------------------------------------------------------- signals

-- A wave from one node out through the net. `kind` says who started it.
function Net:wave(nd, strength, kind, env)
  if nd == nil or nd.gone then return end
  local id = self.next_wave
  self.next_wave = id + 1
  local w = { id = id, visited = { [nd] = true }, kind = kind, live = 0 }
  self.waves[id] = w
  nd.glow = math.max(nd.glow, strength)
  self.pending[#self.pending + 1] = { kind = "note", node = nd, strength = strength, wave = kind }
  self:spread(nd, nil, strength, w, env)
end

function Net:spread(nd, came, strength, w, env)
  local s = strength * env.decay
  if s < 0.1 then return end
  for _, nb in ipairs(neighbours(nd)) do
    if nb ~= came and not w.visited[nb] then
      local dx, dy = nb.x - nd.x, nb.y - nd.y
      local dist = math.sqrt(dx * dx + dy * dy)
      self.pulses[#self.pulses + 1] = { from = nd, to = nb, t = 0, dur = dist / env.pulse_speed, s = s, w = w }
      w.live = w.live + 1
    end
  end
end

-- ---------------------------------------------------------------- removal

function Net:remove(nd)
  if nd.gone then return end
  nd.gone = true
  nd.colony.count = nd.colony.count - 1
  local p = nd.parent
  local guard = 0
  local d = nd.desc + 1
  while p and guard < 400 do
    p.desc = math.max(0, p.desc - d)
    p = p.parent
    guard = guard + 1
  end
end

-- Cut: everything within r of (x, y) goes; what hung from it withers.
function Net:cut(x, y, r)
  local cut = {}
  self:near(x, y, r, function(nd) cut[#cut + 1] = nd end)
  for _, nd in ipairs(cut) do
    for _, k in ipairs(nd.kids) do
      if not k.gone then k.parent = nil k.withering = self.time + 0.4 end
    end
    self:remove(nd)
  end
  for i = #self.tips, 1, -1 do
    local t = self.tips[i]
    if t.node.gone or (math.abs(t.x - x) < r and math.abs(t.y - y) < r) then table.remove(self.tips, i) end
  end
  return #cut
end

-- the orphans of a cut wither from the cut outward
local function wither(self)
  for _, nd in ipairs(self.nodes) do
    if not nd.gone and nd.withering and self.time > nd.withering then
      for _, k in ipairs(nd.kids) do
        if not k.gone and not k.withering then k.withering = self.time + 0.25 + self.rand() * 0.3 end
      end
      nd.fade = 1
      self:remove(nd)
    end
  end
end

-- now and then an old, unused end dies back: the net renews itself
local function die_back(self, env, dt)
  local n = #self.nodes
  if n == 0 then return end
  local pressure = env.alive / env.max_nodes
  local tries = math.floor((env.die * env.season.die * 0.6 + pressure * pressure * 1.5) * dt * 10 + self.rand())
  for _ = 1, tries do
    local nd = self.nodes[math.floor(self.rand() * n) + 1]
    if nd and not nd.gone and not nd.origin and #nd.links == 0 and self.time - nd.born > 20 then
      local alive_kids = 0
      for _, k in ipairs(nd.kids) do if not k.gone then alive_kids = alive_kids + 1 end end
      if alive_kids == 0 and self.time - (nd.lit or 0) > 3 then
        nd.fade = 1
        self:remove(nd)
      end
    end
  end
end

local function compact(self)
  local keep = {}
  for _, nd in ipairs(self.nodes) do
    if not nd.gone or (nd.fade and nd.fade > 0) then keep[#keep + 1] = nd end
  end
  self.nodes = keep
  for k, b in pairs(self.hash) do
    local nb = {}
    for _, nd in ipairs(b) do if not nd.gone then nb[#nb + 1] = nd end end
    if #nb == 0 then self.hash[k] = nil else self.hash[k] = nb end
  end
  for _, nd in ipairs(self.nodes) do
    if not nd.gone then
      local kids = {}
      for _, k in ipairs(nd.kids) do if not k.gone then kids[#kids + 1] = k end end
      nd.kids = kids
      local links = {}
      for _, l in ipairs(nd.links) do if not l.gone then links[#links + 1] = l end end
      nd.links = links
    end
  end
  -- food the net has grown into is digested where it lies: the colony with
  -- most of itself there takes it in, a little a second for each node
  for _, f in ipairs(self.food) do
    local c, by = 0, {}
    self:near(f.x, f.y, 5, function(nd) c = c + 1 by[nd.colony] = (by[nd.colony] or 0) + 1 end)
    f.near = c
    local who, most = nil, 0
    for col, k in pairs(by) do if k > most then who, most = col, k end end
    if who and f.amount > 0.05 then
      local take = math.min(f.amount, 0.03 * math.min(most, 6) * 2)
      f.amount = f.amount - take
      who.energy = who.energy + take
    end
  end
  local cols = {}
  for _, c in ipairs(self.colonies) do
    if c.count > 0 then cols[#cols + 1] = c end
  end
  self.colonies = cols
end

-- ---------------------------------------------------------------- growth

local function grow_tip(self, t, env, events)
  local r = self.rand
  local step = env.speed * env.season.grow * (env.rain and 1.4 or 1) * (0.7 + r() * 0.6) * env.dt * 5
  -- turn toward food within smell, toward a root it has not reached yet
  local f = nearest_food(self, t.x, t.y, env.sense)
  local want = nil
  if f then
    want = math.atan(f.y - t.y, f.x - t.x)
  else
    local p = nearest_root(self, t.x, t.y, env.sense * 0.6)
    if p and (t.colony.roots < 4) then want = math.atan(p[2] - t.y, p[1] - t.x) end
  end
  if want then
    local d = (want - t.a + math.pi) % TAU - math.pi
    t.a = t.a + clamp(d, -0.35, 0.35) * 0.5
  else
    -- outward from where the colony began, gently, and away from the
    -- surface: the soil below is where there is room
    local oy = t.y - t.colony.y
    if t.y < self:ground(t.x) + 9 then oy = math.max(oy, 3) end
    local out = math.atan(oy, t.x - t.colony.x)
    local d = (out - t.a + math.pi) % TAU - math.pi
    t.a = t.a + d * 0.04
    -- just under the surface and not heading down: it bends away
    if t.y < self:ground(t.x) + 5 and math.sin(t.a) < 0.3 then
      local dd = (math.pi / 2 - t.a + math.pi) % TAU - math.pi
      t.a = t.a + dd * 0.15
    end
  end
  t.a = t.a + (r() - 0.5) * 0.5
  local nx, ny = t.x + math.cos(t.a) * step, t.y + math.sin(t.a) * step
  -- it runs out of the picture: we lose sight of it
  if nx < 0 or nx > 127.5 or ny > 63.5 then return false end
  if self:blocked(nx, ny) then
    t.a = t.a + ((r() < 0.5) and 1 or -1) * (0.6 + r() * 1.2)
    t.stuck = t.stuck + 1
    return t.stuck < 9
  end
  t.x, t.y, t.stuck = nx, ny, 0
  t.run = t.run + step
  if t.run < SEG then return true end
  t.run = 0
  -- the soil is full: only a colony that has less than its share grows on
  if env.alive >= env.max_nodes and (t.colony.count >= env.share or env.alive >= env.max_nodes * 1.15) then return false end
  -- its own last few nodes are not company
  local mine = {}
  local a, k = t.node, 0
  while a and k < 10 do mine[a] = true a, k = a.parent, k + 1 end
  -- crowded: too many of the others' nodes close by, and it stops
  local company = 0
  self:near(t.x, t.y, 3.5, function(nd) if not mine[nd] then company = company + 1 end end)
  if company >= env.crowd and t.young <= 0 then return false end

  -- meeting: its own colony fuses, another stops it. A fusion joins two
  -- branches that are far apart in the tree; a sister branch just beside it
  -- is not a meeting, and a young tip has not gone far enough to meet.
  local met, other = nil, nil
  if t.young > 0 then
    t.young = t.young - 1
  else
    self:near(t.x, t.y, 2.2, function(nd)
      if mine[nd] then return true end
      if nd.colony ~= t.colony then other = nd return false end
      local b, j = nd, 0
      while b and j < 10 do
        if mine[b] then return true end
        b, j = b.parent, j + 1
      end
      met = nd
      return false
    end)
  end
  local nd = node(self, t.x, t.y, t.node, t.colony)
  env.alive = env.alive + 1
  t.node = nd
  if met then
    nd.links[#nd.links + 1] = met
    met.links[#met.links + 1] = nd
    events[#events + 1] = { kind = "fuse", node = nd }
    return false
  end
  if other then
    events[#events + 1] = { kind = "meet", node = nd }
    return false
  end

  -- food under it: eat, and tell the net
  for _, fo in ipairs(self.food) do
    if fo.amount > 0.05 then
      local dx, dy = fo.x - t.x, fo.y - t.y
      local reach = 2.5 + fo.amount * 0.35
      if dx * dx + dy * dy < reach * reach then
        local bite = math.min(fo.amount, 0.6)
        fo.amount = fo.amount - bite
        t.colony.energy = t.colony.energy + bite
        t.life = t.maxlife
        t.lateral = false
        events[#events + 1] = { kind = "feed", node = nd, food = fo }
        break
      end
    end
  end
  -- a root: the oak and the fungus trade, sugar for water and salts
  if not nd.root then
    local p, d = nearest_root(self, t.x, t.y, 2.5)
    if p then
      nd.root = true
      t.life = t.maxlife
      local c = t.colony
      c.reached = c.reached or {}
      if not c.reached[p] then
        -- a root this colony had not reached yet
        c.reached[p] = true
        c.roots = c.roots + 1
        events[#events + 1] = { kind = "root", node = nd, first = (c.roots == 1) }
      end
    end
  end
  -- fork: a leader throws out short side branches at a sharp angle; a side
  -- branch seldom forks again. It is what makes the net feathery.
  local pb = env.branch * env.season.branch
  if t.lateral then pb = pb * 0.25 end
  if r() < pb then
    local side = (r() < 0.5) and 1 or -1
    local nt = tip(self, nd, t.a + side * (0.5 + r() * 0.45), t.colony, 3 + math.floor(r() * 5))
    nt.lateral = true
    nt.young = 2
  end
  t.life = t.life - 1
  return t.life > 0
end

-- ---------------------------------------------------------------- the step

-- env: dt, speed, branch, sense, crowd, max_nodes, decay, pulse_speed,
-- season (a number, 0 spring .. 4), rain, die, fruit, spores, wind,
-- heartbeat (waves a second), max_colonies, max_mushrooms
function Net:step(dt, env)
  self.time = self.time + dt
  local r = self.rand
  env.dt = dt
  env.season = season_at(env.season_value or 0)
  env.alive = env.alive or self:alive_count()
  env.share = env.max_nodes / (2 * math.max(1, #self.colonies))
  local events = self.pending
  self.pending = {}

  -- the tips
  local keep = {}
  for _, t in ipairs(self.tips) do
    if not t.node.gone and grow_tip(self, t, env, events) then keep[#keep + 1] = t end
  end
  self.tips = keep

  -- colonies that have eaten grow new tips from where they are; the soil
  -- itself, rotting slowly, gives every colony a little
  for _, c in ipairs(self.colonies) do
    c.energy = c.energy + (env.trickle or 0.04) * env.season.grow * dt
    local tips = 0
    for _, t in ipairs(self.tips) do if t.colony == c then tips = tips + 1 end end
    local want = math.min(8, 1 + math.floor(c.energy / 2))
    local room = env.alive < env.max_nodes or (c.count < env.share and env.alive < env.max_nodes * 1.15)
    if tips < want and c.energy > 0.6 and room and r() < dt * 1.5 * env.season.grow then
      -- from where the colony is thinnest, away from its own crowd
      local best, bc, bx, by = nil, 1e9, 0, 0
      for _ = 1, 8 do
        local nd = self.nodes[math.floor(r() * #self.nodes) + 1]
        if nd and not nd.gone and nd.colony == c then
          local cnt, sx, sy = 0, 0, 0
          self:near(nd.x, nd.y, 6, function(o) cnt, sx, sy = cnt + 1, sx + o.x, sy + o.y end)
          if cnt < bc then best, bc, bx, by = nd, cnt, sx / cnt, sy / cnt end
        end
      end
      if best then
        local dx, dy = best.x - bx, best.y - by
        local a
        if dx * dx + dy * dy > 0.25 then a = math.atan(dy, dx) else a = math.atan(best.y - c.y, best.x - c.x) end
        tip(self, best, a + (r() - 0.5) * 1.2, c, 14)
        c.energy = c.energy - 0.6
      end
    end
  end

  -- the oak's sugar, through every root a colony has reached
  for _, c in ipairs(self.colonies) do
    if c.roots > 0 then
      c.root_t = (c.root_t or (r() * 6)) + dt
      if c.root_t > 7 then
        c.root_t = 0
        local candidates = {}
        for _, nd in ipairs(self.nodes) do
          if nd.root and not nd.gone and nd.colony == c then candidates[#candidates + 1] = nd end
        end
        if #candidates > 0 then
          c.energy = c.energy + 0.3 * math.min(c.roots, 3)
          self:wave(candidates[math.floor(r() * #candidates) + 1], 0.75, "root", env)
        end
      end
    end
  end

  -- a heartbeat: now and then a wave from somewhere in the net
  if env.heartbeat > 0 and #self.nodes > 0 and r() < env.heartbeat * dt then
    local nd = self.nodes[math.floor(r() * #self.nodes) + 1]
    if nd and not nd.gone then self:wave(nd, 0.55, "beat", env) end
  end

  -- signals in flight
  local pk = {}
  for _, p in ipairs(self.pulses) do
    p.t = p.t + dt
    if p.to.gone or p.from.gone then
      p.w.live = p.w.live - 1
    elseif p.t >= p.dur then
      p.w.live = p.w.live - 1
      if not p.w.visited[p.to] then
        p.w.visited[p.to] = true
        local nd = p.to
        nd.glow = math.max(nd.glow, p.s)
        nd.lit = self.time
        if Net.sings(nd) then
          events[#events + 1] = { kind = "note", node = nd, strength = p.s, wave = p.w.kind }
        end
        self:spread(nd, p.from, p.s, p.w, env)
      end
    else
      pk[#pk + 1] = p
    end
  end
  self.pulses = pk
  for id, w in pairs(self.waves) do if w.live <= 0 then self.waves[id] = nil end end

  -- glows and fades
  for _, nd in ipairs(self.nodes) do
    if nd.glow > 0 then nd.glow = math.max(0, nd.glow - dt * 1.8) end
    if nd.fade then nd.fade = math.max(0, nd.fade - dt * 0.6) end
  end

  -- food: leaf litter falls in autumn; what is eaten goes
  if env.season.litter > 0 and r() < env.season.litter * dt * 0.25 then
    local x = 8 + r() * 112
    local y = self:ground(x) + 3 + r() * 9
    if not self:blocked(x, y) then self:feed(x, y, 2 + r() * 2) end
  end
  local fk = {}
  for _, f in ipairs(self.food) do
    -- what lasts (the log) refills slowly; the rest is eaten and gone
    if f.lasting then f.amount = math.min(f.max, f.amount + dt * 0.025) end
    if f.lasting or f.amount > 0.05 then fk[#fk + 1] = f end
  end
  self.food = fk

  -- rain seeps down through the soil
  if env.rain and r() < dt * 6 then
    local x = r() * 128
    self.seeps[#self.seeps + 1] = { x = x, y = self:ground(x) + 1, v = 3 + r() * 5, life = 1 }
  end
  local sk = {}
  for _, s in ipairs(self.seeps) do
    s.y = s.y + s.v * dt
    s.life = s.life - dt * 0.35
    if s.life > 0 and s.y < 63 and not self:blocked(s.x, s.y) then sk[#sk + 1] = s end
  end
  self.seeps = sk

  -- mushrooms: a colony with enough in it fruits, in its season
  self:fruiting(dt, env, events)

  -- spores in the air, and where they land
  local spk = {}
  for _, s in ipairs(self.spores) do
    s.vx = s.vx * 0.98 + env.wind * 0.6 * dt + (r() - 0.5) * 0.6 * dt
    s.vy = s.vy * 0.98 + (0.35 + (r() - 0.6) * 0.8) * dt
    s.x, s.y = s.x + s.vx, s.y + s.vy * 3
    s.life = s.life - dt / 9
    local g = self:ground(s.x)
    if s.y >= g and s.x > 2 and s.x < 125 then
      if r() < env.spores and #self.colonies < env.max_colonies then
        local c, nd = self:colony_at(s.x, g + 4 + r() * 6, s.kind)
        if c then events[#events + 1] = { kind = "colony", node = nd } end
      end
    elseif s.life > 0 and s.x > -2 and s.x < 130 and s.y > -4 then
      spk[#spk + 1] = s
    end
  end
  self.spores = spk

  wither(self)
  die_back(self, env, dt)
  self.compact_t = (self.compact_t or 0) + dt
  if self.compact_t > 2 then
    self.compact_t = 0
    compact(self)
  end
  return events
end

function Net:fruiting(dt, env, events)
  local r = self.rand
  for _, c in ipairs(self.colonies) do
    c.fruit_t = (c.fruit_t or (r() * 3)) + dt
    if c.fruit_t > 2.5 then
      c.fruit_t = 0
      local cost = 6 / math.max(0.2, env.fruit)
      if env.season.fruit > 0.05 and c.energy > cost and #self.mushrooms < env.max_mushrooms
        and r() < env.season.fruit * 0.6 then
        -- the node of this colony nearest the surface, not under the log or the trunk
        local best, bd = nil, 1e9
        for _, nd in ipairs(self.nodes) do
          if not nd.gone and nd.colony == c then
            local lx = self.scene.log
            local tx = self.scene.trunk
            local free = nd.x >= 6 and nd.x <= 121
              and not (nd.x >= lx[1] - 2 and nd.x <= lx[2] + 2) and not (nd.x >= tx[1] - 6 and nd.x <= tx[2] + 6)
            for _, m in ipairs(self.mushrooms) do
              if math.abs(m.x - nd.x) < 8 then free = false end
            end
            if free then
              local d = nd.y - self:ground(nd.x)
              if d < bd then best, bd = nd, d end
            end
          end
        end
        if best and bd < 9 then
          c.energy = c.energy - cost
          best.fruit = true
          local m = { x = math.floor(best.x), node = best, colony = c, kind = c.kind, stage = 0, life = 0, puff = 0 }
          self.mushrooms[#self.mushrooms + 1] = m
          events[#events + 1] = { kind = "pin", mushroom = m, node = best }
        end
      end
    end
  end
  local keep = {}
  for _, m in ipairs(self.mushrooms) do
    if m.stage < 3 then
      m.stage = m.stage + dt / 5
      if m.stage >= 3 then
        m.stage = 3
        events[#events + 1] = { kind = "open", mushroom = m }
        self:wave(m.node, 0.9, "fruit", env)
      end
      keep[#keep + 1] = m
    elseif m.life < 45 then
      m.life = m.life + dt
      m.puff = m.puff + dt
      if m.puff > 1.6 then
        m.puff = 0
        for _ = 1, 2 do
          local g = self:ground(m.x)
          self.spores[#self.spores + 1] = { x = m.x + (r() - 0.5) * 4, y = g - 8 - r() * 2,
            vx = (r() - 0.5) * 0.4, vy = -0.3 - r() * 0.3, life = 1, kind = m.kind }
        end
      end
      if m.life >= 45 then m.stage = 4 end
      keep[#keep + 1] = m
    elseif m.life < 55 then
      m.life = m.life + dt
      keep[#keep + 1] = m
    else
      if m.node then m.node.fruit = nil end
    end
  end
  self.mushrooms = keep
end

-- A touch: the node nearest (x, y) within r rings, and the net carries it.
function Net:pluck(x, y, r, strength, env)
  local best, bd = nil, r * r + 1
  self:near(x, y, r, function(nd, d2)
    if d2 < bd then best, bd = nd, d2 end
  end)
  if best then self:wave(best, strength, "pluck", env) end
  return best
end

-- Pick a mushroom near x (for a harvest): it goes, in a burst of spores.
function Net:harvest(x, within)
  for i, m in ipairs(self.mushrooms) do
    if math.abs(m.x - x) <= within and m.stage >= 2 then
      local g = self:ground(m.x)
      for _ = 1, 10 do
        self.spores[#self.spores + 1] = { x = m.x + (self.rand() - 0.5) * 6, y = g - 7 - self.rand() * 3,
          vx = (self.rand() - 0.5) * 1.2, vy = -0.6 - self.rand() * 0.6, life = 1, kind = m.kind }
      end
      if m.node then m.node.fruit = nil end
      table.remove(self.mushrooms, i)
      return m
    end
  end
  return nil
end


return Net
