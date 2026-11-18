// E9-112 — how busy the main thread is, cheaply enough to leave running.
//
// A phone was brought to a crawl by a script and the page said nothing: the
// instrument draws three CPU readings on its home overlay and all three
// were dead here — `_norns.stat` was sent four zeros and the two
// `audio_get_*` calls are stubs. So norns reported a machine at rest while
// it was at eighty-five per cent of a core. See `docs/13-CPU.md`.
//
// A TIMER THAT MEASURES ITS OWN LATENESS is the whole of it. A 5 ms
// interval that fires 9 ms after the last one spent 4 ms not running,
// because something else held the thread; summed over a second, that is
// the fraction of the second the main thread was busy. It costs one timer
// and one subtraction, which is why it can be left on for ever rather than
// turned on when somebody suspects something.
//
// THE PERIOD AND THE SLACK ARE BOTH MEASURED, not chosen, and the first
// draft of this file had both wrong: see `periodMs` and `slackMs` below
// for the four-by-four of readings that settled them. A meter that reads
// 5% when the truth is 17% is worse than no meter, because it is believed.
//
// IT READS HIGH, ON PURPOSE. It catches everything that holds the thread
// and not only the parts anyone instrumented: Lua, drawing, garbage
// collection, layout, the browser's own work, other pages sharing the
// core. Validated against instrumentation that timed `lua_pcall` and the
// frame directly — `awake` 15 against 14 ms/s, `n.kria` 356 against 214.
// For "is this page busy", the larger number is the more honest one; for
// "which of our functions is slow", it is the wrong instrument entirely.
//
// A HIDDEN PAGE IS NOT A BUSY ONE. Browsers throttle timers in a
// background tab to about one a second, so every tick looks a full second
// late and the meter would read 98% for a page that is doing nothing at
// all. Hidden windows are not measured and the last reading is held.

export interface CpuMeter {
  /** Busy share of the last completed window, 0..100. */
  readonly percent: number;
  /** Windows measured since the start; 0 means nothing has been reported yet. */
  readonly windows: number;
  stop(): void;
}

export interface CpuMeterOptions {
  /**
   * How often to look, in milliseconds.
   *
   * FIVE, AND TWENTY WAS WRONG — which only measuring showed. A metro
   * callback is a couple of milliseconds; at twenty, most of them fall
   * between two ticks and are never seen. The same page, the same script,
   * the same algorithm, four periods:
   *
   *                  idle      n.kria      signal
   *     20 ms        14        56          42 ms/s
   *     10 ms        31        110         79
   *      5 ms        62        169         107
   *      2 ms        503       562         59   (the floor swallows it)
   *
   * Against instrumentation that timed `lua_pcall` directly and put
   * n.kria at 152-214 ms/s, twenty reported a fifth of the truth. Two is
   * past the browser's own timer granularity and reads half a second of
   * lateness on an idle page.
   */
  readonly periodMs?: number;
  /**
   * Lateness to forgive on each tick, in milliseconds.
   *
   * A timer is never exactly on time: at five milliseconds the browser's
   * own granularity costs about a quarter of a millisecond a tick, which
   * over two hundred ticks is a sixth of a second of lateness on a page
   * doing nothing at all. Forgiving a millisecond of it, measured:
   *
   *     slack      idle        n.kria
   *     0          62 ms/s     200 ms/s
   *     0.5        25          171
   *     1.0         4          126
   *     2.0         0          152   (noise; the signal is being eaten)
   *
   * One, because a meter that reads 2.5% on an idle page is a meter
   * people learn to ignore. It costs some of the signal — 126 against a
   * true 150-plus — and that is the right direction for a warning light
   * to be wrong in.
   */
  readonly slackMs?: number;
  /** How much to average over. One second, to match `_norns.stat`. */
  readonly windowMs?: number;
  /** Supplied by tests. `document.hidden` otherwise. */
  readonly hidden?: () => boolean;
  /** Supplied by tests. `performance.now` otherwise. */
  readonly now?: () => number;
  /** Supplied by tests, so a window can be driven without waiting for one. */
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (id: unknown) => void;
}

export function startCpuMeter(opts: CpuMeterOptions = {}): CpuMeter {
  const period = opts.periodMs ?? 5;
  const slack = opts.slackMs ?? 1;
  const window = opts.windowMs ?? 1000;
  const now = opts.now ?? (() => performance.now());
  const hidden = opts.hidden ?? (() => globalThis.document?.hidden === true);
  const every = opts.setInterval ?? ((f, ms) => setInterval(f, ms));
  const cancel = opts.clearInterval ?? ((id) => clearInterval(id as number));

  let last = now();
  let late = 0;
  let elapsed = 0;
  let percent = 0;
  let windows = 0;

  const id = every(() => {
    const t = now();
    const gap = t - last;
    last = t;
    if (hidden()) {
      // Throttled, not busy. Drop the partial window as well: half of it
      // was measured under one rule and half under another.
      late = 0;
      elapsed = 0;
      return;
    }
    elapsed += gap;
    const over = gap - period - slack;
    if (over > 0) late += over;
    if (elapsed >= window) {
      // Clamped because the two clocks are not the same clock: a timer that
      // is late by more than the window it was measured over says only
      // that the thread was gone for all of it.
      percent = Math.max(0, Math.min(100, (late / elapsed) * 100));
      windows++;
      late = 0;
      elapsed = 0;
    }
  }, period);

  return {
    get percent(): number {
      return percent;
    },
    get windows(): number {
      return windows;
    },
    stop(): void {
      cancel(id);
    },
  };
}
