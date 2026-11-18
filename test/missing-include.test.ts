// E9-109 — `tmi` would not load, and the page would not say why.
//
// Reported from a phone (user, 2026-11-18). Reproduced here on localhost by
// removing `kolor` from a tree that had `tmi` in it, which gives exactly the
// log that came off the phone:
//
//     ### MISSING INCLUDE: kolor/lib/lattice
//     ### SCRIPT ERROR: load fail
//     /home/we/dust/code/tmi/lib/tmi.lua:4: MISSING INCLUDE: kolor/lib/lattice
//
// `tmi/lib/tmi.lua:4` is `lattice=include("kolor/lib/lattice")`: tmi borrows
// a library from another CATALOGUE SCRIPT, and that script is not here.
// Nothing on screen said so.
//
// Two defects, and the second is why the first was easy to miss.

import { describe, expect, it } from "vitest";
import {
  MISSING_INCLUDE,
  SCRIPT_LOAD,
  readMissingInclude,
} from "../src/community/missing-include.js";
import { needsOf, sayNeeds } from "../src/community/needs.js";
import { Vfs } from "../src/fs/vfs.js";
import type { CatalogEntry } from "../src/community/catalog.js";

const entry = (name: string): CatalogEntry => ({
  name,
  author: "somebody",
  description: "",
  url: `https://github.com/somebody/${name}`,
  tags: [],
  discussion: null,
  documentation: null,
});

const write = (vfs: Vfs, path: string, body: string): void => {
  vfs.write(path, new TextEncoder().encode(body));
};

describe("the lines the page reads off its own log", () => {
  it("takes the path out of norns' own MISSING INCLUDE", () => {
    // Printed by `third_party/norns/lua/core/startup.lua:63`, verbatim.
    const m = MISSING_INCLUDE.exec("### MISSING INCLUDE: kolor/lib/lattice");
    expect(m?.[1]).toBe("kolor/lib/lattice");
    expect(MISSING_INCLUDE.exec("including /home/we/dust/code/tmi/lib/json.lua")).toBeNull();
  });

  it("takes the script out of a load line, space and all", () => {
    // `get in the sea!` is a real catalogue folder. A name split on `.`
    // or taken off the FILE would get this one wrong.
    const m = SCRIPT_LOAD.exec("# script load: /home/we/dust/code/get in the sea!/get_in_the_sea.lua");
    expect(m?.[1]).toBe("/home/we/dust/code/get in the sea!/get_in_the_sea.lua");
  });
});

describe("what a missing include means", () => {
  const nothingInstalled = (): boolean => false;
  const everythingInstalled = (): boolean => true;

  it("names the other script, which is the case that brought this in", () => {
    const v = readMissingInclude("kolor/lib/lattice", "tmi", nothingInstalled);
    expect(v.want).toBe("kolor");
    expect(v.installed).toBe(false);
    expect(v.line).toContain("tmi");
    expect(v.line).toContain("kolor");
    expect(v.line).toContain("not installed");
  });

  it("tells a part-finished install apart from an absent one", () => {
    // Same path, opposite cure: here `kolor` IS in `code/` and the FILE is
    // not in it, which an install cannot fix by being started again — it
    // has to replace the folder.
    const v = readMissingInclude("kolor/lib/lattice", "tmi", everythingInstalled);
    expect(v.want).toBe("kolor");
    expect(v.installed).toBe(true);
    expect(v.line).toContain("IS installed");
    expect(v.line).toContain("Reinstalling kolor");
  });

  it("does not send anybody to maiden for a file the script owns", () => {
    // `include("tmi/lib/missing")` from tmi is tmi's own file. Suggesting
    // an install of `tmi` from inside tmi would be nonsense, and a
    // suggestion to install `lib` would be worse.
    const own = readMissingInclude("tmi/lib/gone", "tmi", nothingInstalled);
    expect(own.want).toBeNull();
    expect(own.line).toContain("its own");

    const bare = readMissingInclude("lib/foo", null, nothingInstalled);
    expect(bare.want).toBe("lib");
    const noSlash = readMissingInclude("musicutil", null, nothingInstalled);
    expect(noSlash.want).toBeNull();
    expect(noSlash.line).toContain("not a library you can install");
  });

  it("works without knowing who asked", () => {
    const v = readMissingInclude("kolor/lib/lattice", null, nothingInstalled);
    expect(v.want).toBe("kolor");
    expect(v.line).toContain("this script");
  });
});

describe("an engine the page already has", () => {
  // THE SECOND DEFECT, and it is why the first was easy to skim past. From
  // the user's own log, a few lines above a list of nine engines with
  // PolyPerc among them:
  //
  //     maiden: tmi also needs kolor and the PolyPerc engine,
  //             which no catalogue script has
  //
  // Half true, half false. `enginesHere` was built by reading every `.sc`
  // under `~/dust/code` — where a SCRIPT's engine lives — and the engines
  // built into the page are not there: they are compiled into scsynth.
  const CATALOGUE = [entry("kolor"), entry("tmi")];

  const treeWithTmi = (): Vfs => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/tmi/tmi.lua", 'engine.name = "PolyPerc"\n');
    write(vfs, "/home/we/dust/code/tmi/lib/tmi.lua", 'lattice=include("kolor/lib/lattice")\n');
    return vfs;
  };

  it("was reported missing when nobody said what exists", () => {
    const needs = needsOf(treeWithTmi(), "tmi", CATALOGUE);
    expect(needs.map((n) => `${n.kind}:${n.want}`)).toEqual(["script:kolor", "engine:PolyPerc"]);
    expect(sayNeeds("tmi", needs)).toContain("PolyPerc");
  });

  it("is not reported once the server has said it is there", () => {
    const needs = needsOf(treeWithTmi(), "tmi", CATALOGUE, "/home/we/dust", [
      "PolyPerc",
      "PolySub",
      "None",
    ]);
    expect(needs.map((n) => `${n.kind}:${n.want}`)).toEqual(["script:kolor"]);
    // And the sentence that survives is the one that was urgent all along.
    expect(sayNeeds("tmi", needs)).toContain("kolor");
    expect(sayNeeds("tmi", needs)).not.toContain("PolyPerc");
  });

  it("still reports an engine nothing has, so this cannot hide one", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/x/x.lua", 'engine.name = "Nowhere"\n');
    const needs = needsOf(vfs, "x", CATALOGUE, "/home/we/dust", ["PolyPerc"]);
    expect(needs.map((n) => `${n.kind}:${n.want}`)).toEqual(["engine:Nowhere"]);
  });

  it("defaults to knowing nothing, which is what every caller used to pass", () => {
    const vfs = new Vfs();
    write(vfs, "/home/we/dust/code/x/x.lua", 'engine.name = "PolyPerc"\n');
    expect(needsOf(vfs, "x", CATALOGUE).map((n) => n.want)).toEqual(["PolyPerc"]);
  });
});
