// E9-109 — a script that cannot load because another script is not here.
//
// Reported from a phone (user, 2026-11-18). `tmi` would not run, and the
// whole of what the page said was:
//
//     ### MISSING INCLUDE: kolor/lib/lattice
//     ### SCRIPT ERROR: load fail
//     /home/we/dust/code/tmi/lib/tmi.lua:4: MISSING INCLUDE: kolor/lib/lattice
//     stack traceback: …
//
// Every word of that is true and none of it is actionable. `tmi/lib/tmi.lua`
// line 4 is `lattice=include("kolor/lib/lattice")` — tmi borrows a library
// from ANOTHER catalogue script, and that script is not installed. Nothing
// on screen says so, and nothing says that installing `kolor` is the cure.
//
// IT IS SUPPOSED TO BE INSTALLED FOR YOU, and usually is: E9-32 reads a
// freshly installed script's includes and E9-34 fetches what they name,
// which is why installing `tmi` here queues `kolor` behind it. But that
// happens ONCE, in the minute after the install, and it is the only time
// anybody asks. `kolor` is 446 files; a phone that backgrounds the tab, or
// a reload, or a cancel, leaves `tmi` installed and `kolor` not — and the
// question is never asked again. The user's own log carries the signature
// of exactly that: `swept 1 interrupted download: awake`.
//
// So the question is asked again at the moment it matters, which is when
// the include fails. This module is the reading of that line; what to do
// about it is `main.ts`, which has the installer.
//
// WHAT THIS DOES NOT DO: guess. A head that names no folder and no
// catalogue entry is reported as what it is, because `include` is also how
// a script reaches its OWN files and a wrong suggestion about those would
// send somebody to maiden to look for a file that was never a script.

/** `### MISSING INCLUDE: <path>`, as norns' own `startup.lua` prints it. */
export const MISSING_INCLUDE = /^### MISSING INCLUDE: (.+)$/;

/** `# script load: <path>`, which says who is asking. */
export const SCRIPT_LOAD = /^# script load: (.+)$/;

export interface MissingInclude {
  /** The whole path that was asked for, `kolor/lib/lattice`. */
  readonly path: string;
  /**
   * The folder its head names, when the head is another script's.
   *
   * Null when the include has no folder at all (`include 'lib/foo'` from
   * the script's own directory resolves against three roots and names no
   * script), or when the head IS the asking script.
   */
  readonly want: string | null;
  /** True when that folder is in `code/` and the FILE is what is missing. */
  readonly installed: boolean;
  /** One line a person can act on. */
  readonly line: string;
}

/**
 * What a `### MISSING INCLUDE` line means.
 *
 * @param path      what `include()` was given, e.g. `kolor/lib/lattice`.
 * @param by        the script that asked, by folder name, or null.
 * @param installed does `code/<name>` exist and hold anything?
 */
export function readMissingInclude(
  path: string,
  by: string | null,
  installed: (name: string) => boolean,
): MissingInclude {
  const asker = by === null ? "this script" : by;
  const slash = path.indexOf("/");
  if (slash <= 0) {
    // No folder: `include 'lib/foo'` without a head, or a bare name.
    // `startup.lua` looked in the script's own directory, `code/` and
    // `extn/`, so the file simply is not anywhere — and nothing can be
    // installed to change that.
    return {
      path,
      want: null,
      installed: false,
      line: `${asker} includes \`${path}\`, which is not in its own folder, in ~/dust/code or in extn/. That is a file the script is missing, not a library you can install.`,
    };
  }
  const head = path.slice(0, slash);
  if (by !== null && head.toLowerCase() === by.toLowerCase()) {
    return {
      path,
      want: null,
      installed: true,
      line: `${asker} includes its own \`${path}.lua\` and that file is not in it — the install was cut short, or the repository moved it. Reinstalling ${asker} from maiden replaces the folder.`,
    };
  }
  if (installed(head)) {
    return {
      path,
      want: head,
      installed: true,
      line: `${asker} includes \`${path}\` and \`${head}\` IS installed, but \`${path}.lua\` is not in it — a part-finished install, or a version that no longer ships it. Reinstalling ${head} from maiden replaces the folder.`,
    };
  }
  return {
    path,
    want: head,
    installed: false,
    line: `${asker} borrows a library from \`${head}\`, which is not installed.`,
  };
}
