// E9-209 — what the catalogue does not say: how many stars a script has,
// when it was first published and when it was last touched.
//
// The catalogue is a name, an author, a sentence and some tags. "Popular"
// and "new" are questions about the REPOSITORY each entry points at, and
// GitHub answers them for sixty repositories in one unauthenticated search
// (`repo:a/b repo:c/d …`), with `Access-Control-Allow-Origin: *`. Six
// requests cover all 355.
//
// THREE COPIES, AND THE NEWEST ONE WINS.
//
//   shipped   `/community-meta.json`, written by `tools/build-meta.mjs`.
//             What a first visit, a visit with no network and the desktop
//             application start from: the charts are there at once.
//   kept      the last answer this browser got, in Cache Storage.
//   asked     GitHub, when what is held is more than a week old — or when
//             the catalogue has grown a script that neither copy has
//             heard of, which is exactly the script "new" is for.
//
// IT IS NEVER IN THE WAY. Every failure here — no table shipped, a cache
// that will not open, GitHub saying "later" — leaves a store that sorts by
// name, which is what it did before this file existed. Ten searches a
// minute is the anonymous allowance; a refresh that is told to stop stops,
// keeps what it had, and does not try again for six hours.
//
// WHAT A STAR IS NOT. It is a count on a repository, given by people with
// a GitHub account, since the day it was made: old scripts have had longer
// to collect them, and a script is not better for having more. The store
// calls the shelf "popular" and shows the number, and that is all it says.

import type { CatalogEntry } from "./catalog.js";
import { parseRepoUrl } from "./install.js";

export interface ScriptMeta {
  readonly stars: number;
  /** `2019-02-17` — the day the repository was made. */
  readonly created: string;
  /** The day of the last push. */
  readonly pushed: string;
}

export interface MetaStore {
  /** Resolves when `get` can answer from the shipped and the kept copies. */
  ready(): Promise<void>;
  get(name: string): ScriptMeta | null;
  /** How many scripts have a row. */
  size(): number;
  /** The day the numbers are from, or null when there are none. */
  asOf(): string | null;
  /**
   * Ask GitHub, if what is held is old or the catalogue has outgrown it.
   * Resolves true when a row changed. Never rejects.
   */
  refresh(entries: readonly CatalogEntry[]): Promise<boolean>;
  onChange(listener: () => void): () => void;
}

export interface MetaStoreOptions {
  /** The shipped table. */
  readonly url?: string;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Cache Storage, or null to do without. */
  readonly caches?: Pick<CacheStorage, "open"> | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
  /** Somebody has asked their browser to spend less: nothing is refreshed. */
  readonly saveData?: () => boolean;
}

export const META_URL = "/community-meta.json";
export const META_CACHE = "norns-js-meta-1";
/**
 * The name the kept copy goes under. Cache Storage keys are http(s) URLs
 * and the desktop application's own address is neither, so this is a name
 * and not a place: `.invalid` resolves nowhere, by definition.
 */
export const META_KEY = "https://norns-js.invalid/community-meta.json";
export const SEARCH_URL = "https://api.github.com/search/repositories";
/** Sixty was measured to answer; the page size caps it at a hundred. */
export const PER_QUERY = 60;
export const FRESH_FOR_MS = 7 * 24 * 3600 * 1000;
export const RETRY_AFTER_MS = 6 * 3600 * 1000;
/** Between two searches. Ten a minute is the allowance. */
export const GAP_MS = 1500;

const DAY = /^\d{4}-\d{2}-\d{2}/;
const day = (v: unknown): string => (typeof v === "string" && DAY.test(v) ? v.slice(0, 10) : "");

function metaOf(stars: unknown, created: unknown, pushed: unknown): ScriptMeta | null {
  const c = day(created);
  if (typeof stars !== "number" || !Number.isFinite(stars) || c === "") return null;
  return { stars: Math.max(0, Math.round(stars)), created: c, pushed: day(pushed) || c };
}

