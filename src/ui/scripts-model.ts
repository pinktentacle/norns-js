// E9-208 — what the script store shows, worked out away from the page.
//
// It is laid out like an application store because that is the gesture
// people already know: a front page of shelves to wander along, categories,
// a search, a library of what is installed, and a page per script with one
// big button that says `get` and then says `open`.
//
// None of the questions behind that needs a DOM: which entries match what
// has been typed and which tags are chosen; what each tag would lead to
// from here; what goes on the front page today; and what to call a folder
// in `code/` the catalogue has never heard of.
//
// THE CATALOGUE HAS NO CHARTS OF ITS OWN. An entry is a name, an author, a
// sentence and some tags. E9-209: what is popular, what is new and what was
// touched last are read off the repository each entry points at
// (`community/meta.ts`) — stars and two dates — and everything here takes
// them as a question it may get no answer to: a script with no row sorts
// after the ones that have one, and with no rows at all the front page is
// what it was, the catalogue's tags turned into shelves whose fronts change
// with the day.

import { search, type CatalogEntry } from "../community/catalog.js";
import type { ScriptMeta } from "../community/meta.js";

export type StoreView = "discover" | "browse" | "installed";
/** `all`: every chosen tag. `any`: at least one of them. */
export type TagMatch = "all" | "any";

/** `popular`: most stars. `new`: published last. `updated`: pushed to last. */
export type SortBy = "name" | "popular" | "new" | "updated";
export const SORTS: ReadonlyArray<readonly [sort: SortBy, label: string, title: string]> = [
  ["name", "a–z", "by name"],
  ["popular", "popular", "most stars on GitHub first"],
  ["new", "new", "published most recently first"],
  ["updated", "updated", "changed most recently first"],
];

/** What is known about a script beyond the catalogue, or null. */
export type MetaOf = (name: string) => ScriptMeta | null;
const NO_META: MetaOf = () => null;

export interface BrowseQuery {
  readonly text: string;
  readonly tags: readonly string[];
  readonly match: TagMatch;
  /** Only what is installed. */
  readonly installedOnly?: boolean;
  readonly sort?: SortBy;
}

/**
 * Which of two scripts comes first under `sort`; 0 when it cannot say.
 * A script nothing is known about comes after every one that has a row.
 */
export function inOrder(sort: SortBy, meta: MetaOf): (a: CatalogEntry, b: CatalogEntry) => number {
  if (sort === "name") return () => 0;
  return (a, b) => {
    const ma = meta(a.name);
    const mb = meta(b.name);
    if (ma === null || mb === null) return ma === mb ? 0 : ma === null ? 1 : -1;
    if (sort === "popular") return mb.stars - ma.stars;
    const [da, db] = sort === "new" ? [ma.created, mb.created] : [ma.pushed, mb.pushed];
    return da === db ? 0 : da < db ? 1 : -1;
  };
}

const lower = (s: string): string => s.toLowerCase();

function hasTags(e: CatalogEntry, tags: readonly string[], match: TagMatch): boolean {
  if (tags.length === 0) return true;
  return match === "all" ? tags.every((t) => e.tags.includes(t)) : tags.some((t) => e.tags.includes(t));
}

/**
 * A folder in `code/` that is not a catalogue entry: something installed by
 * URL, a library, a script somebody is writing. It belongs in the library
 * like anything else that is there.
 */
export function localEntry(name: string): CatalogEntry {
  return {
    name,
    url: "",
    author: "",
    description: "in your code folder; not a catalogue entry",
    tags: [],
    discussion: null,
    documentation: null,
  };
}

/** The catalogue, plus whatever is installed that it does not list. */
export function withLocals(entries: readonly CatalogEntry[], installed: readonly string[]): CatalogEntry[] {
  const known = new Set(entries.map((e) => lower(e.name)));
  const locals = installed.filter((n) => !known.has(lower(n))).map(localEntry);
  return [...entries, ...locals];
}

/**
 * What to show, in the order to show it.
 *
 * Alphabetical, as the site is, or in the order asked for — except that
 * typing brings a name that BEGINS with what was typed to the front,
 * because that is nearly always the script being looked for.
 */
