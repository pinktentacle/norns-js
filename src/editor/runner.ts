// maiden, phase 2: the play button, and the error that comes back.
//
// WHAT MAIDEN DOES, copied rather than invented. `bound-edit-activity.js`
// sends `norns.script.load("<the file you are editing>")` to the matron
// REPL, and refuses anything under `/lib/`, `/data/` or `/audio/` — it
// runs the FILE, not some script the file belongs to. A folder under
// `code/` can hold several loadable scripts and SELECT lists them all, so
// running the one in front of you is the only answer that is never wrong.
//
// ONE DEPARTURE, AND IT IS NOT OPTIONAL. maiden loads the script from
// wherever the norns happens to be; this goes through the menu first.
// `Script.init` ends in an unconditional `_norns.screen_save()` and the
// matching `screen_restore` in `Script.run` only happens when the menu is
// showing — so loading from play mode pushes one cairo gstate per load and
// never pops it. About twenty loads later the deeper stack leaves cairo's
// tessellator too little wasm stack, a fill over a self-intersecting arc
// overflows it, and the module traps (E5-27, found by the exerciser).
// Twenty is a normal afternoon with a play button.
//
// HOW THE OUTCOME IS READ: from what norns already prints, and nothing
// else. No hook into `norns.init_done`, no sentinel of our own, no probe
// into a Lua table — `script.lua:146` prints `# script init` and
// `menu.lua:82` prints `### SCRIPT ERROR: ` followed by the error and its
// traceback. Reading those is reading the same thing the person would read
// in the console, which is the one definition of "what happened" that
// cannot drift from what they are shown.

import type { Host } from "../lua/host.js";

export interface RunOutcome {
  readonly ok: boolean;
  /** What went wrong, as norns said it. Null on success. */
  readonly message: string | null;
  /** The file and line the error named, when it named one. */
  readonly at: { readonly path: string; readonly line: number } | null;
}

export interface MaidenRunner {
  /** Why this file cannot be run, or null when it can. */
  refuse(path: string): string | null;
  run(path: string): Promise<RunOutcome>;
}

const CODE = "/home/we/dust/code/";

/**
 * `path.lua:123:` out of a Lua error, which is how the line gets marked.
 *
 * Lua puts the chunk name and line at the front of the message it raises,
 * and norns' own handler prints that message verbatim before the
 * traceback. The traceback lines carry the same shape, so the FIRST match
 * is the one that matters — it is where the error was raised rather than
 * where it was caught.
 */
function siteOf(text: string): { path: string; line: number } | null {
  const m = /(\/home\/we\/dust\/[^\s:]+):(\d+):/.exec(text);
  if (m === null) return null;
  return { path: m[1]!, line: Number(m[2]) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createRunner(
  host: Host,
  opts: { initTimeoutMs?: number; settleMs?: number } = {},
): MaidenRunner {
  const initTimeout = opts.initTimeoutMs ?? 20_000;
  // AFTER `# script init`, NOT INSTEAD OF IT. That line is printed before
  // `init()` is called, not after it returns — so an error inside init
  // arrives just behind it, and a success is the absence of one. The window
  // is the price of not hooking anything.
  const settle = opts.settleMs ?? 700;

  const menu = (on: boolean): void => {
    host.run(`if _menu and _menu.set_mode then pcall(_menu.set_mode, ${on}) end`);
  };

  return {
    refuse(path) {
      if (!path.startsWith(CODE)) return "only files under code/ can be run";
      if (!path.endsWith(".lua")) return "not a lua file";
      for (const part of ["/lib/", "/data/", "/audio/"]) {
        if (path.includes(part)) return `files under ${part.slice(1)} are not scripts`;
      }
      return null;
    },

    async run(path) {
      const why = this.refuse(path);
      if (why !== null) return { ok: false, message: why, at: null };

      const from = host.output.length;
      menu(true);
      const raised = host.run(`norns.script.load(${JSON.stringify(path)})`);
      if (raised !== null) {
        menu(false);
        return { ok: false, message: raised, at: siteOf(raised) };
      }

      const since = (): string[] => host.output.slice(from);
      const failure = (lines: string[]): RunOutcome => {
        const i = lines.findIndex(
          (l) => l.startsWith("### SCRIPT ERROR:") || l.startsWith("# script load failed"),
        );
        // The line norns printed, plus what followed it: the message Lua
        // raised lives in the lines AFTER the banner, and the banner alone
        // says "init" and nothing else.
        const text = lines.slice(i, i + 6).join("\n");
        return { ok: false, message: text.trim(), at: siteOf(text) };
      };

      const deadline = performance.now() + initTimeout;
      let started = false;
      while (performance.now() < deadline) {
        const lines = since();
        if (lines.some((l) => l.startsWith("### SCRIPT ERROR:") || l.startsWith("# script load failed"))) {
          menu(false);
          return failure(lines);
        }
        if (lines.some((l) => l === "# script init")) {
          started = true;
          break;
        }
        await sleep(50);
      }

      if (!started) {
        menu(false);
        return { ok: false, message: "it never reached init", at: null };
      }

      await sleep(settle);
      const lines = since();
      if (lines.some((l) => l.startsWith("### SCRIPT ERROR:"))) {
        menu(false);
        return failure(lines);
      }
      // Back to play mode, which is where a script draws — and which pops
      // the gstate the menu pushed.
      menu(false);
      return { ok: true, message: null, at: null };
    },
  };
}
