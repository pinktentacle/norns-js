// E9-213 — SCRIPTS MADE FOR NORNS-JS, in the store before they are in the
// catalogue.
//
// They are served by the page itself, from `own-scripts/` (written into
// `public/` by `tools/build-own-scripts.mjs`): an `index.json` naming them,
// and for each one its folder, a `files.json` listing what is in it, and a
// `cover.png` for the store. An entry's url is that folder on this origin,
// which is all the installer needs to tell one from a GitHub repository —
// see `Repo.base` in `install.ts`.
//
// Nothing here is written into `~/dust/data/catalogs`: those two files are
// maiden's, `folio` reads them, and on a norns they would not have these
// scripts in them either. The entries are added to what the STORE is shown,
// and nowhere else.

import type { Catalog, CatalogEntry } from "./catalog.js";

/** Where the page serves them, relative to the page. */
export const OWN_DIR = "own-scripts/";

/** The tag every one of them carries, which is also the store's shelf. */
export const OWN_TAG = "norns-js";

/** `own-scripts/` against the page, as an absolute url ending in `/`. */
export function ownBase(page: string): string {
  return new URL(OWN_DIR, page).href;
}

export function isOwnUrl(url: string, base: string): boolean {
  return url.startsWith(base) && url.length > base.length;
}

/** The script's folder name, from its url. */
export function ownName(url: string, base: string): string {
  return url.slice(base.length).replace(/\/+$/, "").split("/")[0] ?? "";
}

/** The picture the store shows for one of them. */
export function ownCover(url: string): string {
  return `${url.replace(/\/*$/, "/")}cover.png`;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * `index.json`, read the way `parseCatalog` reads someone else's file:
 * every field checked, an entry without a name dropped. It is ours, but it
 * is fetched, and a page that falls over on a bad index is worse than a
 * store without these scripts.
 */
export function parseOwnIndex(value: unknown, base: string): CatalogEntry[] {
  const root = (value ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(root["scripts"]) ? (root["scripts"] as unknown[]) : [];
  const out: CatalogEntry[] = [];
  for (const item of raw) {
    const e = (item ?? {}) as Record<string, unknown>;
    const name = str(e["name"]);
    if (name === "" || !/^[a-z0-9_-]+$/i.test(name)) continue;
    const tags = Array.isArray(e["tags"]) ? (e["tags"] as unknown[]).map(str).filter(Boolean) : [];
    out.push({
      name,
      url: `${base}${name}/`,
      author: str(e["author"]),
      description: str(e["description"]),
      tags: tags.includes(OWN_TAG) ? tags : [...tags, OWN_TAG],
      discussion: null,
      documentation: null,
    });
  }
  return out;
}

/**
 * The catalogue with them added, sorted the way `parseCatalog` sorts.
 *
 * A catalogue entry of the same name wins: when one of these is published
 * on norns.community, the store should offer it from there, and showing
 * both would be two buttons for one script.
 */
export function withOwn(catalog: Catalog, own: readonly CatalogEntry[]): Catalog {
  if (own.length === 0) return catalog;
  const have = new Set(catalog.entries.map((e) => e.name.toLowerCase()));
  const added = own.filter((e) => !have.has(e.name.toLowerCase()));
  if (added.length === 0) return catalog;
  const entries = [...catalog.entries, ...added].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  return { ...catalog, entries };
}

/**
 * Fetch the index once, and remember the answer.
 *
 * `kept` is what the store opens on before the network has answered, and
 * it is synchronous, so the last list is held here for it. A failure is an
 * empty list and a line in the log, never an exception: the store must
 * open whether or not this part of the page arrived.
 */
export function createOwnScripts(opts: {
  base: string;
  fetchJson?: (url: string) => Promise<unknown>;
  log?: (line: string) => void;
}): { load(): Promise<CatalogEntry[]>; last(): CatalogEntry[] } {
  const fetchJson =
    opts.fetchJson ??
    (async (url: string): Promise<unknown> => {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    });
  let last: CatalogEntry[] = [];
  let asked: Promise<CatalogEntry[]> | null = null;
  return {
    load() {
      asked ??= fetchJson(`${opts.base}index.json`).then(
        (v) => (last = parseOwnIndex(v, opts.base)),
        (e: unknown) => {
          opts.log?.(`scripts: the scripts made for norns-js did not arrive (${String((e as Error)?.message ?? e)})`);
          asked = null;
          return last;
        },
      );
      return asked;
    },
    last: () => last,
  };
}
