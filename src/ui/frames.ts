/**
 * E9-162 — WHERE THE MAIN THREAD WENT WHEN IT WAS NOT JAVASCRIPT.
 *
 * A `?profile=90` from a Pixel 9 Pro playing `kolor` closed one question
 * and opened a better one:
 *
 *     profile: 8987 samples over 90 s, busy in 562 of them (6.3%)
 *     cpu: 92% of the main thread — the page is at its limit
 *
 * Both are this project's instruments and both are right. The sampler
 * found JavaScript on the stack in six per cent of its samples; the
 * meter found the thread unavailable for ninety-two per cent of a
 * second, and never reported coming back down for the fifty-three
 * seconds that followed. Five and a half seconds of script cannot
 * explain forty of saturation, so the cost is not script — and nothing
 * this project had could say what it was instead.
 *
 * `cpu-meter.ts` cannot: it measures a timer's lateness, so it catches
 * everything and names none of it, which its own comment says. The
 * sampler cannot either: the JS Self-Profiling API samples JS STACKS, so
 * style, layout, paint, garbage collection and the compositor are not
 * "some other function" to it — they are indistinguishable from an idle
 * page.
 *
 * LONG ANIMATION FRAMES ARE THE INSTRUMENT FOR EXACTLY THIS. The browser
 * reports every frame that took more than 50 ms and breaks it down from
 * the inside: which scripts ran and for how long, when rendering began,
 * when style and layout began. The remainder is the main thread doing
 * something no script asked for.
 *
 * SO A NEGATIVE RESULT IS ALSO A RESULT. If the meter says the thread is
 * pinned and this reports NO long frames at all, then the main thread is
 * not the thing that is busy — and on a phone running a software
 * synthesiser in an audio worklet, the next place to look is the audio
 * thread competing for a core. That is why the line prints its count
 * even when the count is zero.
 *
 * COSTS NOTHING UNTIL A FRAME IS SLOW. The observer is handed entries
 * the browser was already producing, only for frames past 50 ms. A page
 * that is keeping up reports nothing and does no work.
 */

/** One `long-animation-frame` entry, as much of it as this file reads. */
interface LoafEntry {
  readonly startTime: number;
  readonly duration: number;
  /** When rendering began, or 0 if the frame did not render. */
  readonly renderStart?: number;
  /** When style and layout began, or 0 if there was none. */
  readonly styleAndLayoutStart?: number;
  readonly scripts?: ReadonlyArray<{
    readonly duration?: number;
    readonly invoker?: string;
    readonly invokerType?: string;
    readonly sourceFunctionName?: string;
  }>;
}

export interface FrameLoad {
  /** Frames over 50 ms since the last reset. */
  readonly frames: number;
  /** All of their durations together. */
  readonly totalMs: number;
  /** Of that, what scripts took. */
  readonly scriptMs: number;
  /** Of that, rendering — style, layout and the main thread's share of paint. */
  readonly renderMs: number;
  /** Of the rendering, style and layout alone. */
  readonly styleLayoutMs: number;
  /** The worst single frame. */
  readonly worstMs: number;
  /** What asked for the scripts, dearest first. */
  readonly byInvoker: ReadonlyArray<{ name: string; ms: number; calls: number }>;
}

export interface FrameWatch {
  load(): FrameLoad;
  /** Forget everything — a new span is a new measurement. */
  reset(): void;
  stop(): void;
}

export interface Mutable {
  frames: number;
  totalMs: number;
  scriptMs: number;
  renderMs: number;
  styleLayoutMs: number;
  worstMs: number;
  byInvoker: Map<string, { ms: number; calls: number }>;
}

export function emptyLoad(): Mutable {
  return {
    frames: 0,
    totalMs: 0,
    scriptMs: 0,
    renderMs: 0,
    styleLayoutMs: 0,
    worstMs: 0,
    byInvoker: new Map(),
  };
}

/**
 * Add one entry to a running total. Exported for the tests, which must be
 * able to feed entries no browser is going to produce on demand.
 */