export interface MetaFile {
  /** The day it was made. */
  readonly generated: string | null;
  /** By script name, lower-cased. */
  readonly scripts: Map<string, ScriptMeta>;
  /** When GitHub last answered for everything, in ms. Kept copies only. */
  readonly checked: number;
  /** When it was last asked at all, answered or not. */
  readonly tried: number;
  /** Repositories a whole refresh asked for and was not given. */
  readonly absent: readonly string[];
}

/** Somebody else's file, or an old one of ours: every field is checked. */
export function parseMeta(value: unknown): MetaFile {
  const root = (value ?? {}) as Record<string, unknown>;
  const scripts = new Map<string, ScriptMeta>();
  const raw = (root["scripts"] ?? {}) as Record<string, unknown>;
  if (typeof raw === "object" && raw !== null) {
    for (const [name, v] of Object.entries(raw)) {
      if (!Array.isArray(v)) continue;
      const m = metaOf(v[0], v[1], v[2]);
      if (m !== null) scripts.set(name.toLowerCase(), m);
    }
  }
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const generated = day(root["generated"]) || null;
  return {
    generated,
    scripts,
    checked: num(root["checked"]),
    tried: num(root["tried"]),
    absent: Array.isArray(root["absent"]) ? (root["absent"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
  };
}

/** `owner/repo` for an entry, or null when it is not on GitHub. */
export function repoKey(entry: CatalogEntry): string | null {
  const r = parseRepoUrl(entry.url);
  return r === null ? null : `${r.owner}/${r.repo}`;
}

/** The searches that ask about `repos`, sixty to a request. */
export function searchUrls(repos: readonly string[], per = PER_QUERY): string[] {
  const out: string[] = [];
  for (let i = 0; i < repos.length; i += per) {
    const q = repos
      .slice(i, i + per)
      .map((r) => `repo:${r}`)
      .join("+");
    // `fork:true`, or a script that is a fork of another is not found.
    out.push(`${SEARCH_URL}?q=${q}+fork:true&per_page=100`);
  }
  return out;
}

/** A search's answer, by `owner/repo` lower-cased. */
export function readSearch(body: unknown): Map<string, ScriptMeta> {
  const out = new Map<string, ScriptMeta>();
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    const r = (item ?? {}) as Record<string, unknown>;
    const name = r["full_name"];
    const m = metaOf(r["stargazers_count"], r["created_at"], r["pushed_at"]);
    if (typeof name === "string" && m !== null) out.set(name.toLowerCase(), m);
  }
  return out;
}

const same = (a: ScriptMeta | undefined, b: ScriptMeta): boolean =>
  a !== undefined && a.stars === b.stars && a.created === b.created && a.pushed === b.pushed;

export function createMetaStore(opts: MetaStoreOptions = {}): MetaStore {
  const url = opts.url ?? META_URL;
  const doFetch = opts.fetch ?? ((u: string, init?: RequestInit) => fetch(u, init));
  const storage = opts.caches === undefined ? (globalThis.caches ?? null) : opts.caches;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});

  const scripts = new Map<string, ScriptMeta>();
  let asOf: string | null = null;
  let checked = 0;
  let tried = 0;
  let absent: string[] = [];
  const listeners = new Set<() => void>();
  const tell = (): void => {
    for (const l of listeners) l();
  };

  let cache: Promise<Cache | null> | null = null;
  const opened = (): Promise<Cache | null> =>
    (cache ??= storage === null ? Promise.resolve(null) : storage.open(META_CACHE).then((c) => c, () => null));

  const shipped = async (): Promise<MetaFile | null> => {
    try {
      const res = await doFetch(url);
      return res.ok ? parseMeta(await res.json()) : null;
    } catch {
      return null;
    }
  };
  const kept = async (): Promise<MetaFile | null> => {
    try {
      const res = await (await opened())?.match(META_KEY);
      return res === undefined ? null : parseMeta(await res.json());
    } catch {
      return null;
    }
  };
  const keep = async (): Promise<void> => {
    const body = {
      generated: asOf,
      checked,
      tried,
      absent,
      scripts: Object.fromEntries([...scripts].map(([n, m]) => [n, [m.stars, m.created, m.pushed]])),
    };
    try {
      await (await opened())?.put(
        META_KEY,
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      );
    } catch {
      /* full, or refused: it is asked for again another day */
    }
  };

  let loaded: Promise<void> | null = null;
  const ready = (): Promise<void> =>
    (loaded ??= (async () => {
      const [a, b] = await Promise.all([shipped(), kept()]);
      // The older one first, the newer one over it: a release that ships a
      // newer table than the one this browser kept must not lose to it.
      const when = (f: MetaFile | null): number =>
        f === null ? -1 : Math.max(f.checked, f.generated === null ? 0 : Date.parse(f.generated) || 0);
      const order = [a, b].filter((f): f is MetaFile => f !== null).sort((x, y) => when(x) - when(y));
      for (const f of order) {
        for (const [n, m] of f.scripts) scripts.set(n, m);
        if (f.generated !== null) asOf = f.generated;
      }
      const newest = order[order.length - 1];
      checked = newest === undefined ? 0 : when(newest);
      // What was tried and what was absent is only ever the kept copy's to say.
      tried = b?.tried ?? 0;
      absent = [...(b?.absent ?? [])];
    })());

  let refreshing: Promise<boolean> | null = null;
  const refresh = (entries: readonly CatalogEntry[]): Promise<boolean> =>
    (refreshing ??= (async () => {
      await ready();
      if (opts.saveData?.() === true) return false;
      const t = now();
      if (t - tried < RETRY_AFTER_MS) return false;

      // Whose rows a repository's answer fills.
      const names = new Map<string, { repo: string; names: string[] }>();
      for (const e of entries) {
        const repo = repoKey(e);
        if (repo === null) continue;
        const slot = names.get(repo.toLowerCase()) ?? { repo, names: [] };
        slot.names.push(e.name.toLowerCase());
        names.set(repo.toLowerCase(), slot);
      }
      const stale = t - checked >= FRESH_FOR_MS;
      const gone = new Set(absent.map((r) => r.toLowerCase()));
      const wanted = [...names]
        .filter(([key, w]) => stale || (!gone.has(key) && w.names.some((n) => !scripts.has(n))))
        .map(([, w]) => w.repo);
      if (wanted.length === 0) return false;

      tried = t;
      let changed = false;
      let whole = true;
      const answered = new Set<string>();
      const urls = searchUrls(wanted);
      for (let i = 0; i < urls.length; i++) {
        if (i > 0) await sleep(GAP_MS);
        let res: Response;
        try {
          res = await doFetch(urls[i]!, { headers: { accept: "application/vnd.github+json" }, credentials: "omit" });
        } catch (e) {
          log(`scripts: the charts were not refreshed — ${(e as Error).message}`);
          whole = false;
          break;
        }
        // 422 is "none of these exists", which is an answer and not a refusal.
        if (res.status === 422) continue;
        if (!res.ok) {
          log(`scripts: the charts were not refreshed — GitHub answered ${res.status}; what is held is kept`);
          whole = false;
          break;
        }
        let found: Map<string, ScriptMeta>;
        try {
          found = readSearch(await res.json());
        } catch {
          whole = false;
          break;
        }
        for (const [key, m] of found) {
          answered.add(key);
          for (const n of names.get(key)?.names ?? []) {
            if (!same(scripts.get(n), m)) changed = true;
            scripts.set(n, m);
          }
        }
      }
      if (whole) {
        // A repository asked for and not given: renamed, or gone. It keeps
        // the row it has, and is not what triggers the next request.
        const missing = wanted.filter((r) => !answered.has(r.toLowerCase()));
        absent = stale ? missing : [...new Set([...absent, ...missing])];
        if (stale) {
          checked = t;
          asOf = new Date(t).toISOString().slice(0, 10);
        }
      }
      await keep();
      if (changed) tell();
      return changed;
    })().then(
      (v) => {
        refreshing = null;
        return v;
      },
      () => {
        refreshing = null;
        return false;
      },
    ));

  return {
    ready,
    get: (name) => scripts.get(name.toLowerCase()) ?? null,
    size: () => scripts.size,
    asOf: () => asOf,
    refresh,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
