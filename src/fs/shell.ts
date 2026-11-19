// E6-05 / E6-06 — the shell commands norns actually issues, and nothing else.
//
// `execute` and `system_cmd` run arbitrary shell. A browser has no process
// model, so they cannot be implemented — but norns does not USE them
// arbitrarily. Every call site in `lua/core` is one of a dozen fixed shapes,
// and a handful of those are load-bearing:
//
//   find ~/dust/code/ -mindepth 2 … | grep -Ev … | sort   SELECT's script list
//   ls -1 <dir><name>*.pset | sort                        PARAMS > PSET
//   ls -pL --group-directories-first "<dir>"              util.scandir
//   mkdir -p <dir>                                        util.make_dir
//   rm <file>                                             deleting a pset
//   cp <dir>/data/*.pset <dir>                            installing a script
//
// So this is a recogniser for those, not an emulator of sh. Anything it does
// not recognise is REFUSED and recorded, per ADR-08: a shell that silently
// returns "" for `nmcli` would have norns believe wifi was configured.
//
// The matching is deliberately shape-based rather than a parser. A parser
// would invite the belief that arbitrary commands work.

import { Vfs, normalise, basename, dirname } from "./vfs.js";
import { insideExtensions } from "../community/extensions.js";
import { runFind } from "./find.js";

export interface ShellResult {
  /** Standard output, as norns expects to receive it. */
  readonly out: string;
  /** False when the command was not recognised; `out` is then empty. */
  readonly ok: boolean;
  /** Why it was refused, for the compatibility page. */
  readonly refused?: string;
  /**
   * E9-37 — a download the host can do and the shell cannot.
   *
   * `git clone`, `wget -O` and `curl -o` all mean "put what is at this URL
   * there". A browser can do that; a SYNCHRONOUS Lua call cannot wait for
   * it. So the shape is recognised here, the work is handed up, and this
   * run is told honestly that it did not happen — the same contract a
   * script that brings a new engine already lives with: it is ready next
   * time.
   */
  readonly fetch?: {
    /** `repo` for a GitHub repository, `file` for one URL to one path. */
    readonly kind: "repo" | "file";
    readonly url: string;
    readonly dest: string;
  };
}

const OK = (out: string): ShellResult => ({ out, ok: true });
const NO = (refused: string): ShellResult => ({ out: "", ok: false, refused });
/**
 * Not run, but worth starting. `ok` is FALSE on purpose: the files are not
 * there yet, and a script told otherwise would read them and find nothing.
 */
const LATER = (refused: string, fetch: NonNullable<ShellResult["fetch"]>): ShellResult => ({
  out: "",
  ok: false,
  refused,
  fetch,
});

/** Strip one layer of single or double quotes. */
/**
 * A shell word with its quoting removed, wherever the quotes are.
 *
 * Not just a matched pair at the ends. Scripts quote the DIRECTORY and
 * leave the rest bare — `ls "<dir>"/*.wav` is how `beets` finds its loops
 * — so the quote sits in the middle of the token and a pair-at-the-ends
 * test leaves it in. The path then matches nothing, the glob returns no
 * lines, and the script loads no loops: it runs, it keeps time, and it is
 * silent, with nothing anywhere to say why.
 */
/**
 * A shell pattern as a regular expression, for matching ONE name.
 *
 * Only `*` and `?`, which is all a norns script uses. Everything else is
 * taken literally, including the dots that sound files are full of.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if ("\\^$.|?*+()[]{}".includes(ch)) out += "\\" + ch;
    else out += ch;
  }
  return new RegExp("^" + out + "$");
}

/**
 * E9-130 — A LEADING DOT IS HIDDEN, and this shim did not know it.
 *
 * `ls` without `-a` omits every entry whose name begins with a dot, and a
 * glob's `*` does not match one either: two spellings of one POSIX rule,
 * and the whole reason a Unix directory can hold housekeeping that listing
 * it does not show. Here `vfs.list` was handed straight back, so there was
 * no such thing as a hidden file and every caller of `util.scandir` saw
 * everything there was.
 *
 * WHAT IT COST, measured in a log off a Pixel. `audio/common/808/` is a
 * sample folder, and E9-41 put a `README.txt` in it to say the sounds are
 * synthesised rather than Roland's. `bakeneko` lists that folder and picks
 * a file at random — the README itself says so, in the sentence above the
 * one that put it there — so it drew the text file, `decodeAudioData`
 * refused it, and `Buffer.read`'s action ran with a nil buffer:
 *
 *     ERROR: Nil does not understand the message '>'.
 *       Engine_Goldeneye_ef20e1.sc:100   if (bufnum.numChannels>1,{
 *
 * Five of those in one boot, each a forty-line SuperCollider dump with
 * source extracts. On hardware that folder holds `.wav` and nothing else,
 * so no script has ever had to defend against it.
 *
 * FIXED HERE RATHER THAN BY MOVING THE FILE, because the file is not the
 * bug. `.gitignore`, `.DS_Store` and a whole `.git/` arrive with every
 * installed script, and without this rule each of them is handed to the
 * next thing that enumerates a folder and assumes everything in it is its
 * own. The README moves too — to `.README.txt`, which is where a note for
 * humans belongs once the machine can be told to look past it.
 */
function dotted(name: string): boolean {
  return name.startsWith(".");
}

/**
 * One short flag, wherever it sits in a run of them.
 *
 * `-pL` and `-apL` carry the same `-p`, and a substring test for `"-p"`
 * sees it only in the first: written that way, `ls -apL` missed the
 * `util.scandir` branch entirely and fell through to the plain listing at
 * the bottom — no trailing slashes, no directories first, which is
 * precisely the thing `util.scandir` reads. Found by the test for `-a`.
 *
 * ANCHORED ON THE DASH THAT OPENS A RUN, so the `a` inside
 * `--group-directories-first` is not read as a flag: a long option starts
 * with two dashes, and the second is not a letter.
 */
function hasFlag(cmd: string, letter: string): boolean {
  return new RegExp(`\\s-[a-zA-Z]*${letter}`).test(cmd);
}

