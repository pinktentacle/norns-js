// E1-03 / E1-04 — the surface and its return contracts.
//
// These assert against `src/api/surface.json`, which is DERIVED from
// `weaver.cc` by `tools/extract-api.mjs`. So a failure here means either our
// stub table is wrong or upstream changed — never that someone forgot to
// update a list by hand.

import { describe, expect, it } from "vitest";
import surface from "../src/api/surface.json" with { type: "json" };
import { STUBS, stubFor, stubReturns } from "../src/api/stubs.js";
import { checkStubArity, SURFACE } from "../src/norns/install.js";

describe("the _norns surface", () => {
  it("is 178 functions, which is 174 direct registrations plus 4 from a table literal", () => {
    expect(surface.counts).toEqual({ direct: 174, viaTable: 4, total: 178 });
    expect(SURFACE).toHaveLength(178);
  });

  it("has no duplicate names", () => {
    const names = SURFACE.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes the four image functions the old grep missed", () => {
    const names = SURFACE.map((f) => f.name);
    for (const n of [
      "screen_load_png",
      "screen_create_image",
      "screen_display_image",
      "screen_display_image_region",
    ]) {
      expect(names, `${n} must be present`).toContain(n);
    }
  });

  it("records arc_all_led as the alias it is", () => {
    const arc = SURFACE.find((f) => f.name === "arc_all_led");
    // `return _grid_all_led(l);` verbatim in weaver.cc. Implementing it twice
    // would be a bug; E5-12 says so too.
    expect(arc?.aliasOf).toBe("_grid_all_led");
  });
});

describe("stub return contracts", () => {
  it("every stub pushes a number of values the C could have pushed", () => {
    expect(checkStubArity()).toEqual([]);
  });

  it("the default is to push NOTHING, not 0", () => {
    // The rule the whole file exists for. `0` is truthy in Lua, so a generic
    // `return 0` made the P0 spike's norns believe it was factory hardware.
    const silent = SURFACE.filter((f) => f.returns.length === 1 && f.returns[0] === 0);
    expect(silent.length).toBeGreaterThan(140);
    for (const f of silent) {
      expect(stubReturns(stubFor(f.name)), `${f.name} must push nothing`).toEqual([]);
    }
  });

  it("platform_factory and platform_shield are boolean false, never 0", () => {
    for (const n of ["platform_factory", "platform_shield"]) {
      const v = stubReturns(stubFor(n));
      expect(v).toHaveLength(1);
      expect(v[0], `${n} must be a boolean`).toBe(false);
    }
  });

  it("clock_get_tempo is 120, not 0 — core/clock.lua divides by it", () => {
    expect(stubReturns(stubFor("clock_get_tempo"))).toEqual([120.0]);
  });

  it("system_glob reports GLOB_NOMATCH as a failure, (nil, 3), not an empty table", () => {
    expect(stubReturns(stubFor("system_glob"))).toEqual([null, 3]);
  });

  it("execute returns a string, never nil — util.scandir calls :gmatch on it", () => {
    const v = stubReturns(stubFor("execute"));
    expect(typeof v[0]).toBe("string");
  });

  it("get_time advances", async () => {
    const a = stubReturns(stubFor("get_time"));
    await new Promise((r) => setTimeout(r, 5));
    const b = stubReturns(stubFor("get_time"));
    expect(a).toHaveLength(2);
    const at = (a[0] as number) + (a[1] as number) / 1e6;
    const bt = (b[0] as number) + (b[1] as number) / 1e6;
    expect(bt).toBeGreaterThan(at);
  });

  it("every stub explains why it is not the default", () => {
    for (const [name, spec] of Object.entries(STUBS)) {
      expect(spec.why.length, `${name} needs a reason`).toBeGreaterThan(20);
    }
  });
});
