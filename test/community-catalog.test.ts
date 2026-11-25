// E6-11 — the community catalogue, and installing from it.
//
// The network half is measured in the page (it is the whole point that it
// reaches norns.community). What is tested here is everything that decides:
// what counts as an entry, what a search matches, which repository URL means
// what, and which of a repository's files belong in a dust tree.

import { afterEach, describe, expect, it, vi } from "vitest";
import { communityUrl, parseCatalog, samePage, search, tagCounts } from "../src/community/catalog.js";
import {
  installFromRepo,
  listFiles,
  parseRepoUrl,
  parseGitmodules,
  wanted,
  type Candidate,
} from "../src/community/install.js";
import { Vfs } from "../src/fs/vfs.js";

const sample = {
  catalog_name: "community",
  date: "0001-01-01T00:00:00Z",
  entries: [
    {
      project_name: "zed",
      project_url: "https://github.com/someone/zed",
      author: "someone",
      description: "a grid sequencer",
      tags: ["grid", "sequencer"],
      discussion_url: "https://llllllll.co/t/zed/1",
      documentation_url: "",
    },
    {
      project_name: "alpha",
      project_url: "https://github.com/other/alpha",
      author: "other",
      description: "a drone",
      tags: ["drone"],
    },
    // No repository: nothing the install button could do.
    { project_name: "ghost", author: "nobody" },
  ],
};

describe("reading the catalogue", () => {
  it("keeps only entries something could be done with, and sorts them", () => {
    const c = parseCatalog(sample);
    expect(c.entries.map((e) => e.name)).toEqual(["alpha", "zed"]);
    expect(c.name).toBe("community");
  });

  it("maps the fields the dialogue shows, and nulls the empty ones", () => {
    const [, zed] = parseCatalog(sample).entries;
    expect(zed!.author).toBe("someone");
    expect(zed!.description).toBe("a grid sequencer");
    expect(zed!.tags).toEqual(["grid", "sequencer"]);
    expect(zed!.discussion).toBe("https://llllllll.co/t/zed/1");
    expect(zed!.documentation).toBeNull();
  });

  it("survives a file that is not the shape we expect", () => {
    expect(parseCatalog(null).entries).toEqual([]);
    expect(parseCatalog({ entries: "nope" }).entries).toEqual([]);
    expect(parseCatalog({ entries: [42, null] }).entries).toEqual([]);
  });

  it("searches across every field, and NARROWS with each word", () => {
    const e = parseCatalog(sample).entries;
    expect(search(e, "grid").map((x) => x.name)).toEqual(["zed"]);
    expect(search(e, "someone").map((x) => x.name)).toEqual(["zed"]);
    expect(search(e, "grid sequencer").map((x) => x.name)).toEqual(["zed"]);
    // Both words must appear somewhere: this is an AND, not an OR.
    expect(search(e, "grid drone")).toEqual([]);
    expect(search(e, "  ").length).toBe(2);
  });

  it("counts tags, commonest first", () => {
    const e = parseCatalog(sample).entries;
    expect(tagCounts(e)[0]).toEqual(["drone", 1]);
    expect(tagCounts(e).length).toBe(3);
  });
});

describe("the page on norns.community", () => {
  it("strips what the site strips, rather than slugifying", () => {
    // The site's own build script removes everything outside [a-zA-Z0-9-_]
    // and does nothing else: no lower-casing, and a space is REMOVED, not
    // turned into a dash. Each of these three was fetched and confirmed to
    // be a real page before the rule was written down.
    expect(communityUrl("arcologies")).toBe("https://norns.community/arcologies/");
    expect(communityUrl("carter's delay")).toBe("https://norns.community/cartersdelay/");
    expect(communityUrl("nørgård")).toBe("https://norns.community/nrgrd/");
    expect(communityUrl("xD1"), "case is kept").toBe("https://norns.community/xD1/");
    expect(communityUrl("mx.samples")).toBe("https://norns.community/mxsamples/");
  });

  it("spots the documentation link that IS the details page", () => {
    // Ten of the 354 entries do this, and they write it without the trailing
    // slash the permalink has — so two links that differ by one character
    // would otherwise sit side by side pointing at one page.
    const details = communityUrl("arcologies");
    expect(samePage("https://norns.community/arcologies", details)).toBe(true);
    expect(samePage("https://norns.community/arcologies/#usage", details)).toBe(false);
    expect(samePage("https://github.com/x/y", details)).toBe(false);
    expect(samePage(null, details)).toBe(false);
  });

  it("has no link rather than a link to the site's front page", () => {
    expect(communityUrl("")).toBeNull();
    expect(communityUrl("...")).toBeNull();
  });
});

