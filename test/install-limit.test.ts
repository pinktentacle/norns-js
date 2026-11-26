// E9-72 — how many files an install will take, and who decides.
//
// It was a constant, 400, with a comment calling anything bigger "a sample
// library wearing a script's hat". Measured against the catalogue, that
// guess refused exactly one script in 355: of the 351 repositories that
// list, only `mosaic` is over 400 — at 1209 — and the next largest is
// `pirate-radio` at 239. What actually stops a repository that IS a sample
// library counts bytes, not files.
//
// So the number moved to `limits.json` and into SETTINGS > FILES, where
// the person whose connection and whose storage it is can move it. Three
// readers, one number: the installer, the panel, and
// `tools/build-blockers.mjs`, which decides from it whether a repository
// gets a note.

import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_AUDIO_MB, DEFAULT_MAX_FILES, installFromRepo } from "../src/community/install.js";
import limits from "../src/community/limits.json";
import {
  createSettings,
  INSTALL_AUDIO_MB_MAX,
  INSTALL_AUDIO_MB_MIN,
  INSTALL_FILES_MAX,
  INSTALL_FILES_MIN,
} from "../src/ui/settings.js";
import { Vfs } from "../src/fs/vfs.js";

/** A listing of `n` Lua files, which is what a big repository looks like. */
const listingOf = (n: number): unknown => ({
  files: Array.from({ length: n }, (_, i) => ({ name: `/lib/f${i}.lua`, size: 10 })),
});

/** A listing of named files, for the durability tests at the bottom. */
const treeOf = (names: readonly string[]): unknown => ({
  files: names.map((name) => ({ name: "/" + name, size: 4 })),
});

const install = (n: number, maxFiles?: number): Promise<unknown> =>
  installFromRepo(new Vfs(), { owner: "a", repo: "big" }, {
    fetchJson: async () => listingOf(n),
    fetchBytes: async () => new TextEncoder().encode("-- x"),
    ...(maxFiles === undefined ? {} : { maxFiles }),
  });

describe("the install file limit", () => {
  it("is the one in limits.json, which the panel and the generator read too", () => {
    expect(DEFAULT_MAX_FILES).toBe(limits.installMaxFiles);
    // Not an arbitrary assertion: mosaic is 1209 files and is the largest
    // in the catalogue. A default below it puts the note back.
    expect(DEFAULT_MAX_FILES).toBeGreaterThan(1209);
  });

  it("takes a repository the old 400 refused", async () => {
    // mosaic-sized. This threw before E9-72.
    await expect(install(1209)).resolves.toBeTruthy();
  });

  it("still refuses one over the limit, and says how to change it", async () => {
    await expect(install(DEFAULT_MAX_FILES + 1)).rejects.toThrow(/SETTINGS > FILES/);
    await expect(install(DEFAULT_MAX_FILES + 1)).rejects.toThrow(
      new RegExp(`over the limit of ${DEFAULT_MAX_FILES}`),
    );
  });

  it("obeys the limit it is given, not the default", async () => {
    await expect(install(500, 400)).rejects.toThrow(/over the limit of 400/);
    await expect(install(500, 600)).resolves.toBeTruthy();
  });

  it("counts the listing, before anything has been downloaded", async () => {
    // The question is "is this a script-sized repository", and it has to be
    // answerable before a thousand requests have been made. Nothing is
    // fetched when it refuses.
    let fetched = 0;
    await expect(
      installFromRepo(new Vfs(), { owner: "a", repo: "big" }, {
        fetchJson: async () => listingOf(5000),
        fetchBytes: async () => {
          fetched += 1;
          return new TextEncoder().encode("-- x");
        },
      }),
    ).rejects.toThrow();
    expect(fetched).toBe(0);
  });
});

describe("the setting behind it", () => {
  const store = (): Record<string, string> => ({});
  const storageOf = (back: Record<string, string>) => ({
    getItem: (k: string) => back[k] ?? null,
    setItem: (k: string, v: string) => void (back[k] = v),
    removeItem: (k: string) => void delete back[k],
  });

  it("starts at the default", () => {
    expect(createSettings(storageOf(store())).installMaxFiles).toBe(DEFAULT_MAX_FILES);
    // And with no storage at all, which is a private window.
    expect(createSettings(null).installMaxFiles).toBe(DEFAULT_MAX_FILES);
  });

  it("keeps what it is set to, and reads it back", () => {
    const back = store();
    const a = createSettings(storageOf(back));
    a.setInstallMaxFiles(3000);
    expect(a.installMaxFiles).toBe(3000);
    expect(createSettings(storageOf(back)).installMaxFiles).toBe(3000);
  });

  it("clamps rather than refuses, in both directions", () => {
    const s = createSettings(storageOf(store()));
    s.setInstallMaxFiles(1);
    expect(s.installMaxFiles).toBe(INSTALL_FILES_MIN);
    s.setInstallMaxFiles(1e9);
    expect(s.installMaxFiles).toBe(INSTALL_FILES_MAX);
    s.setInstallMaxFiles(1234.6);
    expect(s.installMaxFiles, "a count of files is a whole number").toBe(1235);
  });

  it("falls back to the default on a stored value that is not a number", () => {
    const back = { "norns-js/settings/v1": JSON.stringify({ installMaxFiles: "lots" }) };
    expect(createSettings(storageOf(back)).installMaxFiles).toBe(DEFAULT_MAX_FILES);
  });

  it("tells the page which setting changed", () => {
    const s = createSettings(storageOf(store()));
    const seen: string[] = [];
    s.subscribe((_st, what) => seen.push(what));
    s.setInstallMaxFiles(1500);
    expect(seen).toEqual(["files"]);
  });
});