export function browse(
  entries: readonly CatalogEntry[],
  q: BrowseQuery,
  installed: ReadonlySet<string>,
  meta: MetaOf = NO_META,
): CatalogEntry[] {
  const text = q.text.trim();
  let out = search(entries, text).filter((e) => hasTags(e, q.tags, q.match));
  if (q.installedOnly === true) out = out.filter((e) => installed.has(lower(e.name)));
  const first = lower(text.split(/\s+/)[0] ?? "");
  const rank = (e: CatalogEntry): number => {
    if (first === "") return 0;
    const n = lower(e.name);
    return n === first ? 0 : n.startsWith(first) ? 1 : n.includes(first) ? 2 : 3;
  };
  const order = inOrder(q.sort ?? "name", meta);
  return out.sort((a, b) => rank(a) - rank(b) || order(a, b) || lower(a.name).localeCompare(lower(b.name)));
}

export interface TagRow {
  readonly tag: string;
  /** How many entries of the whole catalogue carry it. */
  readonly total: number;
  /** How many would be shown if this tag were toggled now. */
  readonly leads: number;
  readonly chosen: boolean;
}

/**
 * Every tag, with where it leads from here.
 *
 * `leads` is what makes a list of fifty tags navigable: with `sequencer`
 * chosen and `all` in force, `grid` says how many grid sequencers there are
 * and a tag that says 0 is a dead end before it is clicked.
 */
export function tagRows(
  entries: readonly CatalogEntry[],
  q: BrowseQuery,
  installed: ReadonlySet<string>,
): TagRow[] {
  const totals = new Map<string, number>();
  for (const e of entries) for (const t of e.tags) totals.set(t, (totals.get(t) ?? 0) + 1);
  const rows: TagRow[] = [];
  for (const [tag, total] of totals) {
    const chosen = q.tags.includes(tag);
    const next = chosen ? q.tags.filter((t) => t !== tag) : [...q.tags, tag];
    rows.push({ tag, total, chosen, leads: browse(entries, { ...q, tags: next }, installed).length });
  }
  return rows.sort((a, b) => b.total - a.total || a.tag.localeCompare(b.tag));
}

/** `12 scripts` · `1 script`, or a sentence when there is nothing. */
export function countLabel(n: number, installedOnly: boolean): string {
  if (n === 0) return installedOnly ? "nothing installed matches" : "no script matches";
  return `${n} script${n === 1 ? "" : "s"}${installedOnly ? " installed" : ""}`;
}

/** The file `norns.script.load` is given: `<name>/<name>.lua`, else the first there is. */
export function mainScript(name: string, files: readonly string[]): string | null {
  const dir = `/home/we/dust/code/${name}/`;
  const mine = files.filter((f) => lower(f).startsWith(lower(dir)) && !f.slice(dir.length).includes("/"));
  if (mine.length === 0) return null;
  const exact = mine.find((f) => lower(f) === lower(`${dir}${name}.lua`));
  return exact ?? [...mine].sort()[0]!;
}

// ---------------------------------------------------------------------------
// the front page
// ---------------------------------------------------------------------------

/**
 * The shelves, in the order somebody looking for an instrument would ask:
 * what kind of thing it is first, what it is played with after.
 */
export const SHELVES: ReadonlyArray<readonly [tag: string, title: string]> = [
  ["sequencer", "sequencers"],
  ["synth", "synths"],
  ["looper", "loopers"],
  ["sampler", "samplers"],
  ["granulator", "granular"],
  ["generative", "generative"],
  ["drum", "drums"],
  ["audio_fx", "effects"],
  ["delay", "delays"],
  ["drone", "drones"],
  ["art", "art"],
  ["utility", "utilities"],
  ["grid", "made for grid"],
  ["arc", "made for arc"],
  ["crow", "made for crow"],
  ["midi", "plays with midi"],
  ["keyboard", "keyboards"],
  ["mod", "mods"],
];

