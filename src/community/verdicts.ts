// E9-209 — whether a script works here, said on its picture.
//
// The store used to keep a script with a note off its shelves: findable,
// but not in the window. That hid the very thing somebody needs to know
// before pressing `get`. It is shown now, everywhere, with a band across
// its picture that says how it stands.
//
// TWO FILES, AND THE FIRST ONE IS THE GATE.
//
//   community-blockers.json   what a script is MISSING, worked out from
//                             its source. Carries no opinion.
//   verdicts.json             what that cost when the script was run,
//                             from the campaigns in docs/11-MISSING.md.
//
// A script with no note has no standing at all, whatever `verdicts.json`
// says: fix one, regenerate the table, and the band goes without anybody
// remembering to take it off. A script WITH a note and no verdict gets the
// plain mark — it is missing something, and nobody has measured what that
// costs. The table fails open and so does this.
//
// E9-211 — AND ONE THING A PERSON CAN BRING. A row with `samples` is a
// script whose README has you download a pack of samples by hand, from a
// GitHub release a page may not fetch. Once the folder it names has files
// in it, the script has what it needs and nothing is said against it,
// whatever the table says: the table is about the repository, and this is
// about what is on this machine.

import table from "./verdicts.json";

/**
 * `gone`   cannot be installed.
 * `no`     starts, or tries to, and cannot do what it is for.
 * `part`   runs and plays with a part of it absent.
 * `needs`  runs once something is done.
 * `note`   missing something; what that costs was not measured.
 */
export type Verdict = "gone" | "no" | "part" | "needs" | "note";

export interface Standing {
  readonly verdict: Verdict;
  /** A few words, for the band across the picture. */
  readonly label: string;
  /** What was seen when it was run. Empty when it was not. */
  readonly measured: string;
  /** Whether the band covers the picture, or is a tag in its corner. */
  readonly veiled: boolean;
  /** The pack to download by hand, when that is what it needs. */
  readonly samples: Samples | null;
}

/** A sample pack a person downloads, and where it goes. */
export interface Samples {
  /** Where the README sends you. */
  readonly url: string;
  /** What the download is called. */
  readonly file: string;
  readonly bytes: number;
  /** Under `~/dust`, the folder that has files in it once it is added. */
  readonly holds: string;
}

const LABEL: Record<Verdict, string> = {
  gone: "can't be installed",
  no: "won't work here",
  part: "incomplete here",
  needs: "needs something",
  note: "something missing",
};

interface Row {
  readonly verdict?: string;
  readonly label?: string;
  readonly measured?: string;
  readonly samples?: Samples;
}
const ROWS = (table as { scripts: Record<string, Row> }).scripts;
const KNOWN: readonly string[] = ["gone", "no", "part", "needs"];

/** Every script a verdict is written down for. */
export const VERDICT_NAMES: readonly string[] = Object.keys(ROWS);

const rowOf = (name: string): Row | undefined => ROWS[name] ?? ROWS[name.toLowerCase()];

/** The sample pack `name` needs, or null. */
export function samplesFor(name: string): Samples | null {
  const s = rowOf(name)?.samples;
  return s === undefined || typeof s.url !== "string" || typeof s.holds !== "string" ? null : s;
}

/**
 * Whether what stands against `name` has been put right on this machine:
 * its sample pack is in. `has` answers for a path under `~/dust`.
 */
export function satisfied(name: string, has: (path: string) => boolean): boolean {
  const s = samplesFor(name);
  return s !== null && has(s.holds);
}

/**
 * How `name` stands, given the notes the blockers table has for it.
 * Null when it has none: nothing is known against it. Null too when what
 * it needed has been added here (`has`, a path under `~/dust`).
 */
export function standing(
  name: string,
  notes: readonly string[],
  has: (path: string) => boolean = () => false,
): Standing | null {
  if (notes.length === 0 || satisfied(name, has)) return null;
  const row = rowOf(name);
  const verdict: Verdict = row !== undefined && KNOWN.includes(row.verdict ?? "") ? (row.verdict as Verdict) : "note";
  return {
    verdict,
    label: row?.label ?? LABEL[verdict],
    measured: row?.measured ?? "",
    veiled: verdict === "gone" || verdict === "no" || verdict === "part",
    samples: samplesFor(name),
  };
}