// E9-140 — "installed" has to mean on disk.
//
// Reported from a Pixel 9 Pro: `tmi` would not load because
// `kolor/lib/lattice.lua` was missing from a `kolor` that was installed.
// The file is in the upstream repository and the filter takes it; it had
// never reached that phone's storage. The log named it twice over —
// `swept 8 interrupted downloads: … kolor, tmi` at boot, and the page's
// own MISSING INCLUDE line afterwards.
//
// The move into `code/` is synchronous, so the OVERLAY is never half
// moved. The OPFS mirror is debounced and asynchronous, so the DISK can
// be, and a page that goes away mid-flush leaves exactly what was
// reported. `commit` is awaited after the move so the install does not
// finish until the disk agrees.
describe("an install is not finished until it is durable", () => {
  it("awaits commit, and only after the files are in place", async () => {
    const vfs = new Vfs();
    const seen: string[] = [];
    await installFromRepo(vfs, { owner: "o", repo: "thing" }, {
      name: "thing",
      fetchJson: async () => treeOf(["thing.lua", "lib/helper.lua"]),
      fetchBytes: async () => new TextEncoder().encode("-- x"),
      commit: async () => {
        // Everything is already in the tree when this runs; that is the
        // whole point of where it sits.
        seen.push(...vfs.walk("/home/we/dust/code/thing"));
      },
    });
    expect(seen).toContain("/home/we/dust/code/thing/thing.lua");
    expect(seen).toContain("/home/we/dust/code/thing/lib/helper.lua");
  });

  it("does not commit an install that was cancelled", async () => {
    const vfs = new Vfs();
    let committed = 0;
    const ac = new AbortController();
    ac.abort();
    await expect(
      installFromRepo(vfs, { owner: "o", repo: "thing" }, {
        name: "thing",
        signal: ac.signal,
        fetchJson: async () => treeOf(["thing.lua"]),
        fetchBytes: async () => new TextEncoder().encode("-- x"),
        commit: async () => void committed++,
      }),
    ).rejects.toThrow();
    expect(committed, "a cancelled install made its nothing durable").toBe(0);
  });

  // The Node harness and every test that does not pass one.
  it("installs without a commit, for a caller that has no mirror", async () => {
    const vfs = new Vfs();
    const r = await installFromRepo(vfs, { owner: "o", repo: "thing" }, {
      name: "thing",
      fetchJson: async () => treeOf(["thing.lua"]),
      fetchBytes: async () => new TextEncoder().encode("-- x"),
    });
    expect(r.files).toBe(1);
    expect(vfs.readText("/home/we/dust/code/thing/thing.lua")).toBe("-- x");
  });
});

// E9-261 — the audio an install will take, the same way.
describe("the install audio limit", () => {
  const store = (): Record<string, string> => ({});
  const storageOf = (back: Record<string, string>) => ({
    getItem: (k: string) => back[k] ?? null,
    setItem: (k: string, v: string) => void (back[k] = v),
    removeItem: (k: string) => void delete back[k],
  });

  it("is the one in limits.json, and takes nc01-drone's 118 MB", () => {
    expect(DEFAULT_MAX_AUDIO_MB).toBe(limits.installMaxAudioMb);
    expect(DEFAULT_MAX_AUDIO_MB).toBeGreaterThan(118);
  });

  it("is a setting: default, kept, clamped", () => {
    const back = store();
    const s = createSettings(storageOf(back));
    expect(s.installMaxAudioMb).toBe(DEFAULT_MAX_AUDIO_MB);
    expect(createSettings(null).installMaxAudioMb).toBe(DEFAULT_MAX_AUDIO_MB);
    s.setInstallMaxAudioMb(1024);
    expect(createSettings(storageOf(back)).installMaxAudioMb).toBe(1024);
    s.setInstallMaxAudioMb(1);
    expect(s.installMaxAudioMb).toBe(INSTALL_AUDIO_MB_MIN);
    s.setInstallMaxAudioMb(1e9);
    expect(s.installMaxAudioMb).toBe(INSTALL_AUDIO_MB_MAX);
  });

  it("is obeyed by the install it is given to", async () => {
    const vfs = new Vfs();
    const r = await installFromRepo(vfs, { owner: "a", repo: "drone" }, {
      fetchJson: async () => ({
        files: [
          { name: "/drone.lua", size: 10 },
          { name: "/lib/a.wav", size: 20 * 1024 * 1024 },
        ],
      }),
      fetchBytes: async () => new Uint8Array(4),
      maxAudioMb: 16,
    });
    expect(r.skipped.map((x) => x.path)).toContain("lib/a.wav");
  });
});
