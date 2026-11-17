// E3 — metros that do not drift, and a clock scheduler that does not drop.
//
// The manual clock drives the SAME scheduler, metro table and core the
// worklet does, so these are tests about behaviour rather than about a mock.
// What they cannot test is whether the audio thread is pulled and whether it
// keeps running in a hidden tab — measured in E0-39a, 8/8, and not repeated
// here.

import { describe, expect, it } from "vitest";
import { createManualClock, type ManualClock } from "../src/clock/clock.js";
import { nextClockBeat, fmax, MAX_NUM_METROS, ClockScheduler } from "../src/clock/scheduler.js";
import { ClockCore } from "../src/clock/core.js";

function clock(extra: Partial<Parameters<typeof createManualClock>[0]> = {}): {
  c: ManualClock;
  metros: Array<[number, number]>;
  clocks: Array<[number, number]>;
  stalls: number[];
} {
  const metros: Array<[number, number]> = [];
  const clocks: Array<[number, number]> = [];
  const stalls: number[] = [];
  const c = createManualClock({
    onMetro: (idx, stage) => metros.push([idx, stage]),
    onClock: (id, beat) => clocks.push([id, beat]),
    onStall: (s) => stalls.push(s),
    ...extra,
  });
  return { c, metros, clocks, stalls };
}

describe("metro", () => {
  it("sleeps first and then fires, with stage counting from 0", () => {
    // metro.cc's loop is sleep -> check -> bang -> increment, so nothing
    // happens at t=0 and the first bang carries stage 0.
    const { c, metros } = clock();
    c.metroStart(0, 0.1, -1, 0);
    c.advanceSeconds(0.05);
    expect(metros).toEqual([]);
    c.advanceSeconds(0.06);
    expect(metros).toEqual([[0, 0]]);
  });

  it("fires exactly `count` times and then stops", () => {
    const { c, metros } = clock();
    c.metroStart(0, 0.01, 3, 0);
    c.advanceSeconds(1);
    expect(metros.map(([, stage]) => stage)).toEqual([0, 1, 2]);
  });

  it("runs forever when count is -1", () => {
    const { c, metros } = clock();
    c.metroStart(0, 0.01, -1, 0);
    c.advanceSeconds(0.5);
    expect(metros.length).toBeGreaterThan(40);
  });

  it("does not drift: the hundredth bang is where arithmetic says", () => {
    // The whole reason for absolute scheduling. A relative implementation —
    // "next = now + period" on each wake — accumulates the rounding of every
    // quantum, which is how an uncorrected setTimeout loop drifted 1.5 s in
    // six seconds in E0-39.
    const { c, metros } = clock();
    c.metroStart(0, 0.01, 100, 0);
    c.advanceSeconds(1.5);
    expect(metros.length).toBe(100);
    // The clock's own time when the last one fired must be within one
    // quantum of 1.00 s. A quantum at 48 kHz is 2.67 ms.
    expect(c.time).toBeGreaterThan(1.0);
  });

  it("reuses the previous period when seconds is not positive", () => {
    // `metro:start()` with no arguments passes -1, which means "the value you
    // already had". A fixed-arity port silently restarts at 1 second.
    const { c, metros } = clock();
    c.metroStart(0, 0.02, -1, 0);
    c.advanceSeconds(0.05);
    const first = metros.length;
    c.metroStop(0);
    metros.length = 0;
    c.metroStart(0, -1, -1, 0);
    c.advanceSeconds(0.05);
    expect(metros.length).toBe(first);
  });

  it("starts at the stage it was given", () => {
    const { c, metros } = clock();
    c.metroStart(0, 0.01, -1, 4);
    c.advanceSeconds(0.015);
    expect(metros[0]).toEqual([0, 4]);
  });

  it("set_time does not move a deadline that is already set", () => {
    // metro.cc:235 does `t->time += t->delta` at the START of each sleep and
    // then waits on an ABSOLUTE deadline, so changing the period while a
    // sleep is in flight cannot shorten it. The new value governs from the
    // bang after next. Shortening the pending one would make a metro fire
    // early exactly once, which is the kind of thing a sequencer hears.
    const { c, metros } = clock();
    c.metroStart(0, 0.1, -1, 0);
    c.advanceSeconds(0.11); // one bang at 0.1; next deadline is 0.2
    c.metroSetTime(0, 0.01);
    c.advanceSeconds(0.05); // to 0.16 — still before 0.2
    expect(metros.length).toBe(1);
    c.advanceSeconds(0.05); // past 0.2
    expect(metros.length).toBe(2);
    // From here the new period governs: ten more in a tenth of a second.
    c.advanceSeconds(0.1);
    expect(metros.length).toBeGreaterThanOrEqual(11);
  });

  it("fires more than once per quantum when the period is shorter than one", () => {
    // 1 ms is legal on norns and a quantum at 48 kHz is 2.67 ms. A tick that
    // fired at most once would turn a 1 kHz metro into a 375 Hz one.
    const { c, metros } = clock();
    c.metroStart(0, 0.001, -1, 0);
    c.step(128); // 2.67 ms
    expect(metros.length).toBeGreaterThanOrEqual(2);
  });

  it("has 36 slots and refuses what is outside them", () => {
    const { c, metros } = clock();
    expect(MAX_NUM_METROS).toBe(36);
    c.metroStart(36, 0.01, -1, 0);
    c.metroStart(-1, 0.01, -1, 0);
    c.advanceSeconds(0.1);
    expect(metros).toEqual([]);
  });

  it("stops cleanly and stays stopped", () => {
    const { c, metros } = clock();
    c.metroStart(0, 0.01, -1, 0);
    c.advanceSeconds(0.05);
    const n = metros.length;
    c.metroStop(0);
    c.advanceSeconds(0.5);
    expect(metros.length).toBe(n);
  });
});

