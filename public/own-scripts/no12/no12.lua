-- no12
-- a pocket operator rhythm
-- for norns, after ulnd/po-12
--
-- E1 the finger   K2 press it
-- K3 play / stop
-- E2 / E3 knobs A / B
-- K1 is write, held down
--
-- while K2 holds a button, E1
-- moves a second finger and K3
-- presses it: the PO's chords.
-- (holding FX, E1 picks the
--  effect itself)
--
-- grid (optional): the keypad

engine.name = "No12"

local shapes = include("lib/lcd_shapes")

local DATA = _path.data .. "no12/"
local S = 128 / 314 -- the browser LCD's pixels, to the norns screen's

-- ---------------------------------------------------------------- what the browser version says

local MODES = { { "HIP-HOP", 80 }, { "DISCO", 120 }, { "TECHNO", 140 } }

-- which sounds move which part of the drummer
local BELL = { [4] = true, [7] = true, [8] = true, [13] = true, [14] = true }
local DRUM = { [2] = true, [5] = true, [11] = true, [12] = true }
local CLAP = { [6] = true, [9] = true, [10] = true }
local HAT = { [3] = true }
local KICK = { [1] = true }

-- the glyph each pattern number is drawn with
local GLYPHS = {
  { "topLeft", "topRight", "bottomLeft", "bottomRight" },
  { "topLeft", "bottomRight" },
  { "topLeft", "mid", "topVert" },
  { "mid", "bottomLeft", "bottomRight", "bottom" },
  { "topLeft", "topRight" },
  { "topLeft", "mid", "bottomLeft" },
  { "topRight", "mid", "bottomRight" },
  { "mid", "bottom" },
  { "bottomLeft", "bottomRight" },
  { "mid" },
  { "bottomLeft", "bottomRight", "bottom" },
  { "mid", "bottom", "topVert", "bottomVert" },
  { "topLeft", "topRight", "mid", "bottomLeft", "bottomRight" },
  { "mid", "topVert", "bottomVert" },
  { "topLeft", "topRight", "bottom" },
  { "mid", "bottomLeft" },
}
local SEGS = { "topLeft", "topRight", "mid", "bottomLeft", "bottomRight", "bottom", "topVert", "bottomVert" }

-- seven segments: top, top left, bottom left, middle, top right, bottom right, bottom
local DIGITS = {
  [0] = { 1, 1, 1, 0, 1, 1, 1 }, { 0, 0, 0, 0, 1, 1, 0 }, { 1, 0, 1, 1, 1, 0, 1 }, { 1, 0, 0, 1, 1, 1, 1 },
  { 0, 1, 0, 1, 1, 1, 0 }, { 1, 1, 0, 1, 0, 1, 1 }, { 1, 1, 1, 1, 0, 1, 1 }, { 1, 0, 0, 0, 1, 1, 0 },
  { 1, 1, 1, 1, 1, 1, 1 }, { 1, 1, 0, 1, 1, 1, 0 },
  ["-"] = { 0, 0, 0, 1, 0, 0, 0 },
  blank = { 0, 0, 0, 0, 0, 0, 0 },
  y = { 0, 1, 0, 1, 1, 1, 1 },
}

local SPOOLS = { 1, 2, 3, 2, 1, 0 }

-- ---------------------------------------------------------------- state

local patterns = {}
-- per pattern and step: the effect recorded there, and per sound the knobs locked there
local fx_steps, locks = {}, {}
local selected_pattern, selected_sound, bpm = 1, 1, 80
local queued, prequeued = nil, nil
local queue_clear_at, spool_started = nil, nil
local mode = "default" -- "sound" | "pattern"
local recording, playing = false, false
-- every sound has its own two knobs, in the middle to begin with: as recorded
local knob_a, knob_b = {}, {}
for n = 1, 16 do knob_a[n], knob_b[n] = 4, 4 end
local beat_pos, step_start = 0, 0
local sounds_playing = {}
local seq_clock = nil
local keyed = {}
local finger = 1
local bpm_shown_until = 0
local upload, upload_until = nil, 0
local anim = {}
local anim_clocks = {}
local was_queued = false
local held = { false, false, false }
local redraw_metro = nil
local C = { bg = 12, off = 9, on = 0, bezel = 0 }
local g = grid.connect()

-- the effects: the one punched in now, and the FX button being held
local fx_punch = nil
local fx_held, fx_held_since, fx_chose = false, 0, false
local fx_engine = 0

-- the rest of the PO-12
local retrig = {} -- per pattern and step: the step multiplier, 2, 4, 8 or 16
local chain, chain_pos = nil, 1
local swing = 0 -- the off-beat sixteenths, late by this much of a step: 0 to 0.5
local sync_mode = 0 -- SY0 .. SY5
local alarm = { hour = -1, min = 0, pattern = 1 } -- hour -1: off
local alarm_setting, alarm_fired = false, nil
local finger2 = 1
local k2_target, k3_target = nil, nil
local consumed = {}
local pad_count = {}
local pattern_presses = nil
local bpm_used, write_used = false, false
local display, display_until = nil, 0
local idle_since = 0
local sleeping = false
local skip_once = {}
local slave = { last = nil, interval = 0.375, pos = 0 }

local FINGERS = 22 -- 16 buttons, then sound, pattern, bpm, fx, write, special
local FUNCTION_NAMES = { "sound", "pattern", "bpm", "fx", "write", "special" }

local function reset_anim()
  anim = {
    hittingKick = false, hittingHighHat = false, hittingDrum = false, finishedHittingDrum = false,
    hittingClap = false, finishedHittingClap = false, hittingBell1 = false, hittingBell2 = false,
  }
end

local function empty_pattern()
  local p = {}
  for i = 1, 16 do p[i] = {} end
  return p
end

local function empty_locks()
  local l = {}
  for i = 1, 16 do l[i] = {} end
  return l
end

-- the browser version's demo, pattern 1
local function default_patterns()
  for k = 1, 16 do
    patterns[k], fx_steps[k], locks[k], retrig[k] = empty_pattern(), {}, empty_locks(), {}
  end
  local demo = { { 1 }, { 2 }, {}, { 3 }, {}, { 1 }, {}, { 1 }, { 1 }, {}, { 3 }, {}, { 1 }, { 1 }, {}, { 3 } }
  for i, notes in ipairs(demo) do
    for _, n in ipairs(notes) do patterns[1][i][n] = true end
  end
end

local function non_empty(p)
  for i = 1, 16 do
    if next(patterns[p][i]) then return true end
  end
  return false
end

-- ---------------------------------------------------------------- time

local function step_dur()
  if sync_mode >= 2 then return slave.interval / 2 end
  return 60 / bpm / 4
