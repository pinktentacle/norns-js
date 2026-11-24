// E6-08 — a tree leaving and coming back.
//
// The round trip through zip is already covered; what is tested here is the
// decisions on top of it: what goes into an export, what is refused on the
// way in, and where a GitHub zip ends up.

import { describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import {
  commonPrefix,
  exportTree,
  importSamples,
  importTree,
  installScript,
  safeJoin,
} from "../src/fs/transfer.js";
import { samplesFor, satisfied, standing } from "../src/community/verdicts.js";
import { zip } from "../src/fs/zip.js";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

function treeWithBaseAndEdits(): Vfs {
  const vfs = new Vfs();
  // Two files the BUILD supplies, as the dust loader mounts them.
  vfs.mountAll({
    "/home/we/dust/code/awake/awake.lua": () => text("-- bundled\n"),
    "/home/we/dust/code/awake/lib/x.lua": () => text("-- bundled lib\n"),
  });
  // and two the user made
  vfs.write("/home/we/dust/code/mine/mine.lua", text("-- written here\n"));
  vfs.write("/home/we/dust/data/awake/awake-01.pset", text('"alpha": 7\n'));
  return vfs;
}

describe("exporting", () => {
  it("takes what the user changed and leaves the bundled files behind", async () => {
    // The 690 bundled files arrive fresh from the build on every load, so an
    // archive of them is 5 MB of what the server already has.
    const vfs = treeWithBaseAndEdits();
    const r = await exportTree(vfs);
    const back = await importTree(new Vfs(), r.bytes);
    expect(r.files).toBe(2);
    expect(back.written).toBe(2);
  });

  it("takes everything when asked, bundled files included", async () => {
    const vfs = treeWithBaseAndEdits();
    const r = await exportTree(vfs, { everything: true });
    expect(r.files).toBe(4);
  });

  it("leaves out an asset that was merely DOWNLOADED, not changed", async () => {
    // Reading a lazily-fetched sound file caches its bytes into the same
    // overlay a written file lands in, so `dirty()` reports both. Measured
    // in the page: an export of "what you changed" came to 8.2 MB, of which
    // one amen sample was 9.7 MB uncompressed.
    const vfs = treeWithBaseAndEdits();
    vfs.mountRemoteAll({
      "/home/we/dust/audio/amen/break.wav": { url: "/dust-bin/break.wav", size: 1270628 },
    });
    // As `fetchRemote` would leave it: in the overlay, but downloaded.
    globalThis.fetch = (async () =>
      new Response(text("pretend this is a megabyte") as BodyInit)) as typeof fetch;
    await vfs.fetchRemote("/home/we/dust/audio/amen/break.wav");

    const r = await exportTree(vfs);
    expect(r.files).toBe(2);
    expect(r.skipped).toContain("/home/we/dust/audio/amen/break.wav");

    // ...but editing it makes it the user's, and then it travels.
    vfs.write("/home/we/dust/audio/amen/break.wav", text("I changed this"));
    const after = await exportTree(vfs);
    expect(after.files).toBe(3);
    expect(after.skipped).toEqual([]);
  });

  it("names the lazily-fetched assets rather than writing empty files for them", async () => {
    // A declared-but-not-downloaded sound file has no bytes here. A
    // zero-length entry for it would be a lie that imports successfully.
    const vfs = treeWithBaseAndEdits();
    vfs.mountRemoteAll({
      "/home/we/dust/audio/big.wav": { url: "/dust-bin/big.wav", size: 1024 },
    });
    const r = await exportTree(vfs, { everything: true });
    expect(r.skipped).toContain("/home/we/dust/audio/big.wav");
    expect(r.files).toBe(4);
  });

  it("round-trips the contents, not just the names", async () => {
    const vfs = treeWithBaseAndEdits();
    const r = await exportTree(vfs);
    const fresh = new Vfs();
    await importTree(fresh, r.bytes);
    expect(fresh.readText("/home/we/dust/code/mine/mine.lua")).toBe("-- written here\n");
    expect(fresh.readText("/home/we/dust/data/awake/awake-01.pset")).toBe('"alpha": 7\n');
  });
});

describe("importing an archive we did not make", () => {
  it("REFUSES a path that climbs out of the tree", async () => {
    // `../../etc/passwd` is a real entry name in real archives. A VFS is no
    // excuse for honouring it: the next thing to read that path is Lua.
    const archive = await zip([
      { path: "../../outside.lua", bytes: text("-- nope\n") },
      { path: "code/ok/ok.lua", bytes: text("-- fine\n") },
    ]);
    const vfs = new Vfs();
    const r = await importTree(vfs, archive);
    expect(r.written).toBe(1);
    expect(r.refused.map((x) => x.path)).toEqual(["../../outside.lua"]);
    expect(vfs.readText("/home/we/dust/code/ok/ok.lua")).toBe("-- fine\n");
    expect(vfs.exists("/outside.lua")).toBe(false);
    expect(vfs.exists("/home/outside.lua")).toBe(false);
  });

  it("refuses absolute paths and drive letters too", () => {
    expect(safeJoin("/home/we/dust", "/etc/passwd")).toBeNull();
    expect(safeJoin("/home/we/dust", "C:/windows/system32")).toBeNull();
    expect(safeJoin("/home/we/dust", "a/../../b")).toBeNull();
    expect(safeJoin("/home/we/dust", "")).toBeNull();
    expect(safeJoin("/home/we/dust", "./code/./x.lua")).toBe("/home/we/dust/code/x.lua");
    expect(safeJoin("/home/we/dust", "code\\win\\x.lua")).toBe("/home/we/dust/code/win/x.lua");
  });
});

describe("restore and add a script are not the same door", () => {
  // The gear used to call these `import` and `install` and say nothing
  // about the difference, and the hint under one of them advised using the
  // other: "download the zip yourself and use import". Follow that with a
  // GitHub zip and the script lands OUTSIDE code/, where SELECT never
  // looks, and it appears to have vanished. This is that advice, measured.
  const githubZip = async (): Promise<Uint8Array> =>
    zip([
      { path: "myscript-main/myscript.lua", bytes: text("-- the script") },
      { path: "myscript-main/lib/helper.lua", bytes: text("-- a lib") },
    ]);

  it("RESTORE keeps the zip's own paths, wrapper and all", async () => {
    const vfs = new Vfs();
    await importTree(vfs, await githubZip());
    expect(vfs.read("/home/we/dust/myscript-main/myscript.lua")).not.toBeNull();
    expect(
      vfs.read("/home/we/dust/code/myscript/myscript.lua"),
      "nothing under code/, so SELECT shows nothing",
    ).toBeNull();
  });

  it("ADD A SCRIPT strips the wrapper and rehomes it under code/", async () => {
    const vfs = new Vfs();
    const r = await installScript(vfs, await githubZip());
    expect(r.name).toBe("myscript");
    expect(vfs.read("/home/we/dust/code/myscript/myscript.lua")).not.toBeNull();
    expect(vfs.read("/home/we/dust/code/myscript/lib/helper.lua")).not.toBeNull();
    expect(vfs.read("/home/we/dust/myscript-main/myscript.lua")).toBeNull();
  });

  it("and the other way round: an EXPORT goes back through restore", async () => {
    // The inverse pairing, which is the reason restore exists at all.
    const made = treeWithBaseAndEdits();
    const out = await exportTree(made, { everything: false });
    const back = new Vfs();
    await importTree(back, out.bytes);
    expect(back.read("/home/we/dust/code/mine/mine.lua")).not.toBeNull();
    expect(back.read("/home/we/dust/data/awake/awake-01.pset")).not.toBeNull();
  });
});

describe("installing a script's archive", () => {
  it("strips the wrapper directory GitHub adds, and the ref from its name", async () => {
    // Nobody wants code/awake-main/awake-main/awake.lua.
    const archive = await zip([
      { path: "awake-main/awake.lua", bytes: text("-- awake\n") },
      { path: "awake-main/lib/thing.lua", bytes: text("-- lib\n") },
      { path: "awake-main/README.md", bytes: text("# awake\n") },
    ]);
    const vfs = new Vfs();
    const r = await installScript(vfs, archive);
    expect(r.name).toBe("awake");
    expect(r.files).toBe(3);
    expect(vfs.readText("/home/we/dust/code/awake/awake.lua")).toBe("-- awake\n");
    expect(vfs.readText("/home/we/dust/code/awake/lib/thing.lua")).toBe("-- lib\n");
  });

  it("takes the name it is given over the one in the archive", async () => {
    const archive = await zip([{ path: "repo-v1.2.3/a.lua", bytes: text("-- a\n") }]);
    const vfs = new Vfs();
    const r = await installScript(vfs, archive, { name: "chosen" });
    expect(r.name).toBe("chosen");
    expect(vfs.readText("/home/we/dust/code/chosen/a.lua")).toBe("-- a\n");
  });

  it("handles an archive with no wrapper directory", async () => {
    const archive = await zip([
      { path: "thing.lua", bytes: text("-- thing\n") },
      { path: "lib/more.lua", bytes: text("-- more\n") },
    ]);
    const vfs = new Vfs();
    const r = await installScript(vfs, archive, { name: "thing" });
    expect(vfs.readText("/home/we/dust/code/thing/thing.lua")).toBe("-- thing\n");
    expect(vfs.readText("/home/we/dust/code/thing/lib/more.lua")).toBe("-- more\n");
  });

  it("refuses to guess a name when there is nothing to guess from", async () => {
    const archive = await zip([{ path: "a.lua", bytes: text("-- a\n") }]);
    await expect(installScript(new Vfs(), archive)).rejects.toThrow(/no name/);
  });

  it("knows when entries share a directory and when they only look like it", () => {
    expect(commonPrefix(["a/x", "a/y/z"])).toBe("a");
    expect(commonPrefix(["a/x", "b/y"])).toBe("");
    expect(commonPrefix(["x"])).toBe("");
    expect(commonPrefix([])).toBe("");
  });
});

// E9-211 — moonraker was silent on the phone: its eight banks are a sample
// pack its README has you `unzip` in ~/dust/audio, from a release a page
// may not fetch. The person downloads it; this is the unzip.
describe("a sample pack, added by hand", () => {
  // The real pack's names, as its central directory gives them: a double
  // slash after the folder, 960 WAVs in eight numbered folders.
  const pack = async (): Promise<Uint8Array> =>
    zip([
      { path: "moonraker/", bytes: new Uint8Array(0) },
      { path: "moonraker//1/001_moonraker.wav", bytes: text("RIFF-one") },
      { path: "moonraker//8/112_moonraker.wav", bytes: text("RIFF-two") },
      { path: "__MACOSX/moonraker/._001_moonraker.wav", bytes: text("resource fork") },
      { path: "moonraker/.DS_Store", bytes: text("finder") },
      { path: "../escape.wav", bytes: text("no") },
    ]);

  it("lands where the README unzips it, folders and all", async () => {
    const vfs = new Vfs();
    const r = await importSamples(vfs, await pack());
    expect(r.written).toBe(2);
    expect(r.folders).toEqual(["moonraker"]);
    expect(r.bytes).toBe(16);
    expect(vfs.readText("/home/we/dust/audio/moonraker/1/001_moonraker.wav")).toBe("RIFF-one");
    expect(vfs.readText("/home/we/dust/audio/moonraker/8/112_moonraker.wav")).toBe("RIFF-two");
    // The folder the script scans has exactly what it should.
    expect(vfs.list("/home/we/dust/audio/moonraker/1").map((e) => e.name)).toEqual(["001_moonraker.wav"]);
  });

  it("leaves out what a Mac adds, and refuses a path that climbs out", async () => {
    const vfs = new Vfs();
    const r = await importSamples(vfs, await pack());
    expect(vfs.exists("/home/we/dust/audio/__MACOSX/moonraker/._001_moonraker.wav")).toBe(false);
    expect(vfs.exists("/home/we/dust/audio/moonraker/.DS_Store")).toBe(false);
    expect(r.refused.map((x) => x.path)).toEqual(["../escape.wav"]);
    expect(vfs.exists("/home/we/dust/escape.wav")).toBe(false);
  });

  it("is what moonraker's standing waits for, and nothing else", async () => {
    const notes = ["its samples are a 95 MB GitHub release"];
    const vfs = new Vfs();
    const has = (path: string): boolean => vfs.walk(`/home/we/dust/${path}`).length > 0;
    const before = standing("moonraker", notes, has)!;
    expect([before.verdict, before.label, before.veiled]).toEqual(["needs", "needs its samples", false]);
    expect(before.samples).toEqual(samplesFor("moonraker"));
    expect(before.samples?.url).toBe("https://github.com/schollz/moonraker/releases/download/samplepack1/moonraker.zip");
    expect(satisfied("moonraker", has)).toBe(false);
    await importSamples(vfs, await pack());
    expect(satisfied("moonraker", has)).toBe(true);
    expect(standing("moonraker", notes, has)).toBeNull();
    // A script with no pack to bring is not put right by any folder.
    expect(satisfied("tulpamancer", () => true)).toBe(false);
    expect(standing("tulpamancer", ["reads nyse.com"], () => true)?.verdict).toBe("no");
  });
});
