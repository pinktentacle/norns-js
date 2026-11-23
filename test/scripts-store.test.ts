// E9-208 — the script store: what it shows, and the pictures it keeps.
//
// The page itself is looked at in a browser. What is tested here is what
// decides its contents — the search, the tags and where each leads, the
// front page of the day — and the cover cache, which must never turn a
// missing picture into an error.

import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../src/community/catalog.js";
import { ABSENT_FOR_MS, ABSENT_HEADER, COVERS_CACHE, coverAddress, createCoverStore } from "../src/community/covers.js";
import type { ScriptMeta } from "../src/community/meta.js";
import {
  agoLabel,
  browse,
  countLabel,
  dayOf,
  frontPage,
  inOrder,
  localEntry,
  mainScript,
  metaLabel,
  monthLabel,
  shuffled,
  starsLabel,
  tagRows,
  withLocals,
  type BrowseQuery,
} from "../src/ui/scripts-model.js";

const entry = (name: string, tags: string[], description = `${name} does something`, author = "someone"): CatalogEntry => ({
  name,
  url: `https://github.com/x/${name}`,
  author,
  description,
  tags,
  discussion: null,
  documentation: null,
});

const CAT = [
  entry("awake", ["sequencer", "grid"], "time changes on two wheels", "tehn"),
  entry("cranes", ["looper", "sampler"], "stereo varispeed looper", "dan_derks"),
  entry("kria", ["sequencer", "grid", "midi"], "the ansible sequencer"),
  entry("mlr", ["looper", "sampler", "grid"], "live sample cutter"),
  entry("molly_the_poly", ["synth", "midi"], "polyphonic subtractive synth"),
  entry("less_concepts", ["sequencer", "generative"], "1-d cellular automata sequencer"),
];
const q = (over: Partial<BrowseQuery> = {}): BrowseQuery => ({ text: "", tags: [], match: "all", ...over });
const names = (list: readonly CatalogEntry[]): string[] => list.map((e) => e.name);
const NONE = new Set<string>();

describe("finding a script", () => {
  it("shows the whole catalogue in order when nothing is asked", () => {
    expect(names(browse(CAT, q(), NONE))).toEqual(["awake", "cranes", "kria", "less_concepts", "mlr", "molly_the_poly"]);
  });

  it("looks in the name, the author, the sentence and the tags", () => {
    expect(names(browse(CAT, q({ text: "tehn" }), NONE))).toEqual(["awake"]);
    expect(names(browse(CAT, q({ text: "varispeed" }), NONE))).toEqual(["cranes"]);
    expect(names(browse(CAT, q({ text: "synth" }), NONE))).toEqual(["molly_the_poly"]);
    // Every word has to be somewhere: two words narrow.
    expect(names(browse(CAT, q({ text: "grid sequencer" }), NONE))).toEqual(["awake", "kria"]);
  });

  it("puts a name that begins with what was typed in front", () => {
    // `mlr` is found by "m", and so is everything with an m in its sentence.
    expect(names(browse(CAT, q({ text: "m" }), NONE)).slice(0, 2)).toEqual(["mlr", "molly_the_poly"]);
  });

  it("narrows with every tag under `all` and widens under `any`", () => {
    expect(names(browse(CAT, q({ tags: ["sequencer", "grid"] }), NONE))).toEqual(["awake", "kria"]);
    expect(names(browse(CAT, q({ tags: ["synth", "looper"], match: "any" }), NONE))).toEqual([
      "cranes",
      "mlr",
      "molly_the_poly",
    ]);
    expect(browse(CAT, q({ tags: ["synth", "looper"] }), NONE)).toEqual([]);
  });

  it("keeps to what is installed when asked", () => {
    const have = new Set(["kria", "mlr"]);
    expect(names(browse(CAT, q({ installedOnly: true }), have))).toEqual(["kria", "mlr"]);
    expect(names(browse(CAT, q({ installedOnly: true, tags: ["sequencer"] }), have))).toEqual(["kria"]);
  });

  it("says how many, or that there is nothing", () => {
    expect(countLabel(12, false)).toBe("12 scripts");
    expect(countLabel(1, true)).toBe("1 script installed");
    expect(countLabel(0, false)).toBe("no script matches");
    expect(countLabel(0, true)).toBe("nothing installed matches");
  });
});

