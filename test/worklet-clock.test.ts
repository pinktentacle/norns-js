// E9-181 — the worklet clock's main-thread half, with NO animation frames.
//
// `test/clock.test.ts` drives the manual clock, which shares the core, the
// metro table and the scheduler — everything except the part that was
// broken. What was broken lives only in `createWorkletClock`: a beat mirror
// recomputed inside `requestAnimationFrame`, and a ring drained from the
// same place.
//
// Measured with the tab behind another in the same pane, before the fix:
//
//     ctx.currentTime   +5.011 s over 5.003 s of wall time
//     clock.beat        +0.000
//     rAF               0 frames in 8 s
//     metro at 20 Hz    0 callbacks in 8 s
//
// So `requestAnimationFrame` here is a function that is CALLED and never
// calls back. That is not a convenience for the test: it is the condition
// the bug needed, and every assertion below is about what still has to work
// without a single frame.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkletClock } from "../src/clock/clock.js";
import { ringPush, ringViews, EV_METRO, EV_CLOCK } from "../src/clock/ring.js";

type Port = {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage: (m: unknown) => void;
  sent: unknown[];
};

type Harness = {
  ctx: { currentTime: number; sampleRate: number; audioWorklet: { addModule: () => Promise<void> } };
  port: Port;
  /** The SharedArrayBuffer the clock handed the processor, or null. */
  sab: SharedArrayBuffer | null;
  rafCalls: number;
};

let h: Harness;

/** Advance the audio clock, as the audio thread does whether or not anyone looks. */
function audioSeconds(seconds: number): void {
  h.ctx.currentTime += seconds;
}

beforeEach(() => {
  h = {
    ctx: {
      currentTime: 100, // not zero: a real context has been running a while
      sampleRate: 48000,
      audioWorklet: { addModule: async () => {} },
    },
    port: { onmessage: null, postMessage: (m: unknown) => void h.port.sent.push(m), sent: [] },
    sab: null,
    rafCalls: 0,
  };

  class FakeNode {
    port: Port;
    constructor(_ctx: unknown, _name: string, opts: { processorOptions?: { sab?: SharedArrayBuffer } }) {
      h.sab = opts.processorOptions?.sab ?? null;
      this.port = h.port;
    }
    disconnect(): void {}
  }
  vi.stubGlobal("AudioWorkletNode", FakeNode);
  // CALLED, never calling back.
  vi.stubGlobal("requestAnimationFrame", () => {
    h.rafCalls++;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const makeClock = (): ReturnType<typeof createWorkletClock> =>
  createWorkletClock({
    context: h.ctx as unknown as AudioContext,
    onMetro: () => {},
    onClock: () => {},
  });

describe("the beat mirror, with no animation frames", () => {
  it("advances from the audio clock alone", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const c = await makeClock();
    c.setTempo(120); // two beats a second
    c.transportStart();
    audioSeconds(1);
    // The whole bug in one assertion: this read 0 before, for as long as
    // the tab stayed behind another one.
    expect(c.beat).toBeCloseTo(2, 6);
    audioSeconds(0.5);
    expect(c.beat).toBeCloseTo(3, 6);
    expect(h.rafCalls).toBeGreaterThan(0); // it asked; nothing answered
    c.destroy();
  });

  it("a tempo change does not move the beat you are on", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const c = await makeClock();
    c.setTempo(120);
    c.transportStart();
    audioSeconds(1);
    const before = c.beat;
    c.setTempo(60);
    // Re-anchoring is the point: without it every past second is recounted
    // at the new rate and the beat jumps.
    expect(c.beat).toBeCloseTo(before, 6);
    audioSeconds(1);
    expect(c.beat).toBeCloseTo(before + 1, 6);
    c.destroy();
  });

  it("transport start is beat zero, and it keeps counting from there", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const c = await makeClock();
    c.setTempo(120);
    audioSeconds(5);
    c.transportStart();
    expect(c.beat).toBeCloseTo(0, 6);
    audioSeconds(2);
    expect(c.beat).toBeCloseTo(4, 6);
    c.destroy();
  });

  it("a state message from the worklet re-anchors rather than being stored beside the mirror", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const c = await makeClock();
    c.setTempo(120);
    c.transportStart();
    audioSeconds(1);
    expect(c.beat).toBeCloseTo(2, 6);
    // The thread that actually counts says it is somewhere else.
    h.port.onmessage?.({ data: { t: "state", beat: 10, tempo: 60 } });
    expect(c.beat).toBeCloseTo(10, 6);
    // And it carries on from THERE at the tempo it was told, which is what
    // storing the number beside a derived mirror could never do: the next
    // read would have thrown it away.
    audioSeconds(2);
    expect(c.beat).toBeCloseTo(12, 6);
    c.destroy();
  });
});

