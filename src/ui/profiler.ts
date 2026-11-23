/**
 * E9-149 — THE BROWSER'S OWN SAMPLING PROFILER, ASKED FOR BY URL.
 *
 * `call-cost.ts` names the work this project instrumented. That is not
 * everything: a Pixel log had the main thread pinned for seventeen
 * seconds with the whole account coming to 978 ms of it, and the answer
 * was somewhere nobody had thought to put a clock. An instrument that
 * only measures what you suspected cannot tell you that you suspected
 * wrong.
 *
 * The JS Self-Profiling API samples the real stack on a timer, so it
 * finds what is running whether or not anyone expected it. It needs a
 * `Document-Policy: js-profiling` response header, which `public/_headers`
 * and the dev server both carry — the header only PERMITS it, and costs
 * nothing until something constructs a `Profiler`.
 *
 * THE RESULT GOES IN THE LOG, not only into a file. A file off a phone is
 * a thing somebody has to find, attach and send; the console is already
 * the channel that works between whoever is holding the phone and whoever
 * reads it. The file is offered as well, because the log is a summary and
 * a trace is the evidence.
 *
 * `?profile` AND NOTHING ELSE STARTS IT. No setting, no button: a page
 * that is struggling is a page whose buttons are hard to press, and the
 * URL is the one control that still works when the interface does not.
 */

/** What the API returns. Typed here because TypeScript's lib does not have it. */
interface ProfilerTrace {
  readonly frames: ReadonlyArray<{ name?: string; resourceId?: number; line?: number }>;
  readonly stacks: ReadonlyArray<{ frameId: number; parentId?: number }>;
  readonly samples: ReadonlyArray<{ timestamp: number; stackId?: number }>;
  readonly resources: readonly string[];
}

interface ProfilerLike {
  stop(): Promise<ProfilerTrace>;
  readonly sampleInterval: number;
}

type ProfilerCtor = new (opts: { sampleInterval: number; maxBufferSize: number }) => ProfilerLike;

export interface ProfileRequest {
  /** Seconds to sample for. */
  readonly seconds: number;
  /** Milliseconds between samples; the browser may give a coarser one. */
  readonly intervalMs: number;
  /**
   * Whether Lua is sampled too, from inside the interpreter (E9-200).
   *
   * OFF UNLESS ASKED FOR, with `&lua`. A count hook puts the VM on its
   * slow path for every instruction, so a run with it on is a run of a
   * slower Lua: right for finding which function is hot, wrong for
   * reading what anything costs. `_cpu` measures the difference itself.
   */
  readonly lua: boolean;
}

/**
 * Read `?profile` off a URL.
 *
 * `?profile` alone is thirty seconds, `?profile=90` is ninety. Anything
 * unreadable is treated as absent rather than guessed at, because a
 * profile that runs for a length nobody chose is one nobody can read.
 */
export function profileRequest(search: string): ProfileRequest | null {
  const p = new URLSearchParams(search);
  if (!p.has("profile")) return null;
  const raw = (p.get("profile") ?? "").trim();
  const seconds = raw === "" ? 30 : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  /**
   * E9-200 — FIVE MILLISECONDS, AND SAYABLE. It was ten, which gives a
   * five-second phase five hundred samples and a phase that is two per
   * cent busy ten of them. `&interval=2` asks for finer; the browser
   * answers with what it can do — sixteen on Windows, whatever is asked
   * — and the report prints the one it actually used.
   */
  const asked = Number(p.get("interval") ?? "");
  const intervalMs = Number.isFinite(asked) && asked >= 1 && asked <= 50 ? asked : 5;
  const lua = p.has("lua") && p.get("lua") !== "0";
  // Ten minutes is far past anything useful and well inside the buffer.
  return { seconds: Math.min(seconds, 600), intervalMs, lua };
}

