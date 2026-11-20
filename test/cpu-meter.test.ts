// E9-112 — the meter that was missing when a phone went under.
//
// `src/ui/cpu-meter.ts` is a timer that measures its own lateness, and the
// whole of its behaviour is arithmetic on two clocks. Driven here by a fake
// interval and a fake clock, so the assertions are exact rather than
// "about a tenth of a second".

import { describe, expect, it } from "vitest";
import { startCpuMeter } from "../src/ui/cpu-meter.js";

/**
 * A meter whose timer and clock this test owns.
 *
 * `tick(ms)` advances the clock by `ms` and fires the interval once, which
 * is what a timer that was `ms` late looks like from inside.
 */
function fake(
  opts: { hidden?: () => boolean; periodMs?: number; windowMs?: number; slackMs?: number } = {},
) {
  let t = 0;
  let fire: () => void = () => {};
  const meter = startCpuMeter({
    // 20 and 0 here, not the real 5 and 1: these tests are about the
    // arithmetic, and a slack of zero keeps each sum legible. The real
    // numbers are measurements and live in the module.
    periodMs: opts.periodMs ?? 20,
    slackMs: opts.slackMs ?? 0,
    windowMs: opts.windowMs ?? 1000,
    now: () => t,
    ...(opts.hidden ? { hidden: opts.hidden } : { hidden: () => false }),
    setInterval: (fn) => {
      fire = fn;
      return 1;
    },
    clearInterval: () => {},
  });
  return {
    meter,
    tick(ms: number) {
      t += ms;
      fire();
    },
  };
}

describe("the main-thread busy meter", () => {
  it("reads zero when every tick is on time", () => {
    const f = fake();
    for (let i = 0; i < 50; i++) f.tick(20);
    expect(f.meter.windows).toBe(1);
    expect(f.meter.percent).toBe(0);
  });

  it("reads the share of the window the thread was gone", () => {
    // Forty ticks on time is 800 ms. Then ticks of 40 ms where 20 were
    // asked for: five of them bring the elapsed total to 1000 and the
    // window closes there, with 5 x 20 = 100 ms of lateness in it.
    const f = fake();
    for (let i = 0; i < 40; i++) f.tick(20);
    for (let i = 0; i < 5; i++) f.tick(40);
    expect(f.meter.windows).toBe(1);
    expect(f.meter.percent).toBeCloseTo((100 / 1000) * 100, 5);
  });

  it("catches one long task as well as many small ones", () => {
    // A single 500 ms block is 480 ms of lateness, which is what a script
    // that freezes the page for half a second actually looks like.
    const f = fake();
    for (let i = 0; i < 25; i++) f.tick(20);  // 500 ms, none of it late
    f.tick(500);                              // 1000 ms elapsed, 480 late
    expect(f.meter.windows).toBe(1);
    expect(f.meter.percent).toBeCloseTo((480 / 1000) * 100, 5);
  });

  it("never reports more than a whole thread", () => {
    // The two clocks are not the same clock, and a timer later than the
    // window it was measured over says only that the thread was gone for
    // all of it.
    const f = fake();
    f.tick(100000);
    expect(f.meter.percent).toBeLessThanOrEqual(100);
    expect(f.meter.percent).toBeGreaterThanOrEqual(0);
  });

  it("does not call a hidden page a busy one", () => {
    // Browsers throttle a background tab's timers to about one a second,
    // so every tick is a full second late and the meter would read 98%
    // for a page doing nothing at all.
    let away = false;
    const f = fake({ hidden: () => away });
    for (let i = 0; i < 50; i++) f.tick(20);
    expect(f.meter.percent).toBe(0);
    away = true;
    for (let i = 0; i < 5; i++) f.tick(1000);
    expect(f.meter.windows, "a hidden page reported a window").toBe(1);
    expect(f.meter.percent).toBe(0);
  });

  it("throws away the half-window it was in the middle of", () => {
    // Half measured while visible and half while throttled is not a
    // measurement of either.
    let away = false;
    const f = fake({ hidden: () => away });
    for (let i = 0; i < 12; i++) f.tick(40); // 480 ms in: half a window
    expect(f.meter.windows, "it closed a window early").toBe(0);
    away = true;
    f.tick(1000);                            // throttled, and discarded
    away = false;
    for (let i = 0; i < 50; i++) f.tick(20); // one clean second
    expect(f.meter.windows).toBe(1);
    // 0 and not (240 + 0) / 1480: the busy half was thrown away with the
    // throttled tick, so the window that reports is wholly visible time.
    expect(f.meter.percent).toBe(0);
  });

  it("forgives the slack it is given, and no more", () => {
    // The browser's own timer granularity, which on an idle page at a 5 ms
    // period is about a quarter of a millisecond a tick — a sixth of a
    // second over two hundred of them. Measured; see the module.
    const forgiving = fake({ slackMs: 1 });
    for (let i = 0; i < 50; i++) forgiving.tick(21); // 1 ms late each time
    expect(forgiving.meter.percent).toBe(0);

    const strict = fake({ slackMs: 0 });
    for (let i = 0; i < 50; i++) strict.tick(21);
    expect(strict.meter.percent).toBeCloseTo((50 / 1050) * 100, 5);
  });

  it("stops when it is told to", () => {
    let cleared: unknown = null;
    const m = startCpuMeter({
      now: () => 0,
      hidden: () => false,
      setInterval: () => 7,
      clearInterval: (id) => void (cleared = id),
    });
    m.stop();
    expect(cleared).toBe(7);
  });
});