/** A small, even generator: the same day gives the same shelves everywhere. */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The entries in an order that depends on `seed` and nothing else. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** `2026-11-23` — a day, which is how often the front page changes. */
export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface Shelf {
  readonly tag: string;
  readonly title: string;
  /** How many the tag has in all; `entries` is the front of them. */
  readonly total: number;
  readonly entries: CatalogEntry[];
}

/** A shelf that is a ranking, not a kind. */
export interface Chart {
  readonly sort: Exclude<SortBy, "name">;
  readonly title: string;
  readonly entries: CatalogEntry[];
}

export const CHARTS: ReadonlyArray<readonly [sort: Chart["sort"], title: string]> = [
  ["popular", "popular"],
  ["new", "new"],
  ["updated", "recently updated"],
];

export interface FrontPage {
  /** One script to look at today, or null with an empty catalogue. */
  readonly pick: CatalogEntry | null;
  /** Empty when nothing is known beyond the catalogue. */
  readonly charts: Chart[];
  readonly shelves: Shelf[];
}

/**
 * Today's front page.
 *
 * `avoid` keeps a script that cannot run here from being TODAY'S PICK, and
 * from nothing else. E9-209: it used to keep them off the shelves too,
 * which hid from somebody browsing the one thing worth knowing before
 * pressing `get`. They are on the shelves now, marked.
 */
export function frontPage(
  entries: readonly CatalogEntry[],
  day: string,
  avoid: (name: string) => boolean = () => false,
  perShelf = 14,
  meta: MetaOf = NO_META,
): FrontPage {
  const sound = entries.filter((e) => !avoid(e.name));
  // A pick needs something to say for itself: a sentence, and a kind.
  const candidates = sound.filter((e) => e.description.trim().length > 12 && e.tags.length > 0);
  const pick = shuffled(candidates.length > 0 ? candidates : sound, hash(`pick:${day}`))[0] ?? null;

  const charts: Chart[] = [];
  const ranked = entries.filter((e) => meta(e.name) !== null);
  if (ranked.length >= 3) {
    for (const [sort, title] of CHARTS) {
      const order = inOrder(sort, meta);
      charts.push({
        sort,
        title,
        entries: [...ranked]
          .sort((a, b) => order(a, b) || lower(a.name).localeCompare(lower(b.name)))
          .slice(0, perShelf),
      });
    }
  }

  const shelves: Shelf[] = [];
  for (const [tag, title] of SHELVES) {
    const all = entries.filter((e) => e.tags.includes(tag));
    if (all.length < 3) continue;
    shelves.push({
      tag,
      title,
      total: all.length,
      entries: shuffled(all, hash(`${tag}:${day}`)).slice(0, perShelf),
    });
  }
  return { pick, charts, shelves };
}

// ---------------------------------------------------------------------------
// saying a number and a date in a card's corner
// ---------------------------------------------------------------------------

/** `61`, `1.2k`. */
export function starsLabel(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/[.]0$/, "") : Math.round(k)}k`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** `2020-08-27` → `aug 2020`. */
export function monthLabel(day: string): string {
  const month = MONTHS[Number(day.slice(5, 7)) - 1];
  return month === undefined ? day.slice(0, 4) : `${month} ${day.slice(0, 4)}`;
}

/** How long ago a day was, the way it is said: `3 weeks ago`. */
export function agoLabel(day: string, today: Date): string {
  const then = Date.parse(day);
  if (Number.isNaN(then)) return "";
  const days = Math.floor((today.getTime() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 61) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30.44)} months ago`;
  return `${Math.floor(days / 365.25)} years ago`;
}

/**
 * The one thing a card says beyond the catalogue: the number or the date
 * it is being sorted by, or its stars when it is sorted by neither.
 */
export function metaLabel(meta: ScriptMeta | null, sort: SortBy, today: Date): string {
  if (meta === null) return "";
  if (sort === "new") return monthLabel(meta.created);
  if (sort === "updated") return agoLabel(meta.pushed, today);
  return `★ ${starsLabel(meta.stars)}`;
}
