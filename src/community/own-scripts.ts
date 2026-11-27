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
// E9-278 — AND LISTED, so that a new one needs no release. Each of them is
// its own public repository (pinktentacle/poche, …), and the list of them —
// this same index.json, naming each one's repository and cover — is
// published on its own in OWN_LIST_REPO by `tools/publish-own-scripts.ps1`.
// The page reads that list first (raw.githubusercontent sends CORS, and the
// desktop shell's policy allows it) and installs a listed script from its
// repository, as it installs any catalogue script. A script added to the
// list is in every copy of the page — the site, the portable copy, the
// desktop app — the next time it starts, without a build. The copy served
// beside the page stays, as what is offered when GitHub cannot be reached,
// and for a script the list does not have yet.
//
// Nothing here is written into `~/dust/data/catalogs`: those two files are
// maiden's, `folio` reads them, and on a norns they would not have these
// scripts in them either. The entries are added to what the STORE is shown,
// and nowhere else.

import type { Catalog, CatalogEntry } from "./catalog.js";

/** Where the page serves them, relative to the page. */
export const OWN_DIR = "own-scripts/";

/** The public repository that holds only the list of them (E9-278). */
export const OWN_LIST_REPO = "pinktentacle/norns-js-scripts";

/** The list, from its default branch. */
export const OWN_LIST = `https://raw.githubusercontent.com/${OWN_LIST_REPO}/main/index.json`;

/** `https://github.com/<owner>/<repo>` and nothing else: what a listed script must name. */
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/;

/** The tag every one of them carries, which is also the store's shelf. */
export const OWN_TAG = "norns-js";

/** `own-scripts/` against the page, as an absolute url ending in `/`. */
export function ownBase(page: string): string {
  return new URL(OWN_DIR, page).href;
}

export function isOwnUrl(url: string, base: string): boolean {
  return url.startsWith(base) && url.length > base.length;
}

/**
 * Where a person reads about one of them: its repository when it came from
 * the published list, else its README beside the page.
 */
export function ownPage(url: string): string {
  if (GITHUB_REPO.test(url)) return url.replace(/\/+$/, "");
  return `${url.replace(/\/*$/, "/")}README.md`;
}

/**
 * The published list (E9-278): the same index, read for each script's
 * repository and cover. An entry without a GitHub repository, or with a
 * cover path that leaves it, is dropped: the list is fetched, and a page
 * that installs from what a fetched file names checks what it names.
 */
export function parseOwnList(value: unknown): CatalogEntry[] {
  const root = (value ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(root["scripts"]) ? (root["scripts"] as unknown[]) : [];
  const out: CatalogEntry[] = [];
  for (const item of raw) {
    const e = (item ?? {}) as Record<string, unknown>;
    const name = str(e["name"]);
    const repo = GITHUB_REPO.exec(str(e["repo"]));
    if (name === "" || !/^[a-z0-9_-]+$/i.test(name) || repo === null) continue;
    const coverPath = str(e["cover"]);
    const okCover = coverPath !== "" && /^[A-Za-z0-9_./-]+$/.test(coverPath) && !coverPath.split("/").includes("..");
    const tags = Array.isArray(e["tags"]) ? (e["tags"] as unknown[]).map(str).filter(Boolean) : [];
    out.push({
      name,
      url: `https://github.com/${repo[1]}/${repo[2]}`,
      author: str(e["author"]),
      description: str(e["description"]),
      tags: tags.includes(OWN_TAG) ? tags : [...tags, OWN_TAG],
      discussion: null,
      documentation: null,
      ...(okCover ? { cover: `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/HEAD/${coverPath}` } : {}),
    });
  }
  return out;
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
 *
 * E9-278 — with `remote` (the published list's address), that list is
 * asked for too, and wins: a script in both is installed from its own
 * repository, which can change without a release. One only beside the
 * page is still offered. A list that does not answer in `timeoutMs`
 * counts as not answering.
 */
export function createOwnScripts(opts: {
  base: string;
  remote?: string;
  fetchJson?: (url: string) => Promise<unknown>;
  log?: (line: string) => void;
  timeoutMs?: number;
}): { load(): Promise<CatalogEntry[]>; last(): CatalogEntry[] } {
  const fetchJson =
    opts.fetchJson ??
    (async (url: string): Promise<unknown> => {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    });
  const why = (e: unknown): string => String((e as Error)?.message ?? e);
  const timed = (p: Promise<unknown>): Promise<unknown> =>
    new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error("no answer")), opts.timeoutMs ?? 8000);
      p.then(
        (v) => (clearTimeout(t), ok(v)),
        (e: unknown) => (clearTimeout(t), fail(e)),
      );
    });
  let last: CatalogEntry[] = [];
  let asked: Promise<CatalogEntry[]> | null = null;
  let toldRemote = false;
  return {
    load() {
      if (opts.remote === undefined) {
        asked ??= fetchJson(`${opts.base}index.json`).then(
          (v) => (last = parseOwnIndex(v, opts.base)),
          (e: unknown) => {
            opts.log?.(`scripts: the scripts made for norns-js did not arrive (${why(e)})`);
            asked = null;
            return last;
          },
        );
        return asked;
      }
      const remote = opts.remote;
      asked ??= Promise.allSettled([timed(fetchJson(remote)), fetchJson(`${opts.base}index.json`)]).then(
        ([r, l]) => {
          if (r.status === "rejected" && l.status === "rejected") {
            opts.log?.(`scripts: the scripts made for norns-js did not arrive (${why(r.reason)}; ${why(l.reason)})`);
            asked = null;
            return last;
          }
          if (r.status === "rejected" && !toldRemote) {
            toldRemote = true;
            opts.log?.(`scripts: the published list of scripts made for norns-js could not be read (${why(r.reason)}); offering the copy in this build`);
          }
          const published = r.status === "fulfilled" ? parseOwnList(r.value) : [];
          const here = l.status === "fulfilled" ? parseOwnIndex(l.value, opts.base) : [];
          const have = new Set(published.map((e) => e.name.toLowerCase()));
          last = [...published, ...here.filter((e) => !have.has(e.name.toLowerCase()))];
          // Asked again next time when the published list did not come.
          if (r.status === "rejected") asked = null;
          return last;
        },
      );
      return asked;
    },
    last: () => last,
  };
}