/** One line of the summary: a function, and how long it was on top of the stack. */
export interface Summary {
  /** Samples where something was running. */
  readonly busy: number;
  /** Every sample the profiler took, idle included. */
  readonly total: number;
  readonly frames: HotFrame[];
  /** The commonest whole stacks, leaf first. E9-200. */
  readonly stacks: HotStack[];
}

/**
 * One stack, as far up as is worth printing.
 *
 * A function at 20% self says where the time is and not why it is being
 * called. `encodeMessage` was hot in one profile because of one caller
 * out of four, and the table of frames could not say which.
 */
export interface HotStack {
  /** `leaf < caller < its caller`, at most `STACK_DEPTH` deep. */
  readonly path: string;
  /** Share of the busy samples that ended in exactly this. */
  readonly pct: number;
}

/** How far up a stack is printed. Past this it is the event loop. */
export const STACK_DEPTH = 6;

export interface HotFrame {
  readonly name: string;
  /** Samples with this frame at the LEAF, as a share of all samples. */
  readonly selfPct: number;
  /** Samples with this frame anywhere in the stack. */
  readonly totalPct: number;
}

/**
 * Turn a trace into the few lines worth reading.
 *
 * SELF TIME FIRST, because that is where the work actually happens: a
 * frame high in the stack has a large total and tells you nothing you did
 * not know. Total is carried beside it, since a function that is nowhere
 * near the leaf but accounts for most of the run is the other shape worth
 * seeing.
 *
 * Anonymous frames keep their resource and line, because "(anonymous)"
 * twelve times is not a summary.
 */
export function hotFrames(trace: ProfilerTrace, top = 12): HotFrame[] {
  return summarise(trace, top).frames;
}

/**
 * The same, with the denominator attached.
 *
 * E9-159 — AND THE DENOMINATOR IS THE POINT. Percentages here are of the
 * samples where something was RUNNING, which is the only honest way to
 * rank functions: a page that is idle 96% of the time would otherwise
 * report every number as tiny and hide what it does when it works.
 *
 * But the same choice makes "39% self" readable as "a third of this
 * page" when it is a third of one second spread across forty-five. The
 * author of this file read two of his own traces that way and spent an
 * afternoon optimising a path that turned out to be worth 0.1
 * microseconds a call. The share of samples that were busy at all goes
 * in the line now, first, so the percentages beneath it have something
 * to be a percentage OF.
 */
export function summarise(
  trace: ProfilerTrace,
  top = 12,
  since = -Infinity,
  until = Infinity,
  topStacks = 0,
): Summary {
  const nameOf = (frameId: number): string => {
    const f = trace.frames[frameId];
    if (!f) return "(unknown)";
    const where =
      f.resourceId !== undefined && trace.resources[f.resourceId] !== undefined
        ? ` ${trace.resources[f.resourceId]!.split("/").pop()}${f.line === undefined ? "" : ":" + f.line}`
        : "";
    return (f.name && f.name !== "" ? f.name : "(anonymous)") + where;
  };

  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const paths = new Map<string, number>();
  let counted = 0;

  let window = 0;
  for (const s of trace.samples) {
    // E9-162 — AND THE BOOT IS NOT THE SCRIPT. See `startProfile`.
    if (s.timestamp < since || s.timestamp >= until) continue;
    window++;
    if (s.stackId === undefined) continue; // idle: nothing was running
    counted++;
    const leaf = trace.stacks[s.stackId];
    if (leaf) self.set(nameOf(leaf.frameId), (self.get(nameOf(leaf.frameId)) ?? 0) + 1);
    // Up the stack, each frame counted once per sample.
    const seen = new Set<string>();
    let at: number | undefined = s.stackId;
    let path = "";
    let depth = 0;
    while (at !== undefined) {
      const node: { frameId: number; parentId?: number } | undefined = trace.stacks[at];
      if (!node) break;
      const n = nameOf(node.frameId);
      if (!seen.has(n)) {
        seen.add(n);
        total.set(n, (total.get(n) ?? 0) + 1);
      }
      if (topStacks > 0 && depth < STACK_DEPTH) path += (depth === 0 ? "" : " < ") + n;
      depth++;
      at = node.parentId;
    }
    if (topStacks > 0) paths.set(path, (paths.get(path) ?? 0) + 1);
  }

  const frames =
    counted === 0
      ? []
      : [...self]
          .map(([name, n]) => ({
            name,
            selfPct: (n / counted) * 100,
            totalPct: ((total.get(name) ?? 0) / counted) * 100,
          }))
          .sort((a, b) => b.selfPct - a.selfPct)
          .slice(0, top);
  const stacks =
    counted === 0
      ? []
      : [...paths]
          .map(([path, n]) => ({ path, pct: (n / counted) * 100 }))
          .sort((a, b) => b.pct - a.pct)
          .slice(0, topStacks);
  return { busy: counted, total: window, frames, stacks };
}

