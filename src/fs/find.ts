// E9-49 — `find`, because four scripts cannot see what this build has.
//
// `graintopia` prints "[installer] missing Fverb" while `Fverb.sc` and
// `Fverb_scsynth.so` sit in Extensions where E9-40 wrote them. Its
// installer enumerates that directory with
//
//     find <dir> -type f -printf '%p!'
//
// and the shell had one hard-coded `find` — SELECT's script list — so the
// enumeration came back empty and the requirement was never satisfied.
// `twins`, `rachim` and `tapedeck` ask the same way about PortedPlugins,
// and `amenbreak` about AnalogTape.
//
// WHAT IS IMPLEMENTED IS WHAT THE CATALOGUE WRITES, read off all 354
// repositories rather than guessed at. Thirteen distinct command lines, and
// between them they use: `-maxdepth`, `-mindepth`, `-type f|d`, `-name`,
// `-iname`, `-not -path`, `-not -empty`, `-prune -o`, `-print`, `-printf`
// with `%p` and `%f`, a `\( … -o … \)` group, and a trailing `| sort`,
// `| tail -n +2`, `| grep` or `2>/dev/null`.
//
// Anything outside that vocabulary returns null, and the caller refuses the
// command by name. A `find` that quietly returns the wrong set is worse
// than one that says it cannot: the wrong set is indistinguishable from an
// empty directory, which is the bug this file exists to fix.

import { Vfs, normalise, basename } from "./vfs.js";
import { globToRegExp } from "./shell.js";

/** One `-name`/`-iname`/`-path` test, or a group of them. */
interface Test {
  readonly kind: "name" | "iname" | "path";
  readonly glob: string;
  readonly negated: boolean;
}

interface Parsed {
  readonly roots: string[];
  readonly tests: Test[][];
  readonly type: "f" | "d" | null;
  readonly minDepth: number;
  readonly maxDepth: number;
  readonly prune: string[];
  readonly notEmpty: boolean;
  readonly format: string | null;
}

/** Split a command line into words, keeping quoted runs together. */
function tokens(s: string): string[] {
  return s.match(/(?:'[^']*'|"[^"]*"|\\\(|\\\)|[^\s'"])+/g) ?? [];
}

const unquote = (s: string): string =>
  (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))
    ? s.slice(1, -1)
    : s;

/**
 * `-printf '%p\n'` and friends, as a template with `%p` and `%f` in it.
 *
 * The separator matters as much as the field: `scinstaller` asks for
 * `'%p!'` and then splits on `!`, so a `\n` instead would hand it one long
 * path it would read as a single file that does not exist.
 */
function expand(fmt: string, full: string): string {
  return fmt
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/%p/g, full)
    .replace(/%P/g, full)
    .replace(/%f/g, basename(full));
}

/** Push a test as its own AND group, or join it to the last one with OR. */
function add(groups: Test[][], joinLast: boolean, test: Test): void {
  const last = groups[groups.length - 1];
  if (joinLast && last !== undefined) last.push(test);
  else groups.push([test]);
}

