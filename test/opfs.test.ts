// E6-01 / E5-09 — the overlay survives a reload.
//
// The fake below is an in-memory OPFS, not a stub: it has real directories,
// a real `entries()` and a `createWritable` that truncates. That matters
// because the bugs this code can have are about the SHAPE of the store — a
// rewritten file keeping its old tail, a deletion that does not reach the
// disk, a restore that copies everything straight back out — and a stub that
// records calls would catch none of them.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Vfs, seedDust } from "../src/fs/vfs.js";
import {
  restoreFromOpfs,
  mirrorToOpfs,
  type DirHandleLike,
  type FileHandleLike,
} from "../src/fs/opfs.js";

// ---------------------------------------------------------------- the fake

class FakeFile implements FileHandleLike {
  constructor(public data: Uint8Array = new Uint8Array()) {}
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    const d = this.data;
    return Promise.resolve({
      arrayBuffer: () => Promise.resolve(d.slice().buffer as ArrayBuffer),
    });
  }
  createWritable(): Promise<{ write(d: Uint8Array): Promise<void>; close(): Promise<void> }> {
    // A fresh writable truncates — the whole point of the test below.
    this.data = new Uint8Array();
    return Promise.resolve({
      write: (d: Uint8Array) => {
        this.data = new Uint8Array(d);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    });
  }
}

class FakeDir implements DirHandleLike {
  readonly children = new Map<string, FakeDir | FakeFile>();
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike> {
    const got = this.children.get(name);
    if (got instanceof FakeDir) return Promise.resolve(got);
    if (got !== undefined) return Promise.reject(new Error(`${name} is a file`));
    if (opts?.create !== true) return Promise.reject(new Error(`no ${name}`));
    const d = new FakeDir();
    this.children.set(name, d);
    return Promise.resolve(d);
  }
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike> {
    const got = this.children.get(name);
    if (got instanceof FakeFile) return Promise.resolve(got);
    if (got !== undefined) return Promise.reject(new Error(`${name} is a directory`));
    if (opts?.create !== true) return Promise.reject(new Error(`no ${name}`));
    const f = new FakeFile();
    this.children.set(name, f);
    return Promise.resolve(f);
  }
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const got = this.children.get(name);
    if (got === undefined) return Promise.reject(new Error(`no ${name}`));
    // As OPFS does: without `recursive`, a directory with anything in it
    // refuses. E9-56's prune leans on that refusal as its stop condition,
    // so a fake that deletes anyway could not show the difference.
    if (got instanceof FakeDir && got.children.size > 0 && opts?.recursive !== true) {
      return Promise.reject(new Error(`${name} is not empty`));
    }
    this.children.delete(name);
    return Promise.resolve();
  }
  async *entries(): AsyncIterableIterator<[string, DirHandleLike | FileHandleLike]> {
    for (const [k, v] of [...this.children]) yield [k, v];
  }
}

function store() {
  const root = new FakeDir();
  return { root, open: () => Promise.resolve(root as DirHandleLike) };
}

const text = (v: Uint8Array | null): string | null =>
  v === null ? null : new TextDecoder().decode(v);

describe("the mirror", () => {
  it("writes what the overlay wrote, and nothing the base supplied", async () => {
    const s = store();
    const vfs = new Vfs();
    vfs.mount("/home/we/dust/code/awake/awake.lua", () => "-- base, from the build");
    const m = mirrorToOpfs(vfs, { root: s.open, debounceMs: 0 });

    vfs.write("/home/we/dust/data/awake/awake-01.pset", "hello");
    await m.flush();

    // The pset is there...
    const dust = await s.root.getDirectoryHandle("norns-dust");
    const walk = async (d: DirHandleLike, at = ""): Promise<string[]> => {
      const out: string[] = [];
      for await (const [name, h] of d.entries()) {
        if ((h as FakeFile).getFile !== undefined) out.push(`${at}/${name}`);
        else out.push(...(await walk(h as DirHandleLike, `${at}/${name}`)));
      }
      return out;
    };
    const paths = await walk(dust);
    expect(paths).toContain("/home/we/dust/data/awake/awake-01.pset");
    // ...and the 690-file base is NOT.
    expect(paths.some((p) => p.includes("awake.lua"))).toBe(false);
    m.stop();
  });

  it("truncates, so a shorter rewrite does not keep the old tail", async () => {
    const s = store();
    const vfs = new Vfs();
    const m = mirrorToOpfs(vfs, { root: s.open, debounceMs: 0 });
    vfs.write("/a.txt", "a very long first version");
    await m.flush();
    vfs.write("/a.txt", "short");
    await m.flush();

    const vfs2 = new Vfs();
    await restoreFromOpfs(vfs2, { root: s.open });
    expect(text(vfs2.read("/a.txt"))).toBe("short");
    m.stop();
  });

  it("coalesces a burst into one write per path", async () => {
    const s = store();
    const vfs = new Vfs();
    const m = mirrorToOpfs(vfs, { root: s.open, debounceMs: 5 });
    for (let i = 0; i < 50; i++) vfs.write("/busy.txt", `v${i}`);
    await m.flush();
    expect(m.stats.writes).toBe(1);
    m.stop();
  });
});

