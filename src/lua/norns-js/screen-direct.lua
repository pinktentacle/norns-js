-- E9-112 -- the pass-through that is half of every screen call.
--
-- `core/screen.lua` is, for 31 of its 49 functions, one line:
--
--     Screen.level = function(value) _norns.screen_level(value) end
--
-- On hardware that wrapper buys a stable Lua name for a C function and
-- costs about fifty nanoseconds. Under fengari, which was the interpreter
-- when this was written, a function call was 150 ns local and 393 ns
-- global -- so the wrapper was not a detail, it was HALF THE CALL.
-- Measured in the page (`docs/13-CPU.md`):
--
--     screen.level(5)    563 ns   ->   309 ns      45% off
--     screen.move(1,1)   638 ns   ->   344 ns      46% off
--     screen.text('x')   787 ns   ->   509 ns      35% off
--
-- and the same pixels come out: 91 lit for the same string, 0 after a
-- clear. A script drawing 24 000 glyphs a second -- which several in the
-- catalogue do -- got about 7 ms of every second back.
--
-- E9-118 -- AND THE PORT TOOK MOST OF THAT BACK AGAIN, which is said here
-- rather than left for somebody to discover. Lua 5.3 calls a Lua function
-- in about 10 ns, so re-measured in the page on 5.3:
--
--     screen.level(5)    120 ns   ->   113 ns       6% off
--     screen.move(1,1)   120 ns   ->   100 ns      17% off
--     screen.text('x')   297 ns   ->   280 ns       6% off
--
-- (os.clock quantises at 10 ns over 300 000 calls, so read these as
-- 7-20 ns saved per call rather than as three decimal places.) It is
-- still a saving and it still costs nothing at runtime -- the table below
-- is built once at boot -- but it is a 6-17% one now, not a 45% one, and
-- nobody should reach for this shape again on the strength of the first
-- table.
--
-- ONLY THE ONES THAT ARE REALLY PASS-THROUGHS. Every name below was
-- checked against upstream's source: the parameter list and the argument
-- list must be identical and the target must be `screen_<name>`.
-- `export_screenshot` looks like one and is not -- it builds a path -- and
-- `update` is not one either, which matters: `core/norns.lua:107` swaps
-- `screen.update` for the low-battery overlay at runtime, and aliasing it
-- here would be a race with that.
--
-- `test/screen-direct.test.ts` re-derives this list from
-- `third_party/norns/lua/core/screen.lua` and fails if the two disagree.
-- That is the whole guard: if upstream ever gives one of these a body,
-- the test says so rather than this file quietly keeping the old meaning.

-- THREE OF THE THIRTY-ONE ARE NOT HERE, and finding out why was worth the
-- detour: `circle`, `text_rotate` and `text_center_rotate` call
-- `_norns.screen_circle`, `_norns.screen_text_rotate` and
-- `_norns.screen_text_center_rotate`, and matron exports none of the
-- three -- they are absent from `src/api/surface.json`, which is
-- generated from `weaver.cc` itself. So those wrappers already call nil
-- on this build, and aliasing them would turn `screen.circle` into nil
-- as well: a blank screen instead of an error, which is worse. They keep
-- their wrappers and whatever happens today keeps happening.
local direct = {
  "aa", "clear", "level", "line_width", "move", "move_rel", "line",
  "line_rel", "arc", "rect", "curve", "curve_rel", "close",
  "stroke", "fill", "text", "text_trim", "text_right",
  "text_center", "font_face", "font_size",
  "display_png", "display_image", "poke", "rotate", "translate",
  "save", "restore",
}

local swapped, missing = 0, {}
for _, name in ipairs(direct) do
  local fn = _norns["screen_" .. name]
  if fn ~= nil then
    screen[name] = fn
    swapped = swapped + 1
  else
    -- A name on the list that the surface does not have is a mismatch
    -- between this file and `src/api/surface.json`, not a reason to stop:
    -- the wrapper that is already there still works.
    missing[#missing + 1] = name
  end
end

if #missing > 0 then
  print("screen: " .. #missing .. " of " .. #direct ..
        " not on the surface (" .. table.concat(missing, ", ") .. ")")
end

return swapped
