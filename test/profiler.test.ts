// E9-149 — the self-profiler's two decisions, which are both pure.
//
// Starting a `Profiler` needs a browser and a `Document-Policy` header, so
// that half is exercised in the page. What is here is what turns a URL
// into a request and a trace into the few lines worth reading — and the
// second one is where a profile gets misread: sorting by TOTAL time puts
// whatever is highest up the stack at the top and says nothing.

import { describe, expect, it } from "vitest";
import { hotFrames, profileRequest, summarise } from "../src/ui/profiler.js";

describe("asking for a profile", () => {
  it("is off unless the URL says so", () => {
    expect(profileRequest("")).toBeNull();
    expect(profileRequest("?machine=phone")).toBeNull();
  });

  it("defaults to thirty seconds, and takes a number", () => {
    expect(profileRequest("?profile")?.seconds).toBe(30);
    expect(profileRequest("?profile=")?.seconds).toBe(30);
    expect(profileRequest("?profile=90")?.seconds).toBe(90);
  });

  // A profile that runs for a length nobody chose is one nobody can read.
  it("refuses a length it cannot read rather than guessing", () => {
    expect(profileRequest("?profile=soon")).toBeNull();
    expect(profileRequest("?profile=-5")).toBeNull();
    expect(profileRequest("?profile=0")).toBeNull();
  });

  it("caps a request that would outlive anybody's patience", () => {
    expect(profileRequest("?profile=99999")?.seconds).toBe(600);
  });
});

describe("reading a trace", () => {
  /**
   * A stack of `boot → draw → blit`, sampled four times, plus two samples
   * in `boot → other` and one idle. `blit` does the work; `boot` is on the
   * stack for everything and does none of it.
   */
  const trace = {
    resources: ["https://x/main.js"],
    frames: [
      { name: "boot", resourceId: 0, line: 1 },
      { name: "draw", resourceId: 0, line: 2 },
      { name: "blit", resourceId: 0, line: 3 },
      { name: "other", resourceId: 0, line: 4 },
    ],
    stacks: [
      { frameId: 0 },
      { frameId: 1, parentId: 0 },
      { frameId: 2, parentId: 1 },
      { frameId: 3, parentId: 0 },
    ],
    samples: [
      { timestamp: 0, stackId: 2 },
      { timestamp: 10, stackId: 2 },
      { timestamp: 20, stackId: 2 },
      { timestamp: 30, stackId: 2 },
      { timestamp: 40, stackId: 3 },
      { timestamp: 50, stackId: 3 },
      { timestamp: 60 },
    ],
  };

  it("ranks by self time, because that is where the work is", () => {
    const hot = hotFrames(trace);
    expect(hot[0]!.name).toContain("blit");
    expect(hot[0]!.selfPct).toBeCloseTo(66.7, 0);
  });

  // `boot` never runs anything and is under every sample. Ranked by total
  // it would be first, and first is where people stop reading.
  it("still reports total, so a frame that is never the leaf is visible", () => {
    const hot = hotFrames(trace);
    const boot = hot.find((f) => f.name.includes("boot"));
    expect(boot, "boot has no self time and so is not listed").toBeUndefined();
    const blit = hot.find((f) => f.name.includes("blit"))!;
    expect(blit.totalPct).toBeCloseTo(66.7, 0);
  });

  it("does not count an idle sample as work", () => {
    // Six of the seven samples had a stack; the percentages are of six.
    const hot = hotFrames(trace);
    const other = hot.find((f) => f.name.includes("other"))!;
    expect(other.selfPct).toBeCloseTo(33.3, 0);
  });

  it("says where a frame is, because a name alone repeats", () => {
    expect(hotFrames(trace)[0]!.name).toBe("blit main.js:3");
  });

  it("answers nothing for a trace that caught nothing", () => {
    expect(hotFrames({ ...trace, samples: [{ timestamp: 0 }] })).toEqual([]);
  });
});

