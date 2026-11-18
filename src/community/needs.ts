// E9-32 — what a freshly installed script still needs, and who has it.
//
// 28 of the catalogue's 354 entries are LIBRARIES for other entries. On
// hardware the user installs both from maiden and nothing says they are
// related; here the installer has just read the whole tree and can see it.
//
// Two shapes, and the second is invisible to the first:
//
//   include("midigrid/lib/mg_128")   a PATH whose head names another script
//   engine.name = "Ash"              a CLASS another script defines
//
// Measured across the catalogue: 28 scripts want another script's Lua, and
// twelve want another script's engine — and five of the six libraries that
// supply an engine are already in the first list, so naming the first
// closes most of the second with it.
//
// WHY THE HEAD MUST MATCH A CATALOGUE NAME, and not merely be absent: a
// script says `require 'core/paramset'` and `include 'lib/foo'` all day.
// `core` and `lib` are not missing, they are norns and the script's own
// folder. Matching against the catalogue is the test that cannot produce a
// false alarm.
//
// E9-71 — AND A LIBRARY THAT IS NOT IN THE CATALOGUE IS NOT NECESSARILY
// NOWHERE. This used to pass over one, "which is correct: there would be
// nothing to offer". E9-70 went and looked, because the blockers table had
// ten notes of that shape and every one of them was wrong: `shnth` is at
// github.com/cfdrake/shnth and five more like it exist. `off-catalogue.ts`
// is where they are, and a head the catalogue does not name is matched
// against that before it is given up on. `toga` still is.

import type { Vfs } from "../fs/vfs.js";
import type { CatalogEntry } from "./catalog.js";
import { OFF_CATALOGUE } from "./off-catalogue.js";
import engineIndex from "./engines.json";

/**
 * E9-74 — which catalogue script declares an engine class.
 *
 * Read off every `.sc` in all 355 repositories by
 * `tools/build-blockers.mjs`, beside the blockers table and from the
 * same scan. 145 engines are declared in exactly one script; one that
 * two scripts declare is left out, because the point is to install the
 * thing that has it and a choice is not an answer.
 */
const ENGINE_IN = engineIndex.engines as Record<string, string | undefined>;

export interface Need {
  /** `script`: another entry's Lua. `engine`: another entry's SC class. */
  readonly kind: "script" | "engine";
  /** `midigrid` for an include, `Ash` for an engine. */
  readonly want: string;
  /** The file that asked, so the message can point at it. */
  readonly from: string;
  /**
   * The catalogue entry that would satisfy it, when one can be named.
   *
   * Always set for a `script` need — that is how it was recognised.
   *
   * E9-74 — AND USUALLY SET FOR AN ENGINE NEED NOW. This used to be null
   * for every engine, on the argument that "a table of engine names built
   * at release time would go stale the first time somebody adds a script,
   * and a stale answer here is worse than an honest 'something is
   * missing'". What that cost was measured on `shnthsalslied`: it needs
   * `LiedMotor`, its own README says the class is in `schicksalslied`,
   * `schicksalslied` is a catalogue entry, and the panel said only that an
   * engine was missing.
   *
   * The table it argued against FAILS OPEN, which is what makes it
   * survivable and is the blockers table's contract too: an engine the
   * index does not name leaves this null exactly as before, so a script
   * added since costs nothing. The only way to be wrong is for a script to
   * delete an engine class it used to declare, and then the install simply
   * does not help.
   */
  readonly entry: CatalogEntry | null;
  /**
   * Real, installable, and not a catalogue entry — so the message says
   * WHERE it is. "sines also needs z_tuning" sends somebody to a catalogue
   * that does not have it; naming the repository does not.
   */
  readonly offCatalogue?: true;
}