describe("which repository a link means", () => {
  it("reads the owner and the repo out of the shapes people paste", () => {
    expect(parseRepoUrl("https://github.com/a/b")).toEqual({ owner: "a", repo: "b" });
    expect(parseRepoUrl("https://github.com/a/b.git")).toEqual({ owner: "a", repo: "b" });
    expect(parseRepoUrl("https://github.com/a/b/tree/main")).toEqual({ owner: "a", repo: "b" });
    expect(parseRepoUrl("https://www.github.com/a/b/")).toEqual({ owner: "a", repo: "b" });
  });

  it("refuses anything that is not a GitHub repository", () => {
    // The install route is GitHub-specific: a CDN that mirrors GitHub. An
    // entry hosted elsewhere gets a link and an honest disabled button.
    expect(parseRepoUrl("https://gitlab.com/a/b")).toBeNull();
    expect(parseRepoUrl("https://github.com/a")).toBeNull();
    expect(parseRepoUrl("not a url")).toBeNull();
  });

  // E9-203 — the catalogue still says jaseknighter/semiconductor, which is a
  // 404; the author deleted it and published the script again as
  // norns_semiconductor, so GitHub forwards nothing. Listed and read on
  // 2026-11-23: its own includes say 'semiconductor/lib/…'.
  it("follows a script that was published again under another name", () => {
    expect(parseRepoUrl("https://github.com/jaseknighter/semiconductor")).toEqual({
      owner: "jaseknighter",
      repo: "norns_semiconductor",
    });
    expect(parseRepoUrl("https://github.com/JaseKnighter/Semiconductor.git")?.repo).toBe("norns_semiconductor");
    // And nothing else is touched, the new name included.
    expect(parseRepoUrl("https://github.com/jaseknighter/norns_semiconductor")?.repo).toBe("norns_semiconductor");
    expect(parseRepoUrl("https://github.com/jaseknighter/flora")).toEqual({ owner: "jaseknighter", repo: "flora" });
  });
});

describe("which of a repository's files belong in a dust tree", () => {
  const files: Candidate[] = [
    { path: "/thing.lua", size: 4000 },
    { path: "/lib/helper.lua", size: 2000 },
    { path: "/lib/Engine_Thing.sc", size: 1500 },
    { path: "/LICENSE", size: 1000 },
    { path: "/README.md", size: 9000 },
    { path: "/docs/manual.md", size: 5000 },
    { path: "/screenshots/one.png", size: 50_000 },
    { path: "/cover.png", size: 4000 },
    { path: "/samples/loop.wav", size: 9_000_000 },
    { path: "/huge.lua", size: 900_000 },
    { path: "/.github/workflows/ci.yml", size: 300 },
  ];

  it("takes the script, its libs, its classes, its picture AND its samples", () => {
    const { take } = wanted(files);
    expect(take.map((f) => f.path)).toEqual([
      "thing.lua",
      "lib/helper.lua",
      "lib/Engine_Thing.sc",
      "LICENSE",
      "README.md",
      "cover.png",
      "samples/loop.wav",
    ]);
  });

  it("takes the samples, because a sampler without them installs silent", () => {
    // Measured on `amen`: with samples left behind, its own start-up copy had
    // nothing to copy and crone said "no such file
    // .../amen/amenbreak_bpm136.wav", then "Buffer UGen: no buffer data".
    const amen = [
      { path: "/amen.lua", size: 20_000 },
      { path: "/samples/amenbreak_bpm136.wav", size: 1_241_000 },
      { path: "/samples/vinyl2.wav", size: 9_522_000 },
    ];
    expect(wanted(amen).take.map((f) => f.path)).toEqual([
      "amen.lua",
      "samples/amenbreak_bpm136.wav",
      "samples/vinyl2.wav",
    ]);
  });

  it("stops at one big file, and at a running total", () => {
    const huge = { path: "/samples/epic.wav", size: 20 * 1024 * 1024 };
    expect(wanted([huge]).skip[0]!.why).toContain("16 MB of audio");

    // Eight 10 MB files: six fit under 64 MB, the rest are said rather than
    // silently downloaded into somebody's browser storage.
    const many = Array.from({ length: 8 }, (_, i) => ({
      path: `/samples/${i}.wav`,
      size: 10 * 1024 * 1024,
    }));
    const r = wanted(many);
    expect(r.take.length).toBe(6);
    expect(r.skip.length).toBe(2);
    expect(r.skip[0]!.why).toContain("past 64 MB");
  });

  it("ALWAYS takes the licence, which is how a tidy filter infringes", () => {
    // E7-13 found exactly this in our own build: the dust packer dropped
    // every LICENSE because they have no extension.
    const { take } = wanted([{ path: "/deep/inside/LICENSE.md", size: 500 }]);
    expect(take.map((f) => f.path)).toEqual(["deep/inside/LICENSE.md"]);
  });

  it("leaves documentation, screenshots and sample libraries on the server", () => {
    const { skip } = wanted(files);
    const why = new Map(skip.map((s) => [s.path, s.why]));
    expect(why.get("docs/manual.md")).toContain("docs/");
    expect(why.get("screenshots/one.png")).toContain("screenshots/");
    expect(why.get("samples/loop.wav"), "audio is taken now").toBeUndefined();
    expect(why.get("huge.lua")).toContain("512 KB");
    expect(why.get(".github/workflows/ci.yml")).toContain(".github/");
  });
});

