// E1-07 — calling into Lua, and the 1-based conversions that come with it.

import { beforeAll, describe, expect, it } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { makeCallbacks, callNorns, type Callbacks } from "../src/norns/callbacks.js";
import { lua, to_luastring } from "../src/lua/lua.js";

let host: Host;
let cb: Callbacks;

/** Read a global string, for probing what Lua saw. */
function globalString(name: string): string | null {
  lua.lua_getglobal(host.L, to_luastring(name));
  const v = lua.lua_type(host.L, -1) === lua.LUA_TSTRING ? lua.lua_tojsstring(host.L, -1) : null;
  lua.lua_pop(host.L, 1);
  return v;
}

beforeAll(() => {
  host = createHost({ sources: loadNornsLua() });
  boot(host, loadConfig());
  cb = makeCallbacks(host.L);
});

describe("callbacks", () => {
  it("an unclaimed callback is a no-op, not an error", () => {
    // matron fires some of these before anything has assigned a handler. On
    // hardware that does nothing; here it must also do nothing rather than
    // throwing into whatever called us.
    expect(callNorns(host.L, "nothing_has_this_name", [])).toBeNull();
    expect(callNorns(host.L, "grid.no_such_handler", [1])).toBeNull();
  });

  it("converts indices to 1-based exactly where weaver.cc does", () => {
    host.run(`
      _SEEN = ''
      _norns.grid.key = function(id, x, y, s) _SEEN = string.format('%d,%d,%d,%d', id, x, y, s) end
    `);
    // 0-based on the wire, as a serialosc message delivers them.
    expect(cb.gridKey(0, 0, 0, 1)).toBeNull();
    expect(globalString("_SEEN")).toBe("1,1,1,1");
  });

  it("metro passes both index and stage 1-based", () => {
    host.run(`_SEEN = '' _norns.metro = function(i, s) _SEEN = i .. '/' .. s end`);
    expect(cb.metro(0, 0)).toBeNull();
    expect(globalString("_SEEN")).toBe("1/1");
  });

  it("vu sends twelve separate integers, not a table", () => {
    host.run(`
      _SEEN = ''
      _norns.vu = function(...)
        local n = select('#', ...)
        local first = select(1, ...)
        _SEEN = n .. ':' .. type(first)
      end
    `);
    expect(cb.vu([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBeNull();
    expect(globalString("_SEEN")).toBe("12:number");
  });

  it("refuses a vu frame that is not twelve levels", () => {
    const err = cb.vu([1, 2, 3]);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/12/);
  });

  it("poll has two arities under one name", () => {
    host.run(`_SEEN = '' _norns.poll = function(...) _SEEN = tostring(select('#', ...)) end`);
    expect(cb.pollValue(0, 0.5)).toBeNull();
    expect(globalString("_SEEN")).toBe("2");
    expect(cb.pollData(0, [1, 2, 3], 3)).toBeNull();
    expect(globalString("_SEEN")).toBe("3");
  });

  it("reports a Lua error from inside a callback instead of swallowing it", () => {
    host.run(`_norns.key = function() error('deliberate') end`);
    const err = cb.key(1, 1);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/deliberate/);
  });

  it("every report goes as (data, COUNT) — the second argument is not optional", () => {
    // `core/engine.lua:32` does `"available engines ("..count..")"`, so a
    // missing count surfaces as "attempt to concatenate a nil value" and
    // names neither the callback nor the argument.
    host.run(`_SEEN = '' _norns.report.engines = function(d, n) _SEEN = n .. ':' .. d[1] end`);
    expect(cb.reportEngines(["PolyPerc", "TestSine"])).toBeNull();
    expect(globalString("_SEEN")).toBe("2:PolyPerc");
  });

  it("polls go as (id, name) pairs — poll.lua keys by data[i][1]", () => {
    host.run(`
      _SEEN = ''
      _norns.report.polls = function(d, n)
        _SEEN = n .. '|' .. tostring(d[1][1]) .. '|' .. tostring(d[1][2])
      end
    `);
    expect(cb.reportPolls([{ id: 1, name: "amp_in_l" }])).toBeNull();
    expect(globalString("_SEEN")).toBe("1|1|amp_in_l");
  });

  it("commands go as (name, format) pairs", () => {
    host.run(`
      _SEEN = ''
      _norns.report.commands = function(d, n)
        _SEEN = n .. '|' .. d[1][1] .. '|' .. d[1][2]
      end
    `);
    expect(cb.reportCommands([{ name: "hz", format: "f" }])).toBeNull();
    expect(globalString("_SEEN")).toBe("1|hz|f");
  });

  it("clock.resume is reached on the global clock table, not on _norns", () => {
    host.run(`
      _SEEN = ''
      clock = clock or {}
      clock.resume = function(id, v) _SEEN = id .. '=' .. tostring(v) end
    `);
    expect(cb.clockResume(7, 1.5)).toBeNull();
    expect(globalString("_SEEN")).toBe("7=1.5");
  });
});
