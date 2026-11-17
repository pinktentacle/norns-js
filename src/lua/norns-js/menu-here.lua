-- norns-js: the menu pages that cannot do what they offer, saying so.
--
-- ADR-08's rule applied to the menu instead of to the shell. A refused
-- command returns false and never calls its callback, which is exactly what
-- norns does when a process will not start -- faithful, and on a 128x64
-- screen indistinguishable from a page that has frozen:
--
--   UPDATE sat on "checking for update." for ever, because it asks ping and
--   then curl and both are refused, so neither callback ever ran.
--   WIFI offered off / hotspot / connect / add / del, and every one of them
--   ran an nmcli that went nowhere.
--   SLEEP muted the DAC and the headphone gain, saved the state, and asked
--   for a shutdown a browser tab cannot perform -- leaving the page silent
--   with no way back but a reload.
--   SETTINGS > PASSWORD ran sudo chpasswd and sudo smbpasswd, which were
--   refused in silence, and then printed "hotspot password changed" because
--   writing that one file DID succeed. A success message for the only part
--   that means nothing.
--
-- Nothing here pretends to work. Each page is replaced by what is true, and
-- the pages that do work -- RESTART, RESET, MODS, TAPE, DEVICES, PARAMS --
-- are not touched.
--
-- Mutated rather than replaced: `_menu.set_page` reads a dozen fields off a
-- page table (refresh, keycode, keychar, the four gamepad hooks), and a
-- fresh table with three of them would be a different kind of broken.

local function back_to_system(n, z)
  if z == 1 then _menu.set_page("SYSTEM") end
end

-- One title, some body text, and the way out. Three body lines at most and
-- under about 25 characters each: the first draft used four, the fourth
-- landed at y=60 and sat on top of the "K2: back" at y=62.
local function say(title, body)
  return function()
    screen.clear()
    screen.level(15)
    screen.move(0, 16)
    screen.text(title)
    screen.level(4)
    local y = 30
    for _, line in ipairs(body) do
      screen.move(0, y)
      screen.text(line)
      y = y + 10
    end
    screen.level(1)
    screen.move(0, 62)
    screen.text("K2: back")
    screen.update()
  end
end

local function dead_page(name, title, body)
  local m = _menu.m[name]
  if m == nil then return end
  -- init too, not only redraw: UPDATE's own init is what fires the commands
  -- that cannot return, and leaving it in place would keep the console
  -- filling with refusals every time the page is opened.
  m.init = norns.none
  m.deinit = norns.none
  m.enc = norns.none
  m.key = back_to_system
  m.redraw = say(title, body)
end

dead_page("UPDATE", "update", {
  "norns-js is a web page:",
  "reload it and you have",
  "the newest there is.",
})

dead_page("WIFI", "wifi", {
  "the browser owns the",
  "network. nothing on this",
  "page can reach it.",
})

-- SLEEP: the half that means something, without the half that does not.
--
-- Saving the state and closing the tape are what sleep IS; muting the audio
-- was preparation for a power-off that never comes. So the state is saved,
-- the mute is dropped, and the screen says what the person has to do.
local sleep_page = _menu.m.SLEEP
if sleep_page ~= nil then
  sleep_page.key = function(n, z)
    if n == 2 and z == 1 then
      _menu.set_page("HOME")
    elseif n == 3 and z == 1 then
      sleep_page.njs_slept = true
      if audio.tape_is_recording() then audio.tape_record_stop() end
      norns.state.clean_shutdown = true
      norns.state.save()
      print("SLEEP: state saved. Close the tab -- a page cannot close itself.")
      _menu.redraw()
    end
  end
  sleep_page.init = function() sleep_page.njs_slept = false end
  sleep_page.redraw = function()
    screen.clear()
    if sleep_page.njs_slept then
      screen.level(4)
      screen.move(64, 30)
      screen.text_center("state saved.")
      screen.move(64, 42)
      screen.text_center("close this tab to sleep.")
    else
      screen.level(15)
      screen.move(64, 40)
      screen.text_center("sleep?")
    end
    screen.update()
  end
end

-- Did a battery ever report? SETTINGS asks, below.
--
-- Set from the handler rather than from the host, because the host learns
-- the answer asynchronously -- `navigator.getBattery()` is a promise -- and
-- this file runs the moment boot finishes. `rawset` because `Script.clear`
-- puts a metatable on _G that diverts every new global into the running
-- script's own table, where nothing could read it back.
local real_battery = _norns.battery
_norns.battery = function(percent, current)
  rawset(_G, "_NJS_BATTERY", true)
  return real_battery(percent, current)
end