// E9-159 — the percentages need their denominator beside them.
//
// Two traces taken on a page that was 96% idle reported 39% and 10% self
// time for the string path into Lua. Read as "half this page", acted on,
// and measured afterwards at 0.1 microseconds a call: 39% of ONE SECOND
// spread across forty-five. The ranking is right and has to stay — a
// share of wall time would make every function on an idle page look free
// — but the number it is a share of has to travel with it.
describe("what the percentages are of", () => {
  const trace = {
    resources: ["https://x/main.js"],
    frames: [{ name: "work", resourceId: 0, line: 1 }],
    stacks: [{ frameId: 0 }],
    samples: [
      { timestamp: 0, stackId: 0 },
      { timestamp: 10 },
      { timestamp: 20 },
      { timestamp: 30 },
    ],
  };

  it("counts the busy samples and every sample, separately", () => {
    const s = summarise(trace);
    expect(s.busy, "idle samples counted as work").toBe(1);
    expect(s.total, "idle samples dropped from the total").toBe(4);
  });

  it("still ranks by share of the busy ones", () => {
    // One busy sample, all of it in `work`: 100% of the work done, and
    // 25% of the time, which are different claims.
    expect(summarise(trace).frames[0]!.selfPct).toBe(100);
  });

  it("gives hotFrames the same answer it always gave", () => {
    expect(hotFrames(trace)).toEqual(summarise(trace).frames);
  });
});

// E9-200 — a profile is read one phase at a time, and a hot function is
// only half an answer without the thing that called it.
describe("one span of a trace, and who was calling", () => {
  const trace = {
    resources: ["https://x/main.js"],
    frames: [
      { name: "tick", resourceId: 0, line: 1 },
      { name: "redraw", resourceId: 0, line: 2 },
      { name: "encode", resourceId: 0, line: 3 },
      { name: "note", resourceId: 0, line: 4 },
    ],
    stacks: [
      { frameId: 0 },
      { frameId: 1, parentId: 0 },
      { frameId: 2, parentId: 1 }, // encode < redraw < tick
      { frameId: 3, parentId: 0 },
      { frameId: 2, parentId: 3 }, // encode < note < tick
    ],
    samples: [
      // the first phase: drawing
      { timestamp: 0, stackId: 2 },
      { timestamp: 10, stackId: 2 },
      { timestamp: 20, stackId: 1 },
      { timestamp: 30 },
      // the second: notes
      { timestamp: 100, stackId: 4 },
      { timestamp: 110, stackId: 4 },
      { timestamp: 120, stackId: 4 },
      { timestamp: 130 },
    ],
  };

  it("ranks only what fell inside the span", () => {
    const first = summarise(trace, 12, 0, 100);
    expect(first.total).toBe(4);
    expect(first.busy).toBe(3);
    expect(first.frames.map((f) => f.name)).toEqual(["encode main.js:3", "redraw main.js:2"]);
    const second = summarise(trace, 12, 100, 200);
    expect(second.busy).toBe(3);
    expect(second.frames.map((f) => f.name)).toEqual(["encode main.js:3"]);
  });

  it("puts the end of a span outside it, so two spans never share a sample", () => {
    expect(summarise(trace, 12, 0, 100).total + summarise(trace, 12, 100, 200).total).toBe(8);
    expect(summarise(trace, 12, 0, 110).total).toBe(5);
  });

  it("says who was calling, which the table of frames cannot", () => {
    // `encode` is 5 of 6 busy samples over the run. The frames say that
    // and stop; the stacks say it has two callers and which is which.
    const whole = summarise(trace, 12, -Infinity, Infinity, 5);
    expect(whole.frames[0]!.name).toBe("encode main.js:3");
    expect(whole.stacks.map((s) => s.path)).toEqual([
      "encode main.js:3 < note main.js:4 < tick main.js:1",
      "encode main.js:3 < redraw main.js:2 < tick main.js:1",
      "redraw main.js:2 < tick main.js:1",
    ]);
    expect(whole.stacks[0]!.pct).toBeCloseTo(50, 6);
  });

  it("builds no stacks unless asked, and none for an idle span", () => {
    expect(summarise(trace).stacks).toEqual([]);
    expect(summarise(trace, 12, 30, 40, 5).stacks).toEqual([]);
  });
});

describe("what else the address can ask for", () => {
  it("samples every five milliseconds unless told otherwise", () => {
    expect(profileRequest("?profile=90")?.intervalMs).toBe(5);
    expect(profileRequest("?profile=90&interval=2")?.intervalMs).toBe(2);
  });

  it("ignores an interval that is not one", () => {
    expect(profileRequest("?profile=90&interval=fast")?.intervalMs).toBe(5);
    expect(profileRequest("?profile=90&interval=0")?.intervalMs).toBe(5);
    expect(profileRequest("?profile=90&interval=5000")?.intervalMs).toBe(5);
  });

  it("leaves Lua unsampled unless asked, because sampling it slows it", () => {
    expect(profileRequest("?profile=90")?.lua).toBe(false);
    expect(profileRequest("?profile=90&lua")?.lua).toBe(true);
    expect(profileRequest("?profile=90&lua=1")?.lua).toBe(true);
    expect(profileRequest("?profile=90&lua=0")?.lua).toBe(false);
  });
});
