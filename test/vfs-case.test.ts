// E9-55 — the script folder, spelled the way the script spells it.
//
// The installer names a script's folder after its catalogue entry, folded
// to lower case. A script that builds its own paths out of something
// capitalised then misses by case alone, and it misses through every door
// at once:
//
//     Ygg.lua:36    local CODE_DIR = _path.code .. engine.name .. "/"
//     Ygg.lua:1172  tree = screen.load_png(CODE_DIR .. "img/tree.png")
//                   assert(tree, "tree.png failed to load")
//
// The engine is `Ygg`, the folder is `ygg`, and `init` asserted its way out
// on a file that was right there. E9-27 answered the same mismatch for
// `include` alone; this is the same answer, one layer down, where `io.open`
// and `util.scandir` reach it too.
//
// A LAST RESORT, and only ever that: the exact path is tried first, only
// the first segment under `~/dust/code` is folded, and an ambiguous pair of
// folders differing only by case is left alone.

import { describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";

const CODE = "/home/we/dust/code";

const withYgg = (): Vfs => {
  const vfs = new Vfs();
  vfs.write(`${CODE}/ygg/Ygg.lua`, "-- the script");
  vfs.write(`${CODE}/ygg/img/tree.png`, "PNG");
  vfs.write(`${CODE}/ygg/Demo/1.pset`, "a pset");
  return vfs;
};

describe("reading a script's own folder through the other spelling", () => {
  it("reads a file the script asks for in capitals", () => {
    const vfs = withYgg();
    expect(vfs.readText(`${CODE}/Ygg/img/tree.png`)).toBe("PNG");
    expect(vfs.exists(`${CODE}/Ygg/img/tree.png`)).toBe(true);
  });

  it("lists and walks it too, which is util.scandir", () => {
    const vfs = withYgg();
    expect(vfs.list(`${CODE}/Ygg/Demo`).map((e) => e.name)).toEqual(["1.pset"]);
    expect(vfs.walk(`${CODE}/Ygg`)).toContain(`${CODE}/ygg/img/tree.png`);
    expect(vfs.isDir(`${CODE}/Ygg/img`)).toBe(true);
  });

  it("reads back exactly what it wrote, through the spelling it wrote", () => {
    // A write is NOT folded — it creates what it names, which is the only
    // way the installer can ever make a folder that differs by case. The
    // script is not split by that, because its own read of its own path is
    // exact and never reaches the fold.
    const vfs = withYgg();
    vfs.write(`${CODE}/Ygg/patches.txt`, "mine");
    expect(vfs.readText(`${CODE}/Ygg/patches.txt`)).toBe("mine");
    expect(vfs.read(`${CODE}/ygg/patches.txt`), "it went where it said").toBeNull();
  });

  it("takes the exact spelling first when both exist", () => {
    const vfs = withYgg();
    vfs.write(`${CODE}/Ygg/Ygg.lua`, "the capitalised one");
    expect(vfs.readText(`${CODE}/Ygg/Ygg.lua`)).toBe("the capitalised one");
    expect(vfs.readText(`${CODE}/ygg/Ygg.lua`)).toBe("-- the script");
  });

  it("refuses to choose between two folders that differ only by case", () => {
    const vfs = new Vfs();
    vfs.write(`${CODE}/thing/a.lua`, "lower");
    vfs.write(`${CODE}/Thing/a.lua`, "upper");
    // Both exist, so each exact path answers for itself and nothing folds.
    expect(vfs.readText(`${CODE}/thing/a.lua`)).toBe("lower");
    expect(vfs.readText(`${CODE}/Thing/a.lua`)).toBe("upper");
    // A third spelling matches two folders, and is not guessed at.
    expect(vfs.read(`${CODE}/THING/a.lua`)).toBeNull();
  });

  it("is a miss when the file is simply not there", () => {
    const vfs = withYgg();
    expect(vfs.read(`${CODE}/Ygg/img/nothing.png`)).toBeNull();
    expect(vfs.read(`${CODE}/Nope/thing.lua`)).toBeNull();
    expect(vfs.exists(`${CODE}/Nope/thing.lua`)).toBe(false);
  });

  it("leaves everything outside ~/dust/code alone", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/audio/kit/a.wav", "x");
    expect(vfs.read("/home/we/dust/audio/Kit/a.wav")).toBeNull();
  });
});
