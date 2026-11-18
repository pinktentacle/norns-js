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