describe("the round trip", () => {
  it("brings a file back after a reload", async () => {
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    a.write("/home/we/dust/data/system.state", "norns.state.clock.tempo = 140");
    await m.flush();
    m.stop();

    // A reload: a brand new Vfs, the same store.
    const b = new Vfs();
    const r = await restoreFromOpfs(b, { root: s.open });
    expect(r.files).toBe(1);
    expect(text(b.read("/home/we/dust/data/system.state"))).toBe(
      "norns.state.clock.tempo = 140",
    );
  });

  it("KEEPS A DELETION. A removed base file must not come back", async () => {
    const s = store();
    const base = (v: Vfs) => v.mount("/home/we/dust/code/doomed.lua", () => "-- bundled");
    const a = new Vfs();
    base(a);
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    expect(a.exists("/home/we/dust/code/doomed.lua")).toBe(true);
    a.remove("/home/we/dust/code/doomed.lua");
    await m.flush();
    m.stop();

    // The base is supplied fresh on every load, so without a tombstone the
    // file is simply back.
    const b = new Vfs();
    base(b);
    const r = await restoreFromOpfs(b, { root: s.open });
    expect(r.tombstones).toBe(1);
    expect(b.exists("/home/we/dust/code/doomed.lua")).toBe(false);
  });

  it("keeps an empty directory, which util.make_dir creates before any write", async () => {
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    a.mkdir("/home/we/dust/data/newscript");
    await m.flush();
    m.stop();

    const b = new Vfs();
    await restoreFromOpfs(b, { root: s.open });
    expect(b.isDir("/home/we/dust/data/newscript")).toBe(true);
  });

  // E9-56 — a user asked why maiden offered `terrarium` as installed while
  // SELECT had nothing to choose. The folder was there and empty: deleting
  // a script's files left its directory in OPFS, the restore turns every
  // OPFS directory into a `vfs.mkdir`, and maiden's installed list is
  // directories. 281 of 329 folders were in that state.
  it("takes the folder away with the last file in it", async () => {
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    a.write("/home/we/dust/code/terrarium/terrarium.lua", "-- script");
    a.write("/home/we/dust/code/terrarium/lib/brain.lua", "-- lib");
    await m.flush();
    for (const p of a.walk("/home/we/dust/code/terrarium")) a.remove(p);
    await m.flush();
    m.stop();

    const b = new Vfs();
    await restoreFromOpfs(b, { root: s.open });
    expect(b.isDir("/home/we/dust/code/terrarium"), "no phantom script").toBe(false);
    expect(b.list("/home/we/dust/code").map((e) => e.name)).toEqual([]);
  });

  it("stops at a folder that still has something in it", async () => {
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    a.write("/home/we/dust/code/thing/thing.lua", "-- script");
    a.write("/home/we/dust/code/thing/lib/one.lua", "-- one");
    a.write("/home/we/dust/code/thing/lib/two.lua", "-- two");
    await m.flush();
    a.remove("/home/we/dust/code/thing/lib/one.lua");
    await m.flush();
    m.stop();

    const b = new Vfs();
    await restoreFromOpfs(b, { root: s.open });
    expect(b.readText("/home/we/dust/code/thing/lib/two.lua")).toBe("-- two");
    expect(b.readText("/home/we/dust/code/thing/thing.lua")).toBe("-- script");
  });

  it("leaves a script's own data folder alone when its last pset goes", async () => {
    // Only `~/dust/code` is pruned. A folder under `~/dust/data` belongs to
    // a script — `util.make_dir` on first run is how it appears — and an
    // empty one there is not pretending to be anything.
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    a.mkdir("/home/we/dust/data/thing");
    a.write("/home/we/dust/data/thing/one.pset", "a pset");
    await m.flush();
    a.remove("/home/we/dust/data/thing/one.pset");
    await m.flush();
    m.stop();

    const b = new Vfs();
    await restoreFromOpfs(b, { root: s.open });
    expect(b.isDir("/home/we/dust/data/thing")).toBe(true);
  });

  it("does not copy the restored tree straight back out", async () => {
    // `restore` bypasses the watchers on purpose. Without that, every boot
    // rewrites everything it just read.
    const s = store();
    const a = new Vfs();
    const m1 = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    for (let i = 0; i < 5; i++) a.write(`/f${i}.txt`, `x${i}`);
    await m1.flush();
    m1.stop();

    const b = new Vfs();
    await restoreFromOpfs(b, { root: s.open });
    const m2 = mirrorToOpfs(b, { root: s.open, debounceMs: 0 });
    await m2.flush();
    expect(m2.stats.writes).toBe(0);
    m2.stop();
  });

  it("is a first run, not an error, when there is nothing stored", async () => {
    const s = store();
    const vfs = new Vfs();
    const r = await restoreFromOpfs(vfs, { root: s.open });
    expect(r).toEqual({
      files: 0,
      tombstones: 0,
      placeholders: 0,
      references: 0,
      bytes: 0,
      ghosts: 0,
      dropped: [],
    });
  });

  it("carries on with no OPFS at all", async () => {
    const vfs = new Vfs();
    const lines: string[] = [];
    const root = () => Promise.reject(new Error("no OPFS in this browser"));
    const r = await restoreFromOpfs(vfs, { root, log: (l) => lines.push(l) });
    expect(r.files).toBe(0);
    expect(lines[0]).toContain("unavailable");

    const m = mirrorToOpfs(vfs, { root, debounceMs: 0, log: (l) => lines.push(l) });
    vfs.write("/a.txt", "still works in memory");
    await m.flush();
    expect(text(vfs.read("/a.txt"))).toBe("still works in memory");
    m.stop();
  });
});

