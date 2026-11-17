// `bit32` and `cjson` — the rest of norns' Lua environment.
//
// The reference values are Lua 5.2's own manual and cjson's documented
// behaviour, not this implementation's output: a test written by reading the
// code back to itself proves only that the code is self-consistent.

import { describe, expect, it, beforeAll } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { lua, to_luastring } from "../src/lua/lua.js";

let host: Host;

beforeAll(() => {
  host = createHost({ sources: loadNornsLua() });
  const err = boot(host, loadConfig());
  expect(err).toBeNull();
});

/**
 * Evaluate a Lua expression as a NUMBER.
 *
 * bit32 values at or above 2^31 come back as floats here, because fengari's
 * integers are 32-bit and cannot hold them; `tostring` then says
 * "4294967295.0". The value is exact either way, so the comparison that
 * means anything is numeric.
 */
function evalNum(code: string): number {
  const err = host.run(`_T = ${code}`);
  if (err) throw new Error(err);
  lua.lua_getglobal(host.L, to_luastring("_T"));
  const v = lua.lua_tonumber(host.L, -1);
  lua.lua_pop(host.L, 1);
  return v;
}

/** Evaluate a Lua expression and read it back as a string. */
function evalStr(code: string): string {
  const err = host.run(`_T = tostring(${code})`);
  if (err) return `ERROR: ${err}`;
  lua.lua_getglobal(host.L, to_luastring("_T"));
  const v = lua.lua_tojsstring(host.L, -1);
  lua.lua_pop(host.L, 1);
  return v;
}

describe("bit32", () => {
  beforeAll(() => {
    expect(host.run(`b = require 'bit32'`)).toBeNull();
  });

  it("is unsigned 32-bit, so bnot(0) is 4294967295 and not -1", () => {
    expect(evalNum("b.bnot(0)")).toBe(0xffffffff);
    expect(evalNum("b.band(0xF0F0F0F0, 0xFF00FF00)")).toBe(0xf000f000);
    expect(evalNum("b.bxor(0xFFFF, 0x00FF)")).toBe(0xff00);
    expect(evalNum("b.bor(1, 2, 4, 8)")).toBe(15);
  });

  it("saturates shifts at 32, where Lua's own operators would reach 0 at 64", () => {
    // In plain Lua 5.3, 1 << 32 is 4294967296. bit32 says 0.
    expect(evalNum("b.lshift(1, 32)")).toBe(0);
    expect(evalNum("b.rshift(0xFFFFFFFF, 32)")).toBe(0);
    expect(evalNum("b.lshift(1, 31)")).toBe(0x80000000);
    // A negative displacement shifts the other way.
    expect(evalNum("b.lshift(0xFF, -4)")).toBe(15);
  });

  it("propagates the sign bit in arshift and not in rshift", () => {
    expect(evalNum("b.arshift(0x80000000, 4)")).toBe(0xf8000000);
    expect(evalNum("b.rshift(0x80000000, 4)")).toBe(0x08000000);
    expect(evalNum("b.arshift(0x80000000, 40)")).toBe(0xffffffff);
    expect(evalNum("b.arshift(0x40000000, 40)")).toBe(0);
  });

  it("extracts and replaces fields, and refuses bits that do not exist", () => {
    expect(evalNum("b.extract(0xDEADBEEF, 0, 8)")).toBe(0xef);
    expect(evalNum("b.extract(0xDEADBEEF, 16, 8)")).toBe(0xad);
    expect(evalNum("b.replace(0xFFFFFFFF, 0, 8, 8)")).toBe(0xffff00ff);
    expect(evalStr("pcall(b.extract, 0, 30, 8)")).toBe("false");
  });

  it("rotates rather than dropping bits", () => {
    expect(evalNum("b.lrotate(0x80000000, 1)")).toBe(1);
    expect(evalNum("b.rrotate(1, 1)")).toBe(0x80000000);
    expect(evalNum("b.lrotate(0x12345678, 0)")).toBe(0x12345678);
  });

  it("btest is band ~= 0", () => {
    expect(evalStr("b.btest(0xF0, 0x10)")).toBe("true");
    expect(evalStr("b.btest(0xF0, 0x01)")).toBe("false");
  });
});

