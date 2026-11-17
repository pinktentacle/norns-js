// E5-09 — norns' own state file has to be readable by norns.
//
// `state.save_state` writes Lua source and `state.resume` dofiles it back.
// That only works if every value it writes is a Lua literal, and one class
// of value was not: `norns.state.mix.rev_monitor_input` and two others
// default to `-math.huge` (state.lua:27-28, 46), and concatenating that
// gives `-inf` on hardware and `-Infinity` here. Neither is Lua.
//
// The symptom was not a missing file. The file was there, 3 KB of it, and
// `state.resume` died on line 21 of norns' own output with
// "attempt to perform arithmetic on a nil value (global 'Infinity')" — so
// every setting was lost on every boot, including the vport bindings this
// story is about.

import { describe, expect, it, beforeAll } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { loadDustNode } from "../src/fs/dust-node.js";
import { registerFs } from "../src/fs/register.js";
import { Vfs } from "../src/fs/vfs.js";
import { lua, to_luastring } from "../src/lua/lua.js";

let host: Host;
let vfs: Vfs;

beforeAll(() => {
  vfs = loadDustNode();
  host = createHost({ sources: loadNornsLua(), vfs });
  registerFs(host.registry, vfs);
  expect(boot(host, loadConfig())).toBeNull();
  // `save_state` writes `norns.state.clock.midi_out[1..16]`, which
  // `clock.add_params` fills when a script sets its params up. Nothing has
  // loaded a script here, so they are supplied directly — the point of the
  // test is the FORMATTING, not the param system.
  expect(host.run("for i = 1, 16 do norns.state.clock.midi_out[i] = 0 end")).toBeNull();
});

function luaString(name: string): string {
  lua.lua_getglobal(host.L, to_luastring(name));
  const v = lua.lua_type(host.L, -1) === lua.LUA_TSTRING ? lua.lua_tojsstring(host.L, -1) : "";
  lua.lua_pop(host.L, 1);
  return v;
}

describe("the system state file", () => {
  it("writes an infinity Lua can read back", () => {
    expect(host.run("norns.state.save_state()")).toBeNull();
    const text = vfs.readText("/home/we/dust/data/system.state");
    expect(text).not.toBeNull();
    expect(text).toContain("math.huge");
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("inf\n");
  });

  it("round-trips: what resume reads is what save wrote", () => {
    expect(
      host.run(`
        grid.vports[2].name = 'virtual grid v0001'
        norns.state.mix.rev_monitor_input = -math.huge
        norns.state.mix.output = -7.5
        norns.state.save_state()
        -- wipe them, then read the file back the way state.resume does
        grid.vports[2].name = 'none'
        norns.state.mix.rev_monitor_input = 0
        norns.state.mix.output = 0
        dofile(_path.data .. 'system.state')
        _RT = grid.vports[2].name
          .. ' / ' .. tostring(norns.state.mix.rev_monitor_input)
          .. ' / ' .. tostring(norns.state.mix.output)
      `),
    ).toBeNull();
    // `-Infinity`, not Lua's `-inf`: fengari's number-to-string is JS's.
    // That spelling is exactly why the file could not be read back before,
    // and the value round-trips now because it is written as `-math.huge`
    // rather than as whatever tostring makes of it.
    expect(luaString("_RT")).toBe("virtual grid v0001 / -Infinity / -7.5");
  });

  it("writes a PSET an infinite level can be read back out of", () => {
    // ParamSet:read already understands "inf" and "-inf" -- Lua spells an
    // infinity that way. Fengari spells it "-Infinity", which matched
    // neither branch and set the param to the STRING, and the next
    // controlspec.unmap did math.max on it.
    expect(
      host.run(`
        local ps = paramset.new()
        ps:add_control('lvl', 'lvl', controlspec.new(-math.huge, 6, 'db', 0, -math.huge, 'dB'))
        ps:write('/home/we/dust/data/probe.pset', 'probe')
        ps:set('lvl', 0)
        ps:read('/home/we/dust/data/probe.pset', true)
        _PV = tostring(ps:get('lvl'))
      `),
    ).toBeNull();
    expect(vfs.readText("/home/we/dust/data/probe.pset")).toContain("-inf");
    expect(vfs.readText("/home/we/dust/data/probe.pset")).not.toContain("Infinity");
    expect(luaString("_PV")).toBe("-Infinity"); // i.e. -math.huge, round-tripped
  });

  it("leaves a path containing the word alone", () => {
    // The rewrite only touches a whole value after "= ", so a script called
    // Infinity.lua is not corrupted into one called math.huge.lua.
    expect(
      host.run(`
        norns.state.script = '/home/we/dust/code/Infinity/Infinity.lua'
        norns.state.save_state()
      `),
    ).toBeNull();
    expect(vfs.readText("/home/we/dust/data/system.state")).toContain("Infinity/Infinity.lua");
  });
});