describe("a copied reference survives a reload", () => {
  // THE BUG THIS CLOSES, from the outside: `beets` copies its demo loops
  // into ~/dust/audio on its first run and plays them. Next session the
  // folder is there, the names are there, and they read as nothing — and
  // beets never repairs it, because it only copies `if util.file_exists
  // (dir) == false`. A script that worked once is broken for ever.
  //
  // The copy is BY REFERENCE on purpose: the loops are fetched the first
  // time they are played, so copying them means copying the declaration,
  // not pulling megabytes through a shell for a copy nobody may read.
  // Which is why the mirror has to keep declarations as well as bytes.
  const demo = { url: "/dust-bin/beets/demo/0.wav", size: 1234 };

  it("comes back, still lazy, and still reaching the same place", async () => {
    const s = store();
    const made = new Vfs();
    made.mountRemote("/home/we/dust/code/beets/demo/0.wav", demo);
    const mirror = mirrorToOpfs(made, { root: s.open, debounceMs: 0 });
    made.copyRemote("/home/we/dust/audio/beets/0.wav", demo);
    await mirror.flush();

    const back = new Vfs();
    // The build declares its own files before a restore runs.
    back.mountRemote("/home/we/dust/code/beets/demo/0.wav", demo);
    const r = await restoreFromOpfs(back, { root: s.open });
    expect(r.references).toBe(1);
    expect(back.remoteAt("/home/we/dust/audio/beets/0.wav")).toEqual(demo);
    expect(back.read("/home/we/dust/audio/beets/0.wav"), "still lazy").toBeNull();
  });

  it("is DROPPED when this version no longer supplies it, and says so", async () => {
    // A stored reference aims at a url the build serves. Update norns-js
    // with a different dust tree and it aims at nothing — restoring it
    // would trade "file absent" for "file fails at the moment you press
    // play", which is worse.
    const s = store();
    const made = new Vfs();
    made.mountRemote("/home/we/dust/code/old/0.wav", demo);
    const mirror = mirrorToOpfs(made, { root: s.open, debounceMs: 0 });
    made.copyRemote("/home/we/dust/audio/old/0.wav", demo);
    await mirror.flush();

    const back = new Vfs();
    const said: string[] = [];
    const r = await restoreFromOpfs(back, { root: s.open, log: (l) => void said.push(l) });
    expect(r.references).toBe(0);
    expect(back.remoteAt("/home/we/dust/audio/old/0.wav")).toBeNull();
    expect(said.some((l) => l.includes("no longer supplies"))).toBe(true);
  });

  it("stops being a reference once its bytes have arrived", async () => {
    const made = new Vfs();
    made.copyRemote("/home/we/dust/audio/x.wav", demo);
    expect(made.references()).toHaveLength(1);
    made.write("/home/we/dust/audio/x.wav", new Uint8Array([1, 2, 3]));
    expect(made.references(), "an ordinary file now").toHaveLength(0);
  });
});

