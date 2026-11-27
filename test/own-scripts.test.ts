// E9-213 — the scripts made for norns-js: an index the store reads, and
// folders on the page's own origin the installer fetches from.

import { describe, expect, it } from "vitest";
import type { Catalog } from "../src/community/catalog.js";
import { installFromRepo, listFiles, ownRepo } from "../src/community/install.js";
import {
  createOwnScripts,
  isOwnUrl,
  OWN_LIST,
  OWN_TAG,
  ownBase,
  ownCover,
  ownName,
  ownPage,
  parseOwnList,
  parseOwnIndex,
  withOwn,
} from "../src/community/own-scripts.js";
import { Vfs } from "../src/fs/vfs.js";

const BASE = ownBase("https://norns-js.pages.dev/");
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("own scripts: the index", () => {
  it("is served beside the page", () => {
    expect(BASE).toBe("https://norns-js.pages.dev/own-scripts/");
    expect(ownBase("http://localhost:5173/?profile=300")).toBe("http://localhost:5173/own-scripts/");
  });

  it("makes catalogue entries whose url is the script's folder, tagged for the shelf", () => {
    const e = parseOwnIndex(
      { scripts: [{ name: "poche", author: "pinktentacle", description: "a drum machine", tags: ["drums"] }] },
      BASE,
    );
    expect(e).toEqual([
      {
        name: "poche",
        url: `${BASE}poche/`,
        author: "pinktentacle",
        description: "a drum machine",
        tags: ["drums", OWN_TAG],
        discussion: null,
        documentation: null,
      },
    ]);
    expect(isOwnUrl(e[0]!.url, BASE)).toBe(true);
    expect(ownName(e[0]!.url, BASE)).toBe("poche");
    expect(ownCover(e[0]!.url)).toBe(`${BASE}poche/cover.png`);
    expect(isOwnUrl("https://github.com/a/b", BASE)).toBe(false);
    expect(isOwnUrl(BASE, BASE)).toBe(false);
  });

  it("drops what it could not install, and reads a broken index as empty", () => {
    expect(parseOwnIndex({ scripts: [{ name: "" }, { name: "../up" }, { description: "x" }, null] }, BASE)).toEqual([]);
    expect(parseOwnIndex(null, BASE)).toEqual([]);
    expect(parseOwnIndex({ scripts: "no" }, BASE)).toEqual([]);
  });

  it("joins the catalogue, sorted, and gives way to a catalogue entry of the same name", () => {
    const catalog: Catalog = {
      name: "community",
      date: null,
      entries: [
        { name: "awake", url: "https://github.com/tehn/awake", author: "tehn", description: "", tags: [], discussion: null, documentation: null },
        { name: "remous", url: "https://github.com/x/remous", author: "x", description: "", tags: [], discussion: null, documentation: null },
      ],
    };
    const own = parseOwnIndex({ scripts: [{ name: "poche" }, { name: "Remous" }, { name: "zz" }] }, BASE);
    const merged = withOwn(catalog, own);
    expect(merged.entries.map((e) => e.name)).toEqual(["awake", "poche", "remous", "zz"]);
    expect(merged.entries.find((e) => e.name === "remous")!.author).toBe("x");
    expect(withOwn(catalog, [])).toBe(catalog);
  });

  it("is asked for once, kept for the store's first draw, and asked again after a failure", async () => {
    let calls = 0;
    let fail = true;
    const logs: string[] = [];
    const own = createOwnScripts({
      base: BASE,
      log: (l) => logs.push(l),
      fetchJson: async (url) => {
        calls++;
        expect(url).toBe(`${BASE}index.json`);
        if (fail) throw new Error("offline");
        return { scripts: [{ name: "poche" }] };
      },
    });
    expect(await own.load()).toEqual([]);
    expect(logs[0]).toMatch(/did not arrive \(offline\)/);
    fail = false;
    expect((await own.load()).map((e) => e.name)).toEqual(["poche"]);
    expect(own.last().map((e) => e.name)).toEqual(["poche"]);
    await own.load();
    expect(calls).toBe(2);
  });
});