/** `include("x/y")` and `require 'x/y'`, with the comment lines dropped. */
const ASKS = /(?:include|require)\s*\(?\s*["']([^"']+)["']/g;
/**
 * The engine a script sets, from one line.
 *
 * AN ASSIGNMENT, never a comparison: `if engine.name == "MxSamples"` is 19
 * of the 43 non-plain lines in the catalogue and names an engine the
 * script is asking ABOUT, not one it needs.
 *
 * E9-74 — AND THE CONDITIONAL FORM, which used to be skipped as "built at
 * runtime". It is, and the name in it is still the only name it can be:
 *
 *     engine.name = util.file_exists(ext.."/FormantTriPTR/FormantTriPTR.sc")
 *                   and 'LiedMotor' or nil
 *
 * Measured over all 355 repositories: 227 plain literals, and exactly NINE
 * lines of this shape — amenbreak, bitters, graintopia, rachim,
 * schicksalslied, shnthsalslied, tapedeck, twins, zxcvbn. Eight of the
 * nine name their OWN engine, so nothing is produced for them; the ninth
 * is `shnthsalslied`, which is a fork and whose class is in
 * `schicksalslied`. Three more scripts assign a VARIABLE and are left
 * alone, because there is no name in the line to take.
 */
const ASSIGNS = /engine\s*\.\s*name\s*=(?!=)/;
const ENGINE_LITERAL = /engine\s*\.\s*name\s*=\s*["']([A-Za-z0-9_]+)["']/;
const ENGINE_CONDITIONAL = /\band\s+["']([A-Za-z0-9_]+)["']\s+or\b/;

function engineNameIn(line: string): string | null {
  if (!ASSIGNS.test(line)) return null;
  return ENGINE_LITERAL.exec(line)?.[1] ?? ENGINE_CONDITIONAL.exec(line)?.[1] ?? null;
}
/** A SuperCollider class declaration, wherever it lives in the file. */
const CLASS = /Engine_([A-Za-z0-9_]+)\s*:/g;

const live = (src: string): string[] =>
  src.split("\n").filter((l) => !l.trimStart().startsWith("--"));

/**
 * What `code/<name>` asks for that is not in `code/`.
 *
 * `root` is the dust tree, so this can see every installed script — the
 * provider may already be there, in which case there is nothing to say.
 */
export function needsOf(
  vfs: Vfs,
  name: string,
  entries: readonly CatalogEntry[],
  root = "/home/we/dust",
  /**
   * E9-109 — THE ENGINE CLASSES THIS MACHINE ALREADY HAS.
   *
   * `enginesHere` below is built by reading every `.sc` under
   * `~/dust/code`, which is where a SCRIPT's engine lives. It is not where
   * the twenty-odd engines built into the page live: those are compiled
   * into scsynth and declared in the class library, and nothing in the
   * dust tree mentions them at all.
   *
   * So every script that asks for one was reported as short of it. From a
   * user's own log, on a page whose very next lines list nine engines with
   * PolyPerc among them:
   *
   *     maiden: tmi also needs kolor and the PolyPerc engine,
   *             which no catalogue script has
   *
   * Half of that sentence was true and urgent and the other half was
   * false, which is the worst way to be half right: a line that cries wolf
   * about the engine teaches you to skim the part about `kolor`.
   *
   * `engine.names` is the answer and the page has had it since the server
   * reported. Empty here means "nobody told us", which reads exactly as it
   * did before — this cannot make the function report LESS than it knows.
   */
  have: readonly string[] = [],
): Need[] {
  const code = `${root}/code`;
  const mine = `${code}/${name}`;
  if (!vfs.isDir(mine)) return [];

  const byName = new Map<string, CatalogEntry>();
  for (const e of entries) byName.set(e.name.toLowerCase(), e);

  // Which folders are in `code/` already, and which engine classes they
  // declare. One walk for both: the tree is a few thousand paths and this
  // runs once per install.
  const present = new Set<string>();
  const enginesHere = new Set<string>(have);
  for (const p of vfs.walk(code)) {
    const rel = p.slice(code.length + 1);
    const head = rel.split("/")[0];
    if (head !== undefined) present.add(head.toLowerCase());
    if (!p.endsWith(".sc")) continue;
    const src = vfs.read(p);
    if (src === null) continue;
    const text = new TextDecoder().decode(src);
    for (const m of text.matchAll(CLASS)) enginesHere.add(m[1]!);
  }

  const needs: Need[] = [];
  const seen = new Set<string>();
  for (const p of vfs.walk(mine)) {
    if (!p.endsWith(".lua")) continue;
    const bytes = vfs.read(p);
    if (bytes === null) continue;
    const lines = live(new TextDecoder().decode(bytes));
    const text = lines.join("\n");

    for (const m of text.matchAll(ASKS)) {
      const target = m[1]!;
      if (!target.includes("/")) continue; // `require 'musicutil'`: no folder
      const head = target.split("/")[0]!.toLowerCase();
      if (head === name.toLowerCase()) continue; // itself, by its own name
      if (present.has(head)) continue;
      // E9-71 — the catalogue first, then the six that are real without
      // being in it. Catalogue first and not the other way round: if an
      // entry ever appears under one of these names, the catalogue is the
      // thing being maintained and this file is the stopgap.
      const entry = byName.get(head) ?? OFF_CATALOGUE.get(head);
      if (entry === undefined) continue; // not something we could install
      const key = `script:${head}`;
      if (seen.has(key)) continue;
      seen.add(key);
      needs.push({
        kind: "script",
        want: entry.name,
        from: p,
        entry,
        ...(byName.has(head) ? {} : { offCatalogue: true }),
      });
    }

    // One engine per file at most — a script sets it once, and the first
    // literal assignment is the one that runs.
    for (const line of lines) {
      const want = engineNameIn(line);
      if (want === null) continue;
      if (want === "None" || enginesHere.has(want)) break;
      const key = `engine:${want}`;
      if (seen.has(key)) break;
      seen.add(key);
      // The script that declares the class, if the index names one and the
      // catalogue still carries it. `present` is checked because the
      // provider can be installed and its `.sc` not yet compiled — a
      // restart, not an install.
      const from = ENGINE_IN[want];
      const provider =
        from !== undefined && !present.has(from.toLowerCase())
          ? (byName.get(from.toLowerCase()) ?? null)
          : null;
      needs.push({ kind: "engine", want, from: p, entry: provider });
      break;
    }
  }
  return needs;
}

/**
 * One line a person can act on.
 *
 * Deliberately short and specific. "amen also needs midigrid" is a
 * sentence; "unmet dependencies detected" is a status code.
 */
export function sayNeeds(name: string, needs: readonly Need[]): string {
  const scripts = needs
    .filter((n) => n.kind === "script")
    .map((n) => (n.offCatalogue ? `${n.want} (${n.entry?.url.replace(/^https?:\/\//, "") ?? ""})` : n.want));
  // E9-74 — an engine WITH a script that has it reads like a script, because
  // that is what will be installed. "shnthsalslied also needs the LiedMotor
  // engine, which no installed script has" was true and useless;
  // "shnthsalslied also needs schicksalslied, for the LiedMotor engine" is
  // the same fact with the answer in it.
  // A provider already named as a script need is not named twice: `esper`
  // includes mx.synths' Lua AND sets its engine, and "needs mx.synths and
  // mx.synths, for the MxSynths engine" is one fact said twice.
  const already = new Set(
    needs.filter((n) => n.kind === "script").map((n) => n.want.toLowerCase()),
  );
  const named = needs.filter(
    (n) => n.kind === "engine" && n.entry !== null && !already.has(n.entry.name.toLowerCase()),
  );
  const unnamed = needs.filter((n) => n.kind === "engine" && n.entry === null).map((n) => n.want);
  const parts: string[] = [];
  if (scripts.length > 0) parts.push(scripts.join(", "));
  for (const n of named) parts.push(`${n.entry!.name}, for the ${n.want} engine`);
  if (unnamed.length > 0) {
    parts.push(
      `the ${unnamed.join(", ")} engine${unnamed.length === 1 ? "" : "s"}, which no catalogue script has`,
    );
  }
  if (parts.length === 0) return "";
  return `${name} also needs ${parts.join(" and ")}`;
}