describe("what norns actually does with it", () => {
  it("brings back the grid vport binding across a reload (E5-09)", async () => {
    // `core/state.lua:163` writes `grid.vports[i].name` into system.state,
    // and `state.resume` dofiles it at startup. The only thing missing was
    // that the file did not survive.
    const s = store();
    const a = new Vfs();
    seedDust(a);
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    a.write(
      "/home/we/dust/data/system.state",
      "grid.vports[1].name = 'virtual grid v0001'\nmidi.vports[1].name = 'virtual midi loopback'\n",
    );
    await m.flush();
    m.stop();

    const b = new Vfs();
    seedDust(b);
    await restoreFromOpfs(b, { root: s.open });
    expect(text(b.read("/home/we/dust/data/system.state"))).toContain("virtual grid v0001");
  });
});

// E9-65 — the phantom script folders, and why they were for ever.
//
// A whole dust tree went missing twice in one session and what was left
// behind was a directory per script with nothing in it. maiden listed
// every one as installed (E9-56 asked for a file instead), and they came
// back on every boot: an empty directory is written to the placeholder
// sidecar, the sidecar is restored with `mkdir`, and `mkdir` puts it back
// into the sidecar. Thirty-four of them were on this disk.
//
// An empty directory is worth keeping almost everywhere — `util.make_dir`
// is how a script claims `~/dust/data/<name>` on its first run. Under
// `~/dust/code` nothing creates a folder except an install, and an install
// puts files in it.
describe("an empty script folder", () => {
  it("is not restored, and does not come back on the next boot either", async () => {
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    a.mkdir("/home/we/dust/code/ghost");
    a.mkdir("/home/we/dust/data/ghost");
    a.write("/home/we/dust/code/real/real.lua", "-- a script");
    await m.flush();
    m.stop();

    const b = new Vfs();
    const r = await restoreFromOpfs(b, { root: s.open });
    expect(b.isDir("/home/we/dust/code/ghost"), "the phantom is dropped").toBe(false);
    expect(b.isDir("/home/we/dust/data/ghost"), "a script's data folder is not").toBe(true);
    expect(b.readText("/home/we/dust/code/real/real.lua")).toBe("-- a script");
    expect(r.ghosts, "one dropped, and it is counted").toBe(1);

    // And the second boot: the sidecar must not have been written back
    // with the phantom still in it.
    const m2 = mirrorToOpfs(b, { root: s.open, debounceMs: 0 });
    b.write("/home/we/dust/data/ghost/anything.txt", "x");
    await m2.flush();
    m2.stop();
    const c = new Vfs();
    await restoreFromOpfs(c, { root: s.open });
    expect(c.isDir("/home/we/dust/code/ghost")).toBe(false);
  });

  it("keeps a code folder that still has a file in it", async () => {
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    a.write("/home/we/dust/code/keep/lib/thing.lua", "-- lib");
    await m.flush();
    m.stop();

    const b = new Vfs();
    await restoreFromOpfs(b, { root: s.open });
    expect(b.isDir("/home/we/dust/code/keep")).toBe(true);
    expect(b.readText("/home/we/dust/code/keep/lib/thing.lua")).toBe("-- lib");
  });
});

