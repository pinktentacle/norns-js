// E9-69 — the two files maiden leaves in the dust tree.
//
// `folio` reads the script library off the disk, from
// `~/dust/data/catalogs/base.json` and `community.json`. Those are
// maiden's: `sources/base.json` and `sources/community.json` name the two
// urls, and `pkg/dust/layout.go` names the directory. Writing them is this
// build's half of "refresh the library in maiden", which is the sentence
// folio prints when they are not there.

import { describe, expect, it } from "vitest";
import {
  CATALOGS_DIR,
  CATALOG_SOURCES,
  fetchAndStoreCatalogs,
} from "../src/community/maiden-catalogs.js";
import { Vfs } from "../src/fs/vfs.js";

const base = JSON.stringify({
  file_info: { version: 1, kind: "script_catalog" },
  catalog_name: "base",
  entries: [
    { project_name: "firstlight", project_url: "https://github.com/monome/firstlight", tags: ["study"] },
  ],
});

// Deliberately holds a field `parseCatalog` has no use for: what lands on
// disk must be the download, not our narrowed view of it.
const community = JSON.stringify({
  file_info: { version: 1, kind: "script_catalog" },
  catalog_name: "community",
  entries: [
    {
      project_name: "zed",
      project_url: "https://github.com/someone/zed",
      author: "someone",
      description: "a grid sequencer",
      tags: ["grid"],
      home_page: "https://example.invalid/zed",
    },
  ],
});

const urlOf = (name: string): string => CATALOG_SOURCES.find((s) => s.name === name)!.url;

/** A `fetch` that answers from a table, and 404s for anything else. */
const fakeFetch = (bodies: Record<string, string | number>): typeof fetch =>
  ((input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const body = bodies[url];
    if (typeof body === "number") {
      return Promise.resolve(new Response("", { status: body, statusText: "Not Found" }));
    }
    if (body === undefined) return Promise.reject(new Error("unexpected url " + url));
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as unknown as typeof fetch;

describe("the catalogs maiden writes", () => {
  it("writes both, where maiden writes them", async () => {
    const vfs = new Vfs();
    const cat = await fetchAndStoreCatalogs(vfs, {
      fetchImpl: fakeFetch({ [urlOf("base")]: base, [urlOf("community")]: community }),
    });
    expect(vfs.readText(`${CATALOGS_DIR}/base.json`)).toBe(base);
    expect(vfs.readText(`${CATALOGS_DIR}/community.json`)).toBe(community);
    expect(CATALOGS_DIR).toBe("/home/we/dust/data/catalogs");
    expect(cat.entries.map((e) => e.name)).toEqual(["zed"]);
  });

  it("writes the bytes that arrived, not a re-serialisation of our shape", async () => {
    const vfs = new Vfs();
    await fetchAndStoreCatalogs(vfs, {
      fetchImpl: fakeFetch({ [urlOf("base")]: base, [urlOf("community")]: community }),
    });
    // `parseCatalog` keeps seven fields and `home_page` is not one of them.
    // A script reading these files must still find it.
    const onDisk = vfs.readText(`${CATALOGS_DIR}/community.json`) ?? "";
    expect(onDisk).toContain("home_page");
    expect(JSON.parse(onDisk).entries[0].home_page).toBe("https://example.invalid/zed");
  });

  it("carries on without the base catalogue, and says so", async () => {
    const vfs = new Vfs();
    const lines: string[] = [];
    const cat = await fetchAndStoreCatalogs(vfs, {
      log: (l) => lines.push(l),
      fetchImpl: fakeFetch({ [urlOf("base")]: 404, [urlOf("community")]: community }),
    });
    expect(cat.entries.length).toBe(1);
    expect(vfs.readText(`${CATALOGS_DIR}/community.json`)).toBe(community);
    expect(vfs.readText(`${CATALOGS_DIR}/base.json`)).toBeNull();
    expect(lines.some((l) => l.includes("base.json did not arrive"))).toBe(true);
  });

  it("raises when the community catalogue does not arrive, as the panel always did", async () => {
    const vfs = new Vfs();
    await expect(
      fetchAndStoreCatalogs(vfs, {
        fetchImpl: fakeFetch({ [urlOf("base")]: base, [urlOf("community")]: 500 }),
      }),
    ).rejects.toThrow(/500/);
  });

  it("will not write a reply that is not a catalogue", async () => {
    // A captive portal or a proxy answers 200 with HTML. Writing that would
    // leave folio parsing a login page.
    const vfs = new Vfs();
    const lines: string[] = [];
    await expect(
      fetchAndStoreCatalogs(vfs, {
        log: (l) => lines.push(l),
        fetchImpl: fakeFetch({ [urlOf("base")]: "<html>sign in</html>", [urlOf("community")]: "{}" }),
      }),
    ).rejects.toThrow();
    expect(vfs.readText(`${CATALOGS_DIR}/base.json`)).toBeNull();
  });

  it("does not rewrite bytes that are already there", async () => {
    const vfs = new Vfs();
    const f = fakeFetch({ [urlOf("base")]: base, [urlOf("community")]: community });
    await fetchAndStoreCatalogs(vfs, { fetchImpl: f });
    // Stamped back to an hour the clock cannot produce twice, so "it was
    // not written again" is a fact and not a same-millisecond coincidence.
    vfs.setMtime(`${CATALOGS_DIR}/community.json`, 1);
    const lines: string[] = [];
    await fetchAndStoreCatalogs(vfs, { fetchImpl: f, log: (l) => lines.push(l) });
    expect(lines).toEqual([]);
    expect(vfs.mtimeOf(`${CATALOGS_DIR}/community.json`)).toBe(1);
  });
});
