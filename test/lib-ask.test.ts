// E9-70 — the two questions the library rule never asked.
//
// `tools/build-blockers.mjs` reported ten scripts as blocked on a library
// that is "not in the catalogue". All ten were measured in the page, with
// the library deliberately absent and then deliberately present, and all
// ten notes were wrong: eight of the scripts ran either way, and the two
// that did not failed for reasons that had nothing to do with the library.
//
// Two of the libraries are in the norns image. The other six sit behind a
// guard the script writes itself. This file feeds both rules the real
// lines, from the real repositories and against the real norns tree, so
// the rules are measured rather than asserted.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isGuarded, nornsAnswers, INCLUDE_ROOTS, REQUIRE_PREFIXES } from "../tools/lib-ask.mjs";

/** Every module name in norns' own Lua tree, as `nornsAnswers` wants it. */
const root = fileURLToPath(new URL("../third_party/norns/lua", import.meta.url));
const names = new Set(
  readdirSync(root, { recursive: true })
    .map((f) => String(f).split(sep).join("/"))
    .filter((f) => f.endsWith(".lua"))
    .map((f) => f.slice(0, -4)),
);
const has = (n: string): boolean => names.has(n);

describe("what norns itself answers", () => {
  it("has the two libraries that were reported missing", () => {
    // Both exist in the tree this build ships. If either moves upstream,
    // these fail here rather than coming back as a false note.
    expect(names.has("extn/sky/unstable"), "tambla: include('sky/unstable')").toBe(true);
    expect(names.has("lib/container/deque"), "phonotype: require('container/deque')").toBe(true);
  });

  it("answers tambla's include, because extn/ is on include's list", () => {
    expect(nornsAnswers("include", "sky/unstable", has)).toBe(true);
  });

  it("answers phonotype's require, because lua/lib is on package.path", () => {
    expect(nornsAnswers("require", "container/deque", has)).toBe(true);
  });

  it("does not pretend include can reach lua/lib, because it cannot", () => {
    // `core/startup.lua:53` searches the script's folder, ~/dust/code and
    // _path.extn — and nothing else. Reading lua/lib into `include` would
    // hide a script that really is about to fail.
    expect(nornsAnswers("include", "container/deque", has)).toBe(false);
    expect(INCLUDE_ROOTS).toEqual(["extn/"]);
  });

  it("says nothing about a library that really is somebody else's", () => {
    expect(nornsAnswers("require", "shnth/lib/shnth", has)).toBe(false);
    expect(nornsAnswers("include", "namesizer/lib/namesizer", has)).toBe(false);
    expect(nornsAnswers("require", "matrix/lib/matrix", has)).toBe(false);
  });

  it("mirrors config.lua's package.path, in its order", () => {
    expect(REQUIRE_PREFIXES).toEqual(["", "core/", "engine/", "core/params/", "lib/", "softcut/"]);
  });
});

describe("a guard the script writes itself", () => {
  it("counts lib/mod.lua, because a mod is required only when enabled", () => {
    // cyrene and fixed-filter-banking-crisis both ask from inside their
    // mod. `core/mods.lua` calls Mods.load_enabled, so a disabled mod is
    // never required — measured: both scripts run, no mod loads.
    expect(isGuarded("cyrene/lib/mod.lua", "local matrix = require('matrix/lib/matrix')", "matrix")).toBe(true);
    expect(isGuarded("fixed-filter-banking-crisis/lib/mod.lua", 'local fx = require("fx/lib/fx")', "fx")).toBe(true);
  });

  it("counts a script that asks the mod system first", () => {
    // sines.lua:197, verbatim.
    const src = ["  local ztuning", "  if _mods.is_enabled('z_tuning') then", "    z_tuning = require('z_tuning/lib/mod')", "  end"].join("\n");
    expect(isGuarded("sines/sines.lua", src, "z_tuning")).toBe(true);
  });

  it("counts a script that asks the filesystem first", () => {
    // cheat_codes_2.lua:31, verbatim.
    const src = ['if util.file_exists(_path.code.."namesizer") then', "  Namesizer = include 'namesizer/lib/namesizer'", "end"].join("\n");
    expect(isGuarded("cheat_codes_2/cheat_codes_2.lua", src, "namesizer")).toBe(true);
  });

  it("does NOT count a guard that names nothing", () => {
    // tetrabobo.lua:30 and gridstep.lua:56. Both are guards, and neither
    // says what it is guarding, so neither is evidence a rule may act on.
    // They are measured by hand in build-blockers.mjs instead.
    const bobo = ["sh = hid.connect(1)", "if sh.device then", '  shnth = include("shnth/lib/shnth")'].join("\n");
    expect(isGuarded("tetrabobo/tetrabobo.lua", bobo, "shnth")).toBe(false);
    const grid = ["_GRID_CAPTURE = false", "if _GRID_CAPTURE then", "    gcap = require 'GridCapture/GridCapture'", "end"].join("\n");
    expect(isGuarded("gridstep/gridstep.lua", grid, "gridcapture")).toBe(false);
  });

  it("does not take a mention for a guard", () => {
    // The head has to be named INSIDE the test, not merely nearby.
    const near = ["if util.file_exists(_path.code..\"something_else\") then", "  X = include 'namesizer/lib/namesizer'", "end"].join("\n");
    expect(isGuarded("x/x.lua", near, "namesizer")).toBe(false);
    expect(isGuarded("x/x.lua", "local m = require 'matrix/lib/matrix'", "matrix")).toBe(false);
  });

  it("is not fooled by a head that is not a plain name", () => {
    expect(isGuarded("x/x.lua", "file_exists('a.b')", "a.b")).toBe(false);
  });
});
