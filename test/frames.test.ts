// E9-162 — the instrument for the cost that is not JavaScript.
//
// A Pixel log had the CPU meter at 92% and the sampling profiler finding
// JS on the stack in 6.3% of its samples. Both were right, and nothing
// could say what the other 86% was. This is what says it, so what it
// must get right is the arithmetic that turns a browser's frame report
// into "script, render, and what is left" — including the case where
// those phases did not happen at all, which the API spells as a zero
// where a timestamp would be.

import { describe, expect, it } from "vitest";
import {
  describeFrames,
  emptyLoad,
  foldFrame,
  snapshot,
  watchLongFrames,
} from "../src/ui/frames.js";

/** One frame, as the browser hands it over. */
function frame(o: {
  startTime?: number;
  duration: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: Array<{ duration: number; invoker?: string }>;
}) {
  return { startTime: o.startTime ?? 0, ...o };
}

describe("reading one frame", () => {
  it("splits a frame into script, render and what is left", () => {
    const acc = emptyLoad();
    // A 100 ms frame starting at 1000: 30 ms of script, rendering from
    // 1060 (40 ms), style and layout from 1080 (20 ms of that 40).
    foldFrame(
      acc,
      frame({
        startTime: 1000,
        duration: 100,
        renderStart: 1060,
        styleAndLayoutStart: 1080,
        scripts: [{ duration: 30, invoker: "FrameRequestCallback" }],
      }),
    );
    const l = snapshot(acc);
    expect(l.frames).toBe(1);
    expect(l.totalMs).toBe(100);
    expect(l.scriptMs).toBe(30);
    expect(l.renderMs).toBe(40);
    expect(l.styleLayoutMs).toBe(20);
    // What is left is the point of the whole file: 30 of script and 40 of
    // rendering do not explain 100 ms, and the 30 that remain are the
    // finding.
    expect(l.totalMs - l.scriptMs - l.renderMs).toBe(30);
  });

  // The zero is the trap. `renderStart` is 0 — not absent — for a frame
  // that did not render, and `end - 0` is the whole uptime of the page.
  it("does not read a missing phase as a phase that took for ever", () => {
    const acc = emptyLoad();
    foldFrame(acc, frame({ startTime: 50_000, duration: 80, renderStart: 0, styleAndLayoutStart: 0 }));
    const l = snapshot(acc);
    expect(l.renderMs).toBe(0);
    expect(l.styleLayoutMs).toBe(0);
    expect(l.totalMs).toBe(80);
  });

  it("keeps the worst frame, which is what a person noticed", () => {
    const acc = emptyLoad();
    foldFrame(acc, frame({ duration: 60 }));
    foldFrame(acc, frame({ duration: 340 }));
    foldFrame(acc, frame({ duration: 90 }));
    const l = snapshot(acc);
    expect(l.worstMs).toBe(340);
    expect(l.frames).toBe(3);
    expect(l.totalMs).toBe(490);
  });

  it("adds up several scripts in one frame, and names what asked for them", () => {
    const acc = emptyLoad();
    foldFrame(
      acc,
      frame({
        duration: 200,
        scripts: [
          { duration: 50, invoker: "setTimeout" },
          { duration: 120, invoker: "FrameRequestCallback" },
          { duration: 10, invoker: "setTimeout" },
        ],
      }),
    );
    const l = snapshot(acc);
    expect(l.scriptMs).toBe(180);
    expect(l.byInvoker).toEqual([
      { name: "FrameRequestCallback", ms: 120, calls: 1 },
      { name: "setTimeout", ms: 60, calls: 2 },
    ]);
  });

  it("has a name for a script the browser could not attribute", () => {
    const acc = emptyLoad();
    foldFrame(acc, frame({ duration: 70, scripts: [{ duration: 70 }] }));
    expect(snapshot(acc).byInvoker[0]!.name).toBe("(unattributed)");
  });

  it("forgets on request, because a new span is a new measurement", () => {
    const w = watchLongFrames(undefined);
    expect(w.load().frames).toBe(0);
    w.reset();
    expect(w.load().frames).toBe(0);
  });
});

describe("the line it prints", () => {
  it("says nothing when no frame was slow, so the caller can say that instead", () => {
    expect(describeFrames(snapshot(emptyLoad()))).toBeNull();
  });

  it("carries the three parts and the worst", () => {
    const acc = emptyLoad();
    foldFrame(
      acc,
      frame({
        startTime: 0,
        duration: 1000,
        renderStart: 700,
        styleAndLayoutStart: 800,
        scripts: [{ duration: 200, invoker: "FrameRequestCallback" }],
      }),
    );
    const line = describeFrames(snapshot(acc))!;
    expect(line).toContain("1 over 50 ms");
    expect(line).toContain("worst 1000 ms");
    expect(line).toContain("script 200 ms");
    expect(line).toContain("render 300 ms");
    expect(line).toContain("style+layout 200");
    expect(line).toContain("other 500 ms");
    expect(line).toContain("FrameRequestCallback");
  });
});

describe("attaching to the browser", () => {
  it("folds what the observer delivers", () => {
    let fire: ((list: { getEntries(): unknown[] }) => void) | null = null;
    let observed: string | null = null;
    class FakeObserver {
      constructor(cb: (list: { getEntries(): unknown[] }) => void) {
        fire = cb;
      }
      observe(o: { type: string }): void {
        observed = o.type;
      }
      disconnect(): void {
        fire = null;
      }
    }
    const w = watchLongFrames(FakeObserver as never);
    expect(observed).toBe("long-animation-frame");
    fire!({ getEntries: () => [frame({ duration: 120, scripts: [{ duration: 20 }] })] });
    expect(w.load().frames).toBe(1);
    expect(w.load().scriptMs).toBe(20);
    w.stop();
  });

  // Firefox and Safari have no long-animation-frame. A watch that threw,
  // or that returned null and made every caller branch, would mean the
  // reporting path is only ever exercised on one engine.
  it("reads zero on a browser that does not have it, rather than throwing", () => {
    class Unsupported {
      constructor(_cb: unknown) {}
      observe(): void {
        throw new Error("not a valid value for entryTypes");
      }
      disconnect(): void {}
    }
    const w = watchLongFrames(Unsupported as never);
    expect(w.load().frames).toBe(0);
    expect(describeFrames(w.load())).toBeNull();
    expect(() => w.stop()).not.toThrow();
  });
});