// E9-55 — three scripts of the twelve unattributed ones failed because of
// this function, and in all three cases the file they needed was sitting in
// the repository being filtered out by name.
describe("the files a script needs that the filter used to refuse", () => {
  it("takes the art a script draws, out of img/", () => {
    // Ygg.lua:1172  tree = screen.load_png(CODE_DIR .. "img/tree.png")
    //               assert(tree, "tree.png failed to load")
    const { take, skip } = wanted([
      { path: "/Ygg.lua", size: 39_061 },
      { path: "/img/tree.png", size: 8565 },
      { path: "/img/screenshot.png", size: 11_961 },
    ]);
    expect(take.map((f) => f.path)).toContain("img/tree.png");
    expect(skip, "the screenshot beside it costs 12 KB, not a broken init").toEqual([]);
  });

  it("takes a data file whose extension is in no list", () => {
    // internorns/lib/patches.lua:20 reads data/default.mtpreset with
    // io.lines, and died with "No such file or directory".
    const { take } = wanted([{ path: "/data/default.mtpreset", size: 18_136 }]);
    expect(take.map((f) => f.path)).toEqual(["data/default.mtpreset"]);
  });

  it("takes data that is bigger than prose is allowed to be", () => {
    // overwintering's four birds, 1.4–2.9 MB of JSON each. Under the old
    // 512 KB text cap every one was skipped and Trove.get_bird returned nil.
    const birds = [52744, 53560, 53943, 54149].map((n) => ({
      path: `/data/${n}.json`,
      size: 2_800_000,
    }));
    const { take, skip } = wanted(birds);
    expect(take.length, skip.map((s) => s.why).join("; ")).toBe(4);
  });

  it("still refuses a binary built for another machine", () => {
    // pitter-patter ships lib/cjson.so, an ARM build of a Lua C module.
    const { skip } = wanted([{ path: "/lib/cjson.so", size: 28_560 }]);
    expect(skip[0]!.why).toContain(".so is not a file this build can use");
  });

  it("refuses an image EDITOR's document, which is not an image", () => {
    // E9-67 — `splnkr` keeps `images/logo/splnkr.xcf`, 2.96 MB of GIMP.
    // An unknown extension counts as a script's data, so it was fetched,
    // and the one source that would serve it was never reached. No norns
    // script reads a .xcf, and the `.psd` beside it was already refused.
    const { take, skip } = wanted([
      { path: "/images/logo/splnkr.xcf", size: 2_960_358 },
      { path: "/images/logo/splnkr.png", size: 9_000 },
    ]);
    expect(take.map((f) => f.path)).toEqual(["images/logo/splnkr.png"]);
    expect(skip[0]!.why).toContain(".xcf is not a file this build can use");
  });

  it("bounds the images and the data, as it bounds the sound", () => {
    const gallery = Array.from({ length: 10 }, (_, i) => ({
      path: `/img/${i}.png`,
      size: 1900 * 1024,
    }));
    const r = wanted(gallery);
    expect(r.take.length).toBe(8);
    expect(r.skip[0]!.why).toContain("past 16 MB of images");

    expect(wanted([{ path: "/data/corpus.json", size: 9 * 1024 * 1024 }]).skip[0]!.why).toContain(
      "larger than 8 MB of data",
    );
  });
});

