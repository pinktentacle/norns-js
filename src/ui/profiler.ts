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
  // Ten minutes is far past anything useful and well inside the buffer.
  return { seconds: Math.min(seconds, 600), intervalMs: 10 };
}

/** One line of the summary: a function, and how long it was on top of the stack. */
export interface Summary {
  /** Samples where something was running. */
  readonly busy: number;
  /** Every sample the profiler took, idle included. */
  readonly total: number;
  readonly frames: HotFrame[];
}

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
export function summarise(trace: ProfilerTrace, top = 12): Summary {
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
  let counted = 0;

  for (const s of trace.samples) {
    if (s.stackId === undefined) continue; // idle: nothing was running
    counted++;
    const leaf = trace.stacks[s.stackId];
    if (leaf) self.set(nameOf(leaf.frameId), (self.get(nameOf(leaf.frameId)) ?? 0) + 1);
    // Up the stack, each frame counted once per sample.
    const seen = new Set<string>();
    let at: number | undefined = s.stackId;
    while (at !== undefined) {
      const node: { frameId: number; parentId?: number } | undefined = trace.stacks[at];
      if (!node) break;
      const n = nameOf(node.frameId);
      if (!seen.has(n)) {
        seen.add(n);
        total.set(n, (total.get(n) ?? 0) + 1);
      }
      at = node.parentId;
    }
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
  return { busy: counted, total: trace.samples.length, frames };
}

export interface ProfileRun {
  /** Resolves when the profile has been taken and summarised. */
  readonly done: Promise<void>;
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
): ProfileRun {
  const Ctor = (globalThis as { Profiler?: ProfilerCtor }).Profiler;
  if (typeof Ctor !== "function") {
    log(
      "profile: this browser has no Profiler. Chrome needs the " +
        "Document-Policy: js-profiling header, which this page sends — so " +
        "on another browser there is nothing to do.",
    );
    return { done: Promise.resolve() };
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
    return { done: Promise.resolve() };
  }

  log(`profile: sampling for ${req.seconds} s. Load the script you want measured now.`);

  const done = new Promise<void>((resolve) => {
    setTimeout(() => {
      void profiler
        .stop()
        .then((trace) => {
          const { busy, total, frames: hot } = summarise(trace);
          if (hot.length === 0) {
            log("profile: no samples — the page was idle, or the buffer ran out.");
            return;
          }
          const share = (busy / Math.max(1, total)) * 100;
          log(
            `profile: ${total} samples over ${req.seconds} s, busy in ${busy} of them ` +
              `(${share.toFixed(1)}% — the percentages below are of THOSE):`,
          );
          for (const f of hot) {
            log(
              `  ${f.selfPct.toFixed(1).padStart(5)}% self  ${f.totalPct
                .toFixed(1)
                .padStart(5)}% total   ${f.name}`,
            );
          }
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

  return { done };
}