export interface ProfileRun {
  /** Resolves when the profile has been taken and summarised. */
  readonly done: Promise<void>;
  /**
   * Say that the boot is over and the rest is somebody using the thing.
   *
   * E9-162 — BECAUSE THE BOOT OUTWEIGHS THE SCRIPT. A `?profile=90` from
   * a Pixel spent its first twenty-four seconds booting — restoring 1146
   * files from OPFS, compiling the SuperCollider class library, starting
   * the server — and three of the twelve lines it ranked were that
   * restore. They are real costs and worth having, but they are not what
   * somebody asking why `kolor` stutters is looking at, and mixed into
   * one ranking there is no way to tell which is which.
   */
  mark(): void;
  /**
   * Name a span, so the samples inside it are ranked on their own.
   *
   * E9-200 — `_bench` and `_cpu` run one thing at a time precisely so
   * that each can be read apart, and the instrumented account has been
   * reported per phase since E9-176. The sampled profile was still one
   * table for the whole run: seven phases of a bench in a single
   * ranking, which says what the average of seven different programs
   * spent its time on.
   */
  phase(label: string, fromMs: number, toMs: number): void;
}

/**
 * Start a profile, and report it when it ends.
 *
 * Everything is reported through `log`, including every way this can
 * fail: a browser without the API, a header the host did not send, a
 * trace with nothing in it. A profiler that quietly does not run is worse
 * than none, because somebody waits for it.
 */
