// E9-149 — the self-profiler's two decisions, which are both pure.
//
// Starting a `Profiler` needs a browser and a `Document-Policy` header, so
// that half is exercised in the page. What is here is what turns a URL
// into a request and a trace into the few lines worth reading — and the
// second one is where a profile gets misread: sorting by TOTAL time puts
// whatever is highest up the stack at the top and says nothing.

import { describe, expect, it } from "vitest";
import { hotFrames, profileRequest } from "../src/ui/profiler.js";

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
