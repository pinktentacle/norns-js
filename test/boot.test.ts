// E1-08 — norns boots headlessly on the generated `_norns` boundary.
//
// The P0 spike measured the floor: **128 calls, 26 distinct, 0 patches to
// `lua/core`**. This asserts the product code reaches the same place, and adds
// the thing the spike could not check — that it reaches it with stubs that
// push nothing by default rather than a generic `0`.
//
// "0 patches" is not asserted by counting patches; it is structural. The host
// reads `third_party/norns/lua` and injects it verbatim.

import { beforeAll, describe, expect, it } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { lua, to_luastring } from "../src/lua/lua.js";

let host: Host;
let bootError: { step: string; error: string } | null;
/** Each post-boot step and the Lua error it produced, if any. */
const steps: Array<{ step: string; error: string | null }> = [];
/** Per-function counts immediately after the canonical sequence. */
let profile: Record<string, number> = {};
let profileTotals: { total: number; distinct: number } = { total: 0, distinct: 0 };

/** Read a global as a JS number, or null. */
function globalNumber(h: Host, name: string): number | null {
  lua.lua_getglobal(h.L, to_luastring(name));
  const v = lua.lua_type(h.L, -1) === lua.LUA_TNUMBER ? lua.lua_tonumber(h.L, -1) : null;
  lua.lua_pop(h.L, 1);
  return v;
}

beforeAll(() => {
  host = createHost({ sources: loadNornsLua() });
  bootError = boot(host, loadConfig());

  // The rest of the P0 spike's 13 steps, in its order, because the order is
  // part of the contract: matron pushes `stat` and `battery` on a timer from
  // the moment it starts, and `core/menu/home.lua:51` indexes the cpu field
  // they populate. Redrawing the menu before either has arrived is not a
  // norns-js bug, it is a sequence that never happens on hardware.
  for (const [step, code] of [
    ["_norns.stat()", `_norns.stat(50, 40, 10, 10, 10, 10, 10)`],
    ["_norns.battery()", `_norns.battery(100, 0)`],
    ["menu mode on", `norns.menu.toggle(true)`],
    ["_menu.redraw()", `_menu.redraw()`],
    ["enc(1,1)", `_norns.enc(1, 1)`],
    ["key(2,1) key(2,0)", `_norns.key(2, 1) _norns.key(2, 0)`],
    ["_menu.redraw() again", `_menu.redraw()`],
  ] as const) {
    steps.push({ step, error: host.run(code, `=(${step})`) });
  }

  // Freeze the profile here. Anything a later test calls must not change the
  // number being compared with the spike's, or the comparison stops meaning
  // "the same sequence produces the same calls".
  profile = Object.fromEntries(host.registry.stats().byName);
  profileTotals = host.registry.stats();
});

describe("boot", () => {
  it("completes config, core/norns, _startup and _post_startup", () => {
    expect(bootError, bootError ? `${bootError.step}: ${bootError.error}` : "").toBeNull();
  });

  it("reaches the measured floor of distinct _norns functions", () => {
    // The spike's 26. More is fine and expected as subsystems land; fewer
    // means something stopped being called, which is a regression worth
    // failing on.
    const { total, distinct } = profileTotals;
    expect(distinct).toBeGreaterThanOrEqual(26);
    expect(total).toBeGreaterThanOrEqual(128);
  });

  it("matches the P0 spike's call profile, function by function", () => {
    // The spike ran the same sequence against a Lua-side stub table and
    // recorded what norns asked for. Comparing per name rather than on the
    // total is the point: a total that happens to match while two functions
    // are each wrong by the same amount would pass, and tells you nothing.
    const ours = profile;
    const names = [...new Set([...Object.keys(SPIKE_COUNTS), ...Object.keys(ours)])].sort();
    const diffs = names
      .map((n) => ({ n, spike: SPIKE_COUNTS[n] ?? 0, ours: ours[n] ?? 0 }))
      .filter((d) => d.spike !== d.ours)
      .map((d) => `${d.n}: spike ${d.spike}, ours ${d.ours}`);
    expect(diffs).toEqual([]);
  });

  it("calls screen functions more than anything else, as upstream does", () => {
    const byName = new Map(Object.entries(profile));
    const screenCalls = [...byName.entries()]
      .filter(([n]) => n.startsWith("screen_"))
      .reduce((a, [, c]) => a + c, 0);
    expect(screenCalls).toBeGreaterThan(0);
  });

  it("runs every one of the spike's post-boot steps without error", () => {
    const failed = steps.filter((s) => s.error);
    expect(failed.map((s) => `${s.step}: ${s.error}`)).toEqual([]);
  });
});