end

-- whole steps since play, and how far into the next: the original's currentBeat
local function current_beat()
  if not playing then return 0 end
  return beat_pos + util.clamp((util.time() - step_start) / step_dur(), 0, 0.999)
end

-- ---------------------------------------------------------------- the drummer

local function track(name, fn)
  if anim_clocks[name] then clock.cancel(anim_clocks[name]) end
  anim_clocks[name] = clock.run(fn)
end

local function cancel_tracks()
  for name, id in pairs(anim_clocks) do
    clock.cancel(id)
    anim_clocks[name] = nil
  end
end

local function interpret(list)
  if #list == 0 or queued then return end
  local interval = 60 / 16 / bpm
  local function any(set)
    for _, n in ipairs(list) do
      if set[n] then return true end
    end
    return false
  end
  if any(BELL) then
    track("bell", function()
      anim.hittingBell1, anim.hittingBell2 = true, false
      for _ = 1, 3 do
        clock.sleep(interval / 2)
        anim.hittingBell1, anim.hittingBell2 = not anim.hittingBell1, not anim.hittingBell2
      end
      clock.sleep(interval / 2)
      anim.hittingBell1, anim.hittingBell2 = false, false
    end)
  end
  if any(DRUM) then
    track("drum", function()
      anim.hittingDrum, anim.finishedHittingDrum, anim.finishedHittingClap = true, false, false
      clock.sleep(interval)
      anim.hittingDrum, anim.finishedHittingDrum = false, true
    end)
  end
  if any(CLAP) then
    track("clap", function()
      anim.hittingClap, anim.finishedHittingClap, anim.finishedHittingDrum = true, false, false
      clock.sleep(interval)
      anim.hittingClap, anim.finishedHittingClap = false, true
    end)
  end
  if any(HAT) then
    track("hat", function()
      anim.hittingHighHat, anim.finishedHittingDrum, anim.finishedHittingClap = true, false, false
      clock.sleep(interval)
      anim.hittingHighHat, anim.finishedHittingDrum = false, true
    end)
  end
  if any(KICK) then
    track("kick", function()
      anim.hittingKick = true
      clock.sleep(interval)
      anim.hittingKick = false
    end)
  end
end

-- ---------------------------------------------------------------- sound and sequence

-- The PO-12's sixteen effects, numbered as its guide numbers them:
--  1 low sample rate   2 distortion      3 bit crush        4 delay
--  5 lowpass filter    6 lowpass sweep   7 hipass filter    8 hipass sweep
--  9 stutter 4        10 stutter 3      11 repeat 8        12 repeat 6
-- 13 note shuffle     14 feedback       15 parameter lfo   16 vibrato
-- The ones that change the sound are the engine's; the ones that change
-- which notes play, and when, are here.
local ENGINE_FX = { [1] = true, [2] = true, [3] = true, [4] = true, [5] = true, [6] = true,
  [7] = true, [8] = true, [14] = true, [16] = true }
-- blip, tone and bass tone play notes: their knob A moves in semitones
local MELODIC = { [14] = true, [15] = true, [16] = true }
local MULTIPLIERS = { 2, 4, 8, 16 }

-- the LCD's tick or cross, for a second
local function flash(state)
  upload, upload_until = state, util.time() + 1
end

local function set_engine_fx(n)
  local e = (n and ENGINE_FX[n]) and n or 0
  if e ~= fx_engine then
    fx_engine = e
    engine.fx(e)
  end
end

-- the effect in force: one punched in now, else one recorded on this step
local function active_fx(idx)
  if fx_punch then return fx_punch end
  return fx_steps[selected_pattern][idx + 1]
end

-- knob A: speed, so pitch, an octave either way of as recorded.
-- knob B: below the middle, how much of the sound is heard; above, an edge.
local function voice_params(n, a, b)
  local rate
  if MELODIC[n] then
    rate = 2 ^ (math.floor((a - 4) * 3 + 0.5) / 12)
  else
    rate = 2 ^ ((a - 4) / 4)
  end
  local decay, color = 1, 0
  if b < 4 then decay = math.max(0.04, (b / 4) ^ 1.5) else color = (b - 4) / 4 end
  return rate, decay, color
end

-- a sound's knobs on a step: what was locked there, else its knobs now
local function knobs_at(n, idx)
  local l = idx and locks[selected_pattern][idx + 1][n]
  return (l and l.a) or knob_a[n], (l and l.b) or knob_b[n]
end

local function hit(n, idx, fx)
  local a, b = knobs_at(n, idx)
  if fx == 15 then
    -- parameter lfo: both knobs swung by a slow wave, a bar long
    local ph = current_beat() / 16 * 2 * math.pi
    a = util.clamp(a + math.sin(ph) * 3, 0, 8)
    b = util.clamp(b + math.cos(ph) * 3, 0, 8)
  end
  local rate, decay, color = voice_params(n, a, b)
  engine.hit(n, params:get("volume"), rate, decay, color)
end

