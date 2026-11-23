// E9-203 — a library asked for as the script's own file, and not shipped.
//
// `metronome.lua:24` is `require "metronome/lib/nb"`. Its repository has two
// files on every branch, README.md and metronome.lua: no `lib/`, so the
// script cannot start, here or on a norns. The library is real — sixolet/nb,
// which eight catalogue scripts carry as a submodule.
//
// E9-73 declined to fix this by copying `nb.lua` into the script's folder:
// that is writing a file into somebody's script that they did not ship. This
// does not. The library is installed beside the script, as itself, and the
// `require` is answered from there when nothing else has found it.

import { beforeEach, describe, expect, it } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";
import { Vfs } from "../src/fs/vfs.js";
import { needsOf, sayNeeds } from "../src/community/needs.js";
import { CARRIED } from "../src/community/off-catalogue.js";

const CODE = "/home/we/dust/code";
/** nb's own shape: it finds `player` from wherever IT is, not from who asked. */
const NB = [
  'local mydir = debug.getinfo(1).source:match("@?" .. _path.code .. "(.*/)")',
  'local player_lib = include(mydir .. "player")',
  "return { from = mydir, player = player_lib.name }",
].join("\n");
const PLAYER = 'return { name = "player" }';

describe("what the table says", () => {
  it("knows nb by the path metronome asks for it by", () => {
    expect(CARRIED.get("lib/nb")).toEqual({ library: "nb", module: "nb/lib/nb" });
  });
});

describe("what metronome needs", () => {
  it("names the library its repository does not carry", () => {
    const vfs = new Vfs();
    vfs.write(`${CODE}/metronome/metronome.lua`, 'nb = require "metronome/lib/nb"');
    const needs = needsOf(vfs, "metronome", []);
    expect(needs.map((n) => [n.kind, n.want, n.offCatalogue])).toEqual([["script", "nb", true]]);
    expect(needs[0]!.entry?.url).toBe("https://github.com/sixolet/nb");
    expect(sayNeeds("metronome", needs)).toBe("metronome also needs nb (github.com/sixolet/nb)");
  });

  it("says nothing to a script that does carry the file", () => {
    const vfs = new Vfs();
    vfs.write(`${CODE}/thing/thing.lua`, 'nb = require "thing/lib/nb"');
    vfs.write(`${CODE}/thing/lib/nb.lua`, "return {}");
    expect(needsOf(vfs, "thing", [])).toEqual([]);
  });

  it("says nothing once the library is installed", () => {
    const vfs = new Vfs();
    vfs.write(`${CODE}/metronome/metronome.lua`, 'nb = require "metronome/lib/nb"');
    vfs.write(`${CODE}/nb/lib/nb.lua`, NB);
    expect(needsOf(vfs, "metronome", [])).toEqual([]);
  });

  it("does not take every missing file of a script's own for a library", () => {
    const vfs = new Vfs();
    vfs.write(`${CODE}/thing/thing.lua`, 'x = require "thing/lib/helpers"');
    expect(needsOf(vfs, "thing", [])).toEqual([]);
  });
});

describe("answering the require, in norns' own Lua", () => {
  let host: Host;
  let vfs: Vfs;

  const out = (code: string): string => {
    const before = host.output.length;
    const err = host.run(code);
    if (err) return `ERROR: ${err}`;
    return host.output.slice(before).join("").trim();
  };

  beforeEach(() => {
    vfs = new Vfs();
    vfs.write(`${CODE}/metronome/metronome.lua`, 'nb = require "metronome/lib/nb"');
    host = createHost({ sources: loadNornsLua(), vfs });
    registerFs(host.registry, vfs);
    const err = boot(host, loadConfig());
    if (err) throw new Error(`boot failed at ${err.step}: ${err.error}`);
  });

  it("fails as it always did while the library is not installed", () => {
    expect(out('print(pcall(require, "metronome/lib/nb"))')).toMatch(/^false\s+module 'metronome\/lib\/nb' not found/);
  });

  it("answers from the installed library, which finds its own files from where it is", () => {
    vfs.write(`${CODE}/nb/lib/nb.lua`, NB);
    vfs.write(`${CODE}/nb/lib/player.lua`, PLAYER);
    const said = out('local nb = require "metronome/lib/nb" print(nb.from, nb.player)');
    expect(said).toContain("metronome/lib/nb is not in the script; answered by the installed nb/lib/nb");
    expect(said).toContain("nb/lib/\tplayer");
    // Nothing was written into the script's folder.
    expect(vfs.exists(`${CODE}/metronome/lib/nb.lua`)).toBe(false);
    expect(vfs.walk(`${CODE}/metronome`)).toEqual([`${CODE}/metronome/metronome.lua`]);
  });

  it("leaves a script's own copy alone", () => {
    vfs.write(`${CODE}/nb/lib/nb.lua`, NB);
    vfs.write(`${CODE}/nb/lib/player.lua`, PLAYER);
    vfs.write(`${CODE}/thing/lib/nb.lua`, 'return { from = "its own" }');
    expect(out('print(require("thing/lib/nb").from)')).toBe("its own");
  });

  it("does not answer for anything but the path in the table", () => {
    vfs.write(`${CODE}/nb/lib/nb.lua`, NB);
    expect(out('print(pcall(require, "metronome/lib/other"))')).toMatch(/^false\s+module 'metronome\/lib\/other' not found/);
  });
});