describe("delivery, with no animation frames", () => {
  it("a timer drains the ring when neither a frame nor a wake arrives", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const fired: Array<[number, number]> = [];
    const c = await createWorkletClock({
      context: h.ctx as unknown as AudioContext,
      onMetro: (idx, stage) => fired.push([idx, stage]),
      onClock: () => {},
    });
    expect(h.sab, "the clock should have made a ring to share").not.toBeNull();
    const ring = ringViews(h.sab!, 1024);

    // The audio thread pushes, exactly as `processor.js` does. No `wake` is
    // posted and no frame is served — the two paths that were measured
    // failing together.
    ringPush(ring, EV_METRO, 3, 0);
    ringPush(ring, EV_METRO, 3, 1);
    expect(fired).toEqual([]);

    vi.advanceTimersByTime(16);
    expect(fired).toEqual([
      [3, 0],
      [3, 1],
    ]);
    c.destroy();
  });

  it("stops draining once destroyed", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const fired: Array<[number, number]> = [];
    const c = await createWorkletClock({
      context: h.ctx as unknown as AudioContext,
      onMetro: (idx, stage) => fired.push([idx, stage]),
      onClock: () => {},
    });
    const ring = ringViews(h.sab!, 1024);
    c.destroy();
    ringPush(ring, EV_METRO, 1, 0);
    vi.advanceTimersByTime(200);
    // A timer left running on a clock nobody holds would deliver metros
    // into a dead callback table for as long as the page lived.
    expect(fired).toEqual([]);
  });

  it("an ordinary batch is delivered whole, however many ticks are in it", async () => {
    // A drain every 16 ms legitimately carries two ticks of a 100 Hz
    // metro. Coalescing those would quietly halve a rate the script asked
    // for, which is a worse fault than the one being fixed.
    vi.stubGlobal("crossOriginIsolated", true);
    const fired: Array<[number, number]> = [];
    const dropped: Array<[number, number]> = [];
    const c = await createWorkletClock({
      context: h.ctx as unknown as AudioContext,
      onMetro: (idx, stage) => fired.push([idx, stage]),
      onClock: () => {},
      onBacklog: (n, gap) => dropped.push([n, gap]),
    });
    const ring = ringViews(h.sab!, 1024);
    ringPush(ring, EV_METRO, 0, 10);
    ringPush(ring, EV_METRO, 0, 11);
    h.port.onmessage?.({ data: { t: "wake" } });
    expect(fired).toEqual([
      [0, 10],
      [0, 11],
    ]);
    expect(dropped).toEqual([]);
    c.destroy();
  });

  it("a backlog is skipped forward, not fired in a burst", async () => {
    // E9-182 — reported as a pile of sound being unstacked at speed on
    // the way back from a tab that had been left in the background. The
    // audio thread never stopped counting; the main thread stopped
    // listening, and everything it had missed arrived at once.
    vi.stubGlobal("crossOriginIsolated", true);
    const fired: Array<[number, number]> = [];
    const dropped: Array<[number, number]> = [];
    const clocks: Array<[number, number]> = [];
    const c = await createWorkletClock({
      context: h.ctx as unknown as AudioContext,
      onMetro: (idx, stage) => fired.push([idx, stage]),
      onClock: (id, beat) => clocks.push([id, beat]),
      onBacklog: (n, gap) => dropped.push([n, gap]),
    });
    const ring = ringViews(h.sab!, 1024);

    // Ten seconds of a 20 Hz metro that nobody took out, plus one
    // coroutine waiting on `clock.sleep`.
    const at = performance.now();
    const clk = vi.spyOn(performance, "now").mockReturnValue(at + 10_000);
    for (let stage = 0; stage < 200; stage++) ringPush(ring, EV_METRO, 3, stage);
    ringPush(ring, EV_CLOCK, 7, 42);
    h.port.onmessage?.({ data: { t: "wake" } });
    clk.mockRestore();

    // One callback, carrying the stage the sequence would have REACHED —
    // so a script lands where it would have been rather than playing the
    // last ten seconds into one millisecond.
    expect(fired).toEqual([[3, 199]]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]![0]).toBe(199);
    expect(dropped[0]![1]).toBeCloseTo(10_000, 0);
    // And the sleeping coroutine is resumed regardless: there is only
    // ever one resume scheduled per coroutine, so it cannot pile up, and
    // dropping it would hang that coroutine for the rest of the session.
    expect(clocks).toEqual([[7, 42]]);
    c.destroy();
  });

  it("keeps every metro apart when several are behind", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const fired: Array<[number, number]> = [];
    const c = await createWorkletClock({
      context: h.ctx as unknown as AudioContext,
      onMetro: (idx, stage) => fired.push([idx, stage]),
      onClock: () => {},
    });
    const ring = ringViews(h.sab!, 1024);
    const at = performance.now();
    const clk = vi.spyOn(performance, "now").mockReturnValue(at + 5000);
    for (let stage = 0; stage < 5; stage++) {
      ringPush(ring, EV_METRO, 1, stage);
      ringPush(ring, EV_METRO, 2, stage * 10);
    }
    h.port.onmessage?.({ data: { t: "wake" } });
    clk.mockRestore();
    // The last of EACH, in the order they last appeared.
    expect(fired).toEqual([
      [1, 4],
      [2, 40],
    ]);
    c.destroy();
  });

  it("the wake message still drains at once, so the timer is a floor and not the path", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const fired: Array<[number, number]> = [];
    const c = await createWorkletClock({
      context: h.ctx as unknown as AudioContext,
      onMetro: (idx, stage) => fired.push([idx, stage]),
      onClock: () => {},
    });
    const ring = ringViews(h.sab!, 1024);
    ringPush(ring, EV_METRO, 7, 2);
    h.port.onmessage?.({ data: { t: "wake" } });
    // No timer advanced, no frame served.
    expect(fired).toEqual([[7, 2]]);
    c.destroy();
  });
});