describe("the tags, and where each leads", () => {
  it("lists every tag, commonest first, with its count", () => {
    const rows = tagRows(CAT, q(), NONE);
    expect(rows.slice(0, 2).map((r) => [r.tag, r.total])).toEqual([
      ["grid", 3],
      ["sequencer", 3],
    ]);
    expect(rows.every((r) => !r.chosen)).toBe(true);
  });

  it("says what adding a tag would leave, so a dead end shows before the click", () => {
    const rows = tagRows(CAT, q({ tags: ["sequencer"] }), NONE);
    const lead = (t: string): number => rows.find((r) => r.tag === t)!.leads;
    expect(lead("grid")).toBe(2);
    expect(lead("generative")).toBe(1);
    expect(lead("looper")).toBe(0);
    // A chosen tag leads to what taking it OFF would show.
    expect(rows.find((r) => r.tag === "sequencer")).toMatchObject({ chosen: true, leads: 6 });
  });

  it("counts under `any` as widening", () => {
    const rows = tagRows(CAT, q({ tags: ["synth"], match: "any" }), NONE);
    expect(rows.find((r) => r.tag === "looper")!.leads).toBe(3);
  });
});

describe("what is in the library and not in the catalogue", () => {
  it("is shown as itself rather than left out", () => {
    const all = withLocals(CAT, ["awake", "my-sketch", "Kria"]);
    expect(names(all)).toEqual([...names(CAT), "my-sketch"]);
    expect(localEntry("my-sketch").description).toContain("not a catalogue entry");
  });
});

describe("the file a script is run from", () => {
  const files = [
    "/home/we/dust/code/awake/awake.lua",
    "/home/we/dust/code/awake/lib/halfsecond.lua",
    "/home/we/dust/code/study/a.lua",
    "/home/we/dust/code/study/b.lua",
  ];
  it("is the one named after its folder", () => {
    expect(mainScript("awake", files)).toBe("/home/we/dust/code/awake/awake.lua");
    expect(mainScript("AWAKE", files)).toBe("/home/we/dust/code/awake/awake.lua");
  });
  it("is the first there is when none is, and nothing when there is none", () => {
    expect(mainScript("study", files)).toBe("/home/we/dust/code/study/a.lua");
    expect(mainScript("nb", files)).toBeNull();
  });
});