describe("installing", () => {
  const listing = {
    files: [
      { name: "/thing.lua", size: 20 },
      { name: "/lib/Engine_Thing.sc", size: 10 },
      { name: "/LICENSE", size: 5 },
    ],
  };

  it("falls back from main to master, because old repositories exist", async () => {
    const asked: string[] = [];
    const fetchJson = async (url: string): Promise<unknown> => {
      asked.push(url);
      if (url.includes("@main")) throw new Error("404");
      return listing;
    };
    const r = await listFiles({ owner: "a", repo: "b" }, fetchJson);
    expect(r.branch).toBe("master");
    // Six, not two: for each branch E9-221 asks GitHub which commit it is
    // at, E9-56 asks GitHub for the tree, and only then jsDelivr. This fake
    // answers in jsDelivr's shape, which is how a GitHub reply that is
    // neither a ref nor a tree falls through.
    expect(asked.length).toBe(6);
    expect(asked[0]).toContain("api.github.com/repos/a/b/git/ref/heads/main");
    expect(asked[1]).toContain("api.github.com/repos/a/b/git/trees/main");
    expect(asked[2]).toContain("jsdelivr");
    expect(r.commit, "nothing said which commit").toBeUndefined();
  });

  it("takes GitHub's tree when it answers, and leaves jsDelivr alone", () => {
    // The listing jsDelivr served for carlosedp/terrarium on 2026-11-16
    // named lib/installer.lua, deleted from the repository, and omitted
    // lib/needs.lua, which terrarium.lua:26 includes.
    const asked: string[] = [];
    const fetchJson = async (url: string): Promise<unknown> => {
      asked.push(url);
      if (url.includes("api.github.com")) {
        return {
          truncated: false,
          tree: [
            { path: "terrarium.lua", type: "blob", size: 33077 },
            { path: "lib", type: "tree" },
            { path: "lib/needs.lua", type: "blob", size: 6085 },
            { path: "lib/nb", type: "commit" },
          ],
        };
      }
      return { files: [{ name: "/terrarium.lua", size: 1 }, { name: "/lib/installer.lua", size: 1 }] };
    };
    return listFiles({ owner: "carlosedp", repo: "terrarium" }, fetchJson).then((r) => {
      expect(r.files.map((f) => f.path)).toEqual(["terrarium.lua", "lib/needs.lua"]);
      expect(
        asked.every((u) => u.includes("api.github.com")),
        "jsDelivr was never asked",
      ).toBe(true);
    });
  });

  it("falls through to jsDelivr when GitHub truncates or refuses", async () => {
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.includes("api.github.com")) {
        if (url.includes("@") || url.includes("/main")) throw new Error("403 rate limit exceeded");
        return { truncated: true, tree: [{ path: "a.lua", type: "blob", size: 1 }] };
      }
      return listing;
    };
    const r = await listFiles({ owner: "a", repo: "b" }, fetchJson);
    expect(r.files.map((f) => f.path)).toEqual(["/thing.lua", "/lib/Engine_Thing.sc", "/LICENSE"]);
  });

  it("says which repository it could not list, rather than failing blankly", async () => {
    const fetchJson = async (): Promise<unknown> => {
      throw new Error("404");
    };
    await expect(listFiles({ owner: "a", repo: "b" }, fetchJson)).rejects.toThrow(/a\/b/);
  });

  // E9-221 — one install, one version. Reported from a Pixel: grains.lua
  // from one week and engine_grains.sc from the next, because jsDelivr
  // caches a branch file by file.
  it("lists and fetches every file at the commit the branch is at", async () => {
    const sha = "07944d1a2b3c4d5e6f708192a3b4c5d6e7f80910";
    const asked: string[] = [];
    const fetchJson = async (url: string): Promise<unknown> => {
      asked.push(url);
      if (url.endsWith("/git/ref/heads/main")) return { object: { sha, type: "commit" } };
      if (url.includes(`/git/trees/${sha}`)) {
        return {
          truncated: false,
          tree: [
            { path: "grains.lua", type: "blob", size: 10 },
            { path: "lib/engine_grains.sc", type: "blob", size: 10 },
          ],
        };
      }
      throw new Error(`not expected: ${url}`);
    };
    const fetched: string[][] = [];
    const vfs = new Vfs();
    const r = await installFromRepo(vfs, { owner: "danielrigler", repo: "grains" }, {
      fetchJson,
      fetchBytes: async (url) => {
        fetched.push([url]);
        return new TextEncoder().encode("x");
      },
    });
    expect(r.commit).toBe(sha);
    expect(r.branch).toBe("main");
    expect(fetched.length).toBe(2);
    for (const [url] of fetched) {
      expect(url, "a file not asked for at the commit").toContain(`@${sha}/`);
    }
    expect(asked.some((u) => u.includes("jsdelivr"))).toBe(false);
  });

  it("never falls back to an unversioned url once it has a commit", async () => {
    const sha = "1606595d00000000000000000000000000000000";
    const tried: string[] = [];
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.endsWith("/git/ref/heads/main")) return { object: { sha, type: "commit" } };
      return { truncated: false, tree: [{ path: "x.lua", type: "blob", size: 1 }] };
    };
    await expect(
      installFromRepo(new Vfs(), { owner: "a", repo: "b" }, {
        fetchJson,
        fetchBytes: async (url) => {
          tried.push(url);
          throw new Error("404");
        },
      }),
    ).rejects.toThrow();
    expect(tried.length).toBeGreaterThan(0);
    for (const url of tried) {
      expect(url.includes(sha), `${url} is not that commit`).toBe(true);
    }
  });

  it("goes by the branch, as before, when GitHub will not say which commit", async () => {
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.includes("/git/ref/")) throw new Error("403 rate limit exceeded");
      if (url.includes("api.github.com")) throw new Error("403 rate limit exceeded");
      return listing;
    };
    const r = await listFiles({ owner: "a", repo: "b" }, fetchJson);
    expect(r.branch).toBe("main");
    expect(r.commit).toBeUndefined();
  });

  it("writes the files under code/<name> and flags the engine", async () => {
    const vfs = new Vfs();
    const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
    const r = await installFromRepo(vfs, { owner: "a", repo: "Thing" }, {
      fetchJson: async () => listing,
      fetchBytes: async (url) => bytes(`// ${url.split("@main/")[1]}`),
    });
    expect(r.name).toBe("thing");
    expect(r.files).toBe(3);
    expect(vfs.readText("/home/we/dust/code/thing/thing.lua")).toBe("// thing.lua");
    expect(vfs.readText("/home/we/dust/code/thing/lib/Engine_Thing.sc")).toBe(
      "// lib/Engine_Thing.sc",
    );
    // A SuperCollider class is injected into sclang only at boot, so a
    // script that brings one needs a reload before it will run.
    expect(r.needsReload).toBe(true);
  });

  it("does not claim a reload is needed when nothing was compiled", async () => {
    const vfs = new Vfs();
    const r = await installFromRepo(vfs, { owner: "a", repo: "b" }, {
      fetchJson: async () => ({ files: [{ name: "/b.lua", size: 3 }] }),
      fetchBytes: async () => new Uint8Array([1, 2, 3]),
    });
    expect(r.needsReload).toBe(false);
  });

  it("refuses a repository over the limit it was given", async () => {
    // E9-72 — the limit is a SETTING now, so the test passes one rather
    // than relying on a constant. It was 400 and the comment above it
    // called anything bigger "a sample library wearing a script's hat";
    // measured over the catalogue, 400 refused exactly one script in 355,
    // and it was mosaic, which is mostly its own test suite.
    const many = { files: Array.from({ length: 500 }, (_, i) => ({ name: `/f${i}.lua`, size: 1 })) };
    await expect(
      installFromRepo(new Vfs(), { owner: "a", repo: "b" }, {
        fetchJson: async () => many,
        maxFiles: 400,
      }),
    ).rejects.toThrow(/over the limit of 400/);
  });

  it("refuses a repository with nothing script-shaped in it", async () => {
    await expect(
      installFromRepo(new Vfs(), { owner: "a", repo: "b" }, {
        fetchJson: async () => ({ files: [{ name: "/a.bin", size: 1 }] }),
      }),
    ).rejects.toThrow(/nothing.*looks like/);
  });
});

