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
import { DEFAULT_MAX_FILES, installFromRepo } from "../src/community/install.js";
import limits from "../src/community/limits.json";
import { createSettings, INSTALL_FILES_MAX, INSTALL_FILES_MIN } from "../src/ui/settings.js";
import { Vfs } from "../src/fs/vfs.js";

/** A listing of `n` Lua files, which is what a big repository looks like. */
const listingOf = (n: number): unknown => ({
  files: Array.from({ length: n }, (_, i) => ({ name: `/lib/f${i}.lua`, size: 10 })),
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