/** Parse the arguments after `find`. Null when something is not understood. */
function parse(argv: string[], home: string): Parsed | null {
  const roots: string[] = [];
  const tests: Test[][] = [];
  let type: "f" | "d" | null = null;
  let minDepth = 0;
  let maxDepth = Infinity;
  const prune: string[] = [];
  let notEmpty = false;
  let format: string | null = null;
  let sawAction = false;
  /** The previous token was `-o`, so the next test joins the last group. */
  let orNext = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => unquote(argv[++i] ?? "");
    if (a === "2>/dev/null" || a === "2>&1") continue;
    if (a === "\\(" || a === "\\)" || a === "(" || a === ")") continue;
    // `-o` is OR, and the difference is the whole of twins' question:
    //   \( -iname '*.wav' -o -iname '*.flac' \)
    // as separate AND groups asks for a file that is both at once, which
    // is nothing. The next test joins the group the last one opened.
    if (a === "-o" || a === "-or") {
      orNext = true;
      continue;
    }
    if (a === "-a" || a === "-and") continue;
    if (a === "-print" || a === "-print0") {
      sawAction = true;
      format ??= "%p\n";
      continue;
    }
    if (a === "-printf") {
      sawAction = true;
      format = next();
      continue;
    }
    if (a === "-type") {
      const t = next();
      if (t !== "f" && t !== "d") return null;
      type = t;
      continue;
    }
    if (a === "-maxdepth") {
      maxDepth = Number(next());
      if (!Number.isFinite(maxDepth)) return null;
      continue;
    }
    if (a === "-mindepth") {
      minDepth = Number(next());
      if (!Number.isFinite(minDepth)) return null;
      continue;
    }
    if (a === "-name" || a === "-iname") {
      add(tests, orNext, { kind: a === "-name" ? "name" : "iname", glob: next(), negated: false });
      orNext = false;
      continue;
    }
    if (a === "-path" || a === "-wholename") {
      add(tests, orNext, { kind: "path", glob: next(), negated: false });
      orNext = false;
      continue;
    }
    if (a === "-not" || a === "!") {
      const what = argv[++i];
      if (what === "-empty") {
        notEmpty = true;
        continue;
      }
      if (what === "-path" || what === "-wholename") {
        add(tests, orNext, { kind: "path", glob: next(), negated: true });
        orNext = false;
        continue;
      }
      if (what === "-name" || what === "-iname") {
        tests.push([
          { kind: what === "-name" ? "name" : "iname", glob: next(), negated: true },
        ]);
        continue;
      }
      return null;
    }
    if (a === "-prune") {
      // `-name X -prune -o …`: the test just pushed names what to skip.
      const last = tests.pop();
      if (last === undefined) return null;
      prune.push(last[0]!.glob);
      continue;
    }
    if (a === "-empty" || a === "-nowarn" || a === "-L" || a === "-H") continue;
    if (a.startsWith("-")) return null; // a predicate we do not know
    roots.push(a);
  }
  if (roots.length === 0) return null;
  // A bare `find <dir>` prints everything, directories included.
  if (!sawAction) format = "%p\n";
  return {
    roots: roots.map((r) => normalise(unquote(r).replace(/\*$/, ""), home)),
    tests,
    type,
    minDepth,
    maxDepth,
    prune,
    notEmpty,
    format,
  };
}

/** Does this path satisfy every `-name`/`-path` group? */
function matches(p: Parsed, full: string): boolean {
  for (const group of p.tests) {
    const ok = group.some((t) => {
      const subject = t.kind === "path" ? full : basename(full);
      const re = globToRegExp(t.kind === "iname" ? t.glob.toLowerCase() : t.glob);
      const value = t.kind === "iname" ? subject.toLowerCase() : subject;
      // `-path` globs match across separators, which globToRegExp does not
      // do: `*/.*` has to reach `/home/we/x/.git`. Anchored either way.
      const hit = t.kind === "path" ? pathGlob(t.glob).test(full) : re.test(value);
      return t.negated ? !hit : hit;
    });
    if (!ok) return false;
  }
  return true;
}

/** A `-path` glob, where `*` crosses directory separators. */
function pathGlob(glob: string): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * Run a `find`, or answer null when the line is outside the vocabulary.
 *
 * The result is the raw output; the caller applies any pipeline.
 */
export function runFind(vfs: Vfs, argv: string[]): string | null {
  const p = parse(argv, vfs.home);
  if (p === null || p.format === null) return null;

  const out: string[] = [];
  for (const root of p.roots) {
    // Directories as well as files: `-type d` is asked for by zxcvbn, and a
    // bare `find <dir>` lists both.
    const files = vfs.walk(root);
    const dirs = new Set<string>();
    for (const f of files) {
      for (let d = f.slice(0, f.lastIndexOf("/")); d.length > root.length; d = d.slice(0, d.lastIndexOf("/"))) {
        dirs.add(d);
      }
    }
    const all = [...(p.type === "d" ? [] : files), ...(p.type === "f" ? [] : [root, ...dirs])];
    for (const full of all.sort()) {
      const rel = full === root ? "" : full.slice(root.length + 1);
      const depth = rel === "" ? 0 : rel.split("/").length;
      if (depth < p.minDepth || depth > p.maxDepth) continue;
      if (p.prune.some((g) => rel.split("/").some((seg) => globToRegExp(g).test(seg)))) continue;
      if (p.notEmpty && !files.some((f) => f.startsWith(full + "/")) && !files.includes(full)) {
        continue;
      }
      if (!matches(p, full)) continue;
      out.push(expand(p.format, full));
    }
  }
  return out.join("");
}