describe("cjson", () => {
  beforeAll(() => {
    expect(host.run(`j = require 'cjson'`)).toBeNull();
  });

  it("round-trips the shapes a script actually stores", () => {
    expect(evalStr(`j.encode({1, 2, 3})`)).toBe("[1,2,3]");
    expect(evalStr(`j.decode('[1,2,3]')[2]`)).toBe("2");
    expect(evalStr(`j.decode('{"a":{"b":[true,false]}}').a.b[1]`)).toBe("true");
    expect(evalStr(`j.encode({x = 1})`)).toBe('{"x":1}');
  });

  it("writes integers without a decimal point, which .pset files depend on", () => {
    expect(evalStr(`j.encode({1, 2})`)).toBe("[1,2]");
    expect(evalStr(`j.encode(0.5)`)).toBe("0.5");
  });

  it("encodes an empty table as an object, as cjson does", () => {
    expect(evalStr(`j.encode({})`)).toBe("{}");
  });

  it("refuses a sparse table rather than inventing nulls", () => {
    expect(evalStr(`j.encode({[1] = 'a', [5] = 'b'})`)).toContain('"5"');
  });

  it("decodes null to a sentinel, not to nil, so the key survives", () => {
    expect(evalStr(`j.decode('{"a":null}').a == j.null`)).toBe("true");
    expect(evalStr(`j.decode('[null]')[1] == j.null`)).toBe("true");
  });

  it("handles escapes in both directions", () => {
    expect(evalStr(`j.encode('a"b')`)).toBe('"a\\"b"');
    // The backslash is built in Lua rather than escaped through two layers
    // of quoting: the point of the test is the \u escape reaching the
    // DECODER, and a miscount here tests the test instead.
    const u0041 = `'"a' .. string.char(92) .. 'u0041b"'`;
    expect(evalStr(`#j.decode(${u0041})`)).toBe("3");
    expect(evalStr(`j.decode(${u0041})`)).toBe("aAb");
    expect(evalStr(`j.decode(j.encode('tab\\there'))`)).toBe("tab\there");
  });

  it("rejects trailing junk rather than silently stopping", () => {
    expect(evalStr(`pcall(j.decode, '[1] x')`)).toBe("false");
    expect(evalStr(`pcall(j.decode, '{')`)).toBe("false");
  });

  it("refuses NaN and infinity, which have no JSON spelling", () => {
    expect(evalStr(`pcall(j.encode, 0/0)`)).toBe("false");
    expect(evalStr(`pcall(j.encode, math.huge)`)).toBe("false");
  });
});

// E9-27 — `os.clock` and `os.tmpname`, which fengari cannot do in a browser.
//
// Fengari's `os.clock` is `process.uptime()` and its `os.tmpname` raises
// "unable to generate a unique filename". In Node the first of those happens
// to work, which is exactly why it went unnoticed: in the page it raises
// `TypeError: process.uptime is not a function`, THROUGH Lua, as a crash —
// found in `forge`, whose `lib/test/luaunit.lua` calls it on its first line.
// **Nineteen catalogue scripts call `os.clock`.**
//
// So the assertion that matters here is not "it returns a number" — fengari's
// does too, under Node. It is that the number is OURS: zero at the first
// reading, because `process.uptime()` would be however long vitest had been
// running.
describe("os, where fengari reaches for Node", () => {
  it("starts os.clock at zero and advances it", () => {
    expect(evalNum("os.clock()")).toBe(0);
    const later = evalNum("(function() local n = 0 for i = 1, 200000 do n = n + i end return os.clock() end)()");
    expect(later).toBeGreaterThan(0);
    expect(later).toBeLessThan(60);
  });

  it("takes a difference of two readings, which is all any script does", () => {
    expect(host.run(`_T = (function()
      local a = os.clock()
      local n = 0
      for i = 1, 200000 do n = n + i end
      return os.clock() - a
    end)()`)).toBeNull();
    expect(evalNum("_T")).toBeGreaterThanOrEqual(0);
  });

  it("gives os.tmpname a new name each time instead of refusing", () => {
    const a = evalStr("os.tmpname()");
    const b = evalStr("os.tmpname()");
    expect(a).toMatch(/^\/tmp\/lua_\d+$/);
    expect(b).not.toBe(a);
  });
});

// E9-27 — `bit32` is a GLOBAL on hardware, not only a module.
//
// It is part of the `LUA_COMPAT_5_2` layer norns' interpreter is built
// with, and a compat library is opened by `luaL_openlibs`: on hardware it
// is a global and `package.loaded` already holds it, exactly like
// `math.pow`. Preload alone answers `require` and nothing else.
//
// Found by running `eterna`, whose vendored perlin noise is copied from a
// Lua 5.2 gist and says `bit32.band(...)` with no require in the file:
//
//     lib/ext/perlin.lua:41: attempt to index a nil value (global 'bit32')
//
// `mosaic` does the same; `n.kria` requires it, which is why this went
// unseen.
describe("bit32 as the platform has it", () => {
  it("is there without a require, the way a 5.2 script expects", () => {
    expect(evalStr("type(bit32)")).toBe("table");
    expect(evalNum("bit32.band(0xF0F0, 0xFF00)")).toBe(0xf000);
  });

  it("is the same table require hands back, not a second copy", () => {
    // A script that keeps a reference from one and meets the other should
    // not be able to tell them apart; on hardware there is only one.
    expect(evalStr("tostring(require('bit32') == bit32)")).toBe("true");
  });
});
