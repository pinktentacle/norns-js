// E9-247 — the SynthDef files sclang wrote reach the server before it is
// asked to load them (grains' cached defs).

import { describe, expect, it } from "vitest";
import { encodeMessage } from "../src/engine/osc.js";
import { defLoadOf, mirrorDefs, type DefFS } from "../src/engine/def-files.js";

const DIR = 0o040000;

/** A filesystem in a map: path -> bytes, folders implied. */
function memfs(files: Record<string, string> = {}): DefFS & { files: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>(Object.entries(files).map(([p, s]) => [p, new TextEncoder().encode(s)]));
  const dirs = (): Set<string> => {
    const d = new Set<string>(["/"]);
    for (const p of map.keys()) for (let i = p.indexOf("/", 1); i > 0; i = p.indexOf("/", i + 1)) d.add(p.slice(0, i));
    return d;
  };
  return {
    files: map,
    readdir: (path) => {
      const pre = path.replace(/\/$/, "") + "/";
      const names = new Set<string>();
      for (const p of [...map.keys(), ...dirs()]) if (p.startsWith(pre)) names.add(p.slice(pre.length).split("/")[0]!);
      if (names.size === 0 && !dirs().has(path)) throw new Error("ENOENT");
      return [".", "..", ...names];
    },
    stat: (path) => {
      if (map.has(path)) return { mode: 0o100644 };
      if (dirs().has(path.replace(/\/$/, ""))) return { mode: DIR };
      throw new Error("ENOENT");
    },
    isDir: (mode) => (mode & 0o170000) === DIR,
    readFile: (path) => {
      const b = map.get(path);
      if (!b) throw new Error("ENOENT");
      return b;
    },
    writeFile: (path, data) => void map.set(path, data),
    mkdirTree: () => {},
  };
}

const numbered = (command: number, args: Array<string | number>): Uint8Array => {
  const out = encodeMessage("", args) as Uint8Array;
  out[3] = command;
  return out;
};

describe("what asks the server to read a SynthDef file", () => {
  it("is /d_loadDir and /d_load, by name or by number", () => {
    expect(defLoadOf(encodeMessage("/d_loadDir", ["/home/we/dust/data/grains/defs/"]) as Uint8Array)).toEqual({
      kind: "dir",
      path: "/home/we/dust/data/grains/defs/",
    });
    expect(defLoadOf(encodeMessage("/d_load", ["/x/a.scsyndef"]) as Uint8Array)).toEqual({ kind: "file", path: "/x/a.scsyndef" });
    expect(defLoadOf(numbered(7, ["/x"]))).toEqual({ kind: "dir", path: "/x" });
    expect(defLoadOf(numbered(6, ["/x/*.scsyndef"]))).toEqual({ kind: "file", path: "/x/*.scsyndef" });
  });

  it("is nothing else", () => {
    for (const p of [
      encodeMessage("/d_recv", [new Uint8Array([1])]),
      encodeMessage("/d_free", ["x"]),
      encodeMessage("/d_loadx", ["/x"]),
      encodeMessage("/s_new", ["x", 1, 0, 1]),
      numbered(9, ["x", 1, 0, 1]),
      encodeMessage("/d_load", []),
    ]) {
      expect(defLoadOf(p as Uint8Array)).toBeNull();
    }
  });
});

describe("the files", () => {
  const lang = (): ReturnType<typeof memfs> =>
    memfs({
      "/home/we/dust/data/grains/defs/stamp": "s",
      "/home/we/dust/data/grains/defs/grainsmain.scsyndef": "A",
      "/home/we/dust/data/grains/defs/sub/grainstilt.scsyndef": "B",
      "/home/we/dust/data/other/x.scsyndef": "C",
    });

  it("of a folder go across, sub-folders too, and nothing that is not a def", () => {
    const server = memfs();
    expect(mirrorDefs(lang(), server, { kind: "dir", path: "/home/we/dust/data/grains/defs/" })).toBe(2);
    expect([...server.files.keys()].sort()).toEqual([
      "/home/we/dust/data/grains/defs/grainsmain.scsyndef",
      "/home/we/dust/data/grains/defs/sub/grainstilt.scsyndef",
    ]);
    expect(new TextDecoder().decode(server.files.get("/home/we/dust/data/grains/defs/grainsmain.scsyndef"))).toBe("A");
  });

  it("named, or matched by a pattern", () => {
    const one = memfs();
    expect(mirrorDefs(lang(), one, { kind: "file", path: "/home/we/dust/data/other/x.scsyndef" })).toBe(1);
    const glob = memfs();
    expect(mirrorDefs(lang(), glob, { kind: "file", path: "/home/we/dust/data/grains/defs/grains*.scsyndef" })).toBe(1);
  });

  it("that sclang does not have either: nothing, and the server says so itself", () => {
    expect(mirrorDefs(lang(), memfs(), { kind: "dir", path: "/nowhere/" })).toBe(0);
    expect(mirrorDefs(lang(), memfs(), { kind: "file", path: "/nowhere/x.scsyndef" })).toBe(0);
  });
});
