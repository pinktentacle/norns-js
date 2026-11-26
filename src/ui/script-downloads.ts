// E9-255 — WHAT A SCRIPT IS DOWNLOADING, SAID AT THE TOP OF THE PAGE.
//
// A script that fetches its own files when it starts (a sample pack, a
// library it clones, an instrument mx.samples installs) hands the work to
// the page, and the page did it with only the log saying so. On a phone
// nobody has the log open: the script sat there looking broken while the
// files were on their way. So every such download is counted here, and the
// page shows one line at the top while any is running, gone when all are.
//
// E9-262 — ONE SHORT LINE, A BAR AND A WAY OUT. The first line named every
// download with its size, and `pirate-radio`, which fetches every file the
// community has uploaded to its server, made it 278 names long: a wall of
// text over the page (user, 2026-11-26: "illisible"). Now it names one
// thing, or counts many, and the bar says how far; `stop()` gives up on
// all of them, and what is given up on is not called a failure.
//
// No DOM: `main.ts` draws what `view()` says.

export interface DownloadHandle {
  /** Bytes or files so far; `total` 0 when it is not known. */
  progress(done: number, total: number): void;
  /** Finished, or not. Safe to call more than once. */
  end(ok: boolean): void;
  /** Given up on before it finished: counted as stopped, not as failed. */
  drop(): void;
}

export interface DownloadsView {
  /** "downloading moonraker.zip — 45%", or "downloading 278 files — 12 done". */
  readonly line: string;
  /** 0..1, or null when nothing says how far. */
  readonly fraction: number | null;
  /** Whether `stop()` would stop anything. */
  readonly stoppable: boolean;
}

export interface ScriptDownloads {
  /**
   * One download begins. `unit` is how its progress counts; `cancel`, when
   * given, gives up on it — it still calls `end` itself, as it would on any
   * other way out, and is then counted as stopped rather than failed.
   */
  start(label: string, unit?: "bytes" | "files", cancel?: () => void): DownloadHandle;
  /** How many are running. */
  running(): number;
  /** What the top of the page shows, or null when nothing is running. */
  view(): DownloadsView | null;
  /** Give up on everything running that can be given up on. */
  stop(): void;
  /** Labels that failed since the last time nothing was running. */
  failed(): readonly string[];
  /** How many were stopped since the last time nothing was running. */
  stopped(): number;
}

interface Item {
  readonly label: string;
  readonly unit: "bytes" | "files";
  readonly cancel: (() => void) | undefined;
  done: number;
  total: number;
  cancelled: boolean;
}

const fractionOf = (it: Item): number | null => (it.total > 0 ? Math.min(1, it.done / it.total) : null);

const amount = (it: Item): string => {
  if (it.unit === "files") return it.total > 0 ? ` — ${it.done} of ${it.total} files` : "";
  const f = fractionOf(it);
  if (f !== null) return ` — ${Math.floor(f * 100)}%`;
  return it.done > 0 ? ` — ${(it.done / 1048576).toFixed(1)} MB` : "";
};

export function createScriptDownloads(onChange: () => void): ScriptDownloads {
  const items = new Set<Item>();
  let failures: string[] = [];
  let finished = 0;
  let stoppedCount = 0;

  return {
    start(label, unit = "bytes", cancel) {
      // A new batch starts clean: the last one's outcome was said then.
      if (items.size === 0) {
        failures = [];
        finished = 0;
        stoppedCount = 0;
      }
      const it: Item = { label, unit, cancel, done: 0, total: 0, cancelled: false };
      items.add(it);
      onChange();
      let over = false;
      const end = (ok: boolean): void => {
        if (over) return;
        over = true;
        items.delete(it);
        if (it.cancelled && !ok) stoppedCount++;
        else {
          finished++;
          if (!ok) failures.push(label);
        }
        onChange();
      };
      return {
        progress(done, total) {
          if (over) return;
          it.done = done;
          it.total = total;
          onChange();
        },
        end,
        drop() {
          it.cancelled = true;
          end(false);
        },
      };
    },
    running: () => items.size,
    view() {
      if (items.size === 0) return null;
      const list = [...items];
      const stoppable = list.some((it) => it.cancel !== undefined && !it.cancelled);
      if (list.length === 1 && finished === 0) {
        const it = list[0]!;
        return { line: `downloading ${it.label}${amount(it)}`, fraction: fractionOf(it), stoppable };
      }
      // Many: counted, never listed. The bar is what is finished plus how
      // far the running ones have got, each worth one.
      const all = finished + list.length;
      const partial = list.reduce((s, it) => s + (fractionOf(it) ?? 0), 0);
      return {
        line: `downloading ${all} files — ${finished} done`,
        fraction: (finished + partial) / all,
        stoppable,
      };
    },
    stop() {
      for (const it of [...items]) {
        if (it.cancel === undefined || it.cancelled) continue;
        it.cancelled = true;
        it.cancel();
      }
      onChange();
    },
    failed: () => failures,
    stopped: () => stoppedCount,
  };
}
