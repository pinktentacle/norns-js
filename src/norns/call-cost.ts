/**
 * E9-138 — WHICH CALLBACK HELD THE THREAD.
 *
 * `src/ui/cpu-meter.ts` answers "is this page busy" and says so in its own
 * comment: *for "which of our functions is slow", it is the wrong
 * instrument entirely*. It measures a timer's lateness, so it catches
 * everything — Lua, drawing, garbage collection, the browser's own work —
 * and can name none of it.
 *
 * That was enough while the question was "is the phone struggling". It is
 * not enough for "the script is unusable and Chrome is nearly frozen",
 * because the log from such a session contains no performance information
 * at all: it simply stops. Somebody reading it afterwards learns what the
 * page was doing before the trouble and nothing about the trouble.
 *
 * EVERY CALLBACK GOES THROUGH TWO `lua_pcall`s. `callNorns` and
 * `callGlobal` in `callbacks.ts` are the whole of JS→Lua — `_norns.metro`
 * is how every metro in norns fires, `_norns.key` and `_norns.enc` are the
 * only way anything is played — so two `performance.now()` calls around
 * those two sites time all of it, attributed by name.
 *
 * ALWAYS ON. A clock read is tens of nanoseconds and the callbacks run at
 * a few hundred a second; the meter beside it already costs a timer every
 * five milliseconds. An instrument you have to switch on is one that is
 * off when the thing you needed it for happened.
 *
 * WHAT IT CANNOT DO, said here rather than discovered: a call that never
 * returns is never timed. If Lua goes into a loop with no end, the page is
 * gone and so is the log. This catches the case that is actually reported
 * — a callback that takes seconds, over and over — and not the one that
 * takes for ever.
 */

export interface SlowCall {
  /** `metro`, `grid.key`, `redraw` — the name as `callbacks.ts` spells it. */
  readonly path: string;
  /** This call, in milliseconds. */
  readonly ms: number;
  /** The worst this path has been since the last reset. */
  readonly worstMs: number;
  /** How many times it has been called since the last reset. */
  readonly calls: number;
}

interface Totals {
  calls: number;
  ms: number;
  worst: number;
  reportedAt: number;
}

const totals = new Map<string, Totals>();
let onSlow: ((c: SlowCall) => void) | null = null;
let thresholdMs = 120;
let quietMs = 5000;
let clock: () => number = () => performance.now();

/**
 * Start reporting calls that take too long.
 *
 * `thresholdMs` is 120 by default: four frames at 30 Hz, past anything a
 * metro callback does on purpose and well under the second it takes for a
 * page to feel stuck. `quietMs` rate-limits per path, because a script
 * that is too slow is too slow on every callback and a line each would
 * bury the log it is meant to explain.
 */
export function watchCallCost(opts: {
  onSlow: (c: SlowCall) => void;
  thresholdMs?: number;
  quietMs?: number;
  now?: () => number;
}): void {
  onSlow = opts.onSlow;
  if (opts.thresholdMs !== undefined) thresholdMs = opts.thresholdMs;
  if (opts.quietMs !== undefined) quietMs = opts.quietMs;
  if (opts.now !== undefined) clock = opts.now;
}

/**
 * Time one call into Lua.
 *
 * THE RETURN VALUE IS PASSED THROUGH rather than the caller timing itself,
 * so the two call sites cannot drift apart or forget the second clock read
 * on an early return.
 */
/**
 * E9-160 — SELF TIME, because these nest now.
 *
 * `osc:to-server` is called from inside a `metro` callback, and
 * `draw:grid` from inside a refresh that a callback asked for. Counting
 * the whole elapsed time against each would report the same
 * microseconds two and three times over, and the totals would add up to
 * more than the span they are meant to explain — which is worse than no
 * total at all, because it reads like one.
 *
 * So each entry keeps the time spent INSIDE it and not inside something
 * else it called. The sum of those is the instrumented work, and
 * subtracting it from a busy span is what says how much nothing has a
 * clock on.
 */
let childTime = 0;

export function timed<T>(path: string, run: () => T): T {
  const t0 = clock();
  const outerChild = childTime;
  childTime = 0;
  try {
    return run();
  } finally {
    const elapsed = clock() - t0;
    record(path, elapsed - childTime);
    // What this call cost its own caller, which is all of it.
    childTime = outerChild + elapsed;
  }
}

/** Account for one call. Exported for the tests; `timed` is the way in. */
export function record(path: string, ms: number): void {
  let t = totals.get(path);
  if (t === undefined) {
    t = { calls: 0, ms: 0, worst: 0, reportedAt: -Infinity };
    totals.set(path, t);
  }
  t.calls++;
  t.ms += ms;
  if (ms > t.worst) t.worst = ms;
  if (onSlow === null || ms < thresholdMs) return;
  const at = clock();
  if (at - t.reportedAt < quietMs) return;
  t.reportedAt = at;
  onSlow({ path, ms, worstMs: t.worst, calls: t.calls });
}

/** Everything seen since the last reset, dearest first. */
export function callCosts(): ReadonlyArray<{ path: string; calls: number; ms: number; worstMs: number }> {
  return [...totals]
    .map(([path, t]) => ({ path, calls: t.calls, ms: t.ms, worstMs: t.worst }))
    .sort((a, b) => b.ms - a.ms);
}

/** `162 ms`. Every entry in this table is a duration again. */
export function sayCost(c: { ms: number }): string {
  return `${c.ms.toFixed(0)} ms`;
}

/** Forget everything. A new script is a new measurement. */
export function resetCallCosts(): void {
  totals.clear();
  childTime = 0;
}

/** Every instrumented millisecond since the last reset, self time only. */
export function accountedMs(): number {
  let ms = 0;
  for (const t of totals.values()) ms += t.ms;
  return ms;
}

/** Tests only: put the module back as it was found. */
export function stopWatchingCallCost(): void {
  childTime = 0;
  onSlow = null;
  thresholdMs = 120;
  quietMs = 5000;
  clock = () => performance.now();
  totals.clear();
}
