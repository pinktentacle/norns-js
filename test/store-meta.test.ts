// E9-209 — what the store knows beyond the catalogue: stars and dates from
// GitHub, shipped, kept and asked for again; and how a script that will
// not work here is told apart from one that only needs something done.
//
// No test here touches the network. What GitHub answers is in
// `tools/build-meta.mjs`'s output, which is read below as the file it is.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../src/community/catalog.js";
import {
  FRESH_FOR_MS,
  META_CACHE,
  META_KEY,
  PER_QUERY,
  RETRY_AFTER_MS,
  createMetaStore,
  parseMeta,
  readSearch,
  repoKey,
  searchUrls,
} from "../src/community/meta.js";
import { VERDICT_NAMES, standing } from "../src/community/verdicts.js";

const entry = (name: string, url = `https://github.com/x/${name}`): CatalogEntry => ({
  name,
  url,
  author: "someone",
  description: `${name} does something`,
  tags: [],
  discussion: null,
  documentation: null,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const item = (full_name: string, stars: number, created: string, pushed: string): Record<string, unknown> => ({
  full_name,
  stargazers_count: stars,
  created_at: `${created}T10:00:00Z`,
  pushed_at: `${pushed}T10:00:00Z`,
});

const NOW = Date.parse("2026-11-23T12:00:00Z");
const DAY = 24 * 3600 * 1000;

interface Rig {
  shipped?: unknown;
  /** What the search answers, a request at a time. A number is a status. */
  answers?: Array<unknown | number | Error>;
  kept?: unknown;
  caches?: boolean;
  saveData?: boolean;
}

function rig(over: Rig = {}) {
  const asked: string[] = [];
  const slept: number[] = [];
  const logged: string[] = [];
  const kept = new Map<string, string>();
  if (over.kept !== undefined) kept.set(META_KEY, JSON.stringify(over.kept));
  const opened: string[] = [];
  const answers = [...(over.answers ?? [])];
  let now = NOW;
  const s = createMetaStore({
    url: "/meta.json",
    fetch: async (url) => {
      if (url === "/meta.json") return over.shipped === undefined ? json({}, 404) : json(over.shipped);
      asked.push(url);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      if (typeof a === "number") return json({ message: "no" }, a);
      return json(a ?? { items: [] });
    },
    caches:
      over.caches === false
        ? null
        : {
            open: async (name: string) => {
              opened.push(name);
              return {
                match: async (url: string) => (kept.has(url) ? json(JSON.parse(kept.get(url)!)) : undefined),
                put: async (url: string, res: Response) => void kept.set(url, await res.text()),
              } as unknown as Cache;
            },
          },
    now: () => now,
    sleep: async (ms) => void slept.push(ms),
    log: (l) => logged.push(l),
    ...(over.saveData === undefined ? {} : { saveData: () => over.saveData! }),
  });
  return {
    s,
    asked,
    slept,
    logged,
    opened,
    keptFile: (): Record<string, unknown> | null => (kept.has(META_KEY) ? JSON.parse(kept.get(META_KEY)!) : null),
    later: (ms: number): void => void (now += ms),
  };
}

const SHIPPED = {
  generated: "2026-11-20",
  scripts: { awake: [29, "2019-02-17", "2026-04-30"], Kria: [12, "2018-03-21", "2021-09-10"] },
};

describe("the table of stars and dates", () => {
  it("reads a row a script, and passes over what is not one", () => {
    const f = parseMeta({
      generated: "2026-11-23",
      scripts: { awake: [29, "2019-02-17", "2026-04-30"], broken: ["many", "2019"], short: [3], dateless: [3, "soon", "x"] },
    });
    expect(f.generated).toBe("2026-11-23");
    expect([...f.scripts]).toEqual([["awake", { stars: 29, created: "2019-02-17", pushed: "2026-04-30" }]]);
    expect(parseMeta(null).scripts.size).toBe(0);
    expect(parseMeta({ scripts: "no" }).scripts.size).toBe(0);
  });

  it("is shipped with the page, and that file is one this reads", () => {
    const f = parseMeta(JSON.parse(readFileSync(new URL("../public/community-meta.json", import.meta.url), "utf8")));
    expect(f.generated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 354 of 355 the day it was written; a catalogue that grows has more.
    expect(f.scripts.size).toBeGreaterThan(300);
    for (const m of f.scripts.values()) {
      expect(m.created <= m.pushed).toBe(true);
      expect(m.stars).toBeGreaterThanOrEqual(0);
    }
    expect(f.scripts.get("awake")?.created).toBe("2019-02-17");
  });

  it("answers by name, whatever its capitals, from what was shipped", async () => {
    const t = rig({ shipped: SHIPPED });
    expect(t.s.get("awake")).toBeNull();
    await t.s.ready();
    expect(t.s.get("AWAKE")).toEqual({ stars: 29, created: "2019-02-17", pushed: "2026-04-30" });
    expect(t.s.get("kria")?.stars).toBe(12);
    expect(t.s.size()).toBe(2);
    expect(t.s.asOf()).toBe("2026-11-20");
    expect(t.s.get("nothing")).toBeNull();
  });

  it("is empty, and not an error, when nothing was shipped and nothing kept", async () => {
    const t = rig({ caches: false });
    await t.s.ready();
    expect(t.s.size()).toBe(0);
    expect(t.s.asOf()).toBeNull();
  });

  it("lets the newer of the shipped and the kept copies win, row by row", async () => {
    // Kept after the shipped one was made: its rows are the truer.
    const newerKept = rig({
      shipped: SHIPPED,
      kept: { generated: "2026-11-22", checked: Date.parse("2026-11-22T08:00:00Z"), scripts: { awake: [31, "2019-02-17", "2026-11-21"] } },
    });
    await newerKept.s.ready();
    expect(newerKept.s.get("awake")?.stars).toBe(31);
    expect(newerKept.s.get("kria")?.stars).toBe(12);
    expect(newerKept.s.asOf()).toBe("2026-11-22");
    // A release that ships a newer table must not lose to an old kept one.
    const olderKept = rig({
      shipped: SHIPPED,
      kept: { generated: "2026-10-01", checked: Date.parse("2026-10-01T08:00:00Z"), scripts: { awake: [20, "2019-02-17", "2026-04-30"], gone: [1, "2020-01-01", "2020-01-02"] } },
    });
    await olderKept.s.ready();
    expect(olderKept.s.get("awake")?.stars).toBe(29);
    expect(olderKept.s.get("gone")?.stars).toBe(1);
    expect(olderKept.s.asOf()).toBe("2026-11-20");
  });
});

describe("asking GitHub", () => {
  it("names the repository an entry points at, wherever in it the link lands", () => {
    expect(repoKey(entry("awake", "https://github.com/tehn/awake"))).toBe("tehn/awake");
    expect(repoKey(entry("eels", "https://github.com/andr-ew/eels/releases/download/latest/complete-source-code.zip"))).toBe("andr-ew/eels");
    expect(repoKey(entry("x", "https://github.com/a/b.git"))).toBe("a/b");
    expect(repoKey(entry("elsewhere", "https://codeberg.org/a/b"))).toBeNull();
    // A repository published again under another name is asked for there.
    expect(repoKey(entry("semiconductor", "https://github.com/jaseknighter/semiconductor"))).toBe("jaseknighter/norns_semiconductor");
  });

  it("asks about sixty repositories a request, forks included", () => {
    const repos = Array.from({ length: 130 }, (_, i) => `o/r${i}`);
    const urls = searchUrls(repos);
    expect(PER_QUERY).toBe(60);
    expect(urls.length).toBe(3);
    expect(urls[0]!.startsWith("https://api.github.com/search/repositories?q=repo:o/r0+repo:o/r1+")).toBe(true);
    expect(urls.every((u) => u.endsWith("+fork:true&per_page=100"))).toBe(true);
    expect(urls[2]!.match(/repo:/g)!.length).toBe(10);
    expect(searchUrls([])).toEqual([]);
  });

  it("reads an answer by repository, and nothing out of one that is not an answer", () => {
    const got = readSearch({ items: [item("Tehn/Awake", 29, "2019-02-17", "2026-04-30"), { full_name: "x/y" }, null] });
    expect([...got]).toEqual([["tehn/awake", { stars: 29, created: "2019-02-17", pushed: "2026-04-30" }]]);
    expect(readSearch({ message: "rate limited" }).size).toBe(0);
    expect(readSearch(null).size).toBe(0);
  });

  it("asks nothing while what it holds is less than a week old", async () => {
    const t = rig({ shipped: SHIPPED });
    expect(await t.s.refresh([entry("awake"), entry("kria")])).toBe(false);
    expect(t.asked).toEqual([]);
  });

  it("asks for everything after a week, keeps the answer, and says what changed", async () => {
    const t = rig({ shipped: SHIPPED, answers: [{ items: [item("x/awake", 33, "2019-02-17", "2026-11-25")] }] });
    let told = 0;
    t.s.onChange(() => told++);
    t.later(FRESH_FOR_MS);
    expect(await t.s.refresh([entry("awake"), entry("kria")])).toBe(true);
    expect(t.asked.length).toBe(1);
    expect(t.asked[0]).toContain("repo:x/awake+repo:x/kria");
    expect(t.s.get("awake")).toEqual({ stars: 33, created: "2019-02-17", pushed: "2026-11-25" });
    // kria was not in the answer — renamed, perhaps — and keeps its row.
    expect(t.s.get("kria")?.stars).toBe(12);
    expect(told).toBe(1);
    // A week after the 23rd, which is the day it was asked.
    expect(t.s.asOf()).toBe("2026-11-30");
    expect(t.opened).toEqual([META_CACHE]);
    const file = t.keptFile()!;
    expect(file["absent"]).toEqual(["x/kria"]);
    expect((file["scripts"] as Record<string, unknown>)["awake"]).toEqual([33, "2019-02-17", "2026-11-25"]);
    // And it is fresh again: the next opening asks nothing.
    t.later(RETRY_AFTER_MS + 1);
    expect(await t.s.refresh([entry("awake"), entry("kria")])).toBe(false);
    expect(t.asked.length).toBe(1);
  });

  it("starts the next session from what it kept", async () => {
    const first = rig({ shipped: SHIPPED, answers: [{ items: [item("x/awake", 40, "2019-02-17", "2026-11-26")] }] });
    first.later(FRESH_FOR_MS);
    await first.s.refresh([entry("awake")]);
    const second = rig({ shipped: SHIPPED, kept: first.keptFile() });
    await second.s.ready();
    expect(second.s.get("awake")?.stars).toBe(40);
    second.later(FRESH_FOR_MS - DAY);
    expect(await second.s.refresh([entry("awake")])).toBe(false);
    expect(second.asked).toEqual([]);
  });

  it("waits between two requests, and is not told twice about nothing", async () => {
    const many = Array.from({ length: 130 }, (_, i) => entry(`s${i}`));
    const t = rig({ shipped: SHIPPED });
    let told = 0;
    t.s.onChange(() => told++);
    t.later(FRESH_FOR_MS);
    expect(await t.s.refresh(many)).toBe(false);
    expect(t.asked.length).toBe(3);
    expect(t.slept).toEqual([1500, 1500]);
    expect(told).toBe(0);
  });

  it("asks at once, and only, about a script the catalogue has grown", async () => {
    const t = rig({ shipped: SHIPPED, answers: [{ items: [item("x/brand_new", 2, "2026-11-22", "2026-11-23")] }] });
    expect(await t.s.refresh([entry("awake"), entry("kria"), entry("brand_new")])).toBe(true);
    expect(t.asked).toEqual(["https://api.github.com/search/repositories?q=repo:x/brand_new+fork:true&per_page=100"]);
    expect(t.s.get("brand_new")?.created).toBe("2026-11-22");
    // The day the rest is from has not moved: only one row was asked for.
    expect(t.s.asOf()).toBe("2026-11-20");
  });

  it("does not go on asking about one GitHub does not have", async () => {
    const t = rig({ shipped: SHIPPED, answers: [422] });
    const cat = [entry("awake"), entry("kria"), entry("vials")];
    expect(await t.s.refresh(cat)).toBe(false);
    expect(t.asked.length).toBe(1);
    expect(t.keptFile()!["absent"]).toEqual(["x/vials"]);
    t.later(RETRY_AFTER_MS + 1);
    expect(await t.s.refresh(cat)).toBe(false);
    expect(t.asked.length).toBe(1);
  });

  it("stops when it is told to, keeps what it had, and leaves it six hours", async () => {
    const many = Array.from({ length: 130 }, (_, i) => entry(`s${i}`));
    const t = rig({ shipped: SHIPPED, answers: [{ items: [item("x/s0", 7, "2020-01-01", "2020-02-02")] }, 403] });
    t.later(FRESH_FOR_MS);
    expect(await t.s.refresh(many)).toBe(true);
    expect(t.asked.length).toBe(2);
    expect(t.logged.join("\n")).toContain("GitHub answered 403");
    expect(t.s.get("s0")?.stars).toBe(7);
    expect(t.s.get("awake")?.stars).toBe(29);
    // Not counted as done: the day stays, and it is asked again — later.
    expect(t.s.asOf()).toBe("2026-11-20");
    expect(await t.s.refresh(many)).toBe(false);
    expect(t.asked.length).toBe(2);
    t.later(RETRY_AFTER_MS + 1);
    await t.s.refresh(many);
    expect(t.asked.length).toBe(5);
  });

  it("never fails: no network is a store that sorts by what it has", async () => {
    const t = rig({ shipped: SHIPPED, answers: [new Error("Failed to fetch")] });
    t.later(FRESH_FOR_MS);
    await expect(t.s.refresh([entry("awake")])).resolves.toBe(false);
    expect(t.s.get("awake")?.stars).toBe(29);
    expect(t.logged.join("\n")).toContain("Failed to fetch");
  });

  it("asks nothing of somebody who asked their browser to spend less", async () => {
    const t = rig({ shipped: SHIPPED, saveData: true });
    t.later(FRESH_FOR_MS * 4);
    expect(await t.s.refresh([entry("awake"), entry("new_one")])).toBe(false);
    expect(t.asked).toEqual([]);
  });

  it("has nothing to ask about an entry that is not on GitHub", async () => {
    const t = rig({ shipped: SHIPPED });
    t.later(FRESH_FOR_MS);
    expect(await t.s.refresh([entry("elsewhere", "https://codeberg.org/a/b")])).toBe(false);
    expect(t.asked).toEqual([]);
  });
});

describe("how a script stands here", () => {
  const blockers = JSON.parse(readFileSync(new URL("../public/community-blockers.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string[]>;
  };

  it("has nothing against a script with no note, whatever was once measured", () => {
    expect(standing("awake", [])).toBeNull();
    // A verdict outlives its cause only on paper: the note is the gate.
    expect(standing("tulpamancer", [])).toBeNull();
  });

  it("veils the picture of one that will not work, and only tags one that needs something", () => {
    const no = standing("tulpamancer", blockers.scripts["tulpamancer"]!)!;
    expect([no.verdict, no.label, no.veiled]).toEqual(["no", "won't work here", true]);
    expect(no.measured).toContain("line 46");
    const gone = standing("vials", blockers.scripts["vials"]!)!;
    expect([gone.verdict, gone.label, gone.veiled]).toEqual(["gone", "can't be installed", true]);
    const part = standing("pirate-radio", blockers.scripts["pirate-radio"]!)!;
    expect([part.verdict, part.label, part.veiled]).toEqual(["part", "incomplete here", true]);
    const needs = standing("cheat_codes_2", blockers.scripts["cheat_codes_2"]!)!;
    expect([needs.verdict, needs.label, needs.veiled]).toEqual(["needs", "needs a midi device", false]);
  });

  it("marks plainly one that has a note and was never measured", () => {
    const s = standing("added_since", ["the Foo engine is in no catalogue script"])!;
    expect([s.verdict, s.label, s.measured, s.veiled]).toEqual(["note", "something missing", "", false]);
  });

  it("has a verdict for every script in the table, and for none that has left it", () => {
    // Two files, one made by a tool and one written down after a run: this
    // is what says when one has moved and the other has not.
    expect([...VERDICT_NAMES].sort()).toEqual(Object.keys(blockers.scripts).sort());
    for (const name of VERDICT_NAMES) {
      const s = standing(name, blockers.scripts[name]!)!;
      expect(s.verdict).not.toBe("note");
      expect(s.measured.length).toBeGreaterThan(20);
    }
  });
});