/** `-a` or `-A`, which is what asks for the hidden ones. */
function listsAll(cmd: string): boolean {
  return hasFlag(cmd, "a") || hasFlag(cmd, "A");
}

function unquote(s: string): string {
  return s.trim().replace(/["']/g, "");
}

/** Split on whitespace, keeping quoted runs together. */
function words(cmd: string): string[] {
  // A QUOTE GLUES, IT DOES NOT SEPARATE. Scripts quote the directory and
  // leave the rest bare — `stat -c "%n %Y" "<dir>"/*.lua`, `ls "<dir>"/*.wav`
  // — so `"<dir>"` and `/*.lua` are ONE word. An alternation that matched a
  // quoted run on its own split that into two, and the second half,
  // `/*.lua`, globbed from the root and matched nothing: `twins` got an
  // empty preset list with nothing to say why.
  return cmd.match(/(?:'[^']*'|"[^"]*"|[^\s'"])+/g) ?? [];
}

/**
 * E9-65 — the words of ONE command, stopping at a shell operator.
 *
 * `mkdir -p <dir> && mv a b` reached the mkdir branch whole, and that
 * branch takes every word after `mkdir` that does not begin with `-`. It
 * made five directories: the one asked for, and then `&&`, `mv`, `a` and
 * `b`. Two were sitting at the root of this origin's storage when it was
 * found — `/mv` and `/&&` — with nothing in any log to say where they came
 * from.
 *
 * The operator is NOT handled here, only stopped at: the branches that
 * understand a chain (`cd X && wget …`) match on the whole line before
 * these loops are reached, and a chain nothing understands is refused by
 * name further down. What this prevents is the third outcome — half of it
 * done, and the punctuation filed as a directory.
 */
function argsOf(cmd: string): string[] {
  const out: string[] = [];
  for (const w of words(cmd).slice(1)) {
    if (w === "&&" || w === "||" || w === ";" || w === "|" || w === "&") break;
    out.push(w);
  }
  return out;
}

/** Expand a trailing `*` glob within one directory. */
function globIn(vfs: Vfs, pattern: string): string[] {
  const p = normalise(pattern, vfs.home);
  const dir = dirname(p);
  const pat = basename(p);
  if (!pat.includes("*")) return vfs.exists(p) ? [p] : [];
  const re = new RegExp("^" + pat.split("*").map(escapeRe).join(".*") + "$");
  // A pattern that itself begins with a dot is asking for them; `*` is not.
  const wantsDot = dotted(pat);
  return vfs
    .list(dir)
    .filter((e) => !e.isDir && re.test(e.name) && (wantsDot || !dotted(e.name)))
    .map((e) => `${dir}/${e.name}`);
}

/**
 * E9-148 — a glob with a trailing slash means DIRECTORIES, and only those.
 *
 * `globIn` answers with files, which is right for `ls *.wav` and wrong for
 * the idiom `kolor` uses to walk its banks: a shell matches only
 * directories when the pattern ends in a slash, and prints them with the
 * slash still on, which is how the caller knows to recurse. Answering with
 * the FILES instead sent `kolor` into every sample as though it were a
 * folder.
 */
function globDirsIn(vfs: Vfs, pattern: string): string[] {
  const p = normalise(pattern.replace(/\/+$/, ""), vfs.home);
  const dir = dirname(p);
  const pat = basename(p);
  const re = new RegExp("^" + pat.split("*").map(escapeRe).join(".*") + "$");
  const wantsDot = dotted(pat);
  return vfs
    .list(dir)
    .filter((e) => e.isDir && re.test(e.name) && (wantsDot || !dotted(e.name)))
    .map((e) => `${dir}/${e.name}/`)
    .sort();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Move one file, keeping an unfetched sound file a REFERENCE.
 *
 * The same care `cp` takes, and for the same reason: a declared-but-not-yet
 * downloaded sample is a manifest entry, and reading it here to write it
 * back would pull a megabyte through the shell for a move nothing may ever
 * play. `copyRemote` then `remove` is a move of the reference.
 *
 * The time travels too — a move is not a modification, and `twins` reads
 * `stat -c %Y` on files it has just reorganised.
 */
function moveOne(vfs: Vfs, from: string, to: string): void {
  if (from === to) return;
  const ref = vfs.remoteAt(from);
  if (ref !== null) {
    vfs.copyRemote(to, ref);
    vfs.remove(from);
    return;
  }
  const data = vfs.read(from);
  if (data === null) return;
  const when = vfs.mtimeOf(from);
  vfs.write(to, data);
  if (when !== null) vfs.setMtime(to, when);
  vfs.remove(from);
}

/**
 * @param depth how many `.sh` files deep we already are. A shell script
 * that runs a shell script is ordinary; one that runs itself is not, and
 * nothing here would otherwise stop it.
 */
/**
 * Split `cmd | a | b > file` into its parts.
 *
 * Only as much shell as the catalogue writes: no quoting rules across a
 * pipe, because nothing uses them.
 */
function pipeline(cmd: string): {
  head: string;
  pipes: string[];
  redirect: { path: string; append: boolean } | null;
} {
  let rest = cmd;
  let redirect: { path: string; append: boolean } | null = null;
  const red = /\s(>>?)\s*([^\s|>]+)\s*$/.exec(rest);
  if (red !== null) {
    redirect = { path: unquote(red[2]!), append: red[1] === ">>" };
    rest = rest.slice(0, red.index);
  }
  // SPLIT OUTSIDE QUOTES ONLY. `grep 'wav\|flac'` is one stage whose
  // argument contains a pipe, and cutting there gave two stages, the
  // second of them the word `flac'`. amenbreak writes exactly that line.
  const parts: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (quote !== "") {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "|" && rest[i - 1] !== "\\") { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  return { head: parts[0]!, pipes: parts.slice(1), redirect };
}

/** `sort`, `uniq`, `tail -n +N` and `grep`, which is all they chain. */
function runPipe(text: string, stage: string): string | null {
  const keepEnd = text.endsWith("\n");
  const rows = text.split("\n").filter((l) => l !== "");
  const done = (out: string[]): string =>
    out.join("\n") + (out.length > 0 || keepEnd ? "\n" : "");
  if (/^sort\b/.test(stage)) return done([...rows].sort());
  if (/^uniq\b/.test(stage))
    return done(rows.filter((l, i) => i === 0 || l !== rows[i - 1]));
  const tail = /^tail\s+-n\s*\+(\d+)/.exec(stage);
  if (tail !== null) return done(rows.slice(Number(tail[1]) - 1));
  // E9-150 — `wc -l` and `head`, both of which the catalogue writes and
  // both of which were refused. `ls ~/dust/code | wc -l` is how one script
  // asks how many are installed; `head -n 1` is how another takes the
  // first line. Neither was hard; neither had been asked for by name
  // before the audit that found them.
  const wc = /^wc(\s+-(\w+))?\s*$/.exec(stage);
  if (wc !== null) {
    // `-l` counts lines; bare `wc` prints lines, words and bytes, and
    // nothing in the catalogue reads more than the first number.
    const flags = wc[2] ?? "l";
    if (!/^[lwc]+$/.test(flags)) return null;
    const n = /l/.test(flags) ? rows.length : /w/.test(flags) ? text.split(/\s+/).filter(Boolean).length : text.length;
    return `${n}
`;
  }
  // `head -1` as well as `head -n 1`: the short form is what the
  // catalogue writes, and the first version of this regex took only the
  // long one and refused the other.
  const head = /^head\s*(?:-n\s*)?-?(\d+)?\s*$/.exec(stage);
  if (head !== null) return done(rows.slice(0, Number(head[1] ?? 10)));

  const grep = /^grep\s+(-\w+\s+)?(.+)$/.exec(stage);
  if (grep !== null) {
    const flags = grep[1] ?? "";
    const pat = unquote(grep[2]!.trim());
    // `grep 'wav\|flac'` is BRE alternation; in a JS RegExp that is `|`.
    const re = new RegExp(pat.replace(/\\\|/g, "|"), /i/.test(flags) ? "i" : "");
    const inverted = /v/.test(flags);
    return done(rows.filter((l) => re.test(l) !== inverted));
  }
  return null;
}

export function runShell(vfs: Vfs, command: string, depth = 0): ShellResult {
  /**
   * E9-148 — A STDERR REDIRECT IS NOT PART OF THE COMMAND.
   *
   * `kolor` lists its sample folders with a glob of directories followed
   * by `2>/dev/null`, and the redirect was being parsed as part of the
   * glob -- which matched nothing, so the listing came back empty and the
   * script went looking elsewhere. There is no stderr here to redirect;
   * dropping it is the whole of the right answer.
   */
  const cmd = command.trim().replace(/\s*2>\s*(?:\/dev\/null|&1)\s*$/, "").trim();

  // --- nothing writes into Extensions ------------------------------------
  //
  // E9-33. That directory is a statement about what the SERVER has, and no
  // file a script copies there can make a UGen exist: wasm has no dlopen,
  // so the UGens are compiled in and a `.so` arriving later is a name on a
  // disk. `declareExtensions` writes it at boot from the server's own
  // report, and after that it is read-only.
  //
  // REFUSING IS THE FIX, not the caution. MEASURED, on `bitters`: it
  // copies its bundled `PulsePTR.sc` and `TrianglePTR.sc` in, and its
  // `engine.name` line is
  //
  //     util.file_exists(ext.."/PulsePTR/PulsePTR.sc") and … and "Bitters"
  //
  // evaluated at LOAD, before `init` does the copying. So the first run
  // gets `Engine_None` and the second run gets
  //
  //     loading engine: Bitters
  //     ### SCRIPT ERROR: missing Bitters
  //     ### try 'SYSTEM > RESTART'
  //
  // — a restart that can never help, because the `.so` beside the class
  // was skipped by the installer and the UGen is in no binary. The class
  // without its UGen is the exact half-state this project keeps refusing
  // to ship; here a script was building it for itself.
  if (/^(cp|mv|mkdir|rm|touch|echo|ln|install)\b/.test(cmd)) {
    for (const w of words(cmd).slice(1)) {
      if (w.startsWith("-")) continue;
      if (insideExtensions(normalise(unquote(w), vfs.home))) {
        return NO(
          "SuperCollider/Extensions is what the server reports, not a folder to write: " +
            "a UGen here is compiled in, and a file copied beside it would only " +
            "make a script believe in one that is not",
        );
      }
    }
  }

  // --- find, and the little pipeline scripts hang off it ----------------
  //
  // E9-49. Four scripts cannot see what this build HAS because they ask
  // with `find`: graintopia and rachim enumerate Extensions with
  // `-printf '%p!'`, twins with a `( -iname … -o … )` group, amenbreak
  // with `-name X -prune -o -name Y -print`. `Fverb` and `AnalogTape` are
  // compiled in and declared on disk; the listing came back empty anyway.
  //
  // SELECT's own line stays hand-matched below: it decides which scripts a
  // user can see at all, and a parser getting it subtly wrong would
  // shorten that list silently.
  if (/^find\s/.test(cmd) && !/-mindepth 2/.test(cmd)) {
    const { head, pipes, redirect } = pipeline(cmd);
    const found = runFind(vfs, words(head).slice(1));
    if (found === null) return NO(`find: not a form this shell knows — ${cmd.slice(0, 90)}`);
    let text = found;
    for (const stage of pipes) {
      const piped = runPipe(text, stage);
      if (piped === null) return NO(`find: unsupported pipe — ${stage.slice(0, 40)}`);
      text = piped;
    }
    if (redirect !== null) {
      const prev = redirect.append ? (vfs.read(redirect.path) ?? new Uint8Array()) : null;
      const before = prev === null ? "" : new TextDecoder().decode(prev);
      vfs.write(redirect.path, before + text);
      return OK("");
    }
    return OK(text);
  }

  // --- SELECT's script list -------------------------------------------
  // The real thing, from core/menu/select.lua:61, comment and all:
  //   find ~/dust/code/ -mindepth 2 -name .git -prune -o -type f -name "*.lua"
  //     -printf "%P\n" | grep -Ev "/(lib|data|crow|test|docs)/" | sort
  // Matched on its distinctive parts rather than parsed, because getting it
  // subtly wrong would silently shorten the list of scripts a user can see.
  if (/\bfind\b/.test(cmd) && /-mindepth 2/.test(cmd) && /-name "\*\.lua"/.test(cmd)) {
    const root = normalise(words(cmd)[1] ?? "~/dust/code", vfs.home);
    const excluded = /\/(lib|data|crow|test|docs)\//;
    const rel = vfs
      .walk(root)
      .filter((p) => p.endsWith(".lua"))
      // -mindepth 2: at least one directory below the root.
      .map((p) => p.slice(root.length + 1))
      .filter((r) => r.includes("/"))
      // -name .git -prune
      .filter((r) => !r.split("/").includes(".git"))
      .filter((r) => !excluded.test("/" + r))
      .sort();
    return OK(rel.join("\n") + (rel.length ? "\n" : ""));
  }

  // --- `ls ... | <filter>` -------------------------------------------
  //
  // E9-148 — THE PIPE WAS BEING READ AS PART OF THE PATH, and this is the
  // one that cost a release. `kolor`'s `list_files` asks for the files in
  // a folder the way everybody does:
  //
  //     ls -p /home/we/dust/audio/kolor/bank1/ | grep -v /
  //
  // The `util.scandir` branch below takes `words(cmd).at(-1)` as the
  // directory -- and the last word of that line is the `/` belonging to
  // `grep`. So it listed the ROOT, answered `home/`, and kolor spent the
  // rest of its init trying to load a sample called
  // `/home/we/dust/audio/kolor/bank1/home/`. Twelve times, once per bank.
  //
  // `runPipe` already does `grep -v /`; the ls branches simply never
  // reached it. The listing is computed from the left of the pipe and the
  // stages are applied to its output, which is what a shell does.
  if (/^ls\s/.test(cmd) && /[|>]/.test(cmd)) {
    // E9-150 — `pipeline()`, not a `split("|")`. It keeps a pipe that is
    // inside quotes with its stage and picks up a redirect, which the
    // first version of this did neither of.
    const { head, pipes, redirect } = pipeline(cmd);
    const r = runShell(vfs, head, depth + 1);
    if (!r.ok) return r;
    let text = r.out;
    for (const stage of pipes) {
      const piped = runPipe(text, stage);
      if (piped === null) return NO(`ls: unsupported pipe — ${stage.slice(0, 40)}`);
      text = piped;
    }
    if (redirect !== null) {
      const prev = redirect.append ? (vfs.read(redirect.path) ?? new Uint8Array()) : null;
      const before = prev === null ? "" : new TextDecoder().decode(prev);
      vfs.write(redirect.path, before + text);
      return OK("");
    }
    return OK(text);
  }

  // --- `ls -1 <glob> | sort`, the PSET list ---------------------------
  if (/^ls\s+-1\s/.test(cmd)) {
    const target = unquote(cmd.replace(/^ls\s+-1\s+/, "").split("|")[0]!.trim());
    const hits = globIn(vfs, target).sort();
    return OK(hits.join("\n") + (hits.length ? "\n" : ""));
  }

  // --- `ls -pL --group-directories-first "<dir>"`, util.scandir -------
  // The `-p` is what matters: directories come back with a trailing slash,
  // and `util.scandir` relies on it to tell them apart.
  if (/^ls\s/.test(cmd) && hasFlag(cmd, "p")) {
    const target = unquote(words(cmd).at(-1) ?? "");
    const dir = normalise(target, vfs.home);
    if (!vfs.isDir(dir)) return OK("");
    // THE PATH THAT BIT US: `util.scandir` is this command, and this is
    // where the 808 README reached bakeneko.
    const showAll = listsAll(cmd);
    const entries = vfs.list(dir).filter((e) => showAll || !dotted(e.name));
    const dirs = entries.filter((e) => e.isDir).map((e) => e.name + "/");
    const files = entries.filter((e) => !e.isDir).map((e) => e.name);
    const all = /--group-directories-first/.test(cmd) ? [...dirs, ...files] : [...dirs, ...files].sort();
    return OK(all.join("\n") + (all.length ? "\n" : ""));
  }

  // --- `cd <dir>; ls -d *`, which is how a script lists folder NAMES ---
  //
  // `beets` builds its loops-folder menu with
  // `io.popen('cd ' .. dir .. '; ls -d *')`. Refusing `cd` left it with an
  // empty list, so its folder parameter read "Create folders in
  // audio/beets to load" and its Load button had nothing to load —
  // the script copied its demo loops, kept time, drew, and could not be
  // pointed at anything.
  //
  // A RELATIVE PATTERN PRINTS NAMES, an absolute one prints paths. That is
  // what a shell does and what the caller reads back: beets uses the lines
  // as folder names and joins them to the directory itself.
  const chained = /^cd\s+(.+?)\s*(?:;|&&)\s*(.+)$/.exec(cmd);
  if (chained) {
    const base = normalise(unquote(chained[1]!), vfs.home);
    const rest = chained[2]!.trim();
    // E9-37: `cd <dir> && wget …` is a DOWNLOAD, and the `cd` is only
    // there to say where it lands. Two scripts write it that way, so it
    // falls through to the fetch block below instead of being refused
    // here as "cd ... wget".
    if (!/^ls\b/.test(rest)) {
      if (!/^(wget|curl|git)\b/.test(rest)) {
        return NO(`unsupported shell command: cd ... ${rest.split(/\s+/)[0]}`);
      }
    } else {
    const pattern = unquote(rest.replace(/^ls\s*(?:-\S+\s*)*/, "")) || "*";
    // LISTED, NOT GLOBBED. `globIn` answers with FILES, and the entries a
    // script is asking about here are directories — `ls -d *` in a folder
    // of folders matched nothing at all, which is how beets came to think
    // it had no loops to offer. `-d` means an entry is named as itself.
    const rx = globToRegExp(pattern);
    const wantsDot = dotted(pattern) || listsAll(rest);
    const names = (vfs.isDir(base) ? vfs.list(base) : [])
      .map((e) => e.name)
      .filter((n) => rx.test(n) && (wantsDot || !dotted(n)))
      .sort();
    return OK(names.join("\n") + (names.length ? "\n" : ""));
    }
  }

  // --- a bare `ls <glob>` or `ls <dir>` --------------------------------
  //
  // `beets` finds its loops with `io.popen('ls "<path>"/*.wav')` — no
  // flags at all. Only `-1` and `-p` were recognised, so this fell through
  // to the refusal at the bottom, `f:lines()` yielded nothing, and the
  // script loaded zero loops. It ran, it kept time, and it was silent,
  // with nothing anywhere to say why.
  //
  // A GLOB PRINTS PATHS AND A DIRECTORY PRINTS NAMES, which is what `ls`
  // does and what each caller expects: beets uses the lines as filenames.
  if (/^ls\s/.test(cmd)) {
    // The REST OF THE LINE, not the last word. `ls "<dir>"/*.wav` tokenises
    // as three words -- the quoted directory ends one and `/*.wav` begins
    // another -- so taking the last word asked for a glob at the root and
    // matched nothing. Everything after the command, with the quoting
    // removed wherever it sits, is the one thing being named.
    const target = unquote(cmd.replace(/^ls\s+(?:-\S+\s+)*/, ""));
    if (/[*?]/.test(target)) {
      // A trailing slash asks for directories; see `globDirsIn`.
      const hits = target.endsWith("/") ? globDirsIn(vfs, target) : globIn(vfs, target).sort();
      return OK(hits.join("\n") + (hits.length ? "\n" : ""));
    }
    const dir = normalise(target, vfs.home);
    if (!vfs.isDir(dir)) return OK("");
    const showAll = listsAll(cmd);
    const names = vfs
      .list(dir)
      .filter((e) => showAll || !dotted(e.name))
      .map((e) => e.name)
      .sort();
    return OK(names.join("\n") + (names.length ? "\n" : ""));
  }

  // --- mkdir -p --------------------------------------------------------
  if (/^mkdir\s/.test(cmd)) {
    for (const w of argsOf(cmd)) {
      if (w.startsWith("-")) continue;
      vfs.mkdir(unquote(w));
    }
    return OK("");
  }

  // --- rm --------------------------------------------------------------
  if (/^rm\s/.test(cmd)) {
    /**
     * E9-150 — `rm -rf <dir>` DELETED NOTHING, AND SAID IT HAD.
     *
     * The same fault as `cp -r` in E9-144 and found the same way, by
     * running the shapes the catalogue actually writes: `globIn` answers
     * with FILES, a directory is not one, so a folder argument expanded
     * to nothing and the loop had nothing to do. `rm` appears 45 times
     * in the catalogue and `rm -rf` is most of them — a script clearing
     * its own cache, a downloader clearing a staging folder.
     *
     * Worse than `cp`'s version, because this one looks like it worked:
     * nothing is missing afterwards, which is exactly what you expect to
     * see when a delete succeeds.
     *
     * Without `-r`, a directory is refused by `rm` itself, and the other
     * arguments are still removed — so this skips it rather than failing
     * the command.
     */
    const recursive = /(^|\s)-[a-zA-Z]*[rR]/.test(cmd);
    for (const w of argsOf(cmd)) {
      if (w.startsWith("-")) continue;
      const bare = unquote(w);
      const p = normalise(bare, vfs.home);
      if (vfs.isDir(p)) {
        if (!recursive) continue;
        for (const f of vfs.walk(p)) vfs.remove(f);
        // Deepest first, so a folder is empty by the time it goes.
        const dirs = vfs
          .walk(p)
          .concat([p])
          .sort((a, b) => b.length - a.length);
        for (const d of dirs) vfs.remove(d);
        vfs.remove(p);
        continue;
      }
      for (const hit of globIn(vfs, bare)) vfs.remove(hit);
    }
    return OK("");
  }

  // --- cp --------------------------------------------------------------
  if (/^cp\s/.test(cmd)) {
    const args = words(cmd)
      .slice(1)
      .filter((w) => !w.startsWith("-"))
      .map(unquote);
    const dest = args.pop();
    if (!dest) return NO("cp with no destination");
    // EXPANDED FIRST, because the count decides where things land. A
    // destination that names a FILE rather than a directory is `cp a b`
    // with one source; with several, `b` has to be a directory. The count
    // used to come from the ARGUMENTS, and a glob is one argument however
    // many files it matches — so `cp dir/* dest` relied entirely on `dest`
    // already existing, and if it did not, every matched file was written
    // onto the destination PATH in turn, each overwriting the last. One
    // file, wrongly named, where a folder was meant.
    /**
     * E9-144 — A DIRECTORY IS A SOURCE, and `-r` is what says so.
     *
     * `globIn` answers with FILES: a pattern with no `*` is kept only if
     * `vfs.exists` likes it, and a directory is not a file. So every
     * source that was a folder vanished here, the loop ran over an empty
     * list, and the command returned ok. `kolor` copies its twelve sample
     * banks in exactly that shape --
     *
     *     cp -r /home/we/dust/code/kolor/samples/bank1 /home/we/dust/audio/kolor/
     *
     * -- twelve times, and all twelve did nothing while reporting success.
     * The script then found no samples in any of them, SuperCollider said
     * "Buffer UGen: no buffer data" once per voice, and the page was left
     * running an instrument with nothing in it. Reported from a Pixel as
     * kolor being unusable; reproduced here in four lines.
     */
    const recursive = /(^|\s)-[a-zA-Z]*[rR]/.test(cmd);
    const sources = args.flatMap((a) => {
      const p = normalise(a, vfs.home);
      return vfs.isDir(p) ? [p] : globIn(vfs, a);
    });
    for (const src of sources) {
      const dir = normalise(dest, vfs.home);
      /**
       * A TRAILING SLASH MEANS "INTO", whether or not it is there yet.
       *
       * This asked `vfs.isDir(dest)`, which is false for a folder the
       * script is about to create -- and then `cp x.wav ~/dust/audio/amen/`
       * wrote a FILE called `amen` where the folder was meant. Scripts
       * write the slash when they mean a directory; it is the one piece
       * of intent the command carries and it was being thrown away.
       */
      const into = dest.endsWith("/") || vfs.isDir(dir) || sources.length > 1;
      const to = into ? `${dir}/${basename(src)}` : dir;

      if (vfs.isDir(src)) {
        // `cp` without `-r` prints "omitting directory" and carries on,
        // which is a refusal of that ONE argument and not of the command.
        if (!recursive) continue;
        for (const f of vfs.walk(src)) {
          const target = to + f.slice(src.length);
          const dref = vfs.remoteAt(f);
          if (dref !== null) {
            vfs.copyRemote(target, dref);
            continue;
          }
          const bytes = vfs.read(f);
          if (bytes) vfs.write(target, bytes);
        }
        continue;
      }

      // A SOUND FILE IS COPIED BY REFERENCE. `amen`'s init does
      // `cp .../amen/samples/amenbreak_bpm136.wav ~/dust/audio/amen/`, and
      // that file is 1.2 MB that has not been fetched yet — the manifest
      // says it exists and where it is. Reading it here to write it back
      // would pull it through the shell for a copy nothing may ever read.
      const ref = vfs.remoteAt(src);
      if (ref !== null) {
        // `copyRemote`, not `mountRemote`: this is a reference somebody
        // MADE, and it has to be remembered across a reload. The build's
        // own declarations come back from the manifest every boot; this one
        // exists nowhere else, and losing it leaves a folder listing names
        // that read as nothing.
        vfs.copyRemote(to, ref);
        continue;
      }
      const data = vfs.read(src);
      if (data) vfs.write(to, data);
    }
    return OK("");
  }

  // --- touch -------------------------------------------------------------
  //
  // E9-31. NINE SCRIPTS, and all but one are writing a marker:
  // `touch ~/dust/data/zxcvbn/meta/load_default` is a flag whose CONTENTS
  // never matter, only whether it is there. An empty file is all they need.
  //
  // `twins` is the exception and wants `touch -m -d @<epoch> "<path>"`,
  // restoring a preset's time after rewriting it — which is why the VFS
  // keeps modification times at all.
  //
  // AND ONE SHAPE IS LEFT TO FAIL ON PURPOSE. `krill`, `splnkr` and
  // `gematria` share a copied line that reads
  //
  //     os.execute("touch" .. pset_folder_path)
  //
  // with no space, so the command is `touch/home/we/dust/data/krill/`.
  // That is not a touch, it is a missing binary — and it is a missing
  // binary on a real norns too. Recognising it would be inventing a
  // behaviour the hardware does not have.
  if (/^touch(\s|$)/.test(cmd)) {
    const args = words(cmd).slice(1);
    let when: number | null = null;
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-d" || a === "--date") {
        // `-d @1700000000`: the `@` means "seconds since the epoch".
        const v = unquote(args[++i] ?? "");
        const at = /^@(\d+)$/.exec(v);
        if (!at) return NO(`touch -d wants @<epoch seconds>, got ${v}`);
        when = Number(at[1]) * 1000;
        continue;
      }
      if (a.startsWith("-")) continue; // -m, -a, -c: nothing to do here
      targets.push(unquote(a));
    }
    if (targets.length === 0) return NO("touch with no file");
    for (const t of targets) {
      const path = normalise(t, vfs.home);
      // A trailing slash means a directory was meant.
      if (t.endsWith("/")) {
        vfs.mkdir(path);
        continue;
      }
      if (!vfs.exists(path)) vfs.write(path, "");
      else if (when === null) vfs.write(path, vfs.read(path) ?? new Uint8Array());
      if (when !== null) vfs.setMtime(path, when);
    }
    return OK("");
  }

  // --- mv ------------------------------------------------------------------
  //
  // Five scripts: `mv <file> <file>`, `mv <file> <dir>` and `mv <dir> <dir>`
  // — zxcvbn archives a pset, hs010 renames its data folder, nc03-ds moves
  // a whole audio directory into ~/dust/audio.
  //
  // The destination rule is cp's, for cp's reason: with several sources the
  // destination must be a directory, and a glob is one argument however
  // many files it matches, so the count comes from the EXPANSION.
  if (/^mv\s/.test(cmd)) {
    const args = words(cmd)
      .slice(1)
      .filter((w) => !w.startsWith("-"))
      .map(unquote);
    const dest = args.pop();
    if (dest === undefined || args.length === 0) {
      return NO("mv wants a source and a destination");
    }
    const sources = args.flatMap((a) => globIn(vfs, a));
    // A DIRECTORY IS NOT A GLOB HIT. `globIn` answers with files, so a
    // plain `mv olddir newdir` would find nothing and silently do nothing.
    if (sources.length === 0) {
      for (const a of args) {
        const from = normalise(a, vfs.home);
        if (!vfs.isDir(from)) continue;
        const to = normalise(dest, vfs.home);
        const into = vfs.isDir(to) ? `${to}/${basename(from)}` : to;
        for (const f of vfs.walk(from)) moveOne(vfs, f, into + f.slice(from.length));
        vfs.remove(from);
      }
      return OK("");
    }
    for (const src of sources) {
      const dir = normalise(dest, vfs.home);
      const to = vfs.isDir(dir) || sources.length > 1 ? `${dir}/${basename(src)}` : dir;
      moveOne(vfs, src, to);
    }
    return OK("");
  }

  // --- cat -----------------------------------------------------------------
  //
  // `nornsfetch` reads `~/version.txt`. The other two call sites are a Linux
  // question — `cat /sys/class/input/*/device/name` — and a pipeline —
  // `cat /tmp/foo | sort | uniq > /tmp/files`. Both are refused below rather
  // than half-answered: a device list that comes back empty reads as "no
  // devices" instead of "not asked".
  if (/^cat\s/.test(cmd)) {
    // E9-150 — A PIPELINE IS NOT A DIFFERENT COMMAND. This refused
    // anything containing `|` or `>`, so `cat /tmp/foo | sort | uniq >
    // /tmp/files` — which the catalogue writes verbatim — was answered
    // with nothing at all, and `sort` and `uniq` have been in `runPipe`
    // the whole time. The `<` stays refused: nothing reads a file that
    // way here, and pretending to would be worse than saying no.
    if (/</.test(cmd)) return NO(`cat with an input redirect: ${cmd}`);
    const { head, pipes, redirect } = pipeline(cmd);
    if (pipes.length > 0 || redirect !== null) {
      const inner = runShell(vfs, head, depth + 1);
      if (!inner.ok) return inner;
      let text = inner.out;
      for (const stage of pipes) {
        const piped = runPipe(text, stage);
        if (piped === null) return NO(`cat: unsupported pipe — ${stage.slice(0, 40)}`);
        text = piped;
      }
      if (redirect !== null) {
        const prev = redirect.append ? (vfs.read(redirect.path) ?? new Uint8Array()) : null;
        const before = prev === null ? "" : new TextDecoder().decode(prev);
        vfs.write(redirect.path, before + text);
        return OK("");
      }
      return OK(text);
    }
    const args = words(cmd)
      .slice(1)
      .filter((w) => !w.startsWith("-"))
      .map(unquote);
    if (args.length === 0) return NO("cat with no file");
    const out: string[] = [];
    for (const a of args) {
      const hits = /[*?]/.test(a) ? globIn(vfs, a) : [normalise(a, vfs.home)];
      for (const h of hits) {
        const data = vfs.read(h);
        if (data === null) continue; // cat says so on stderr and carries on
        out.push(new TextDecoder().decode(data));
      }
    }
    return OK(out.join(""));
  }

  // --- echo, with and without a redirect -----------------------------------
  //
  // Three scripts write a one-line marker this way —
  // `echo <name> > ~/dust/data/oooooo/names/<name>` — and the file is read
  // back later, so the newline matters: `echo` adds one.
  if (/^echo(\s|$)/.test(cmd)) {
    const redirect = /^echo\s*(.*?)\s*(>>?)\s*(\S+)\s*$/.exec(cmd);
    const text = unquote(
      (redirect ? redirect[1]! : cmd.replace(/^echo\s*/, "")).trim(),
    );
    if (!redirect) return OK(text + "\n");
    const path = normalise(unquote(redirect[3]!), vfs.home);
    const before =
      redirect[2] === ">>" ? (vfs.read(path) ?? new Uint8Array()) : new Uint8Array();
    const addition = new TextEncoder().encode(text + "\n");
    const whole = new Uint8Array(before.length + addition.length);
    whole.set(before, 0);
    whole.set(addition, before.length);
    vfs.write(path, whole);
    return OK("");
  }

  // --- stat ----------------------------------------------------------------
  //
  // Only `-c`, and only the three conversions the two callers use: `%Y` the
  // modification time in seconds, `%s` the size, `%n` the name. `tmi` asks
  // `stat -c %Y <file>`; `twins` asks `stat -c "%n %Y" <dir>/*.lua` and
  // sorts its presets by the answer.
  //
  // A FILE WITH NO KNOWN TIME IS SKIPPED, not reported as 0. Both callers
  // sort on the number, and an epoch zero would put the build's own files
  // first for ever. `stat` prints nothing to stdout for a file it cannot
  // read, which is the behaviour being matched.
  if (/^stat(\s|$)/.test(cmd)) {
    const spec = /-c\s+("([^"]*)"|'([^']*)'|(\S+))/.exec(cmd);
    if (!spec) return NO(`stat without -c: ${cmd}`);
    const format = spec[2] ?? spec[3] ?? spec[4] ?? "";
    // ONLY THE THREE WE CAN ANSWER. `%U` is an owner, `%A` a permission
    // string, `%i` an inode — a browser has none of them, and leaving an
    // unknown conversion in the output would hand the caller the literal
    // `%U` as if it were the answer. Refusing says so.
    const unknown = format.match(/%./g)?.filter((c) => !["%n", "%Y", "%s"].includes(c));
    if (!format.includes("%") || (unknown !== undefined && unknown.length > 0)) {
      return NO(`stat: only %n, %Y and %s are known, not ${format}`);
    }
    const rest = cmd.slice(spec.index + spec[0].length).replace(/\s*2>\S*\s*$/, "");
    const args = words(rest)
      .filter((w) => !w.startsWith("-"))
      .map(unquote)
      .filter((w) => w !== "");
    const lines: string[] = [];
    for (const a of args) {
      const hits = (/[*?]/.test(a) ? globIn(vfs, a) : [normalise(a, vfs.home)]).sort();
      for (const h of hits) {
        if (!vfs.exists(h)) continue;
        const mtime = vfs.mtimeOf(h);
        if (format.includes("%Y") && mtime === null) continue;
        lines.push(
          format
            .replace(/%n/g, h)
            .replace(/%Y/g, String(Math.floor((mtime ?? 0) / 1000)))
            .replace(/%s/g, String(vfs.size(h) ?? 0)),
        );
      }
    }
    return OK(lines.join("\n") + (lines.length ? "\n" : ""));
  }

  // --- git clone, wget -O, curl -o ---------------------------------------
  //
  // E9-37. FOURTEEN SCRIPTS INSTALL THEIR OWN DEPENDENCIES this way, and
  // most of them want a GitHub repository or a release file — which
  // `installFromRepo` and a plain `fetch` can both do. The obstacle was
  // never the capability, it was the SHAPE: `os.execute` returns a value
  // and a download does not have one yet.
  //
  // So the shape is recognised, the work is handed to the host, and this
  // run is told it did not happen. That is not a hedge: the files really
  // are not there, and a script told otherwise would read them and find
  // nothing. It is the contract a script bringing a new engine already
  // lives with — ready next time.
  //
  // `cd <dir> && wget …` is taken too, because two of them write it that
  // way and the `cd` is only there to choose the destination.
  {
    const chain = /^cd\s+(\S+)\s*&&\s*(.*)$/.exec(cmd);
    const body = chain ? chain[2]!.trim() : cmd;
    const cwd = chain ? unquote(chain[1]!) : null;

    if (/^git\s+clone\s/.test(body)) {
      const args = words(body)
        .slice(2)
        .filter((w) => !w.startsWith("-"))
        .map(unquote);
      const url = args[0];
      if (url === undefined) return NO("git clone with no url");
      if (!/github\.com/.test(url)) return NO(`git clone of ${url}: only github can be fetched here`);
      const dest = args[1];
      if (dest === undefined) {
        // On hardware it lands in the working directory. There is no
        // working directory here, and guessing one would put somebody's
        // library somewhere they would never find it.
        return NO("git clone with no destination: nothing says where it would land");
      }
      return LATER(`fetching ${url} — it will be in place next run`, {
        kind: "repo",
        url,
        dest: normalise(dest, vfs.home),
      });
    }

    if (/^(wget|curl)\s/.test(body)) {
      const ws = words(body);
      let dest: string | null = null;
      let url: string | null = null;
      for (let i = 1; i < ws.length; i++) {
        const w = ws[i]!;
        if (w === "-O" || w === "-o" || w === "--output") {
          dest = unquote(ws[++i] ?? "");
          continue;
        }
        if (w.startsWith("-")) continue; // -q, -s, -L, -k, --max-time …
        if (/^\d+$/.test(w)) continue; // the value of a numeric flag
        if (/^https?:\/\//.test(w) && url === null) url = unquote(w);
      }
      // `> file` is a redirect, not a flag.
      const redirect = /\s>\s*(\S+)\s*$/.exec(body);
      if (redirect && dest === null) dest = unquote(redirect[1]!);
      if (url === null) return NO(`${ws[0]} with no url`);
      if (dest === null) {
        // `wget <url>` writes the basename into the working directory,
        // which only `cd … &&` gives us.
        const base = url.split("?")[0]!.split("/").pop() ?? "";
        if (cwd === null || base === "") {
          return NO(`${ws[0]} with no destination: nothing says where it would land`);
        }
        dest = `${cwd}/${base}`;
      } else if (cwd !== null && !dest.startsWith("/") && !dest.startsWith("~")) {
        dest = `${cwd}/${dest}`;
      }
      return LATER(`fetching ${url} — it will be in place next run`, {
        kind: "file",
        url,
        dest: normalise(dest, vfs.home),
      });
    }
  }

  // --- a shell script the repository ships --------------------------------
  //
  // E9-45. Nine catalogue scripts run one by name — amenbreak, graintopia,
  // makebreakbeat, norns.online, pirate-radio, sampswap, zxcvbn, warmreload
  // and terrarium — and until now `.sh` was not installed at all, so the
  // refusal named a path that did not exist. Reading it is worth more than
  // refusing it twice: the lines it contains are mostly `mkdir`, `cp`, `rm`
  // and `wget`, which this shell already knows, and the ONE line it cannot
  // do is the answer to "why doesn't this script work".
  //
  // Run line by line, stopping at the first refusal AND NAMING IT. A script
  // that half-ran is a worse lie than one that did not run, so the stop is
  // reported rather than swallowed — `os.execute` gets false, which is what
  // a failing shell script returns on hardware too.
  const asScript = /^(?:(?:ba)?sh\s+)?(\/[^\s;|&]*\.sh)$/.exec(cmd);
  if (asScript !== null && depth < 4) {
    const path = normalise(asScript[1]!, vfs.home);
    const body = vfs.read(path);
    if (body === null) return NO(`no such shell script: ${path}`);
    const text = new TextDecoder().decode(body);
    let out = "";
    let line = 0;
    /**
     * A `cd` on its own line reaches the lines BELOW it.
     *
     * Each line is run on its own here, so without this a script that does
     * `cd ~/dust/audio` and then `wget …` on the next line downloads into
     * nowhere — which is the exact shape of `amenbreak/lib/install.sh`.
     * The one-line `cd X && …` form the shell already understood is reused
     * rather than a second notion of a working directory.
     */
    let cwd = "";
    for (const raw of text.split("\n")) {
      line++;
      const one = raw.trim();
      // Comments, the shebang, blank lines, and `set -e` and friends, which
      // say how a shell should behave rather than asking it to do anything.
      if (one === "" || one.startsWith("#") || /^set\s+[-+]/.test(one)) continue;
      const cdOnly = /^cd\s+([^\s;|&]+)$/.exec(one);
      if (cdOnly !== null) {
        cwd = normalise(unquote(cdOnly[1]!), vfs.home);
        continue;
      }
      // AS WRITTEN FIRST, and only then with the directory in front of it.
      // Prefixing every line with `cd X &&` broke lines the shell knows
      // perfectly well — `echo "downloading amens"` came back as
      // `unsupported shell command: cd ... echo`, which names the wrong
      // thing and stops a script on a line that works. The `cd` is a
      // fallback for the lines where the directory is the missing part.
      let r = runShell(vfs, one, depth + 1);
      if (!r.ok && cwd !== "") {
        const again = runShell(vfs, `cd ${cwd} && ${one}`, depth + 1);
        if (again.ok || again.fetch !== undefined) r = again;
      }
      out += r.out;
      if (!r.ok) {
        return {
          out,
          ok: false,
          refused: `${path}:${line}: ${r.refused ?? "could not run"} — ${one.slice(0, 80)}`,
          ...(r.fetch !== undefined ? { fetch: r.fetch } : {}),
        };
      }
    }
    return OK(out);
  }

  // --- everything else --------------------------------------------------
  // nmcli, systemctl, sudo, curl, raspi-config, smbpasswd, sleep. All of them
  // are real on a Raspberry Pi and none of them can be here. Refusing is the
  // point: `norns.system_cmd` returning false means the callback is never
  // invoked, which is exactly what upstream does when a command cannot run.
  return NO(`unsupported shell command: ${cmd.split(/\s+/)[0]}`);
}