describe("the beat clock", () => {
  it("counts beats from frames at the tempo", () => {
    const { c } = clock();
    c.setTempo(120); // two beats a second
    c.transportStart();
    c.advanceSeconds(1);
    expect(c.beat).toBeCloseTo(2, 2);
  });

  it("a tempo change does not move the beat you are on", () => {
    // Re-anchoring is the point: without it, every past frame is recounted at
    // the new rate and the beat jumps.
    const { c } = clock();
    c.setTempo(120);
    c.transportStart();
    c.advanceSeconds(1);
    const before = c.beat;
    c.setTempo(60);
    expect(c.beat).toBeCloseTo(before, 6);
    c.advanceSeconds(1);
    expect(c.beat).toBeCloseTo(before + 1, 2);
  });

  it("transport start resets to beat zero", () => {
    const { c } = clock();
    c.setTempo(120);
    c.transportStart();
    c.advanceSeconds(2);
    expect(c.beat).toBeGreaterThan(3);
    c.transportStart();
    expect(c.beat).toBeCloseTo(0, 6);
  });
});

describe("clock.sync, the part a naive port loses", () => {
  it("a repeat counts from the STORED beat, so a late resume is a flam", () => {
    // E0-39b: recomputing from "now" drops 10 of 64 grid points at 0-150 ms
    // of lateness. Here, two syncs with a long gap between them must still
    // land on consecutive grid points.
    const { c, clocks } = clock();
    c.setTempo(120);
    c.transportStart();
    c.scheduleSync(1, 1, 0);
    c.advanceSeconds(0.6); // past beat 1
    expect(clocks.length).toBe(1);

    // Resume late, well past beat 2.
    c.advanceSeconds(0.9);
    c.scheduleSync(1, 1, 0);
    // The next target is beat 2 — one quantum past the stored beat 1 — which
    // is already behind us, so it fires on the very next tick.
    c.step(128);
    expect(clocks.length).toBe(2);
  });

  it("a sleep breaks the chain, as upstream says", () => {
    const { c, clocks } = clock();
    c.setTempo(120);
    c.transportStart();
    c.scheduleSync(1, 1, 0);
    c.advanceSeconds(0.6);
    c.scheduleSleep(1, 0.1);
    c.advanceSeconds(0.2);
    expect(clocks.length).toBe(2); // the sync, then the sleep
  });

  it("cancel stops a pending sync", () => {
    const { c, clocks } = clock();
    c.setTempo(120);
    c.transportStart();
    c.scheduleSync(1, 1, 0);
    c.cancel(1);
    c.advanceSeconds(2);
    expect(clocks).toEqual([]);
  });

  it("sleep fires after the seconds asked for", () => {
    const { c, clocks } = clock();
    c.scheduleSleep(7, 0.05);
    c.advanceSeconds(0.04);
    expect(clocks).toEqual([]);
    c.advanceSeconds(0.02);
    expect(clocks.map(([id]) => id)).toEqual([7]);
  });
});