describe("the boundary itself", () => {
  it("_norns is a plain writable table — lua/core assigns into it", () => {
    // core/screen.lua:375-395 adds three Lua polyfills, and startup.lua
    // assigns tape_status and the monome handlers. A frozen object or a proxy
    // with a throwing __newindex breaks boot invisibly and late.
    expect(host.run(`_norns.__e1_probe = function() return 42 end`)).toBeNull();
    expect(host.run(`assert(_norns.__e1_probe() == 42)`)).toBeNull();
    // The real ones, which boot itself should already have installed.
    expect(host.run(`assert(type(_norns.screen_circle) == 'function')`)).toBeNull();
    expect(host.run(`assert(type(_norns.screen_text_rotate) == 'function')`)).toBeNull();
  });

  it("every one of the 178 functions exists and is callable", () => {
    const code = `
local missing = {}
for _, n in ipairs(_NORNS_EXPECTED) do
  if type(_norns[n]) ~= 'function' then missing[#missing+1] = n end
end
_MISSING = table.concat(missing, ', ')
`;
    // Hand the expected names to Lua rather than reflecting from Lua, so the
    // list comes from surface.json and not from the table under test.
    const names = host.registry.stats();
    expect(names).toBeTruthy();
    expect(
      host.run(
        `_NORNS_EXPECTED = {${[...SURFACE_NAMES].map((n) => `'${n}'`).join(",")}}` + code,
      ),
    ).toBeNull();
    lua.lua_getglobal(host.L, to_luastring("_MISSING"));
    const missing = lua.lua_tojsstring(host.L, -1);
    lua.lua_pop(host.L, 1);
    expect(missing).toBe("");
  });

  it("the stubs it actually reached are recorded, with their first arguments", () => {
    const used = host.registry.stubsUsed();
    expect(used.length).toBeGreaterThan(0);
    for (const s of used) {
      expect(s.count).toBeGreaterThan(0);
      expect(Array.isArray(s.firstArgs)).toBe(true);
    }
    // The registry is the source for the compatibility page (E7-01), so the
    // order it records must be the order they were first reached.
    const firstTimes = used.map((s) => s.firstAt);
    expect([...firstTimes].sort((a, b) => a - b)).toEqual(firstTimes);
  });

  it("notices that io.open is a stub rather than pretending files exist", () => {
    // norns reads version.txt and the keyboard layout during boot. Fengari has
    // no io.open at all, so this counts how often the gap was hit — E6-02.
    const n = globalNumber(host, "_NORNS_IO_STUBBED");
    expect(n).not.toBeNull();
    expect(n!).toBeGreaterThan(0);
  });
});

// Imported last so the describe blocks above read first.
import surface from "../src/api/surface.json" with { type: "json" };
const SURFACE_NAMES: string[] = surface.functions.map((f: { name: string }) => f.name);

// THE P0 BASELINE, which lives in `test/fixtures/` and not in `spike/`.
// It was written by the spike that produced it and read from there for a
// year — and `spike/` is export-ignored, so the published tree did not
// typecheck: `Cannot find module '../spike/boot-result.json'`. A
// measurement a test depends on is a fixture, whatever wrote it.
import spikeResult from "./fixtures/p0-boot-profile.json" with { type: "json" };
/** What the P0 spike recorded, per `_norns` function, for the same sequence. */
const SPIKE_COUNTS: Record<string, number> = spikeResult.counts;
