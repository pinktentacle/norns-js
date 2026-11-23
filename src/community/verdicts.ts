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
}
const ROWS = (table as { scripts: Record<string, Row> }).scripts;
const KNOWN: readonly string[] = ["gone", "no", "part", "needs"];

/** Every script a verdict is written down for. */
export const VERDICT_NAMES: readonly string[] = Object.keys(ROWS);

/**
 * How `name` stands, given the notes the blockers table has for it.
 * Null when it has none: nothing is known against it.
 */
export function standing(name: string, notes: readonly string[]): Standing | null {
  if (notes.length === 0) return null;
  const row = ROWS[name] ?? ROWS[name.toLowerCase()];
  const verdict: Verdict = row !== undefined && KNOWN.includes(row.verdict ?? "") ? (row.verdict as Verdict) : "note";
  return {
    verdict,
    label: row?.label ?? LABEL[verdict],
    measured: row?.measured ?? "",
    veiled: verdict === "gone" || verdict === "no" || verdict === "part",
  };
}
