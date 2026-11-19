// E9-138 — the instrument that names the slow callback.
//
// `cpu-meter.ts` says in its own comment that it is "the wrong instrument
// entirely" for which function is slow. This is the right one, and the
// thing it must not do is flood the log it exists to explain: a script
// that is too slow is too slow on EVERY callback, so one line per call
// would bury the boot, the script error and the storage line underneath
// a column of its own output.

import { afterEach, describe, expect, it } from "vitest";
import {
  callCosts,
  record,
  resetCallCosts,
  stopWatchingCallCost,
  timed,
  watchCallCost,
  type SlowCall,
} from "../src/norns/call-cost.js";

afterEach(() => stopWatchingCallCost());

/** A clock the test drives, so no assertion waits for a real millisecond. */
function harness(opts: { thresholdMs?: number; quietMs?: number } = {}) {
  let t = 0;
  const seen: SlowCall[] = [];
  watchCallCost({ onSlow: (c) => seen.push(c), now: () => t, ...opts });
  return { seen, at: (ms: number) => void (t = ms), tick: (ms: number) => void (t += ms) };
}

describe("timing a call into Lua", () => {
  it("passes the value through, and times what it took", () => {
    const h = harness({ thresholdMs: 10 });
    const out = timed("metro", () => {
      h.tick(50);
      return 42;
    });
    expect(out).toBe(42);
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.path).toBe("metro");
    expect(h.seen[0]!.ms).toBe(50);
  });

  // The `finally` matters: a callback that throws is exactly the kind that
  // is also slow, and losing its cost would lose the evidence.
  it("times a call that throws, and lets the throw through", () => {
    const h = harness({ thresholdMs: 10 });
    expect(() =>
      timed("redraw", () => {
        h.tick(80);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(h.seen.map((c) => [c.path, c.ms])).toEqual([["redraw", 80]]);
  });

  it("says nothing about a call that is fast", () => {
    const h = harness({ thresholdMs: 120 });
    timed("metro", () => h.tick(3));
    expect(h.seen).toEqual([]);
    expect(callCosts()).toEqual([{ path: "metro", calls: 1, ms: 3, worstMs: 3 }]);
  });
});

describe("not burying the log it explains", () => {
  it("reports one line per path per quiet period", () => {
    const h = harness({ thresholdMs: 100, quietMs: 5000 });
    for (let i = 0; i < 20; i++) {
      record("metro", 200);
      h.tick(100); // 20 slow calls across two seconds
    }
    expect(h.seen).toHaveLength(1);
    h.tick(5000);
    record("metro", 200);
    expect(h.seen).toHaveLength(2);
  });

  it("keeps the paths apart, because two slow things are two findings", () => {
    const h = harness({ thresholdMs: 100, quietMs: 5000 });
    record("metro", 200);
    record("redraw", 300);
    record("grid.key", 150);
    expect(h.seen.map((c) => c.path)).toEqual(["metro", "redraw", "grid.key"]);
  });

  it("carries the worst and the count, so one line is enough", () => {
    const h = harness({ thresholdMs: 100, quietMs: 0 });
    record("metro", 150);
    record("metro", 900);
    record("metro", 120);
    expect(h.seen.at(-1)).toEqual({ path: "metro", ms: 120, worstMs: 900, calls: 3 });
  });
});

describe("the running account", () => {
  it("ranks by total cost, not by the worst single call", () => {
    harness({ thresholdMs: 1e9 });
    // One spike against a steady drip: the drip is what makes a page
    // unusable, and sorting by `worst` would hide it behind the spike.
    record("redraw", 500);
    for (let i = 0; i < 100; i++) record("metro", 30);
    expect(callCosts().map((c) => c.path)).toEqual(["metro", "redraw"]);
    expect(callCosts()[0]).toEqual({ path: "metro", calls: 100, ms: 3000, worstMs: 30 });
  });

  it("forgets on request, because a new script is a new measurement", () => {
    harness({ thresholdMs: 1e9 });
    record("metro", 10);
    expect(callCosts()).toHaveLength(1);
    resetCallCosts();
    expect(callCosts()).toEqual([]);
  });

  it("accounts for calls nobody is listening to", () => {
    // No `watchCallCost`: the totals still accrue, so turning the
    // reporting on later does not start from zero.
    record("metro", 7);
    expect(callCosts()).toEqual([{ path: "metro", calls: 1, ms: 7, worstMs: 7 }]);
  });
});