-- SETTINGS > PASSWORD: no text entry for a password nothing can receive.
local settings_page = _menu.m.SETTINGS
if settings_page ~= nil then
  -- The ">" means "opens a page", and this one no longer does.
  settings_page.list[2] = "PASSWORD"
  local base_key = settings_page.key
  local base_redraw = settings_page.redraw
  settings_page.init = function() settings_page.njs_note = nil end
  settings_page.key = function(n, z)
    if n == 3 and z == 1 and settings_page.pages[settings_page.pos] == "PASSWORD" then
      settings_page.njs_note = "no ssh or samba here"
      _menu.redraw()
      return
    end
    settings_page.njs_note = nil
    base_key(n, z)
  end
  settings_page.redraw = function()
    base_redraw()
    local note = settings_page.njs_note
    -- BATTERY WARNING is a real setting with a real effect -- it swaps
    -- `screen.update` for the low-battery overlay -- and whether it can
    -- ever fire depends on the machine the page is open on, not on the
    -- page. So it is answered where the cursor is, rather than guessed at.
    if note == nil
      and settings_page.list[settings_page.pos] == "BATTERY WARNING"
      and rawget(_G, "_NJS_BATTERY") ~= true then
      note = "no battery on this machine"
    end
    if note ~= nil then
      screen.level(15)
      screen.move(64, 62)
      screen.text_center(note)
      screen.update()
    end
  end
end

-- DEVICES: two of its five sections have nothing behind them.
--
-- HID is always empty: norns' `hid` is for USB input devices, and the one
-- the page does read -- a gamepad, on a Steam Deck -- is read through the
-- frame loop and arrives as K1-K3 and E1-E3, not as a hid device. KEYBOARD
-- LAYOUT sets a layout for typing that is never routed: `_norns.keyboard`
-- is not wired at all, and the browser's keyboard is the panel instead.
-- Both are honest as they stand -- an empty list is an empty list -- but
-- neither says WHY, and "4 x none" looks like something that failed.
local devices_page = _menu.m.DEVICES
if devices_page ~= nil then
  local devices_note = {
    hid = "no usb here; gamepad = keys",
    ["keyboard layout"] = "typing is not routed here",
  }
  local base_devices_redraw = devices_page.redraw
  devices_page.redraw = function()
    base_devices_redraw()
    local note = devices_note[devices_page.section]
    if note ~= nil then
      -- On a cleared strip, because the HID list puts its fourth vport on
      -- the same baseline and the two were drawn through each other. What
      -- is covered is one more row reading "none", which is the thing the
      -- note is there to explain.
      screen.level(0)
      screen.rect(0, 54, 128, 10)
      screen.fill()
      screen.level(15)
      screen.move(64, 62)
      screen.text_center(note)
      screen.update()
    end
  end
end

-- The stats line on HOME: two of its four readings cannot exist here.
--
-- K2 on HOME shows `cpu 0. 0. 0. 0.` across four cores and `0c` for the
-- temperature, and both are inventions: matron reads them from /proc and
-- /sys on hardware, and a browser has neither. A zero there does not read
-- as "unknown", it reads as a measurement -- an idle machine running cold.
--
-- The two beside them are REAL and stay: the percentage is crone's own mean
-- block time against its budget (it reads 0 only because nothing is making
-- sound), and the free space is `navigator.storage.estimate()`.
local real_stat = _norns.stat
_norns.stat = function(disk, temp, cpu, cpu1, cpu2, cpu3, cpu4)
  real_stat(disk, temp, cpu, cpu1, cpu2, cpu3, cpu4)
  -- Strings, and nothing reads these as numbers: `menu/home.lua:51` and
  -- :70 concatenate them and are the only readers in norns or in any
  -- bundled script.
  norns.cpu = { "-", "-", "-", "-" }
  norns.cpu_avg = "-"
  norns.temp = "-"
end

-- SETTINGS > DISPLAY: it saves, and it changes nothing.
--
-- Measured: brightness 0, contrast 0 and gamma 4.0 together change zero of
-- the 8192 pixels, because those three write to an OLED controller that is
-- not in this build. The page is left alone -- its calibration ramp fills
-- the screen and there is nowhere to put a line -- and it says so once, in
-- the console, the first time somebody turns one of the three.
local display_page = _menu.m.DISPLAY
if display_page ~= nil then
  local base_enc = display_page.enc
  display_page.enc = function(n, delta)
    if n == 3 and not display_page.njs_said then
      display_page.njs_said = true
      print("display: brightness, contrast and gamma do nothing here -- there is no OLED controller. The page's own display settings are in the gear.")
    end
    base_enc(n, delta)
  end
end