-- digits shown for a moment, right-aligned, blanks before
local function show_number(v, secs)
  local d = { "blank", "blank", "blank" }
  local text = tostring(math.floor(v + 0.5))
  local len = math.min(3, #text)
  for i = 1, len do d[3 - len + i] = tonumber(text:sub(#text - len + i, #text - len + i)) end
  display, display_until = { d[1], d[2], d[3], partial = false }, util.time() + (secs or 2)
end

local function show_digits(a, b, c, secs)
  display, display_until = { a, b, c, partial = false }, util.time() + (secs or 2)
end

-- the alarm, as the clock shows a time: twelve hours, AM or PM
local function alarm_digits()
  if alarm.hour < 0 then return { "-", "-", "-" }, false, nil end
  local h = alarm.hour % 12
  if h == 0 then h = 12 end
  return { h % 10, math.floor(alarm.min / 10), alarm.min % 10 }, h >= 10, alarm.hour >= 12 and "PM" or "AM"
end

-- Which step plays now, and how many times. The sequence keeps its place
-- underneath, so letting go of an effect lands back on the beat.
local seq_fx, seq_k, seq_anchor = nil, 0, 0

local function step_to_play(idx, fx)
  if fx ~= seq_fx then
    seq_fx, seq_k = fx, 0
    -- repeat 8 and repeat 6 go back over the steps just heard
    if fx == 11 then seq_anchor = idx - 8 elseif fx == 12 then seq_anchor = idx - 6 else seq_anchor = idx end
  end
  local k = seq_k
  seq_k = seq_k + 1
  if fx == 9 then return idx, 4 end
  if fx == 10 then return idx, 3 end
  if fx == 11 then return (seq_anchor + k % 8) % 16, nil end
  if fx == 12 then return (seq_anchor + k % 6) % 16, nil end
  if fx == 13 then return math.random(0, 15), nil end
  return idx, nil
end

local function play_step(idx)
  local fx = active_fx(idx)
  -- in write mode, an effect held over steps is recorded on them
  if recording and fx_punch then fx_steps[selected_pattern][idx + 1] = fx_punch end
  set_engine_fx(fx)
  local at, times = step_to_play(idx, fx)
  -- the step multiplier, unless a stutter says otherwise
  times = times or retrig[selected_pattern][at + 1] or 1
  local list = {}
  local skip = skip_once[at + 1]
  for n = 1, 16 do
    if patterns[selected_pattern][at + 1][n] and not (skip and skip[n]) then list[#list + 1] = n end
  end
  skip_once[at + 1] = nil
  sounds_playing = list
  if #list > 0 then
    if times == 1 then
      for _, n in ipairs(list) do hit(n, at, fx) end
    else
      clock.run(function()
        local d = step_dur() / times
        for r = 1, times do
          for _, n in ipairs(list) do hit(n, at, fx) end
          if r < times then clock.sleep(d) end
        end
      end)
    end
  end
  interpret(list)
  -- a chain moves on at the end of each bar, as a chosen pattern does
  if chain and idx == 12 and not prequeued and not queued then
    chain_pos = chain_pos % #chain + 1
    prequeued = chain[chain_pos]
  end
  -- a pattern chosen while playing waits for beat 12, then takes over at 15
  if prequeued and idx == 12 then
    queued, prequeued = prequeued, nil
  elseif queued and idx == 15 then
    selected_pattern, queued = queued, nil
  end
end

-- sync out (SY1, SY3, SY5): a click on the left channel, two to a beat
local function sync_out() return sync_mode == 1 or sync_mode == 3 or sync_mode == 5 end

local function start()
  if playing then return end
  playing = true
  beat_pos = 0
  step_start = util.time()
  seq_fx = nil
  if sync_mode >= 2 then
    -- sync in: the clicks on the input move the steps, two a click
    slave.pos = 0
    return
  end
  seq_clock = clock.run(function()
    local grid_t = util.time()
    local k = 0
    while playing do
      local idx = k % 16
      if sync_out() and idx % 2 == 0 then engine.pulse() end
      -- swing: the off-beat sixteenths come late
      local late = (idx % 2 == 1) and swing * step_dur() or 0
      if late > 0 then clock.sleep(late) end
      beat_pos, step_start = k, grid_t
      play_step(idx)
      grid_t = grid_t + step_dur()
      clock.sleep(math.max(0, grid_t - util.time()))
      k = k + 1
    end
  end)
end

local function pause()
  playing = false
  if seq_clock then clock.cancel(seq_clock) end
  seq_clock = nil
  beat_pos = 0
  sounds_playing = {}
  set_engine_fx(fx_punch)
end

local function toggle_playing()
  if playing then pause() else start() end
end

-- a click arrived on the input
local function on_pulse()
  local now = util.time()
  if slave.last then slave.interval = util.clamp(now - slave.last, 0.06, 2) end
  slave.last = now
  if sync_mode < 2 then return end
  if sync_out() then engine.pulse() end
  if not playing then return end
  local first = slave.pos
  beat_pos, step_start = first, now
  play_step(first % 16)
  clock.run(function()
    clock.sleep(slave.interval / 2)
    if playing and sync_mode >= 2 then
      beat_pos, step_start = first + 1, util.time()
      play_step((first + 1) % 16)
    end
  end)
  slave.pos = first + 2
end

local function queue_pattern(n, from_chain)
  if not from_chain then chain = nil end
  if playing then
    prequeued = n
  else
    -- stopped: it changes at once, and the drummer shows it for a beat
    queued, selected_pattern = n, n
    queue_clear_at = util.time() + 60 / bpm
    spool_started = util.time()
  end
end

local function next_bpm()
  local nxt = MODES[1][2]
  for i, m in ipairs(MODES) do
    if m[2] == bpm then nxt = MODES[i % #MODES + 1][2] end
  end
  bpm = nxt
  bpm_shown_until = util.time() + 2
  engine.bpm(bpm)
end

local function toggle_note(p, step, sound)
  local notes = patterns[p][step]
  if notes[sound] then
    notes[sound] = nil
    locks[p][step][sound] = nil
  else
    notes[sound] = true
  end
end

local function copy_locks(src)
  local out = empty_locks()
  for i = 1, 16 do
    for n, v in pairs(src[i]) do out[i][n] = { a = v.a, b = v.b } end
  end
  return out
end

-- write + pattern + a key: the active pattern pasted into that slot
local function copy_pattern(to)
  local from = selected_pattern
  patterns[to], fx_steps[to], retrig[to] = empty_pattern(), {}, {}
  for i = 1, 16 do
    for n in pairs(patterns[from][i]) do patterns[to][i][n] = true end
    fx_steps[to][i] = fx_steps[from][i]
    retrig[to][i] = retrig[from][i]
  end
  locks[to] = copy_locks(locks[from])
  flash("success")
end

-- special + pattern: the active pattern emptied
local function clear_pattern(p)
  patterns[p], fx_steps[p], locks[p], retrig[p] = empty_pattern(), {}, empty_locks(), {}
  flash("success")
end

-- write held while playing: the sound of that key, on the nearest step
local function live_record(n)
  local b = current_beat()
  local step = math.floor(b) % 16
  if b - math.floor(b) > 0.5 then
    -- nearer the next step: it goes there, and is not played twice
    step = (step + 1) % 16
    skip_once[step + 1] = skip_once[step + 1] or {}
    skip_once[step + 1][n] = true
  end
  patterns[selected_pattern][step + 1][n] = true
  interpret({ n })
  hit(n, nil, fx_punch)
end

local function is_held(name)
  if name == "write" then return held[1] or keyed["write"] ~= nil end
  return keyed[name] ~= nil
end

local function held_number()
  for n = 1, 16 do
    if keyed[n] then return n end
  end
end

local function cycle_multiplier(step)
  local cur = retrig[selected_pattern][step]
  local nxt = nil
  if not cur then
    nxt = MULTIPLIERS[1]
  else
    for i, m in ipairs(MULTIPLIERS) do
      if m == cur then nxt = MULTIPLIERS[i + 1] end
    end
  end
  retrig[selected_pattern][step] = nxt
  if nxt then show_number(nxt) else show_digits("-", "-", "-") end
end

local function show_battery()
  local pct = norns.battery_percent or 0
  if pct > 0 then show_number(pct) else show_digits("-", "-", "-") end
end

-- A key pressed, read as the PO-12 reads its chords.
local function press_number(n)
  if fx_held then
    fx_punch, fx_chose = n, true
    set_engine_fx(n)
  elseif is_held("bpm") then
    -- bpm + a key: the master volume, 1 to 16
    params:set("volume", n / 10)
    show_number(n)
    bpm_used = true
  elseif is_held("pattern") then
    if is_held("write") then
      copy_pattern(n)
      write_used = true
    else
      -- pattern + keys: one chooses it, more make a chain
      pattern_presses = pattern_presses or {}
      pattern_presses[#pattern_presses + 1] = n
    end
  elseif is_held("sound") then
    selected_sound = n
    mode = "default"
  elseif alarm_setting then
    alarm.pattern = n
    alarm_setting = false
  elseif is_held("write") then
    write_used = true
    if playing then live_record(n) else toggle_note(selected_pattern, n, selected_sound) end
  elseif mode == "sound" then
    selected_sound = n
    mode = "default"
  elseif mode == "pattern" then
    queue_pattern(n)
    mode = "default"
  elseif recording then
    toggle_note(selected_pattern, n, selected_sound)
  else
    interpret({ n })
    hit(n, nil, fx_punch)
  end
end

local function press_function(name)
  if name == "sound" then
    if is_held("pattern") then
      alarm_setting = true
    elseif is_held("bpm") then
      show_battery()
      bpm_used = true
    else
      mode = "sound"
    end
  elseif name == "pattern" then
    if is_held("special") then
      clear_pattern(selected_pattern)
    elseif is_held("sound") then
      alarm_setting = true
    elseif is_held("write") then
      write_used = true
      pattern_presses = {}
    else
      mode = "pattern"
      pattern_presses = {}
    end
  elseif name == "bpm" then
    bpm_used = false
    local step = held_number()
    if is_held("special") then
      params:set("sync", (sync_mode + 1) % 6 + 1)
      bpm_used = true
    elseif is_held("sound") then
      show_battery()
      bpm_used = true
    elseif step then
      cycle_multiplier(step)
      bpm_used = true
    end
  elseif name == "write" then
    write_used = false
  elseif name == "fx" then
    fx_held, fx_held_since, fx_chose = true, util.time(), false
  elseif name == "play" then
    toggle_playing()
  end
end

local function release_function(name)
  if name == "bpm" then
    if not bpm_used then next_bpm() end
    bpm_used = false
  elseif name == "pattern" then
    local presses = pattern_presses
    pattern_presses = nil
    if presses and #presses >= 2 then
      chain, chain_pos = presses, 1
      queue_pattern(presses[1], true)
      mode = "default"
    elseif presses and #presses == 1 then
      queue_pattern(presses[1])
      mode = "default"
    end
  elseif name == "write" then
    if not write_used then recording = not recording end
    write_used = false
  elseif name == "fx" then
    fx_held, fx_punch = false, nil
    local idx = playing and (math.floor(beat_pos) % 16) or nil
    set_engine_fx(idx and fx_steps[selected_pattern][idx + 1] or nil)
  end
end

-- The knobs: the alarm while it is being set; swing and tempo while bpm is
-- held; otherwise the selected sound's, written onto the steps if write is.
local function turn_knob(which, d)
  if alarm_setting then
    if which == "a" then
      alarm.hour = util.clamp(alarm.hour + d, -1, 23)
    else
      alarm.min = (alarm.min + d) % 60
      if alarm.hour < 0 then alarm.hour = 7 end
    end
    return
  end
  if is_held("bpm") then
    if which == "a" then
      swing = util.clamp(swing + d * 0.0125, 0, 0.5)
      show_number(50 + swing * 50)
    else
      bpm = util.clamp(bpm + d, 60, 240)
      bpm_shown_until = util.time() + 2
      engine.bpm(bpm)
    end
    bpm_used = true
    return
  end
  local n = selected_sound
  local t = which == "a" and knob_a or knob_b
  t[n] = util.clamp(t[n] + d * 0.25, 0, 8)
  if is_held("write") then
    write_used = true
    if playing then
      local idx = math.floor(current_beat()) % 16
      local l = locks[selected_pattern][idx + 1][n] or {}
      l[which] = t[n]
      locks[selected_pattern][idx + 1][n] = l
    end
  end
end

-- ---------------------------------------------------------------- the LCD

local cache = {}

local function anim_rule(r)
  local c = cache[r]
  if not c then
    local _, show, hide = r:match("^(anim)|([^|]*)|(.*)$")
    c = { show = {}, hide = {} }
    for k in show:gmatch("%S+") do c.show[#c.show + 1] = k end
    for k in hide:gmatch("%S+") do c.hide[#c.hide + 1] = k end
    cache[r] = c
  end
  if queued then return false end
  local show = true
  if #c.show > 0 then
    show = false
    for _, k in ipairs(c.show) do
      if anim[k] then show = true end
    end
  end
  if #c.hide > 0 then
    local hide = false
    for _, k in ipairs(c.hide) do
      if anim[k] then hide = true end
    end
    if #c.show > 0 then show = show and not hide else show = not hide end
  end
  return show
end

local function spool_index(b)
  if not queued then return 0 end
  if playing then
    local ph = b % 4
    if ph < 0.8 then return 1 elseif ph < 1.6 then return 2 elseif ph < 2.4 then return 3 elseif ph < 3.2 then return 2 end
    return 1
  end
  local k = math.floor((util.time() - (spool_started or util.time())) / (60 / bpm / 6))
  if k < 1 then return 0 end
  return SPOOLS[math.min(k, #SPOOLS)]
end

local function time_digits()
  local t = os.date("*t")
  local h, ampm = t.hour, "AM"
  -- the browser version's own rule: past twelve is PM, and noon is AM
  if h > 12 then h, ampm = h - 12, "PM" end
  if h == 0 then h = 12 end
  return { math.floor(h / 10), h % 10, math.floor(t.min / 10), t.min % 10 }, ampm
end

-- what every named part of the LCD is doing this frame
local function frame_state()
  local f = { on = true, off = false }
  local b = current_beat()
  f.switching, f.not_switching = queued ~= nil, queued == nil
  local ka, kb = knobs_at(selected_sound, playing and math.floor(b) % 16 or nil)
  for n = 0, 7 do
    f["tumblerA>" .. n] = ka > n
    f["tumblerB>" .. n] = kb > n
  end
  local bi = math.floor(b % 16)
  for inst = 1, 4 do
    local threshold = 16 - inst
    local hidden = bi == threshold
    local p = (bi > threshold and queued) and queued or selected_pattern
    local set = {}
    for _, s in ipairs(GLYPHS[p]) do set[s] = true end
    for _, s in ipairs(SEGS) do f["p" .. inst .. ":" .. s] = (not hidden) and set[s] == true end
  end
  -- the time, the BPM after it changes, or the sound while playing; and
  -- before them, whatever a chord asked to see: the alarm being set, a
  -- volume, a swing, a multiplier, a sync mode, the battery
  local digits, ampm = time_digits()
  local now = util.time()
  local show_bpm = now < bpm_shown_until and not sleeping
  local show_sound = playing and selected_sound and not sleeping
  local values, partial
  if alarm_setting then
    values, partial, ampm = alarm_digits()
  elseif display and now < display_until then
    values, partial = { display[1], display[2], display[3] }, display.partial
  elseif show_bpm then
    values = { math.floor(bpm / 100), math.floor((bpm % 100) / 10), bpm % 10 }
    if values[1] == 0 then values[1] = "blank" end
    partial = false
  elseif show_sound then
    values = { "-", math.floor(selected_sound / 10), selected_sound % 10 }
  else
    values = { digits[2], digits[3], digits[4] }
  end
  for k = 1, 3 do
    local map = DIGITS[values[k]]
    for s = 0, 6 do f["d" .. k .. ":seg" .. s] = map[s + 1] == 1 end
  end
  if partial ~= nil then
    f.partial = partial and true or false
  else
    f.partial = (not show_bpm) and (show_sound or digits[1] == 1) and true or false
  end
  f.ampm = ampm
  -- the browser computes this from an eighth of a step and samples it at
  -- sixty frames a second, which makes the wheel flicker: here it flickers
  -- at fifteen, without asking for a redraw every frame
  f.wheel_even = (not playing) or math.floor(util.time() * 15) % 2 == 0
  f.wheel_odd = not f.wheel_even
  f.stamp_up = (b % 2) < 1
  f.stamp_down = not f.stamp_up
  local inactive = playing and math.floor(b % 8) or -1
  for n = 0, 7 do f["feeder" .. n] = inactive ~= n end
  local op, ai = b % 7, 0
  if op < 2 then ai = 0
  elseif op < 3 or op >= 6 then ai = 1
  elseif op < 4 or op >= 5 then ai = 2
  else ai = 3 end
  for n = 0, 3 do f["indicator" .. n] = ai == n end
  local sp = spool_index(b)
  for n = 0, 3 do f["spool" .. n] = sp == n end
  f.icon_playing, f.icon_recording = playing, recording
  f.icon_fail, f.icon_success = upload == "fail", upload == "success"
  f.beat = bi
  f.mirror = (b % 2) < 1
  return f
end

local function lit(f, r)
  if sleeping and not (r:match("^d%d:seg") or r == "partial") then return false end
  local v = f[r]
  if v ~= nil then return v end
  if r:sub(1, 5) == "anim|" then return anim_rule(r) end
  return false
end

local function trace(p, mirror)
  if mirror then
    screen.move(mirror - p[1], p[2])
    for i = 3, #p, 2 do screen.line(mirror - p[i], p[i + 1]) end
  else
    screen.move(p[1], p[2])
    for i = 3, #p, 2 do screen.line(p[i], p[i + 1]) end
  end
end

-- Shapes drawn at two fifths of their size would lose their thinnest parts
-- to antialiasing (a 1.5 px bar becomes 0.6 px of grey): svg2lua grows every
-- filled shape by 0.3 px, once, so each is one fill here.
local function draw_part(part, f, mirror)
  for _, s in ipairs(part) do
    local on = lit(f, s.r)
    if s.k == "f" then
      screen.level(s.bg and C.bg or (on and C.on or C.off))
      local n = (s.eo and #s.p > 1) and 1 or #s.p
      for i = 1, n do
        trace(s.p[i], mirror)
        screen.close()
      end
      screen.fill()
      if n < #s.p then
        -- even-odd: the rest are holes, which show the LCD behind
        screen.level(C.bg)
        for i = 2, #s.p do
          trace(s.p[i], mirror)
          screen.close()
        end
        screen.fill()
      end
    else
      screen.level(on and C.on or C.off)
      screen.line_width(math.max(0.7, s.w))
      for i, p in ipairs(s.p) do
        trace(p, mirror)
        if s.c[i] then screen.close() end
      end
      screen.stroke()
    end
  end
end

-- The LCD's words are ten pixels high in the browser, four once scaled:
-- no font norns has is that small and readable, so they are drawn from a
-- three-by-five pixel alphabet of the letters they use.
local FONT3 = {
  A = { "010", "101", "111", "101", "101" }, C = { "011", "100", "100", "100", "011" },
  D = { "110", "101", "101", "101", "110" }, E = { "111", "100", "110", "100", "111" },
  H = { "101", "101", "111", "101", "101" }, I = { "111", "010", "010", "010", "111" },
  M = { "101", "111", "111", "101", "101" }, N = { "110", "101", "101", "101", "101" },
  O = { "010", "101", "101", "101", "010" }, P = { "110", "101", "110", "100", "100" },
  S = { "011", "100", "010", "001", "110" }, T = { "111", "010", "010", "010", "010" },
  ["-"] = { "000", "000", "111", "000", "000" },
}

local function lcd_text(text, x, y, on)
  screen.level(on and C.on or C.off)
  for i = 1, #text do
    local glyph = FONT3[text:sub(i, i)]
    if glyph then
      for row = 1, 5 do
        for col = 1, 3 do
          if glyph[row]:sub(col, col) == "1" then
            screen.rect(x + (i - 1) * 4 + col - 1, y + row - 1, 1, 1)
          end
        end
      end
    end
  end
  screen.fill()
end

local function draw_lcd(f)
  screen.level(C.bg)
  screen.rect(0, 0, 128, 51)
  screen.fill()
  screen.aa(1)
  draw_part(shapes.metronome, f, f.mirror and (2 + 12) * 2 * S or nil)
  draw_part(shapes.sewing, f)
  draw_part(shapes.tumblers, f)
  for k = 1, 4 do draw_part(shapes["pattern" .. k], f) end
  for k = 0, 3 do draw_part(shapes["digit" .. k], f) end
  for _, n in ipairs({ "playing", "recording", "fail", "success" }) do draw_part(shapes["icon_" .. n], f) end
  draw_part(shapes.figure, f)
  screen.line_width(1)
  -- the sixteen beats along the bottom
  screen.aa(0)
  for k = 0, 15 do
    screen.level((f.beat == k and not sleeping) and C.on or C.off)
    screen.rect(math.floor((4 + k * 19.125) * S + 0.5), math.floor(115 * S + 0.5), math.floor(17.125 * S + 0.5), 2)
    screen.fill()
  end
  -- the tempo names, one a line (the browser wraps them in two, which at
  -- this size would run into the sewing machine), and half of the day
  local mode_now
  for _, m in ipairs(MODES) do
    if m[2] == bpm then mode_now = m[1] end
  end
  if sleeping then mode_now = nil end
  lcd_text("HIP-HOP", 11, 1, mode_now == "HIP-HOP")
  lcd_text("DISCO", 11, 6, mode_now == "DISCO")
  lcd_text("TECHNO", 11, 11, mode_now == "TECHNO")
  lcd_text("AM", 121, 3, f.ampm == "AM")
  lcd_text("PM", 121, 9, f.ampm == "PM")
end

-- ---------------------------------------------------------------- the keypad's lights

local LIGHT = { none = 2, noted = 6, highlighted = 11, active = 15 }

local function number_status(n)
  local status = "none"
  if fx_held then
    -- holding FX, the keys are the sixteen effects
    status = fx_punch == n and "highlighted" or "noted"
  elseif is_held("bpm") then
    -- holding bpm, the keys are the volume
    status = (math.floor(params:get("volume") * 10 + 0.5) >= n) and "noted" or "none"
  elseif is_held("pattern") then
    status = non_empty(n) and "noted" or "none"
    for _, p in ipairs(pattern_presses or {}) do
      if p == n then status = "highlighted" end
    end
  elseif alarm_setting then
    status = alarm.pattern == n and "highlighted" or "none"
  elseif mode == "sound" or is_held("sound") then
    status = selected_sound == n and "highlighted" or "noted"
  elseif mode == "pattern" then
    status = selected_pattern == n and "highlighted" or (non_empty(n) and "noted" or "none")
  else
    if (recording or is_held("write")) and patterns[selected_pattern][n][selected_sound] then status = "noted" end
    if playing then
      local b = current_beat()
      for _, s in ipairs(sounds_playing) do
        if s == n and b % 1 < 0.5 then status = "highlighted" end
      end
      if math.floor(b) % 16 == n - 1 then status = "active" end
    end
  end
  if keyed[n] then status = "active" end
  return status
end

local function has_fx(p)
  return next(fx_steps[p]) ~= nil
end

local function function_status(name)
  if keyed[name] then return "active" end
  if name == "sound" then return mode == "sound" and "highlighted" or "none" end
  if name == "pattern" then return mode == "pattern" and "highlighted" or (chain and "noted" or "none") end
  if name == "write" then return (recording or held[1]) and "noted" or "none" end
  if name == "play" then return playing and "noted" or "none" end
  if name == "fx" then return fx_punch and "highlighted" or (has_fx(selected_pattern) and "noted" or "none") end
  if name == "bpm" then return sync_mode > 0 and "noted" or "none" end
  return "none"
end

local function finger_x(i)
  if i <= 16 then return 2 + (i - 1) * 5 + math.floor((i - 1) / 4) * 2 end
  return 92 + (i - 17) * 6
end

local GLYPH5 = {
  sound = { "0110", "1000", "0110", "0001", "0110" },
  pattern = { "1010", "0000", "1010", "0000", "1010" },
  bpm = { "0110", "0100", "0110", "0110", "1111" },
  fx = { "1110", "1000", "1100", "1000", "1000" },
  write = { "1111", "1001", "1111", "1001", "1111" },
  special = { "1001", "0110", "1111", "0110", "1001" },
}

local function draw_strip()
  screen.aa(0)
  screen.level(C.bezel)
  screen.rect(0, 51, 128, 13)
  screen.fill()
  if sleeping then return end
  for i = 1, FINGERS do
    local x = finger_x(i)
    if i <= 16 then
      screen.level(LIGHT[number_status(i)])
      screen.rect(x, 54, 4, 4)
      screen.fill()
    else
      local name = FUNCTION_NAMES[i - 16]
      screen.level(math.max(4, LIGHT[function_status(name)]))
      for row, bits in ipairs(GLYPH5[name]) do
        for col = 1, 4 do
          if bits:sub(col, col) == "1" then screen.rect(x + col - 1, 53 + row - 1, 1, 1) end
        end
      end
      screen.fill()
    end
  end
  screen.level(15)
  screen.rect(finger_x(finger), 60, 4, 1)
  screen.fill()
  -- the second finger, while K2 holds the first (not while it holds FX,
  -- when E1 is the row of effects)
  if held[2] and not (fx_held and keyed["fx"]) then
    screen.level(7)
    screen.rect(finger_x(finger2), 62, 4, 1)
    screen.fill()
  end
end

local function draw(f)
  screen.clear()
  screen.line_width(1)
  draw_lcd(f)
  draw_strip()
  screen.font_face(1)
  screen.font_size(8)
  screen.update()
end

function redraw() draw(frame_state()) end

-- ---------------------------------------------------------------- grid (optional): the keypad

-- Each numbered button is a 2x2 pad; the function buttons sit beside them;
-- knobs A and B are two faders. A grid has as many fingers as you do, so
-- every chord of the PO-12 is played on it as on the device.
local GRID_FUNCS = {
  { name = "sound", x = 10, y = 1 }, { name = "special", x = 12, y = 1 },
  { name = "pattern", x = 10, y = 3 }, { name = "fx", x = 12, y = 3 },
  { name = "bpm", x = 10, y = 5 }, { name = "play", x = 12, y = 5 },
  { name = "write", x = 10, y = 7 },
}

local function grid_func_at(x, y)
  for _, fn in ipairs(GRID_FUNCS) do
    if x >= fn.x and x <= fn.x + 1 and y >= fn.y and y <= fn.y + 1 then return fn.name end
  end
end

local function grid_redraw()
  g:all(0)
  if not sleeping then
    for n = 1, 16 do
      local c, r = (n - 1) % 4, math.floor((n - 1) / 4)
      local l = LIGHT[number_status(n)]
      for dx = 0, 1 do
        for dy = 0, 1 do g:led(1 + c * 2 + dx, 1 + r * 2 + dy, l) end
      end
    end
    for _, fn in ipairs(GRID_FUNCS) do
      local l = math.max(3, LIGHT[function_status(fn.name)])
      for dx = 0, 1 do
        for dy = 0, 1 do g:led(fn.x + dx, fn.y + dy, l) end
      end
    end
    local ka, kb = knobs_at(selected_sound, playing and math.floor(current_beat()) % 16 or nil)
    for y = 1, 8 do
      g:led(15, y, ka >= 9 - y and 10 or 2)
      g:led(16, y, kb >= 9 - y and 10 or 2)
    end
  end
  g:refresh()
end

-- ---------------------------------------------------------------- pressing

-- any touch wakes the LCD from its sleep, and is spent doing so
local function wake()
  idle_since = util.time()
  if sleeping then
    sleeping = false
    return true
  end
  return false
end

local function press(t)
  keyed[t] = true
  if type(t) == "number" then press_number(t) else press_function(t) end
end

local function release(t)
  if t == nil or not keyed[t] then return end
  keyed[t] = nil
  if type(t) == "string" then release_function(t) end
end

g.key = function(x, y, z)
  local id = "g" .. x .. "," .. y
  if z == 1 then
    if wake() then
      consumed[id] = true
      return
    end
  elseif consumed[id] then
    consumed[id] = nil
    return
  end
  if x <= 8 then
    local n = math.floor((y - 1) / 2) * 4 + math.floor((x - 1) / 2) + 1
    pad_count[n] = (pad_count[n] or 0) + (z == 1 and 1 or -1)
    if z == 1 and pad_count[n] == 1 then press(n) end
    if z == 0 and pad_count[n] <= 0 then
      pad_count[n] = nil
      release(n)
    end
  elseif x >= 15 then
    if z == 1 then
      local which = x == 15 and "a" or "b"
      local level = 9 - y
      if is_held("bpm") or alarm_setting then
        -- the faders turn as the knobs do, a step a key
        turn_knob(which, level >= 5 and 1 or -1)
      else
        local t = which == "a" and knob_a or knob_b
        if level == 1 and t[selected_sound] == 1 then level = 0 end
        turn_knob(which, (level - t[selected_sound]) * 4)
      end
    end
  else
    local name = grid_func_at(x, y)
    if not name then return end
    if z == 1 then press(name) else release(name) end
  end
end

-- ---------------------------------------------------------------- norns controls

local function target_of(i)
  if i <= 16 then return i end
  return FUNCTION_NAMES[i - 16]
end

function enc(n, d)
  if wake() then return end
  if n == 1 then
    if fx_held and keyed["fx"] and held[2] then
      -- holding FX, E1 runs along the keys: the effects
      press_number(util.clamp((fx_punch or 0) + d, 1, 16))
    elseif held[2] then
      finger2 = util.clamp(finger2 + d, 1, FINGERS)
    else
      finger = util.clamp(finger + d, 1, FINGERS)
    end
  elseif n == 2 then
    turn_knob("a", d)
  elseif n == 3 then
    turn_knob("b", d)
  end
end

function key(n, z)
  if z == 1 and wake() then
    consumed[n] = true
    return
  end
  if z == 0 and consumed[n] then
    consumed[n] = nil
    held[n] = false
    return
  end
  held[n] = (z == 1)
  if n == 2 then
    if z == 1 then
      finger2 = finger
      k2_target = target_of(finger)
      press(k2_target)
    else
      release(k2_target)
      k2_target = nil
    end
  elseif n == 3 then
    if z == 1 and held[2] then
      -- the second finger presses
      k3_target = target_of(finger2)
      press(k3_target)
    elseif z == 1 then
      if alarm_setting then
        alarm_setting = false
      elseif held[1] then
        next_bpm()
      else
        toggle_playing()
      end
    else
      release(k3_target)
      k3_target = nil
    end
  end
end

-- ---------------------------------------------------------------- state on disk

local function snapshot()
  local out, fx, lk, rt = {}, {}, {}, {}
  for p = 1, 16 do
    out[p], fx[p], lk[p], rt[p] = {}, {}, {}, {}
    for i = 1, 16 do
      local list = {}
      for n = 1, 16 do
        if patterns[p][i][n] then list[#list + 1] = n end
      end
      out[p][i] = list
      fx[p][i] = fx_steps[p][i] or 0
      rt[p][i] = retrig[p][i] or 0
      local l = {}
      for n, v in pairs(locks[p][i]) do l[#l + 1] = { n, v.a or -1, v.b or -1 } end
      lk[p][i] = l
    end
  end
  return {
    patterns = out, fx = fx, locks = lk, retrig = rt, knob_a = knob_a, knob_b = knob_b,
    selected_pattern = selected_pattern, selected_sound = selected_sound, bpm = bpm,
    chain = chain or {}, swing = swing, alarm = { alarm.hour, alarm.min, alarm.pattern },
  }
end

local function valid(t)
  if type(t) ~= "table" or type(t.patterns) ~= "table" or #t.patterns ~= 16 then return false end
  for p = 1, 16 do
    local pat = t.patterns[p]
    if type(pat) ~= "table" or #pat ~= 16 then return false end
    for i = 1, 16 do
      if type(pat[i]) ~= "table" then return false end
      for _, n in ipairs(pat[i]) do
        if type(n) ~= "number" or n < 1 or n > 16 then return false end
      end
    end
  end
  return true
end

local function knob(v, default)
  v = tonumber(v)
  if v == nil or v < 0 then return default end
  return util.clamp(v, 0, 8)
end

local function cell(t, key, p, i)
  local v = type(t[key]) == "table" and type(t[key][p]) == "table" and t[key][p][i]
  return v
end

-- the patterns are required; everything else is read when it is there
local function restore(t)
  for p = 1, 16 do
    patterns[p], fx_steps[p], locks[p], retrig[p] = empty_pattern(), {}, empty_locks(), {}
    for i = 1, 16 do
      for _, n in ipairs(t.patterns[p][i]) do patterns[p][i][n] = true end
      local fx = tonumber(cell(t, "fx", p, i))
      if fx and fx >= 1 and fx <= 16 then fx_steps[p][i] = math.floor(fx) end
      local rt = tonumber(cell(t, "retrig", p, i))
      if rt == 2 or rt == 4 or rt == 8 or rt == 16 then retrig[p][i] = rt end
      local lk = cell(t, "locks", p, i)
      if type(lk) == "table" then
        for _, e in ipairs(lk) do
          local n = type(e) == "table" and tonumber(e[1])
          if n and n >= 1 and n <= 16 then locks[p][i][n] = { a = knob(e[2], nil), b = knob(e[3], nil) } end
        end
      end
    end
  end
  for n = 1, 16 do
    knob_a[n] = knob(type(t.knob_a) == "table" and t.knob_a[n], 4)
    knob_b[n] = knob(type(t.knob_b) == "table" and t.knob_b[n], 4)
  end
  selected_pattern = util.clamp(tonumber(t.selected_pattern) or 1, 1, 16)
  selected_sound = util.clamp(tonumber(t.selected_sound) or 1, 1, 16)
  local b = tonumber(t.bpm)
  if b then bpm = util.clamp(math.floor(b), 60, 240) end
  chain = nil
  if type(t.chain) == "table" and #t.chain >= 2 then
    chain = {}
    for _, p in ipairs(t.chain) do
      if type(p) == "number" and p >= 1 and p <= 16 then chain[#chain + 1] = math.floor(p) end
    end
    if #chain < 2 then chain = nil end
    chain_pos = 1
  end
  swing = util.clamp(tonumber(t.swing) or 0, 0, 0.5)
  if type(t.alarm) == "table" then
    alarm.hour = util.clamp(math.floor(tonumber(t.alarm[1]) or -1), -1, 23)
    alarm.min = util.clamp(math.floor(tonumber(t.alarm[2]) or 0), 0, 59)
    alarm.pattern = util.clamp(math.floor(tonumber(t.alarm[3]) or 1), 1, 16)
  end
end

local function save(path)
  util.make_dir(DATA)
  tab.save(snapshot(), path)
end

local function load(path)
  if not util.file_exists(path) then return nil end
  local t = tab.load(path)
  if not valid(t) then return false end
  restore(t)
  return true
end

-- the PO-12's factory reset: everything back as it came
local function factory_reset()
  pause()
  default_patterns()
  for n = 1, 16 do knob_a[n], knob_b[n] = 4, 4 end
  selected_pattern, selected_sound, bpm = 1, 1, 80
  chain, swing, recording, mode = nil, 0, false, "default"
  alarm.hour, alarm.min, alarm.pattern = -1, 0, 1
  params:set("volume", 0.6)
  params:set("sync", 1)
  engine.bpm(bpm)
  bpm_shown_until = util.time() + 2
  flash("success")
end

-- ---------------------------------------------------------------- life

-- Everything a frame could show, as one string: the screen is only drawn
-- again when it differs, which while stopped is about once a minute.
local sig_keys = nil
local ANIM_KEYS = { "hittingKick", "hittingHighHat", "hittingDrum", "finishedHittingDrum",
  "hittingClap", "finishedHittingClap", "hittingBell1", "hittingBell2" }

local function signature(f)
  if not sig_keys then
    sig_keys = {}
    for k, v in pairs(f) do
      if type(v) ~= "table" then sig_keys[#sig_keys + 1] = k end
    end
    table.sort(sig_keys)
  end
  local parts = {}
  for i, k in ipairs(sig_keys) do parts[i] = tostring(f[k]) end
  for _, k in ipairs(ANIM_KEYS) do parts[#parts + 1] = anim[k] and "1" or "0" end
  for n = 1, 16 do parts[#parts + 1] = number_status(n) end
  for _, name in ipairs(FUNCTION_NAMES) do parts[#parts + 1] = function_status(name) end
  parts[#parts + 1] = table.concat({ finger, finger2, tostring(held[2]), tostring(sleeping), C.bg,
    tostring(fx_punch), tostring(fx_held) }, "/")
  return table.concat(parts, ",")
end

local last_sig, last_draw = nil, 0

-- the alarm goes off once, in its minute, with its pattern
local function check_alarm()
  if alarm.hour < 0 then return end
  local t = os.date("*t")
  local stamp = t.hour * 60 + t.min
  if t.hour == alarm.hour and t.min == alarm.min and alarm_fired ~= stamp then
    alarm_fired = stamp
    wake()
    if playing then
      queue_pattern(alarm.pattern)
    else
      selected_pattern = alarm.pattern
      start()
    end
  end
end

local function tick()
  local now = util.time()
  if queue_clear_at and now >= queue_clear_at then
    queued, queue_clear_at, spool_started = nil, nil, nil
  end
  if upload and now >= upload_until then upload = nil end
  -- "hold FX without pressing any key to clear effects": a second held does it
  if fx_held and not fx_chose and now - fx_held_since >= 1 then
    fx_steps[selected_pattern] = {}
    fx_chose = true
    flash("success")
  end
  -- the drummer stops while a pattern is changing over
  if queued and not was_queued then
    cancel_tracks()
    reset_anim()
  end
  was_queued = queued ~= nil
  check_alarm()
  -- five minutes of nothing and the LCD keeps only the clock, as the PO's does
  if not playing and not sleeping and now - idle_since >= 300 then sleeping = true end
  local f = frame_state()
  local sig = signature(f)
  if sig ~= last_sig or now - last_draw > 1 then
    last_sig, last_draw = sig, now
    draw(f)
  end
  grid_redraw()
end

local function apply_theme()
  if params:get("theme") == 1 then
    C.bg, C.off, C.on, C.bezel = 12, 9, 0, 0
  else
    C.bg, C.off, C.on, C.bezel = 0, 2, 13, 0
  end
end

local SYNC_NAMES = { "SY0", "SY1", "SY2", "SY3", "SY4", "SY5" }

function init()
  reset_anim()
  default_patterns()
  idle_since = util.time()
  params:add_separator("no12", "no12")
  -- the sounds are normalised near full scale and overlap: at 1 a kick and a
  -- snare together peaked at 1.19, measured, so the default leaves room
  params:add_control("volume", "volume", controlspec.new(0, 1.6, "lin", 0.01, 0.6))
  params:add_option("sync", "sync", SYNC_NAMES, 1)
  params:set_action("sync", function(i)
    sync_mode = i - 1
    engine.sync(sync_mode)
    show_digits(5, "y", sync_mode)
  end)
  params:add_option("theme", "screen", { "lcd", "dark" }, 1)
  params:set_action("theme", apply_theme)
  params:add_trigger("factory_reset", "factory reset")
  params:set_action("factory_reset", factory_reset)
  -- export and import, as the JAM and arrow buttons do in the browser
  params.action_write = function(filename, name, number) save(DATA .. number .. ".data") end
  params.action_read = function(filename, silent, number)
    local ok = load(DATA .. number .. ".data")
    if ok ~= nil then flash(ok and "success" or "fail") end
  end
  params.action_delete = function(filename, name, number) os.remove(DATA .. number .. ".data") end
  params:bang()
  display_until = 0
  load(DATA .. "state.data")

  -- the sounds, from the script's own folder
  for n = 1, 16 do engine.sample(n, norns.state.path .. "samples/" .. n .. ".wav") end
  engine.bpm(bpm)
  engine.fx(0)

  -- the clicks on the input, for sync in
  local ok, p = pcall(poll.set, "sync", function() on_pulse() end)
  if ok and p then p:start() end

  bpm_shown_until = util.time() + 2
  redraw_metro = metro.init(tick, 1 / 30)
  redraw_metro:start()
end

function cleanup()
  save(DATA .. "state.data")
  pause()
  cancel_tracks()
  if redraw_metro then redraw_metro:stop() end
end