export function foldFrame(into: Mutable, e: LoafEntry): void {
  into.frames++;
  into.totalMs += e.duration;
  if (e.duration > into.worstMs) into.worstMs = e.duration;
  const end = e.startTime + e.duration;
  // `renderStart` and `styleAndLayoutStart` are 0 when that phase did not
  // happen, and a 0 is not a timestamp — it would make the phase look as
  // though it took the whole frame and then some.
  const render = e.renderStart !== undefined && e.renderStart > 0 ? Math.max(0, end - e.renderStart) : 0;
  const styleLayout =
    e.styleAndLayoutStart !== undefined && e.styleAndLayoutStart > 0
      ? Math.max(0, end - e.styleAndLayoutStart)
      : 0;
  into.renderMs += render;
  into.styleLayoutMs += styleLayout;
  for (const s of e.scripts ?? []) {
    const ms = s.duration ?? 0;
    into.scriptMs += ms;
    // `invoker` is what the browser says asked for it — a listener, a
    // timer, a frame callback. It is the attribution a sampled stack
    // cannot give, because by the time anything is slow the stack is
    // somewhere else.
    const name = s.invoker ?? s.sourceFunctionName ?? s.invokerType ?? "(unattributed)";
    const got = into.byInvoker.get(name) ?? { ms: 0, calls: 0 };
    got.ms += ms;
    got.calls++;
    into.byInvoker.set(name, got);
  }
}

export function snapshot(m: Mutable): FrameLoad {
  return {
    frames: m.frames,
    totalMs: m.totalMs,
    scriptMs: m.scriptMs,
    renderMs: m.renderMs,
    styleLayoutMs: m.styleLayoutMs,
    worstMs: m.worstMs,
    byInvoker: [...m.byInvoker]
      .map(([name, v]) => ({ name, ms: v.ms, calls: v.calls }))
      .sort((a, b) => b.ms - a.ms),
  };
}

/**
 * One line, or null when there is nothing to say.
 *
 * SCRIPT AND RENDER, AND WHAT IS LEFT. The three add up to the frames'
 * own duration, so a reader can see at a glance which of them the page
 * is spending itself on without working out a percentage.
 */
export function describeFrames(l: FrameLoad): string | null {
  if (l.frames === 0) return null;
  const other = Math.max(0, l.totalMs - l.scriptMs - l.renderMs);
  const who = l.byInvoker
    .filter((i) => i.ms >= 1)
    .slice(0, 2)
    .map((i) => `${i.name} ${i.ms.toFixed(0)} ms`)
    .join(" · ");
  return (
    `frames: ${l.frames} over 50 ms, ${(l.totalMs / 1000).toFixed(1)} s in all ` +
    `(worst ${l.worstMs.toFixed(0)} ms) — script ${l.scriptMs.toFixed(0)} ms, ` +
    `render ${l.renderMs.toFixed(0)} ms of which style+layout ${l.styleLayoutMs.toFixed(0)}, ` +
    `other ${other.toFixed(0)} ms` +
    (who === "" ? "" : ` · ${who}`)
  );
}

interface ObserverLike {
  observe(opts: { type: string; buffered?: boolean }): void;
  disconnect(): void;
}
type ObserverCtor = new (cb: (list: { getEntries(): LoafEntry[] }) => void) => ObserverLike;

/**
 * Start watching, if this browser reports long animation frames.
 *
 * Returns a watch that reads zero everywhere when it does not, rather
 * than null: a caller that has to branch on whether its instrument
 * exists ends up with two code paths and tests only the one it has.
 */
export function watchLongFrames(ctor?: ObserverCtor): FrameWatch {
  let acc = emptyLoad();
  const Ctor = ctor ?? (globalThis as { PerformanceObserver?: ObserverCtor }).PerformanceObserver;
  let obs: ObserverLike | null = null;
  if (typeof Ctor === "function") {
    try {
      obs = new Ctor((list) => {
        for (const e of list.getEntries()) foldFrame(acc, e);
      });
      // `buffered` so a frame that was slow before anyone asked is still
      // counted; an unsupported type throws here and is caught.
      obs.observe({ type: "long-animation-frame", buffered: true });
    } catch {
      obs = null;
    }
  }
  return {
    load: () => snapshot(acc),
    reset: () => void (acc = emptyLoad()),
    stop: () => obs?.disconnect(),
  };
}