// E9-19 — an install is not visible until it is whole, and it can be stopped.
//
// Writing straight into `code/<name>` made the script EXIST from its first
// file: the folder was there, so the project activity listed it as installed
// and SELECT offered it — a script that was one `.lua` and no `lib/` yet,
// which loads and fails. It also made cancelling impossible to do cleanly.
afterEach(() => void vi.useRealTimers());

describe("installing without showing half a script", () => {
  const listing = {
    files: [
      { name: "/thing.lua", size: 10 },
      { name: "/lib/a.lua", size: 10 },
      { name: "/lib/b.lua", size: 10 },
    ],
  };
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

  it("puts nothing under code/ until the last file has arrived", async () => {
    const vfs = new Vfs();
    /** What `code/` looked like at each step of the download. */
    const seen: string[][] = [];
    await installFromRepo(vfs, { owner: "a", repo: "thing" }, {
      fetchJson: async () => listing,
      fetchBytes: async (url) => {
        seen.push(vfs.list("/home/we/dust/code").map((e) => e.name));
        return bytes(url);
      },
    });
    expect(seen, "three fetches, and code/ empty before every one").toEqual([[], [], []]);
    expect(vfs.list("/home/we/dust/code").map((e) => e.name)).toEqual(["thing"]);
    expect(vfs.walk("/home/we/dust/code/thing")).toHaveLength(3);
  });

  it("leaves nothing at all behind when it is cancelled", async () => {
    const vfs = new Vfs();
    const ac = new AbortController();
    const p = installFromRepo(vfs, { owner: "a", repo: "thing" }, {
      fetchJson: async () => listing,
      fetchBytes: async (url) => {
        // Give up once the first file is in: the staging directory now has
        // something in it, which is the case worth proving.
        ac.abort();
        return bytes(url);
      },
      signal: ac.signal,
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(vfs.list("/home/we/dust/code").map((e) => e.name)).toEqual([]);
    expect(vfs.walk("/home/we/dust/.installing"), "and no staging either").toEqual([]);
  });

  it("leaves nothing behind when a file fails half way", async () => {
    const vfs = new Vfs();
    // ONE PATH, EVERY TIME. A single failure is retried now (E9-27), so a
    // test that throws on the second CALL proves the retry and not the
    // sweep. What has to fail is one FILE, for good.
    const p = installFromRepo(vfs, { owner: "a", repo: "thing" }, {
      fetchJson: async () => listing,
      fetchBytes: async (url) => {
        if (url.endsWith("/lib/b.lua")) throw new Error("the cdn said no");
        return bytes(url);
      },
    });
    await expect(p).rejects.toThrow(/cdn/);
    expect(vfs.list("/home/we/dust/code").map((e) => e.name)).toEqual([]);
  });

  // E9-27 — a CDN that disagrees with its own listing.
  //
  // `juhavaaraniemi/giro` is four files, and one run of its install died on
  // `giro.png: 404` for a file the listing had just declared and which has
  // answered 200 on every request since. The script was lost over a
  // screenshot.
  describe("when the CDN will not serve a file it listed", () => {
    const withPng = {
      files: [
        { name: "/thing.lua", size: 10 },
        { name: "/thing.png", size: 10 },
        { name: "/LICENSE", size: 5 },
      ],
    };

    it("asks a second time before believing a failure", async () => {
      const vfs = new Vfs();
      const tries = new Map<string, number>();
      const r = await installFromRepo(vfs, { owner: "a", repo: "thing" }, {
        fetchJson: async () => withPng,
        fetchBytes: async (url) => {
          const n = (tries.get(url) ?? 0) + 1;
          tries.set(url, n);
          if (url.endsWith("/thing.png") && n === 1) throw new Error("404");
          return bytes(url);
        },
      });
      expect(r.files).toBe(3);
      expect(vfs.exists("/home/we/dust/code/thing/thing.png")).toBe(true);
      expect(r.skipped).toEqual([]);
    });

    it("gives up the picture rather than the script, and says which", async () => {
      const vfs = new Vfs();
      const r = await installFromRepo(vfs, { owner: "a", repo: "thing" }, {
        fetchJson: async () => withPng,
        fetchBytes: async (url) => {
          if (url.endsWith("/thing.png")) throw new Error("404 not served");
          return bytes(url);
        },
      });
      expect(vfs.exists("/home/we/dust/code/thing/thing.lua")).toBe(true);
      expect(vfs.exists("/home/we/dust/code/thing/thing.png")).toBe(false);
      expect(r.files).toBe(2);
      const lost = r.skipped.find((s) => s.path === "thing.png");
      expect(lost?.why).toMatch(/not served/);
    });

    it("still refuses to install a script with a .lua missing", async () => {
      // A script missing one of its own files loads and fails somewhere
      // else, which is worse for the user than not being installed.
      const vfs = new Vfs();
      await expect(
        installFromRepo(vfs, { owner: "a", repo: "thing" }, {
          fetchJson: async () => withPng,
          fetchBytes: async (url) => {
            if (url.endsWith("/thing.lua")) throw new Error("404 not served");
            return bytes(url);
          },
        }),
      ).rejects.toThrow(/not served/);
      expect(vfs.list("/home/we/dust/code").map((e) => e.name)).toEqual([]);
    });

    // E9-67 — a source that answers nothing is not a reason to lose the script.
  //
  // Measured on `splnkr`: `images/logo/splnkr.xcf` got a 404 from jsDelivr
  // after 17.7 seconds, twice, and then the URL without a ref never
  // answered AT ALL. raw.githubusercontent serves the same file in 318 ms
  // and was never asked, because a fetch on a dead connection does not
  // return. 56 of 57 files, then nothing, then "install cancelled".
  it("abandons a source that has gone silent and asks the next one", async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((url: string | URL, init?: { signal?: AbortSignal }) => {
      asked.push(String(url));
      if (String(url).includes("cdn.jsdelivr.net")) {
        return new Promise<Response>((_ok, no) => {
          init?.signal?.addEventListener("abort", () => no(init.signal?.reason), { once: true });
        });
      }
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    }) as typeof globalThis.fetch;
    try {
      const vfs = new Vfs();
      const p = installFromRepo(vfs, { owner: "a", repo: "thing" }, {
        fetchJson: async () => ({ files: [{ name: "/thing.lua", size: 3 }] }),
      });
      // Three dead attempts at twenty seconds each, and the 250 ms the
      // retry waits, then the third source answers.
      await vi.advanceTimersByTimeAsync(70_000);
      const r = await p;
      expect(r.files).toBe(1);
      expect(vfs.read("/home/we/dust/code/thing/thing.lua")).toEqual(new Uint8Array([1, 2, 3]));
      expect(asked.filter((u) => u.includes("jsdelivr")).length).toBe(3);
      expect(asked[asked.length - 1]).toContain("raw.githubusercontent.com");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("counts the lost file out of the total, so progress still ends at the end", async () => {
      const steps: string[] = [];
      await installFromRepo(new Vfs(), { owner: "a", repo: "thing" }, {
        fetchJson: async () => withPng,
        fetchBytes: async (url) => {
          if (url.endsWith("/thing.png")) throw new Error("404");
          return bytes(url);
        },
        onProgress: (p) => steps.push(`${p.done}/${p.total}`),
      });
      expect(steps[steps.length - 1]).toBe("2/2");
    });
  });

  it("an update does not leave a file the new version dropped", async () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/thing/gone.lua", "-- from the old version\n");
    await installFromRepo(vfs, { owner: "a", repo: "thing" }, {
      fetchJson: async () => listing,
      fetchBytes: async (url) => bytes(url),
    });
    expect(
      vfs.exists("/home/we/dust/code/thing/gone.lua"),
      "a ghost `include` would still find",
    ).toBe(false);
    expect(vfs.exists("/home/we/dust/code/thing/thing.lua")).toBe(true);
  });

  it("reports how far it has got, so a slow line can be waited out", async () => {
    const vfs = new Vfs();
    const steps: string[] = [];
    await installFromRepo(vfs, { owner: "a", repo: "thing" }, {
      fetchJson: async () => listing,
      fetchBytes: async (url) => bytes(url),
      onProgress: (p) => steps.push(`${p.done}/${p.total}`),
    });
    expect(steps).toEqual(["1/3", "2/3", "3/3"]);
  });
});

// E9-27 — a submodule is a pointer, and a listing does not follow pointers.
//
// MEASURED, against the live CDN, before any of this was written:
// installing `schollz/pitter-patter` wrote 54 files, reported success with
// nothing skipped, and the script died on load —
//
//     ### MISSING INCLUDE: lib/nb/lib/nb
//     /home/we/dust/code/pitter-patter/pitter-patter.lua:25: ...
//
// — because `lib/nb` is a git submodule and jsDelivr lists a repository's
// own tree only. 19 of the catalogue's 354 repositories carry a
// `.gitmodules`; `sixolet/nb` alone is wanted by eight scripts.
describe("a script whose libraries are git submodules", () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

  const GITMODULES = `[submodule "lib/nb"]
	path = lib/nb
	url = https://github.com/sixolet/nb
[submodule "lib/old"]
	path = lib/old
	url = git@github.com:someone/old.git
`;

  /** A parent with one `.gitmodules`, and two libraries behind it. */
  function world(opts: { pins?: Record<string, string> } = {}) {
    const asked: string[] = [];
    const fetchJson = async (url: string): Promise<unknown> => {
      asked.push(url);
      if (url.startsWith("https://api.github.com/")) {
        if (!opts.pins) throw new Error("403 rate limited");
        return Object.entries(opts.pins).map(([name, sha]) => ({ name, sha }));
      }
      if (!url.includes("@main")) throw new Error("404");
      if (url.includes("/gh/a/parent@")) {
        return { files: [{ name: "/parent.lua", size: 4 }, { name: "/.gitmodules", size: 90 }] };
      }
      if (url.includes("/gh/sixolet/nb@")) return { files: [{ name: "/lib/nb.lua", size: 4 }] };
      if (url.includes("/gh/someone/old@")) return { files: [{ name: "/old.lua", size: 4 }] };
      throw new Error(`404 ${url}`);
    };
    const fetchBytes = async (url: string): Promise<Uint8Array> => {
      asked.push(url);
      if (url.endsWith("/.gitmodules")) return bytes(GITMODULES);
      return bytes(`// ${url}`);
    };
    return { asked, fetchJson, fetchBytes };
  }

  it("reads https, ssh and relative urls out of a .gitmodules", () => {
    const mods = parseGitmodules(`[submodule "lib/nb"]
	path = lib/nb
	url = https://github.com/sixolet/nb
[submodule "lib/old"]
	path = lib/old
	url = git@github.com:someone/old.git
[submodule "lib/near"]
	path = lib/near
	url = ../../owner/near
[submodule "lib/gone"]
	path = lib/gone
	url = https://gitlab.example/not/github
`);
    expect(mods).toEqual([
      { path: "lib/nb", repo: { owner: "sixolet", repo: "nb" } },
      { path: "lib/old", repo: { owner: "someone", repo: "old" } },
      { path: "lib/near", repo: { owner: "owner", repo: "near" } },
    ]);
  });

  it("fetches each submodule into the path its parent gave it", async () => {
    const vfs = new Vfs();
    const { fetchJson, fetchBytes } = world();
    const r = await installFromRepo(vfs, { owner: "a", repo: "parent" }, { fetchJson, fetchBytes });
    expect(r.files).toBe(3);
    expect(vfs.exists("/home/we/dust/code/parent/parent.lua")).toBe(true);
    expect(vfs.exists("/home/we/dust/code/parent/lib/nb/lib/nb.lua")).toBe(true);
    expect(vfs.exists("/home/we/dust/code/parent/lib/old/old.lua")).toBe(true);
  });

  it("uses the pinned commit when GitHub will say what it is", async () => {
    const sha = "82d1cb71df10980e6bd399ce3ac83f642dd9cd01";
    const { asked, fetchJson, fetchBytes } = world({ pins: { nb: sha, old: "not-a-sha" } });
    await installFromRepo(new Vfs(), { owner: "a", repo: "parent" }, { fetchJson, fetchBytes });
    // `ndls` carries the same library twice at two different commits, and
    // `include("lib/patcher/ui")` wants a file the library's main branch no
    // longer has. Without the pin that script cannot be installed at all.
    expect(asked.some((u) => u.includes(`/gh/sixolet/nb@${sha}`))).toBe(true);
    // A value that is not a commit id is not a pin: that one falls back.
    expect(asked.some((u) => u.includes("/gh/someone/old@main"))).toBe(true);
  });

  it("installs anyway when GitHub refuses, at the branch head", async () => {
    const vfs = new Vfs();
    const { asked, fetchJson, fetchBytes } = world();
    await installFromRepo(vfs, { owner: "a", repo: "parent" }, { fetchJson, fetchBytes });
    expect(asked.some((u) => u.startsWith("https://api.github.com/"))).toBe(true);
    expect(vfs.exists("/home/we/dust/code/parent/lib/nb/lib/nb.lua")).toBe(true);
  });

  it("loses the library, not the script, when a submodule will not list", async () => {
    const vfs = new Vfs();
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.startsWith("https://api.github.com/")) throw new Error("403");
      if (!url.includes("@main")) throw new Error("404");
      if (url.includes("/gh/a/parent@")) {
        return { files: [{ name: "/parent.lua", size: 4 }, { name: "/.gitmodules", size: 90 }] };
      }
      throw new Error("404 gone");
    };
    const fetchBytes = async (url: string): Promise<Uint8Array> =>
      url.endsWith("/.gitmodules") ? bytes(GITMODULES) : bytes("x");
    const r = await installFromRepo(vfs, { owner: "a", repo: "parent" }, { fetchJson, fetchBytes });
    expect(vfs.exists("/home/we/dust/code/parent/parent.lua")).toBe(true);
    expect(r.skipped.map((s) => s.path)).toContain("lib/nb");
    expect(r.skipped.find((s) => s.path === "lib/nb")?.why).toMatch(/sixolet\/nb/);
  });

  it("counts a submodule's files against the limit, not past it", async () => {
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url.startsWith("https://api.github.com/")) throw new Error("403");
      if (!url.includes("@main")) throw new Error("404");
      if (url.includes("/gh/a/parent@")) {
        return { files: [{ name: "/parent.lua", size: 4 }, { name: "/.gitmodules", size: 90 }] };
      }
      return { files: Array.from({ length: 500 }, (_, i) => ({ name: `/f${i}.lua`, size: 1 })) };
    };
    const fetchBytes = async (url: string): Promise<Uint8Array> =>
      url.endsWith("/.gitmodules") ? bytes(GITMODULES) : bytes("x");
    await expect(
      installFromRepo(new Vfs(), { owner: "a", repo: "parent" }, {
        fetchJson,
        fetchBytes,
        maxFiles: 400,
      }),
    ).rejects.toThrow(/over the limit of 400/);
  });
});
