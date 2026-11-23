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
    // And the dropout count is named as the signal it is. It was called
    // a LOWER BOUND here and that was wrong: a measured delta is
    // floor(t1) - floor(t0), so a true 2.1 ms block measures 3 about a
    // tenth of the time — under the 2.67 ms budget and counted as over —
    // while a true 2.8 ms block measures 2 about a fifth of it. The
    // count invents some and misses others.
    expect(said).toContain("1 over budget by a 1 ms clock");
    expect(said).toContain("misses some and invents others");
    expect(said).not.toContain("at least");
  });

  it("one coarse report taints the whole window's worst", () => {
    const w = emptyAudioLoad();
    foldCrone(w, report({ maxMs: 1.4 }));
    expect(w.coarse).toBe(false);
    foldCrone(w, report({ maxMs: 0, coarse: true }));
    expect(w.coarse).toBe(true);
    expect(describeAudioLoad(w)).toContain("worst block not measurable");
  });

  // E9-197 — the shape, which is the half a 1 ms clock can state without a
  // verdict. A mean hides its tail and `over` is a judgement this clock
  // cannot reach; raw counts per millisecond are neither.
  describe("the histogram", () => {
    it("sums across reports", () => {
      const w = emptyAudioLoad();
      foldCrone(w, report({ hist: [300, 60, 10, 2, 0] }));
      foldCrone(w, report({ hist: [280, 80, 8, 1, 1] }));
      expect(w.hist).toEqual([580, 140, 18, 3, 1]);
    });

    it("prints the buckets, and says so when there is no tail at all", () => {
      const w = emptyAudioLoad();
      foldCrone(w, report({ blocks: 375, hist: [375, 0, 0, 0, 0] }));
      const said = describeAudioLoad(w);
      expect(said).toContain("blocks at 0/1/2/3/4+ ms: 375/0/0/0/0");
      expect(said).toContain("all under a millisecond");
    });

    it("does not claim an absent tail when there is one", () => {
      const w = emptyAudioLoad();
      foldCrone(w, report({ blocks: 375, hist: [300, 60, 10, 4, 1] }));
      const said = describeAudioLoad(w);
      expect(said).toContain("300/60/10/4/1");
      expect(said).not.toContain("all under a millisecond");
    });

    it("says nothing about shape when no report carried one", () => {
      // An older worklet, or a build before this existed.
      const w = emptyAudioLoad();
      foldCrone(w, report({ blocks: 375 }));
      expect(describeAudioLoad(w)).not.toContain("blocks at 0/1/2");
    });
  });

  it("one silent instrument does not silence the other", () => {
    const w = emptyAudioLoad();
    foldScsynth(w, 5, 9);
    const said = describeAudioLoad(w);
    expect(said).toContain("crone has not reported");
    expect(said).toContain("scsynth 5% avg, 9% peak");
  });
});

// E9-200 — a load with no count beside it cannot be divided. Thirty per
// cent for two voices and thirty per cent for thirty are different
// problems, and scsynth was already saying which in every reply.
describe("how much scsynth was running, beside how hard", () => {
  it("keeps the most it held at once", () => {
    const w = emptyAudioLoad();
    foldScsynth(w, 4, 11, 3, 40);
    foldScsynth(w, 19, 31, 30, 420);
    foldScsynth(w, 7, 12, 12, 170);
    expect(w.scSynthsMax).toBe(30);
    expect(w.scUgensMax).toBe(420);
    expect(describeAudioLoad(w)).toContain("scsynth 19% avg, 31% peak, up to 30 synth(s) and 420 ugen(s)");
  });

  it("says nothing about counts it was never given", () => {
    const w = emptyAudioLoad();
    foldScsynth(w, 5, 9);
    const said = describeAudioLoad(w);
    expect(said).toContain("scsynth 5% avg, 9% peak");
    expect(said).not.toContain("synth(s)");
  });
});
