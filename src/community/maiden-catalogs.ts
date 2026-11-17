// E9-69 — the two files maiden leaves in the dust tree.
//
// `folio` browses the script library from the norns itself, and it reads
// that library off the disk rather than off the network:
//
//     scripts, script_names = load_catalogs({
//       paths.data..'catalogs/base.json',
//       paths.data..'catalogs/community.json',
//     })
//
// Neither file is folio's, and neither is norns'. MAIDEN writes them.
// maiden ships two descriptors, `sources/base.json` and
// `sources/community.json`, and each one is four lines naming a method and
// a url:
//
//     { "source": { "name": "community", "method": "download",
//                   "parameters": { "url": "https://raw.githubusercontent.com/
//                                          monome/norns-community/main/
//                                          community.json" } } }
//
// and `pkg/dust/layout.go` says where the download lands: `DataDir()` is
// `<dust>/data`, so the pair arrives as `~/dust/data/catalogs/<name>.json`.
// That is the whole of what "refresh the library in maiden" does to the
// disk, and it is the sentence folio prints when the files are not there.
//
// SO THIS IS NOT A BUG IN FOLIO AND NOT ONE TO PATCH IN ITS LUA. It is a
// file the platform provides and this build did not. The community panel
// already fetches the second of those two urls — it IS our catalogue — so
// the only thing missing was to leave the bytes where maiden leaves them,
// and to fetch the four-entry base catalogue beside them.
//
// VERBATIM, and that is the one decision here worth defending. What is
// written is the bytes that came back, not a re-serialisation of the shape
// `parseCatalog` keeps. folio reads `js['entries']` and then takes
// `project_name`, `project_url`, `author`, `description` and `tags` off
// each entry; a round trip through our own parser would drop every field
// this app has no use for, and the next script to read these files would
// find a catalogue quietly narrower than the one maiden writes. The file
// maiden leaves is the file it downloaded. So is this one.
//
// STILL NOT VENDORED. `catalog.ts` says why a copy of the catalogue is not
// in this repository — it goes stale the day it is made, and it is somebody
// else's work to maintain — and nothing here changes that. These are
// fetched when the panel opens, which is this build's "refresh the
// library", and written where a refresh writes them.

import type { Vfs } from "../fs/vfs.js";
import { CATALOG_URL, parseCatalog, type Catalog } from "./catalog.js";

/** Where `pkg/dust/layout.go` puts them: `DataDir()` + `catalogs`. */
export const CATALOGS_DIR = "/home/we/dust/data/catalogs";

export interface CatalogSource {
  /** The file's name on disk, and maiden's `catalog_name` for it. */
  readonly name: string;
  readonly url: string;
}

/**
 * maiden's two `sources/*.json`, read out as the urls they name.
 *
 * `base` first because folio reads it first and gives up on the first file
 * it cannot open. It is four entries — crow-studies, firstlight, fledge,
 * softcut-studies — and 1.2 kB; `community` is 355 and about 90.
 */
export const CATALOG_SOURCES: readonly CatalogSource[] = [
  { name: "base", url: "https://raw.githubusercontent.com/monome/norns-community/main/base.json" },
  { name: "community", url: CATALOG_URL },
];

interface Fetched {
  readonly source: CatalogSource;
  readonly text: string | null;
  readonly error: string;
}

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function one(source: CatalogSource, f: typeof fetch): Promise<Fetched> {
  try {
    const res = await f(source.url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    // Parsed and then THROWN AWAY: the check is that this is a catalogue
    // and not a proxy's login page, and what gets written is the text.
    const root = JSON.parse(text) as Record<string, unknown>;
    if (!Array.isArray(root["entries"])) throw new Error("no entries array");
    return { source, text, error: "" };
  } catch (e) {
    return { source, text: null, error: why(e) };
  }
}

/**
 * Fetch both catalogues, write them where maiden writes them, and return
 * the community one parsed for the panel.
 *
 * ONE fetch of `community.json`, not two: the panel's catalogue and the
 * file on disk are the same download. The base catalogue is fetched
 * alongside it and is NOT required — if it does not arrive, the community
 * one is still written and still returned, and the log says what is
 * missing. folio reads both, so folio will still stop; everything else
 * carries on.
 */
export async function fetchAndStoreCatalogs(
  vfs: Vfs,
  opts: { log?: (line: string) => void; fetchImpl?: typeof fetch } = {},
): Promise<Catalog> {
  const f = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const got = await Promise.all(CATALOG_SOURCES.map((s) => one(s, f)));

  const community = got.find((g) => g.source.name === "community");
  if (community === undefined || community.text === null) {
    // The panel cannot open without it, and said so before this existed.
    throw new Error(`${CATALOG_URL}: ${community?.error ?? "not fetched"}`);
  }

  vfs.mkdir(CATALOGS_DIR);
  for (const g of got) {
    const path = `${CATALOGS_DIR}/${g.source.name}.json`;
    if (g.text === null) {
      opts.log?.(`catalogs: ${g.source.name}.json did not arrive (${g.error}) — folio reads both`);
      continue;
    }
    // Byte-identical is not a write. The panel opens many times in a
    // session and this is 90 kB through the OPFS mirror each time.
    if (vfs.readText(path) === g.text) continue;
    vfs.write(path, g.text);
    opts.log?.(`catalogs: wrote ${path}`);
  }

  return parseCatalog(JSON.parse(community.text));
}
