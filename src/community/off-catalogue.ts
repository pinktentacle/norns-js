// E9-71 — the libraries that are real without being in the catalogue.
//
// `needs.ts` used to say a library outside the catalogue "is passed over,
// which is correct: there would be nothing to offer". That was true only
// because nobody had looked. E9-70 looked, because the blockers table had
// ten notes of the shape "the X library is not in the catalogue" and every
// one of them was wrong: eight of the scripts ran anyway, and all six
// libraries exist. Each was fetched and checked to hold the exact file its
// script asks for; `off-catalogue.json` records where, and what turns it
// on.
//
// ONE FILE, THREE READERS. `needs.ts` turns a head into something the
// install queue can fetch, `maiden-project.ts` uses it to give an
// installed library an `update` button instead of "not in the catalogue,
// so there is nothing to update it from", and `tools/build-blockers.mjs`
// reads the same JSON so a note and an install cannot disagree about where
// something is.
//
// WORTH SAYING PLAINLY, because it is a judgement and not a measurement:
// all six are OPTIONAL. Each sits behind a guard the script writes — a mod
// that has to be enabled, a folder it tests for, a device that has to be
// plugged in, a constant shipped `false` — and all eight scripts that ask
// for one were measured running without it. Installing them alongside the
// script is a decision about what somebody should have left to do, which
// is enable the mod or plug the thing in. It is not a claim that the
// script was broken.

import offCatalogue from "./off-catalogue.json";
import type { CatalogEntry } from "./catalog.js";

interface Library {
  readonly name: string;
  readonly url: string;
  readonly file: string;
  readonly wanted_by: readonly string[];
  readonly guard: string;
  readonly what: string;
  /**
   * E9-203 — the path a script asks for it by INSIDE ITS OWN FOLDER while
   * carrying no such file: `require "metronome/lib/nb"` in a repository
   * with no `lib/`. See `CARRIED`.
   */
  readonly carried_as?: readonly string[];
}

const LIBRARIES = offCatalogue.libraries as Record<string, Library>;

/** `https://github.com/cfdrake/shnth` -> `cfdrake`. */
const owner = (url: string): string => url.split("/").slice(-2)[0] ?? "";

/**
 * Shaped into catalogue entries on purpose.
 *
 * Everything downstream — the queue, the progress strip, `remove` on the
 * installed tab, `update` — already knows how to handle an entry, and a
 * library that arrived by a different road would be a second thing to
 * maintain for no gain.
 */
export const OFF_CATALOGUE: ReadonlyMap<string, CatalogEntry> = new Map(
  Object.entries(LIBRARIES).map(([head, v]) => [
    head,
    {
      name: v.name,
      url: v.url,
      author: owner(v.url),
      description: v.what,
      tags: [],
      discussion: null,
      documentation: null,
    } satisfies CatalogEntry,
  ]),
);

/**
 * E9-203 — a library a script asks for as a file of its own and does not ship.
 *
 * `lib/nb` -> `{ library: "nb", module: "nb/lib/nb" }`. Two readers:
 * `needs.ts` installs the library with the script, and the Lua searcher in
 * `lua/host.ts` answers the `require` from the installed copy. NOTHING IS
 * WRITTEN INTO THE SCRIPT'S FOLDER — that was the objection to fixing
 * `metronome` in E9-73, and it still stands: the file is not theirs to be
 * given. The `require` is answered from where the library really is.
 */
export const CARRIED: ReadonlyMap<string, { readonly library: string; readonly module: string }> = new Map(
  Object.entries(LIBRARIES).flatMap(([head, v]) =>
    (v.carried_as ?? []).map(
      (tail) => [tail, { library: head, module: `${v.name}/${v.file.replace(/\.lua$/, "")}` }] as const,
    ),
  ),
);

/** The entry for an off-catalogue library, by the folder name a script uses. */
export function offCatalogueEntry(name: string): CatalogEntry | null {
  return OFF_CATALOGUE.get(name.toLowerCase()) ?? null;
}