describe("the front page", () => {
  const big = Array.from({ length: 40 }, (_, i) => entry(`seq${String(i).padStart(2, "0")}`, ["sequencer"]))
    .concat(Array.from({ length: 5 }, (_, i) => entry(`syn${i}`, ["synth"])))
    .concat([entry("lonely", ["art"])]);

  it("is the same all day and different the next", () => {
    const a = frontPage(big, "2026-11-23");
    const b = frontPage(big, "2026-11-23");
    const c = frontPage(big, "2026-11-24");
    expect(names(a.shelves[0]!.entries)).toEqual(names(b.shelves[0]!.entries));
    expect(a.pick?.name).toBe(b.pick?.name);
    expect(names(a.shelves[0]!.entries)).not.toEqual(names(c.shelves[0]!.entries));
    expect(dayOf(new Date("2026-11-23T15:00:00Z"))).toBe("2026-11-23");
  });

  it("makes a shelf of a tag with enough in it, and says how many there are in all", () => {
    const page = frontPage(big, "2026-11-23");
    expect(page.shelves.map((s) => [s.tag, s.title, s.total, s.entries.length])).toEqual([
      ["sequencer", "sequencers", 40, 14],
      ["synth", "synths", 5, 5],
    ]);
  });

  it("never makes today's pick of a script that cannot run here — and keeps it on its shelf", () => {
    const avoid = (n: string): boolean => n.startsWith("syn") || n === "seq00";
    // Whatever the day, the pick is one that runs.
    for (let d = 1; d <= 28; d++) {
      const day = `2026-11-${String(d).padStart(2, "0")}`;
      expect(avoid(frontPage(big, day, avoid).pick!.name)).toBe(false);
    }
    // E9-209 — the shelves are another matter: it used to be left off
    // them, and somebody browsing never learned it was there at all.
    const page = frontPage(big, "2026-11-23", avoid);
    expect(page.shelves.map((s) => [s.tag, s.total, s.entries.length])).toEqual([
      ["sequencer", 40, 14],
      ["synth", 5, 5],
    ]);
    expect(names(page.shelves[1]!.entries).sort()).toEqual(["syn0", "syn1", "syn2", "syn3", "syn4"]);
  });

  it("shuffles without losing or inventing anything", () => {
    const s = shuffled([1, 2, 3, 4, 5, 6, 7], 42);
    expect([...s].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(shuffled([1, 2, 3, 4, 5, 6, 7], 42)).toEqual(s);
  });

  it("has nothing to pick from an empty catalogue", () => {
    expect(frontPage([], "2026-11-23")).toEqual({ pick: null, charts: [], shelves: [] });
  });
});

// E9-209 — popular, new, recently updated.
describe("the charts", () => {
  const META: Record<string, ScriptMeta> = {
    awake: { stars: 29, created: "2019-02-17", pushed: "2026-04-30" },
    cranes: { stars: 61, created: "2020-08-27", pushed: "2023-09-14" },
    kria: { stars: 29, created: "2018-03-21", pushed: "2026-11-20" },
    mlr: { stars: 5, created: "2026-10-02", pushed: "2026-10-09" },
    // molly_the_poly and less_concepts: nothing known.
  };
  const meta = (name: string): ScriptMeta | null => META[name] ?? null;
  const TODAY = new Date("2026-11-23T12:00:00Z");

  it("orders a list by stars, by the day it was published, or by the day it was last changed", () => {
    // A script nothing is known about comes after every one that has a row,
    // and those keep the order of their names.
    expect(names(browse(CAT, q({ sort: "popular" }), NONE, meta))).toEqual([
      "cranes", "awake", "kria", "mlr", "less_concepts", "molly_the_poly",
    ]);
    expect(names(browse(CAT, q({ sort: "new" }), NONE, meta))).toEqual([
      "mlr", "cranes", "awake", "kria", "less_concepts", "molly_the_poly",
    ]);
    expect(names(browse(CAT, q({ sort: "updated" }), NONE, meta))).toEqual([
      "kria", "mlr", "awake", "cranes", "less_concepts", "molly_the_poly",
    ]);
  });

  it("is by name when nothing is known, whatever order is asked for", () => {
    expect(names(browse(CAT, q({ sort: "popular" }), NONE))).toEqual(names(browse(CAT, q(), NONE)));
    expect(inOrder("name", meta)(CAT[0]!, CAT[1]!)).toBe(0);
  });

  it("still puts the name being typed in front of the order", () => {
    // `m` begins mlr and molly_the_poly; cranes has more stars and an m
    // only in its sentence.
    expect(names(browse(CAT, q({ text: "m", sort: "popular" }), NONE, meta)).slice(0, 2)).toEqual(["mlr", "molly_the_poly"]);
  });

  it("keeps to the tags chosen, in the order asked for", () => {
    expect(names(browse(CAT, q({ tags: ["grid"], sort: "new" }), NONE, meta))).toEqual(["mlr", "awake", "kria"]);
  });

  it("puts three shelves in front of the others, of what has a row", () => {
    const page = frontPage(CAT, "2026-11-23", () => false, 3, meta);
    expect(page.charts.map((c) => [c.sort, c.title, names(c.entries)])).toEqual([
      ["popular", "popular", ["cranes", "awake", "kria"]],
      ["new", "new", ["mlr", "cranes", "awake"]],
      ["updated", "recently updated", ["kria", "mlr", "awake"]],
    ]);
  });

  it("has no chart at all when nothing is known — the front page it had before", () => {
    expect(frontPage(CAT, "2026-11-23").charts).toEqual([]);
    expect(frontPage(CAT, "2026-11-23", () => false, 14, (n) => (n === "awake" ? META["awake"]! : null)).charts).toEqual([]);
  });

  it("lists a script that cannot run here on a chart like any other", () => {
    const page = frontPage(CAT, "2026-11-23", (n) => n === "cranes", 3, meta);
    expect(names(page.charts[0]!.entries)).toContain("cranes");
    expect(page.pick!.name).not.toBe("cranes");
  });

  it("says a number of stars, a month and how long ago", () => {
    expect([0, 61, 999, 1000, 1240, 9960, 12400].map(starsLabel)).toEqual(["0", "61", "999", "1k", "1.2k", "10k", "12k"]);
    expect(monthLabel("2020-08-27")).toBe("aug 2020");
    expect(monthLabel("2020")).toBe("2020");
    expect(
      ["2026-11-23", "2026-11-22", "2026-11-18", "2026-11-01", "2026-08-20", "2024-06-01", "2019-02-17"].map((d) => agoLabel(d, TODAY)),
    ).toEqual(["today", "yesterday", "5 days ago", "3 weeks ago", "3 months ago", "2 years ago", "7 years ago"]);
    expect(agoLabel("soon", TODAY)).toBe("");
  });

  it("puts in a card's corner the number its list is in order of", () => {
    const m = META["cranes"]!;
    expect(metaLabel(m, "name", TODAY)).toBe("★ 61");
    expect(metaLabel(m, "popular", TODAY)).toBe("★ 61");
    expect(metaLabel(m, "new", TODAY)).toBe("aug 2020");
    expect(metaLabel(m, "updated", TODAY)).toBe("3 years ago");
    expect(metaLabel(null, "popular", TODAY)).toBe("");
  });
});

describe("a script's picture", () => {
  const png = (): Response => new Response(new Blob([Uint8Array.of(1, 2, 3)]), { headers: { "content-type": "image/png" } });

  function store(
    over: { caches?: boolean; status?: number; type?: string; ahead?: number; kept?: Map<string, Response>; now?: number } = {},
  ) {
    const fetched: string[] = [];
    const kept = over.kept ?? new Map<string, Response>();
    const at = over.now ?? 1_795_000_000_000;
    const opened: string[] = [];
    let inFlight = 0;
    let most = 0;
    const release: (() => void)[] = [];
    const s = createCoverStore({
      base: "https://pics.example/covers",
      fetch: async (url) => {
        fetched.push(url);
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise<void>((r) => release.push(r));
        inFlight--;
        if (over.status !== undefined) return new Response("no", { status: over.status });
        if (over.type !== undefined) return new Response("<html>", { headers: { "content-type": over.type } });
        return png();
      },
      caches:
        over.caches === false
          ? null
          : {
              open: async (name: string) => {
                opened.push(name);
                return {
                  match: async (url: string) => kept.get(url)?.clone(),
                  put: async (url: string, res: Response) => void kept.set(url, res),
                } as unknown as Cache;
              },
            },
      objectUrl: (b) => `blob:${b.size}`,
      parallel: 2,
      now: () => at,
      ...(over.ahead === undefined ? {} : { ahead: over.ahead }),
    });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 0));
        release.splice(0).forEach((r) => r());
      }
    };
    return { s, fetched, kept, opened, flush, most: () => most, now: () => at };
  }

  it("is at the address the site uses, name and all", () => {
    expect(coverAddress("awake")).toBe("https://norns.community/covers/awake.png");
    expect(coverAddress("norns.online")).toBe("https://norns.community/covers/norns.online.png");
    expect(coverAddress("a b")).toBe("https://norns.community/covers/a%20b.png");
  });

  it("is fetched once, kept, and handed out as a blob", async () => {
    const t = store();
    const a = t.s.url("awake");
    const b = t.s.url("awake");
    expect(t.s.peek("awake")).toBeUndefined();
    await t.flush();
    expect(await a).toBe("blob:3");
    expect(await b).toBe("blob:3");
    expect(t.fetched).toEqual(["https://pics.example/covers/awake.png"]);
    expect(t.opened).toEqual([COVERS_CACHE]);
    expect([...t.kept.keys()]).toEqual(["https://pics.example/covers/awake.png"]);
    expect(t.s.peek("awake")).toBe("blob:3");
  });

  it("comes out of the cache the next time, with nothing asked of the network", async () => {
    const t = store();
    t.kept.set("https://pics.example/covers/kria.png", png());
    const u = t.s.url("kria");
    await t.flush();
    expect(await u).toBe("blob:3");
    expect(t.fetched).toEqual([]);
  });

  it("is simply absent when the site has none — and that is remembered for a week", async () => {
    const t = store({ status: 404 });
    const u = t.s.url("nothing");
    await t.flush();
    expect(await u).toBeNull();
    expect(t.s.peek("nothing")).toBeNull();
    // E9-209 — kept as an absence, not as a picture: the next opening does
    // not ask again, and so does not put another 404 in the console.
    const marker = t.kept.get("https://pics.example/covers/nothing.png")!;
    expect(marker.headers.get(ABSENT_HEADER)).toBe(String(t.now()));
    const next = store({ kept: t.kept, now: t.now() + ABSENT_FOR_MS - 1 });
    const again = next.s.url("nothing");
    await next.flush();
    expect(await again).toBeNull();
    expect(next.fetched).toEqual([]);
    // After a week somebody may have drawn one.
    const later = store({ kept: t.kept, now: t.now() + ABSENT_FOR_MS });
    const third = later.s.url("nothing");
    await later.flush();
    expect(await third).toBe("blob:3");
    expect(later.fetched.length).toBe(1);
    expect(later.kept.get("https://pics.example/covers/nothing.png")!.headers.get(ABSENT_HEADER)).toBeNull();
  });

  it("does not remember as absent a picture the site only failed to serve", async () => {
    const t = store({ status: 503 });
    const u = t.s.url("busy");
    await t.flush();
    expect(await u).toBeNull();
    expect(t.kept.size).toBe(0);
  });

  it("is not a picture when the answer is a page", async () => {
    const t = store({ type: "text/html" });
    const u = t.s.url("x");
    await t.flush();
    expect(await u).toBeNull();
  });

  it("asks for a few at a time, in the order they were wanted", async () => {
    const t = store();
    const all = ["a", "b", "c", "d", "e"].map((n) => t.s.url(n));
    await t.flush();
    await Promise.all(all);
    expect(t.most()).toBe(2);
    expect(t.fetched.map((u) => u.split("/").pop())).toEqual(["a.png", "b.png", "c.png", "d.png", "e.png"]);
  });

  it("works without a cache at all", async () => {
    const t = store({ caches: false });
    const u = t.s.url("awake");
    await t.flush();
    expect(await u).toBe("blob:3");
    expect(t.opened).toEqual([]);
  });

  // E9-209 — fetched ahead of being looked at.
  const tail = (t: { fetched: string[] }): string[] => t.fetched.map((u) => u.split("/").pop()!.replace(".png", ""));
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("fetches a whole page ahead, in its order, and keeps every one", async () => {
    const t = store();
    t.s.warm(["a", "b", "c", "d"]);
    await t.flush();
    expect(tail(t)).toEqual(["a", "b", "c", "d"]);
    expect(t.kept.size).toBe(4);
    expect(["a", "b", "c", "d"].map((n) => t.s.peek(n))).toEqual(["blob:3", "blob:3", "blob:3", "blob:3"]);
    // Asked for again, and for one that is being looked at: nothing more.
    t.s.warm(["a", "b"]);
    expect(await t.s.url("c")).toBe("blob:3");
    expect(t.fetched.length).toBe(4);
  });

  it("never lets what is fetched ahead take every slot", async () => {
    const t = store({ ahead: 1 });
    t.s.warm(["w1", "w2", "w3"]);
    await tick();
    // Two slots, and the warm-up holds one: the other is for the screen.
    expect(tail(t)).toEqual(["w1"]);
    void t.s.url("seen");
    await tick();
    expect(tail(t)).toEqual(["w1", "seen"]);
    await t.flush();
    expect(tail(t)).toEqual(["w1", "seen", "w2", "w3"]);
    expect(t.most()).toBe(2);
  });

  it("moves to the front a picture that is scrolled to while it waits its turn", async () => {
    const t = store({ ahead: 1 });
    t.s.warm(["w1", "w2", "w3", "w4"]);
    await tick();
    const seen = t.s.url("w4");
    await t.flush();
    expect(await seen).toBe("blob:3");
    expect(tail(t)).toEqual(["w1", "w4", "w2", "w3"]);
  });

  it("stops counting as fetched ahead one that is looked at while it is in flight", async () => {
    const t = store({ ahead: 1 });
    t.s.warm(["w1", "w2"]);
    await tick();
    expect(tail(t)).toEqual(["w1"]);
    // w1 is being fetched and is now on screen: the warm-up's one slot is
    // free again, so w2 starts beside it instead of behind it.
    void t.s.url("w1");
    await tick();
    expect(tail(t)).toEqual(["w1", "w2"]);
    await t.flush();
    expect(t.fetched.length).toBe(2);
  });

  it("takes what is fetched ahead out of the cache without the network", async () => {
    const t = store();
    t.kept.set("https://pics.example/covers/kria.png", png());
    t.s.warm(["kria"]);
    await t.flush();
    expect(t.s.peek("kria")).toBe("blob:3");
    expect(t.fetched).toEqual([]);
  });
});
