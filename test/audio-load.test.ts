// E9-183 — the audio thread's own cost, folded over a phase.
//
// The hole this fills: the first `_bench` baseline reported `metro 1 ms over
// 80` for a phase running six softcut voices. That is the phase timer and
// nothing else — six voices measured as free, because every clock in
// `call-cost.ts` is on the main thread and softcut is not.

import { describe, expect, it } from "vitest";
import {
  describeAudioLoad,
  emptyAudioLoad,
  foldCrone,
  foldScsynth,
  meanBlockMs,
} from "../src/ui/audio-load.js";

const report = (over: Partial<Parameters<typeof foldCrone>[1]> = {}) => ({
  blocks: 100,
  meanMs: 0.5,
  maxMs: 1.0,
  over: 0,
  budgetMs: 2.67,
  ...over,
});

describe("folding crone's load", () => {
  it("starts empty and says so rather than saying zero", () => {
    const w = emptyAudioLoad();
    expect(w.reports).toBe(0);
    // The whole of E9-180 was a reading of nothing being mistaken for a
    // reading of silence. They must not print the same way.
    expect(describeAudioLoad(w)).toContain("crone has not reported");
    expect(describeAudioLoad(w)).toContain("scsynth has not answered");
  });

  it("means the work, not the readings", () => {
    const w = emptyAudioLoad();
    // One long cheap window and one short dear one. An average of the two
    // MEANS would say 1.5 ms; the average of the WORK is 0.59.
    foldCrone(w, report({ blocks: 1000, meanMs: 0.5 }));
    foldCrone(w, report({ blocks: 50, meanMs: 2.5 }));
    expect(w.blocks).toBe(1050);
    expect(meanBlockMs(w)).toBeCloseTo((1000 * 0.5 + 50 * 2.5) / 1050, 6);
    expect(meanBlockMs(w)).toBeLessThan(0.7);
  });

  it("keeps the worst block, which is the one you can hear", () => {
    const w = emptyAudioLoad();
    foldCrone(w, report({ meanMs: 0.4, maxMs: 0.9 }));
    foldCrone(w, report({ meanMs: 0.4, maxMs: 3.1, over: 2 }));
    foldCrone(w, report({ meanMs: 0.4, maxMs: 1.1 }));
    // A mean comfortably under budget with a worst over it is exactly the
    // shape of a page that clicks once a second.
    expect(meanBlockMs(w)).toBeCloseTo(0.4, 6);
    expect(w.maxMs).toBeCloseTo(3.1, 6);
    expect(w.over).toBe(2);
  });

  it("drops a report with no blocks behind it", () => {
    // crone sends one on the way up before it has rendered anything.
    // Folding it would put a budget in the window with no work under it,
    // which reads as a phase that ran and cost nothing.
    const w = emptyAudioLoad();
    expect(foldCrone(w, report({ blocks: 0 }))).toBe(false);
    expect(w.reports).toBe(0);
    expect(w.budgetMs).toBe(0);
    expect(describeAudioLoad(w)).toContain("crone has not reported");
  });

  it("refuses a reading that is not a number", () => {
    const w = emptyAudioLoad();
    expect(foldCrone(w, report({ meanMs: Number.NaN }))).toBe(false);
    expect(w.reports).toBe(0);
  });
});

describe("folding scsynth's own reading of itself", () => {
  it("keeps the highest of each", () => {
    const w = emptyAudioLoad();
    foldScsynth(w, 4, 11);
    foldScsynth(w, 19, 31);
    foldScsynth(w, 7, 12);
    expect(w.scAvgMax).toBe(19);
    expect(w.scPeakMax).toBe(31);
    expect(w.scReads).toBe(3);
  });

  it("refuses a reading that is not a number", () => {
    const w = emptyAudioLoad();
    expect(foldScsynth(w, Number.NaN, 3)).toBe(false);
    expect(w.scReads).toBe(0);
  });
});

describe("what a phase says it cost the audio thread", () => {
  it("names the budget and the share of it, because 0.5 ms means nothing alone", () => {
    const w = emptyAudioLoad();
    foldCrone(w, report({ blocks: 374, meanMs: 0.5, maxMs: 1.2, budgetMs: 2.67 }));
    foldScsynth(w, 12, 31);
    const said = describeAudioLoad(w);
    expect(said).toContain("0.50 ms mean");
    expect(said).toContain("1.20 ms worst");
    expect(said).toContain("2.67 ms a block");
    expect(said).toContain("19% of it");
    expect(said).toContain("374 block(s)");
    expect(said).toContain("0 over budget");
    expect(said).toContain("scsynth 12% avg, 31% peak");
  });

  it("a dropout is reported as a count, not left to be inferred from the maximum", () => {
    const w = emptyAudioLoad();
    foldCrone(w, report({ blocks: 200, meanMs: 0.6, maxMs: 4.0, over: 3, budgetMs: 2.67 }));
    expect(describeAudioLoad(w)).toContain("3 over budget");
  });

  it("a coarse window withholds the worst block instead of printing a zero", () => {
    // E9-183 — Chrome's AudioWorkletGlobalScope has no `performance.now()`,
    // so crone times itself with `Date`: 1 ms against a 2.67 ms budget.
    // The mean survives that (the truncation is unbiased over a second of
    // blocks); one block's worst cost does not, and a `0.00 ms worst`
    // would read as the best possible result rather than as no result.
    const w = emptyAudioLoad();
    foldCrone(w, report({ blocks: 375, meanMs: 0.62, maxMs: 0, over: 1, coarse: true }));
    const said = describeAudioLoad(w);
    expect(said).toContain("0.62 ms mean");
    expect(said).toContain("worst block not measurable");
    expect(said).not.toContain("0.00 ms worst");
    // And a dropout count a coarse clock can only under-report is named
    // as the lower bound it is.
    expect(said).toContain("at least 1 over budget");
  });

  it("one coarse report taints the whole window's worst", () => {
    const w = emptyAudioLoad();
    foldCrone(w, report({ maxMs: 1.4 }));
    expect(w.coarse).toBe(false);
    foldCrone(w, report({ maxMs: 0, coarse: true }));
    expect(w.coarse).toBe(true);
    expect(describeAudioLoad(w)).toContain("worst block not measurable");
  });

  it("one silent instrument does not silence the other", () => {
    const w = emptyAudioLoad();
    foldScsynth(w, 5, 9);
    const said = describeAudioLoad(w);
    expect(said).toContain("crone has not reported");
    expect(said).toContain("scsynth 5% avg, 9% peak");
  });
});