export function startProfile(
  req: ProfileRequest,
  log: (line: string) => void,
  offer?: (bytes: Uint8Array, name: string) => void,
  /** What else is worth printing beside the sampled frames. E9-162. */
  account?: () => readonly string[],
): ProfileRun {
  let bootEnded: number | null = null;
  const mark = (): void => void (bootEnded = performance.now());
  const phases: Array<{ label: string; from: number; to: number }> = [];
  const phase = (label: string, from: number, to: number): void => {
    // A run of `_cpu` and `_bench` is about thirty spans. Two hundred is
    // far past that and well short of a log nobody could scroll.
    if (phases.length < 200) phases.push({ label, from, to });
  };
  const Ctor = (globalThis as { Profiler?: ProfilerCtor }).Profiler;
  if (typeof Ctor !== "function") {
    log(
      "profile: this browser has no Profiler. Chrome needs the " +
        "Document-Policy: js-profiling header, which this page sends — so " +
        "on another browser there is nothing to do.",
    );
    return { done: Promise.resolve(), mark, phase };
  }

  let profiler: ProfilerLike;
  try {
    // One sample every 10 ms for the whole run, with room to spare: the
    // buffer is in SAMPLES, and running out stops the profile early and
    // silently.
    profiler = new Ctor({
      sampleInterval: req.intervalMs,
      maxBufferSize: Math.ceil((req.seconds * 1000) / req.intervalMs) * 2,
    });
  } catch (err) {
    log(`profile: could not start — ${(err as Error).message}`);
    return { done: Promise.resolve(), mark, phase };
  }

  // What the browser GAVE, which is not always what was asked: Windows
  // rounds to its sixteen-millisecond timer. Every "seconds" below is
  // samples times this, so it has to be the real one.
  const every = profiler.sampleInterval > 0 ? profiler.sampleInterval : req.intervalMs;
  log(
    `profile: sampling for ${req.seconds} s, one sample every ${every} ms` +
      `${every === req.intervalMs ? "" : ` (${req.intervalMs} was asked for)`}. ` +
      `Load the script you want measured now.`,
  );

  const done = new Promise<void>((resolve) => {
    setTimeout(() => {
      void profiler
        .stop()
        .then((trace) => {
          const report = (s: Summary, what: string, seconds: number): void => {
            if (s.frames.length === 0) {
              log(`profile: ${what} — nothing was running.`);
              return;
            }
            const share = (s.busy / Math.max(1, s.total)) * 100;
            log(
              `profile: ${what}: ${s.total} samples over ${seconds.toFixed(0)} s, ` +
                `busy in ${s.busy} of them ` +
                `(${share.toFixed(1)}% — the percentages below are of THOSE):`,
            );
            for (const f of s.frames) {
              log(
                `  ${f.selfPct.toFixed(1).padStart(5)}% self  ${f.totalPct
                  .toFixed(1)
                  .padStart(5)}% total   ${f.name}`,
              );
            }
            // E9-200 — and who was calling, for the stacks that recur.
            for (const k of s.stacks) {
              if (k.pct < 1) break;
              log(`  ${k.pct.toFixed(1).padStart(5)}% stack  ${k.path}`);
            }
          };

          const whole = summarise(trace, 25, -Infinity, Infinity, 12);
          if (whole.frames.length === 0) {
            log("profile: no samples — the page was idle, or the buffer ran out.");
            return;
          }
          report(whole, "the whole run, boot included", (whole.total * every) / 1000);
          /**
           * E9-162 — AND AGAIN WITHOUT THE BOOT, when there was one.
           *
           * Only when the split leaves enough on the other side to rank:
           * a profile that ended while the page was still booting would
           * otherwise print a second table of four samples, which reads
           * like a finding and is noise.
           */
          if (bootEnded !== null) {
            const after = summarise(trace, 25, bootEnded, Infinity, 12);
            if (after.total >= 100) {
              report(after, "after the boot", (after.total * every) / 1000);
            }
          }
          /**
           * E9-200 — AND EACH NAMED SPAN ON ITS OWN.
           *
           * Eight frames and three stacks apiece, and only for a span
           * with enough busy samples to rank: under a dozen, the order
           * of the table is the order the dice fell in. The count is
           * printed either way, because "this phase was idle" is a
           * finding and a missing table is not.
           */
          for (const p of phases) {
            const s = summarise(trace, 8, p.from, p.to, 3);
            if (s.total === 0) continue;
            // With where it was in the run, in the same seconds the log
            // is stamped in, so a table can be found beside its mark.
            const where = `[${p.label} · ${(p.from / 1000).toFixed(1)}-${(p.to / 1000).toFixed(1)} s]`;
            if (s.busy < 12) {
              log(
                `profile: ${where} ${s.total} samples, busy in ${s.busy} ` +
                  `(${((s.busy / s.total) * 100).toFixed(1)}%) — too few to rank.`,
              );
              continue;
            }
            report(s, where, (s.total * every) / 1000);
          }
          for (const line of account?.() ?? []) log(line);
          if (offer) {
            const bytes = new TextEncoder().encode(JSON.stringify(trace));
            offer(bytes, `norns-js-profile-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`);
            log(`profile: the full trace is downloading (${(bytes.length / 1024).toFixed(0)} KB).`);
          }
        })
        .catch((err: unknown) => log(`profile: stopping failed — ${String((err as Error)?.message ?? err)}`))
        .finally(() => resolve());
    }, req.seconds * 1000);
  });

  return { done, mark, phase };
}