describe("own scripts: listed, each from its own repository, so a new one needs no release (E9-278)", () => {
  const LIST = "https://raw.githubusercontent.com/pinktentacle/norns-js-scripts/main/index.json";
  const listed = (...names: string[]): unknown => ({
    scripts: names.map((name) => ({
      name,
      description: name,
      repo: `https://github.com/pinktentacle/${name}`,
      cover: "screenshots/playing.png",
    })),
  });
  const here = (...names: string[]): unknown => ({ scripts: names.map((name) => ({ name, description: name })) });

  it("reads each script's repository and cover from the list, and checks what it names", () => {
    const got = parseOwnList({
      scripts: [
        { name: "poche", repo: "https://github.com/pinktentacle/poche", cover: "screenshots/playing.png", tags: ["drums"] },
        { name: "away", repo: "https://example.com/x/away" },
        { name: "bad cover", repo: "https://github.com/a/b", cover: "../../x.png" },
        { name: "nocover", repo: "https://github.com/a/nocover/", cover: "../x.png" },
      ],
    });
    expect(got.map((e) => e.name)).toEqual(["poche", "nocover"]);
    expect(got[0]!.url).toBe("https://github.com/pinktentacle/poche");
    expect(got[0]!.cover).toBe("https://raw.githubusercontent.com/pinktentacle/poche/HEAD/screenshots/playing.png");
    expect(got[0]!.tags).toEqual(["drums", OWN_TAG]);
    expect(got[1]!.url).toBe("https://github.com/a/nocover");
    expect(got[1]!.cover).toBeUndefined();
    expect(OWN_LIST).toBe(LIST);
  });

  it("reads the list first; one only in this build is still offered, from beside the page", async () => {
    const own = createOwnScripts({
      base: BASE,
      remote: LIST,
      fetchJson: async (url) => (url === LIST ? listed("poche", "nouveau") : here("poche", "ancien")),
    });
    const got = await own.load();
    expect(got.map((e) => e.name)).toEqual(["poche", "nouveau", "ancien"]);
    // A listed script installs from its own repository, as a catalogue one does.
    expect(got[0]!.url).toBe("https://github.com/pinktentacle/poche");
    expect(isOwnUrl(got[0]!.url, BASE)).toBe(false);
    expect(got[2]!.url).toBe(`${BASE}ancien/`);
    expect(isOwnUrl(got[2]!.url, BASE)).toBe(true);
  });

  it("offers this build's copy when GitHub does not answer, says so once, and asks again next time", async () => {
    const logs: string[] = [];
    let up = false;
    const own = createOwnScripts({
      base: BASE,
      remote: LIST,
      log: (l) => logs.push(l),
      timeoutMs: 20,
      fetchJson: async (url) => {
        if (url !== LIST) return here("poche");
        if (!up) return new Promise(() => {}); // never answers
        return listed("poche", "nouveau");
      },
    });
    expect((await own.load()).map((e) => e.url)).toEqual([`${BASE}poche/`]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/could not be read \(no answer\); offering the copy in this build/);
    up = true;
    expect((await own.load()).map((e) => e.name)).toEqual(["poche", "nouveau"]);
    expect(logs).toHaveLength(1);
  });

  it("is empty, and says why, only when neither list arrives", async () => {
    const logs: string[] = [];
    const own = createOwnScripts({
      base: BASE,
      remote: LIST,
      log: (l) => logs.push(l),
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    expect(await own.load()).toEqual([]);
    expect(logs[0]).toMatch(/did not arrive \(offline; offline\)/);
  });

  it("links a listed script to its repository, one from beside the page to its README", () => {
    expect(ownPage("https://github.com/pinktentacle/poche")).toBe("https://github.com/pinktentacle/poche");
    expect(ownPage(`${BASE}poche/`)).toBe(`${BASE}poche/README.md`);
  });

  it("the index this build serves is the list, with every script's repository and cover", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const index = JSON.parse(readFileSync(join(__dirname, "..", "public", "own-scripts", "index.json"), "utf8")) as unknown;
    const list = parseOwnList(index);
    const names = (index as { scripts: Array<{ name: string }> }).scripts.map((s) => s.name);
    expect(list.map((e) => e.name)).toEqual(names);
    for (const e of list) {
      expect(e.url).toBe(`https://github.com/pinktentacle/${e.name}`);
      expect(e.cover).toMatch(/^https:\/\/raw\.githubusercontent\.com\/pinktentacle\/[a-z0-9_-]+\/HEAD\/screenshots\/[\w.-]+\.png$/);
    }
  });
});

describe("own scripts: the install", () => {
  it("lists from files.json in the folder, not from GitHub", async () => {
    const asked: string[] = [];
    const r = await listFiles(ownRepo("poche", `${BASE}poche`), async (url) => {
      asked.push(url);
      return { files: [{ path: "poche.lua", size: 10 }, { path: "lib/Engine_Poche.sc", size: 20 }, { size: 1 }] };
    });
    expect(asked).toEqual([`${BASE}poche/files.json`]);
    expect(r.files).toEqual([
      { path: "poche.lua", size: 10 },
      { path: "lib/Engine_Poche.sc", size: 20 },
    ]);
  });

  it("refuses an empty listing rather than installing nothing", async () => {
    await expect(listFiles(ownRepo("poche", `${BASE}poche/`), async () => ({ files: [] }))).rejects.toThrow(/no files/);
  });

  it("fetches every file from beside the listing, and says when an engine needs a reload", async () => {
    const vfs = new Vfs();
    const fetched: string[] = [];
    const r = await installFromRepo(vfs, ownRepo("poche", `${BASE}poche/`), {
      name: "poche",
      fetchJson: async () => ({
        files: [
          { path: "poche.lua", size: 10 },
          { path: "lib/Engine_Poche.sc", size: 20 },
          { path: "screenshots/playing.png", size: 30 },
        ],
      }),
      fetchBytes: async (url) => {
        fetched.push(url);
        return bytes(`-- ${url.slice(BASE.length)}`);
      },
    });
    expect(fetched.every((u) => u.startsWith(`${BASE}poche/`))).toBe(true);
    expect(fetched.some((u) => /jsdelivr|github/.test(u))).toBe(false);
    expect(vfs.readText("/home/we/dust/code/poche/poche.lua")).toBe("-- poche/poche.lua");
    expect(vfs.readText("/home/we/dust/code/poche/lib/Engine_Poche.sc")).toBe("-- poche/lib/Engine_Poche.sc");
    expect(r.needsReload).toBe(true);
  });
});