// E9-162 — the window a once-a-second reader loses.
//
// `percent` is the LAST completed window and the log polls it once a
// second. A single blocking task stretches the meter's own interval, two
// windows close between one poll and the next, and the busy one is
// overwritten by the quiet one behind it. Measured on the dev server: a
// 2.6 s block of the main thread produced no line at all, while a 3.2 s
// one produced `cpu: 97%`. The meter saw both; only the reading of it
// lost one, which is the worst way for an instrument to fail.
describe("the worst window since somebody last looked", () => {
  /** One window that was half spent elsewhere, then one that was not. */
  const busy = (f: ReturnType<typeof fake>): void => {
    for (let i = 0; i < 25; i++) f.tick(40); // 1000 ms elapsed, 500 late
  };
  const quiet = (f: ReturnType<typeof fake>): void => {
    for (let i = 0; i < 50; i++) f.tick(20); // 1000 ms elapsed, none late
  };

  it("keeps the busy window when a quiet one closes behind it", () => {
    const f = fake();
    busy(f);
    expect(f.meter.percent).toBe(50);
    quiet(f);
    expect(f.meter.percent, "the last window is the quiet one").toBe(0);
    expect(f.meter.peakSince(), "and the busy one would have been lost").toBe(50);
  });

  it("forgets it once it has been read, so the next answer is the next span", () => {
    const f = fake();
    busy(f);
    expect(f.meter.peakSince()).toBe(50);
    quiet(f);
    expect(f.meter.peakSince()).toBe(0);
  });

  it("answers with the current reading when no window has closed since", () => {
    const f = fake();
    busy(f);
    expect(f.meter.peakSince()).toBe(50);
    expect(f.meter.peakSince(), "nothing new, so the same answer").toBe(50);
  });
});

// E9-162 — and a block longer than a window is not a share of one.
describe("one task that held the thread longer than a whole window", () => {
  it("reports the window it swallowed, wherever in one it landed", () => {
    // 900 ms of an honest window, then a single 2600 ms block. Added to
    // what came before, that is 2594 of 3500 — 74%, under the threshold
    // the log reports at, for a page that was gone for two and a half
    // seconds.
    const f = fake();
    for (let i = 0; i < 45; i++) f.tick(20); // 900 ms, none of it late
    f.tick(2600);
    expect(f.meter.percent).toBe(100);
    expect(f.meter.windows).toBe(1);
  });

  it("starts the next window clean, so the block is not counted twice", () => {
    const f = fake();
    f.tick(2600);
    expect(f.meter.percent).toBe(100);
    for (let i = 0; i < 50; i++) f.tick(20);
    expect(f.meter.percent, "the second window was quiet").toBe(0);
    expect(f.meter.windows).toBe(2);
  });

  it("leaves an ordinary late tick alone", () => {
    const f = fake();
    for (let i = 0; i < 40; i++) f.tick(20);
    for (let i = 0; i < 5; i++) f.tick(40);
    expect(f.meter.percent, "100 ms late over a 1000 ms window").toBe(10);
  });
});