// E9-137 — the two numbers that decide whether an install survives.
//
// Reported from a Pixel (user, 2026-11-19): `tmi` fails to load there and
// not here. A fresh-profile install of it was clean on this machine — but
// `tmi` is fifteen files that pull `kolor` behind them, and `kolor` is 446
// files and 58.7 MB. The quota is a share of the DEVICE's free space, so
// what is 12520 MB here can be a fraction of that on a full phone, and
// the page never said either number.
//
// The second number is the quieter one. An origin that has not called
// `navigator.storage.persist()` is BEST-EFFORT: the browser may evict it
// under storage pressure, and Android does. That is a script collection
// gone between two sessions with nothing said.
//
// `main.ts` needs a DOM and an AudioWorklet, so this reads it the way
// `rail-panels.test.ts` reads the rail.
describe("the storage line", () => {
  const raw = fs.readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");
  // Comments out, code in. The first run of the test below failed on the
  // comment that EXPLAINS why persistence is not requested, which quotes
  // the call it is explaining. Same trap as `catalogue-complete.test.ts`.
  const main = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");

  it("reports what is used, what is allowed, and whether it is kept", () => {
    expect(main, "storage is not estimated at boot").toMatch(/navigator\.storage\?\.estimate\?\.\(\)/);
    expect(main, "durability is not reported").toMatch(/navigator\.storage\?\.persisted\?\.\(\)/);
    const line = /log\(\s*`storage: [\s\S]{0,400}?\);/.exec(main);
    expect(line, "the storage line has gone").not.toBeNull();
    expect(line![0]).toContain("used of");
    expect(line![0]).toContain("best-effort");
  });

  // A DECISION, NOT AN OMISSION. Firefox prompts for persistent storage,
  // and a permission dialogue on page load is not this page's to spend.
  // If that is ever reconsidered it should be on a deliberate act — a
  // first install — and not here.
  it("does not ask for persistence on the way in", () => {
    expect(main, "persist() is being requested at boot").not.toMatch(/storage\??\.?\.persist\s*\(/);
  });

  it("survives a browser with no Storage API rather than failing the boot", () => {
    const at = main.indexOf("const est = await navigator.storage?.estimate?.()");
    expect(at).toBeGreaterThan(-1);
    expect(main.lastIndexOf("try {", at), "the estimate is not guarded").toBeGreaterThan(-1);
    expect(main.slice(at, at + 900)).toMatch(/\}\s*catch\s*\{/);
  });
});

// E9-142 — the reset button, and the three things it must do in order.
//
// Asked for in the settings and scoped to scripts alone (user,
// 2026-11-19). The logic sits inline in `main.ts`, which wants a DOM and
// an AudioWorklet, so it is read the way `rail-panels.test.ts` reads the
// rail. Proven once in a browser: 813 files under `code/` before, 705
// after, `opfs: restored 1 file(s), 2.9 KB, 108 deletion(s)` on the way
// back up, and `kolor` and `tmi` gone while the 35 the build ships
// returned.
describe("resetting the scripts", () => {
  const raw = fs.readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");
  const body = (): string => {
    const at = raw.indexOf("resetScripts: async () => {");
    expect(at, "resetScripts has gone").toBeGreaterThan(-1);
    return raw.slice(at, raw.indexOf("\n      },", at));
  };

  // `revert` answers only for a path the BUILD supplies, so the pair is
  // what makes this a reset rather than a delete: bundled scripts come
  // back as the build has them, installed ones cease to exist.
  it("reverts what the build ships and removes what it does not", () => {
    expect(body()).toMatch(/if\s*\(\s*!vfs\.revert\(p\)\s*\)\s*vfs\.remove\(p\)/);
  });

  it("takes the half-finished downloads too", () => {
    expect(body()).toContain(".installing");
  });

  // THE ONE THAT WOULD BE SILENT. Removals only queue; the mirror is
  // debounced. A reset that reloaded first would come back with the
  // scripts still there — E9-135 and E9-140 were both exactly that.
  it("flushes before it restarts, or the reset does not survive the reload", () => {
    const b = body();
    const flush = b.indexOf("mirror.flush()");
    const restart = b.indexOf("doRestart()");
    expect(flush, "the mirror is not flushed").toBeGreaterThan(-1);
    expect(restart, "it does not restart").toBeGreaterThan(-1);
    expect(flush, "it restarts before the removals reach the disk").toBeLessThan(restart);
  });
});

// E9-143 — the other two buttons, and the one that must NOT flush.
describe("the other two resets", () => {
  const raw = fs.readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");
  const bodyOf = (name: string): string => {
    const at = raw.indexOf(`${name}: async () => {`);
    expect(at, `${name} has gone`).toBeGreaterThan(-1);
    return raw.slice(at, raw.indexOf("\n      },", at));
  };

  // `system.state` and `system.pset` live in the same directory and are
  // not a script's: they hold the clock tempo, the mixer and the devices.
  it("spares the system's own files when it empties ~/dust/data", () => {
    const b = bodyOf("resetParams");
    expect(b).toContain("/home/we/dust/data");
    expect(b, "system.state would go with the presets").toMatch(/keep\s*=\s*\/\^system/);
    expect(b).toMatch(/if\s*\(keep\.test/);
  });

  it("flushes the removals before it restarts", () => {
    const b = bodyOf("resetParams");
    expect(b.indexOf("mirror.flush()")).toBeGreaterThan(-1);
    expect(b.indexOf("mirror.flush()")).toBeLessThan(b.indexOf("doRestart()"));
  });

  // THE INVERSION, AND IT IS THE WHOLE CARE IN THAT FUNCTION. Every other
  // reset flushes so its removals survive. This one must not: the overlay
  // still holds everything, and flushing would write it straight back
  // into the directory just erased.
  it("stops the mirror and does NOT flush it", () => {
    const b = bodyOf("factoryReset");
    expect(b).toContain("mirror.stop()");
    expect(b, "flushing here writes the whole overlay back").not.toContain("mirror.flush()");
    expect(b.indexOf("mirror.stop()")).toBeLessThan(b.indexOf("wipeOpfs()"));
  });

  it("reloads rather than restarting, so nothing saves state on the way out", () => {
    const b = bodyOf("factoryReset");
    expect(b).toMatch(/location\?\.reload\(\)/);
    expect(b, "_norns.restart saves system.state as it goes").not.toContain("doRestart()");
  });
});

// E9-216 — every file gone, every folder kept.
//
// Found on this machine for the third time: each script folder in OPFS
// present and empty, `~/dust/data` emptied of every pset, `system.pset`
// gone, and every directory still standing. Nothing in the mirror could
// say what had happened. These are the ways the mirror itself could do
// that, each shown on the fake before it was fixed.
describe("what the mirror removes", () => {
  const filesUnder = async (d: DirHandleLike, at = ""): Promise<string[]> => {
    const out: string[] = [];
    for await (const [name, h] of d.entries()) {
      if ((h as FakeFile).getFile !== undefined) out.push(`${at}/${name}`);
      else out.push(...(await filesUnder(h as DirHandleLike, `${at}/${name}`)));
    }
    return out;
  };
  const dirsUnder = async (d: DirHandleLike, at = ""): Promise<string[]> => {
    const out: string[] = [];
    for await (const [name, h] of d.entries()) {
      if ((h as FakeFile).getFile === undefined) {
        out.push(`${at}/${name}`);
        out.push(...(await dirsUnder(h as DirHandleLike, `${at}/${name}`)));
      }
    }
    return out;
  };

  it("does not take files this page never knew of when it removes a folder", async () => {
    // Tab A booted first; tab B installed a script afterwards. A's picture
    // has no such files, and A removing the folder used to take them all.
    const s = store();
    const b = new Vfs();
    const mb = mirrorToOpfs(b, { root: s.open, debounceMs: 0 });
    b.write("/home/we/dust/code/rainforest/rainforest.lua", "-- from tab B");
    b.write("/home/we/dust/code/rainforest/sounds/rain.wav", "RIFF");
    await mb.flush();
    mb.stop();

    const a = new Vfs(); // booted before B wrote: knows nothing of it
    const ma = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    a.mkdir("/home/we/dust/code/rainforest");
    a.remove("/home/we/dust/code/rainforest");
    await ma.flush();
    ma.stop();

    const dust = await s.root.getDirectoryHandle("norns-dust");
    expect(await filesUnder(dust)).toContain("/home/we/dust/code/rainforest/sounds/rain.wav");
    expect(ma.stats.kept, "the folder kept is counted").toBe(1);
  });

  it("still removes a folder whose files it removed itself, empty subfolders and all", async () => {
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    // mkdir first, as installs and `util.make_dir` do: the folder takes its
    // place in the queue BEFORE its files, so it is processed first.
    a.mkdir("/home/we/dust/.installing/poche/lib");
    a.write("/home/we/dust/.installing/poche/lib/Engine_Poche.sc", "// sc");
    a.write("/home/we/dust/.installing/poche/poche.lua", "-- lua");
    await m.flush();
    for (const p of a.walk("/home/we/dust/.installing/poche")) a.remove(p);
    a.remove("/home/we/dust/.installing/poche");
    a.remove("/home/we/dust/.installing");
    await m.flush();
    m.stop();

    const dust = await s.root.getDirectoryHandle("norns-dust");
    const dirs = await dirsUnder(dust);
    expect(dirs.some((d) => d.includes(".installing")), dirs.join(" ")).toBe(false);
  });

  it("does not make a folder again to remove a file that is already gone", async () => {
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    a.write("/home/we/dust/data/thing/one.pset", "a pset");
    await m.flush();
    // The folder goes first, then a removal for a file inside it arrives.
    a.remove("/home/we/dust/data/thing/one.pset");
    a.remove("/home/we/dust/data/thing");
    await m.flush();
    a.remove("/home/we/dust/data/thing/one.pset");
    await m.flush();
    m.stop();

    const dust = await s.root.getDirectoryHandle("norns-dust");
    expect(await dirsUnder(dust)).not.toContain("/home/we/dust/data/thing");
  });

  it("writes what it removed, and when, into a journal that outlives the page", async () => {
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0, session: "load-1" });
    a.write("/home/we/dust/data/x/a.pset", "1");
    await m.flush();
    a.remove("/home/we/dust/data/x/a.pset");
    await m.flush();
    m.stop();

    const dust = await s.root.getDirectoryHandle("norns-dust");
    const h = (await dust.getFileHandle(".removals.json")) as FakeFile;
    const journal = JSON.parse(new TextDecoder().decode(h.data)) as Array<{ p: string; s: string }>;
    expect(journal.map((e) => e.p)).toEqual(["/home/we/dust/data/x/a.pset"]);
    expect(journal[0]!.s).toBe("load-1");

    // And it is a sidecar, not a file of the tree.
    const b = new Vfs();
    await restoreFromOpfs(b, { root: s.open });
    expect(b.exists("/.removals.json")).toBe(false);
  });

  it("says how many it removed, not how many it sampled", async () => {
    const s = store();
    const a = new Vfs();
    const lines: string[] = [];
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0, log: (l) => lines.push(l) });
    for (let i = 0; i < 12; i++) a.write(`/home/we/dust/data/x/${i}.pset`, "p");
    await m.flush();
    for (let i = 0; i < 12; i++) a.remove(`/home/we/dust/data/x/${i}.pset`);
    await m.flush();
    m.stop();
    expect(lines.find((l) => l.startsWith("opfs: removed"))).toMatch(/^opfs: removed 12 paths/);
  });

  it("saves the boot's own tidying when it is handed over", async () => {
    // The restore drops an empty script folder before the mirror exists;
    // until `touch` it stayed on the disk and was dropped again every boot.
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    a.mkdir("/home/we/dust/code/ghost/lib");
    await m.flush();
    m.stop();

    const b = new Vfs();
    const r = await restoreFromOpfs(b, { root: s.open });
    expect(r.dropped).toEqual(["/home/we/dust/code/ghost"]);
    const m2 = mirrorToOpfs(b, { root: s.open, debounceMs: 0 });
    m2.touch(r.dropped);
    await m2.flush();
    m2.stop();

    const c = new Vfs();
    const r2 = await restoreFromOpfs(c, { root: s.open });
    expect(r2.ghosts, "dropped once, and not again").toBe(0);
  });

  it("stops writing the moment it is stopped, even mid-flush", async () => {
    const s = store();
    const a = new Vfs();
    const m = mirrorToOpfs(a, { root: s.open, debounceMs: 0 });
    for (let i = 0; i < 20; i++) a.write(`/home/we/dust/data/y/${i}.pset`, "p");
    const done = m.flush();
    m.stop();
    await done;
    expect(m.stats.writes).toBeLessThan(20);
  });
});
