// E6-11 — the community script index, read live.
//
// norns.community is a catalogue of what people have written for norns. The
// site at norns.community is BUILT from a single file, and its build script
// says where that file lives:
//
//     curl https://raw.githubusercontent.com/monome/norns-community/main/community.json
//
// So that is what this reads. Not the rendered HTML — scraping a page is a
// promise to break every time someone touches a stylesheet, and the data
// behind it is right there: 354 entries, each with a name, a repository, an
// author, a line of description, links and tags.
//
// LIVE, AND NOT VENDORED. The file is fetched when the dialogue opens and
// never written into this repository. Two reasons, and the second is the
// one that matters: a copy goes stale the day it is made, and the catalogue
// is somebody else's work to maintain. We read it the way a browser reads
// it.
//
// IT IS FETCHABLE AT ALL, which was not obvious and was measured rather than
// assumed. The page is cross-origin isolated for SharedArrayBuffer, so every
// cross-origin read has to be a CORS response or it is refused before it
// starts. raw.githubusercontent sends CORS; GitHub's zip endpoints do not.
// See `install.ts` for what that cost.

export const CATALOG_URL =
  "https://raw.githubusercontent.com/monome/norns-community/main/community.json";

export interface CatalogEntry {
  readonly name: string;
  /** The repository, which is what `install.ts` needs. */
  readonly url: string;
  readonly author: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly discussion: string | null;
  readonly documentation: string | null;
}

export interface Catalog {
  readonly name: string;
  readonly date: string | null;
  readonly entries: readonly CatalogEntry[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The entry's page on norns.community.
 *
 * Not guessed. The site's build script (monome-community/norns-community,
 * `02-build.py`) derives both the output file and the permalink from the
 * project name through one function:
 *
 *     def sanitize(str):
 *         return re.sub('[^a-zA-Z0-9\-_]', '', str)
 *     self.permalink = '/' + self.sanitized_name + '/'
 *
 * which STRIPS rather than transforms: it does not lower-case, and it does
 * not turn a space into a dash — the space simply goes. The surprising cases
 * are the ones worth stating, and all three were fetched to confirm:
 *
 *     carter's delay  ->  /cartersdelay/     apostrophe and space removed
 *     nørgård         ->  /nrgrd/            non-ASCII letters removed
 *     xD1             ->  /xD1/              case kept
 *
 * A name that sanitizes to nothing would make a link to the site's root, so
 * that returns null and the row simply has no details link.
 */
export function communityUrl(projectName: string): string | null {
  const slug = projectName.replace(/[^a-zA-Z0-9\-_]/g, "");
  return slug === "" ? null : `https://norns.community/${slug}/`;
}

/**
 * Whether two links land on the same page, for hiding a duplicate.
 *
 * Ten of the catalogue's 354 entries give their documentation_url as their
 * own norns.community page — written without the trailing slash the site's
 * permalink has, which is why this is a comparison and not an equality.
 */
export function samePage(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (u: string): string => u.replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Read the catalogue's own shape, keeping only entries we could act on.
 *
 * Someone else's file, so every field is checked rather than assumed: an
 * entry with no repository is one the install button could not do anything
 * with, and showing it would be offering something that cannot happen.
 */
export function parseCatalog(value: unknown): Catalog {
  const root = (value ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(root["entries"]) ? (root["entries"] as unknown[]) : [];
  const entries: CatalogEntry[] = [];
  for (const item of raw) {
    const e = (item ?? {}) as Record<string, unknown>;
    const name = str(e["project_name"]);
    const url = str(e["project_url"]);
    if (name === "" || url === "") continue;
    entries.push({
      name,
      url,
      author: str(e["author"]),
      description: str(e["description"]),
      tags: Array.isArray(e["tags"]) ? (e["tags"] as unknown[]).map(str).filter(Boolean) : [],
      discussion: str(e["discussion_url"]) || null,
      documentation: str(e["documentation_url"]) || null,
    });
  }
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return {
    name: str(root["catalog_name"]) || "norns.community",
    date: str(root["date"]) || null,
    entries,
  };
}

export async function fetchCatalog(url = CATALOG_URL): Promise<Catalog> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return parseCatalog(await res.json());
}

/** Entries matching a query over name, author, description and tags. */
export function search(entries: readonly CatalogEntry[], query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...entries];
  // Every word has to appear somewhere, which is what makes "grid sequencer"
  // narrow rather than widen.
  const words = q.split(/\s+/);
  return entries.filter((e) => {
    const hay = `${e.name} ${e.author} ${e.description} ${e.tags.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Every tag in the catalogue, commonest first. */
export function tagCounts(entries: readonly CatalogEntry[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const e of entries) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
