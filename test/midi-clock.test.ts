// E3-09 — MIDI clock as a source.
//
// A MIDI clock transmits no tempo, only 24 pulses per quarter note, so the
// tempo is a measurement and the tests are about how that measurement
// behaves: how fast it settles, what it does with a jittery tick, and what
// it does when the sender vanishes.

import { describe, expect, it } from "vitest";
import { MidiClockSource, type ClockReference } from "../src/clock/midi-source.js";

function source() {
  const refs: ClockReference[] = [];
  const starts: number[] = [];
  const stops: number[] = [];
  const s = new MidiClockSource({
    onReference: (r) => refs.push(r),
    onStart: () => starts.push(refs.length),
    onStop: () => stops.push(refs.length),
  });
  return { s, refs, starts, stops };
}

/** Ticks at a steady tempo. 24 per beat. */
function run(s: MidiClockSource, bpm: number, ticks: number, from = 0): number {
  const dt = 60 / bpm / 24;
  let t = from;
  for (let i = 0; i < ticks; i++) {
    s.handle(0xf8, t);
    t += dt;
  }
  return t;
}

describe("measuring the tempo", () => {
  it("says nothing on the first tick, because there is no interval yet", () => {
    const { s, refs } = source();
    s.handle(0xf8, 0);
    expect(refs).toEqual([]);
    expect(s.tempo).toBe(0);
  });

  it("TAKES TWO BEATS TO SETTLE, and is wildly wrong for the first", () => {
    // This is upstream's, and it is not obvious from the code. The
    // incremental mean recomputes its scale factor only while the buffer is
    // filling, so during the first 24 intervals the entries are D/1, D/2,
    // D/3 ... and nothing is ever subtracted. The sum is therefore D·H(n),
    // the harmonic number — at n = 24 that is 3.776·D, and the tempo reads
    // 120/3.776 ≈ 32 bpm.
    //
    // From the 25th interval the stale entries start being subtracted, one
    // per tick, and the sum walks down to exactly D by the 48th. So an
    // external clock is believable after two beats and not before.
    //
    // Kept rather than fixed: a script that waits a beat before trusting
    // `clock.get_tempo()` is written against this, and a norns-js that
    // settled in one tick would be a different instrument.
    const { s } = source();
    const dt = 60 / 120 / 24;
    let t = 0;
    const at: Record<number, number> = {};
    for (let i = 0; i < 49; i++) {
      s.handle(0xf8, t);
      t += dt;
      at[i + 1] = s.tempo;
    }
    expect(at[25]!).toBeCloseTo(60 / (0.5 * harmonic(24)), 3); // ≈ 31.8
    expect(at[37]!).toBeCloseTo(60 / (0.5 * (harmonic(24) + 0.5 - harmonic(12))), 3);
    expect(at[49]!).toBeCloseTo(120, 9); // exact, two beats in
  });

  it("gives a beat that advances by 1/24 a tick", () => {
    const { s, refs } = source();
    run(s, 120, 5);
    // The counter starts at 0 and the first tick only sets the time, so the
    // four references are beats 1/24 .. 4/24.
    expect(refs.map((r) => r.beat)).toEqual([1 / 24, 2 / 24, 3 / 24, 4 / 24]);
  });

  it("averages over 24 ticks, so one late tick barely moves it", () => {
    const { s } = source();
    const dt = 60 / 120 / 24;
    let t = 0;
    for (let i = 0; i < 72; i++) {
      s.handle(0xf8, t);
      // One tick arrives 30% late, after the mean has settled.
      t += i === 50 ? dt * 1.3 : dt;
    }
    // A naive per-tick tempo would read 92 bpm at that moment. The mean of
    // 24 absorbs it to about a percent.
    expect(s.tempo).toBeGreaterThan(118);
    expect(s.tempo).toBeLessThan(120.5);
  });

  it("follows a real tempo change over the next beat", () => {
    const { s } = source();
    const t = run(s, 120, 49);
    expect(s.tempo).toBeCloseTo(120, 9);
    const t2 = run(s, 140, 24, t);
    // 23 intervals at the new tempo and one straddling the change.
    expect(s.tempo).toBeGreaterThan(138);
    expect(s.tempo).toBeLessThan(140);
    run(s, 140, 2, t2);
    expect(s.tempo).toBeCloseTo(140, 6);
  });

  it("discards a gap longer than four seconds instead of calling it 15 bpm", () => {
    // `beat_duration > 4` in clock_midi.cc: the sender stopped without
    // saying so. Without this, unplugging mid-bar leaves norns crawling.
    const { s } = source();
    const t = run(s, 120, 49);
    s.handle(0xf8, t + 10);
    expect(s.tempo).toBeCloseTo(120, 6);
  });
});

/** H(n), which is what the filling phase of the mean sums to. */
function harmonic(n: number): number {
  let h = 0;
  for (let k = 1; k <= n; k++) h += 1 / k;
  return h;
}

describe("transport", () => {
  it("starts on the FIRST TICK after 0xFA, not on the byte", () => {
    // clock_midi_handle_start sets the counter to -1 so the next tick makes
    // it 0, and `counter == 0` is what fires the start. That is what keeps
    // norns aligned with the sender's first beat rather than with the
    // moment its start byte happened to arrive.
    const { s, starts, refs } = source();
    const t = run(s, 120, 10);
    const before = refs.length;
    s.handle(0xfa, t);
    expect(starts).toEqual([]);
    s.handle(0xf8, t);
    expect(starts.length).toBe(1);
    expect(refs.length).toBe(before + 1);
  });

  it("defers the start when the restart tick is too far from the last one", () => {
    // A long gap is discarded as "the sender stopped", and a discarded tick
    // does not increment the counter — so the start waits for a tick that
    // measures. Upstream's behaviour, and the right one: starting on a tick
    // whose interval was nonsense would start with a nonsense tempo.
    const { s, starts } = source();
    const t = run(s, 120, 10);
    s.handle(0xfa, t);
    s.handle(0xf8, t + 10);
    expect(starts).toEqual([]);
    s.handle(0xf8, t + 10 + 60 / 120 / 24);
    expect(starts.length).toBe(1);
  });

  it("puts the beat back to 0 on a restart", () => {
    const { s, refs } = source();
    const t = run(s, 120, 30);
    s.handle(0xfa, t);
    s.handle(0xf8, t);
    expect(refs[refs.length - 1]!.beat).toBe(0);
  });

  it("keeps the measured tempo across a restart", () => {
    // clock_midi_handle_start does NOT clear the duration buffer, so a
    // sequencer stopped and started again does not have to be re-learned.
    const { s } = source();
    const t = run(s, 140, 49);
    expect(s.tempo).toBeCloseTo(140, 6);
    s.handle(0xfa, t);
    s.handle(0xf8, t);
    expect(s.tempo).toBeGreaterThan(130);
  });

  it("stops on 0xFC", () => {
    const { s, stops } = source();
    run(s, 120, 5);
    s.handle(0xfc, 1);
    expect(stops.length).toBe(1);
  });

  it("ignores bytes that are not clock, start or stop", () => {
    const { s, refs, starts, stops } = source();
    for (const b of [0xfb, 0xfe, 0xff, 0x90]) s.handle(b, 0);
    expect([refs.length, starts.length, stops.length]).toEqual([0, 0, 0]);
  });
});
