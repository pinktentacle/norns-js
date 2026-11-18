// E9-112 — the list of pass-throughs, checked against the thing it describes.
//
// `src/lua/norns-js/screen-direct.lua` replaces 31 of norns' `Screen.*`
// functions with the `_norns` entry point they call, because in fengari
// that wrapper is half the call — 563 ns becomes 309 for `screen.level`,
// measured in the page (`docs/13-CPU.md`).
//
// A hand-written list of other people's function names is exactly the kind
// of thing that goes quietly wrong: upstream gives one of them a body, the
// alias keeps the old meaning, and nothing fails. So the list is derived
// again here, from upstream's own source, and compared.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import surface from "../src/api/surface.json";

const ROOT = path.resolve(__dirname, "..");
const upstream = fs.readFileSync(
  path.join(ROOT, "third_party", "norns", "lua", "core", "screen.lua"),
  "utf8",
);
const ours = fs.readFileSync(
  path.join(ROOT, "src", "lua", "norns-js", "screen-direct.lua"),
  "utf8",
);

/**
 * Every `Screen.x = function(a, b) _norns.screen_x(a, b) end`.
 *
 * The test is not that it is one line: it is that the parameters and the
 * arguments are the SAME list in the same order, and that the target is
 * the `_norns` name derived from this one. Anything that reorders, adds,
 * renames or computes is not a pass-through and must keep its wrapper.
 */
function pureInUpstream(): string[] {
  const out: string[] = [];
  const re = /^Screen\.([a-z_0-9]+) = function\(([^)]*)\) _norns\.([a-z_0-9]+)\(([^)]*)\) end$/gm;
  for (const m of upstream.matchAll(re)) {
    const [, name, params, target, args] = m;
    const p = params!.split(",").map((x) => x.trim()).filter(Boolean);
    const a = args!.split(",").map((x) => x.trim()).filter(Boolean);
    if (target === `screen_${name!}` && p.length === a.length && p.every((x, i) => x === a[i])) {
      out.push(name!);
    }
  }
  return out;
}

/** The `_norns` names matron actually exports, from `weaver.cc`. */
const ON_SURFACE = new Set(
  (surface as { functions: { name: string }[] }).functions.map((f) => f.name),
);

/**
 * A pass-through that there is somewhere to pass through TO.
 *
 * Three of upstream's thirty-one are not: `circle`, `text_rotate` and
 * `text_center_rotate` call `_norns` names that matron does not export.
 * Their wrappers already call nil here; aliasing them would make
 * `screen.circle` nil as well, which is a blank screen instead of an
 * error.
 */
function aliasable(): string[] {
  return pureInUpstream().filter((n) => ON_SURFACE.has(`screen_${n}`));
}

/** The names `screen-direct.lua` actually swaps. */
function listedInOurs(): string[] {
  const at = ours.indexOf("local direct = {");
  expect(at, "the list is not where the test expects it").toBeGreaterThan(-1);
  const body = ours.slice(at, ours.indexOf("}", at));
  return [...body.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]!);
}

describe("the screen functions that are aliased straight through", () => {
  it("is the same set upstream still declares, minus what matron lacks", () => {
    expect([...listedInOurs()].sort()).toEqual([...aliasable()].sort());
  });

  it("is 28 of the 31 of the 49, and the three are named", () => {
    // Not magic numbers for their own sake: if any of these move, upstream
    // or the surface changed, and somebody should look at WHICH before the
    // list is edited.
    expect(upstream.match(/^Screen\.[a-z_0-9]+ = function/gm)).toHaveLength(49);
    expect(pureInUpstream()).toHaveLength(31);
    expect(aliasable()).toHaveLength(28);
    expect(pureInUpstream().filter((n) => !ON_SURFACE.has(`screen_${n}`)).sort()).toEqual([
      "circle",
      "text_center_rotate",
      "text_rotate",
    ]);
  });

  it("leaves `update` alone, because norns swaps it at runtime", () => {
    // `core/norns.lua:107` puts the low-battery overlay in `screen.update`
    // and `core/menu/settings.lua:29` puts it back. An alias here would be
    // racing them for the same field.
    expect(listedInOurs()).not.toContain("update");
    const nornsLua = fs.readFileSync(
      path.join(ROOT, "third_party", "norns", "lua", "core", "norns.lua"),
      "utf8",
    );
    expect(nornsLua).toContain("screen.update = screen.update_low_battery");
  });

  it("leaves `export_screenshot` alone, because it is not a pass-through", () => {
    // It looks like one and builds a path: `_norns.screen_export_screenshot(
    // norns.state.data..filename..'.png')`.
    expect(listedInOurs()).not.toContain("export_screenshot");
    expect(upstream).toContain("norns.state.data..filename..'.png'");
  });

  it("names only functions the surface actually has", () => {
    // A name on the list that `_norns` does not carry would be a nil
    // assignment — `screen.level = nil` — which is a blank screen and no
    // error. The Lua guards against it at run time; this is the same
    // question asked where it can be answered before anybody runs it.
    for (const name of listedInOurs()) {
      expect(ON_SURFACE.has(`screen_${name}`), `_norns.screen_${name} is not on the surface`)
        .toBe(true);
    }
  });
});