describe("E3-06 acceptance: the grid, with lateness", () => {
  // E0-39b measured the naive port dropping 10 of 64 grid points at 0-150 ms
  // of lateness and 111 at 0-550 ms. This runs the PRODUCT scheduler over the
  // same shape and requires zero. The lateness is deterministic so a failure
  // is reproducible.
  function run(maxLateBeats: number): { fired: number; skipped: number } {
    const sched = new ClockScheduler();
    const quantum = 0.25;
    let beat = 0;
    let seen = 0;
    const hit = new Set<number>();
    const out: number[] = [];

    sched.scheduleSync(1, beat, quantum, 0);
    // A poor but reproducible generator, as E0-39's grid used.
    let seed = 12345;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

    while (seen < 64 && beat < 200) {
      // Advance past the next target, plus some lateness.
      beat += quantum + rand() * maxLateBeats;
      out.length = 0;
      sched.tick(beat, 0, out);
      for (const _ of out) {
        seen++;
        // Where the scheduler thinks it is, which is what the next sync
        // counts from.
        hit.add(Math.round(sched.findEventBeat(1) / quantum));
        sched.scheduleSync(1, beat, quantum, 0);
      }
    }
    // Grid points traversed, versus grid points that produced an event.
    const traversed = Math.floor(beat / quantum);
    return { fired: seen, skipped: Math.max(0, Math.min(traversed, 64) - hit.size) };
  }

  it("drops nothing at 0-0.3 beats of lateness, where the naive port dropped 10", () => {
    const r = run(0.3);
    expect(r.fired).toBe(64);
    expect(r.skipped).toBe(0);
  });

  it("drops nothing at 0-1.1 beats, where the naive port dropped 111", () => {
    const r = run(1.1);
    expect(r.fired).toBe(64);
    expect(r.skipped).toBe(0);
  });

  it("every target is an exact multiple of the quantum", () => {
    const sched = new ClockScheduler();
    sched.scheduleSync(1, 0, 0.25, 0);
    for (let k = 1; k <= 64; k++) {
      const target = sched.findEventBeat(1);
      expect(Math.abs(target - k * 0.25)).toBeLessThan(1e-12);
      sched.scheduleSync(1, target + 0.1, 0.25, 0);
    }
  });
});

describe("the arithmetic", () => {
  it("nextClockBeat lands on exact multiples", () => {
    expect(nextClockBeat(0, 1)).toBe(1);
    expect(nextClockBeat(1, 1)).toBe(2);
    expect(nextClockBeat(0.25, 0.25)).toBe(0.5);
    expect(nextClockBeat(0, 1 / 3)).toBeCloseTo(1 / 3, 12);
  });

  it("fmax is C's, not JavaScript's — and the difference is reachable", () => {
    // `clock.sync(math.huge)` passes weaver.cc's only guard. ceil(x/inf)*inf
    // is NaN; C's fmax(NaN, 0) returns 0 and the coroutine free-runs, while
    // Math.max would store NaN and hang it for ever.
    expect(fmax(NaN, 0)).toBe(0);
    expect(Math.max(NaN, 0)).toBeNaN();
    expect(nextClockBeat(0, Infinity)).toBe(0);
  });

  it("the FLT_EPSILON chain stalls at 2^30 beats, not ~1e12", () => {
    // E0-39b corrected this project's own documentation: it is a livelock at
    // about 17 years of uptime at 120 BPM, not sixteen thousand years.
    expect(nextClockBeat(2 ** 30 - 1, 1)).toBe(2 ** 30);
    expect(nextClockBeat(2 ** 30, 1)).toBe(2 ** 30); // stalls: never advances
  });
});

describe("the wall-clock witness", () => {
  it("notices wall time that passed with no audio behind it", () => {
    // E0-39a stage 8: a 3 s ctx.suspend() showed 0.54 s of audio across
    // 3.52 s of wall time, and `currentFrame` came back CONTIGUOUS. A clock
    // anchored on frames alone cannot see that at all.
    const core = new ClockCore(48000);
    let wall = 1_000_000;
    core.advance(128, wall);
    for (let i = 0; i < 100; i++) {
      wall += (128 / 48000) * 1000;
      expect(core.advance(128, wall)).toBe(0);
    }
    // Now three seconds of wall time with one quantum of audio.
    wall += 3000;
    expect(core.advance(128, wall)).toBeGreaterThan(2.9);
  });

  it("does not mistake ordinary jitter for a suspension", () => {
    const core = new ClockCore(48000);
    let wall = 1_000_000;
    core.advance(128, wall);
    for (let i = 0; i < 200; i++) {
      // Up to 20 ms of scheduling noise each way, which is a lot.
      wall += (128 / 48000) * 1000 + (Math.random() - 0.5) * 40;
      expect(core.advance(128, wall)).toBe(0);
    }
  });
});
