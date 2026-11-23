// E9-202 — taking back the latency an underrun left behind.
//
// The one consequence of getting this wrong is an instrument that stops its
// own sound and does not start it again, so it is a state machine with the
// context, the clock and the browser's counters passed in. The fake below
// behaves like the path measured in Chromium: every start of the output is
// counted as four underruns that leave nothing behind, a real underrun adds
// one device callback of latency for good, and a restart takes all of that
// back.

import { describe, expect, it } from "vitest";
import {
  AFTER_MEASURE_MS,
  AFTER_WAIT_MS,
  LOOK_EVERY_MS,
  QUIET_MS,
  createReclaim,
  type ReclaimSources,
} from "../src/ui/latency-reclaim.js";

interface Opts {
  stats: boolean;
  /** Does a restart give the margin back? */
  restartClears: boolean;
  resumeWorks: boolean;
  hidden: boolean;
  /** `outputLatency`, ms. */
  device: number;
  /** Underruns that arrive while the restart is being measured. */
  relapse: number;
}

interface Fake extends ReclaimSources {
  t: number;
  lines: string[];
  suspends: number;
  resumes: number;
  stuckCalls: boolean[];
  state_: string;
  opts: Opts;
  /** A real one: a late block, and a callback of latency left behind. */
  underrun(n?: number): void;
  /** Run one pending sleep; false when nothing was waiting. */
  step(): Promise<boolean>;
  /** Run the pending sleeps until nothing is waiting. */
  settle(): Promise<void>;
}

const PERIOD = 5;
const CLEAN = 0.029;

function fake(over: Partial<Opts> = {}): Fake {
  const opts: Opts = { stats: true, restartClears: true, resumeWorks: true, hidden: false, device: 24, relapse: 0, ...over };
  // The output's own start, counted by the browser, leaving nothing behind.
  let events = 4;
  let lost = 0.02;
  let extra = 0;
  const waiting: { at: number; go: () => void }[] = [];
  const f: Fake = {
    t: 0,
    lines: [],
    suspends: 0,
    resumes: 0,
    stuckCalls: [],
    state_: "running",
    opts,
    now: () => f.t,
    playback: () =>
      opts.stats
        ? {
            underrunEvents: events,
            underrunDuration: lost,
            totalDuration: f.t / 1000,
            averageLatency: CLEAN + extra,
            minimumLatency: CLEAN,
            maximumLatency: CLEAN + extra,
          }
        : null,
    resetLatency: () => {
      // The module resets, reads, then waits and reads again: a relapse
      // lands between its two readings.
      if (opts.relapse > 0 && f.suspends > 0) {
        const n = opts.relapse;
        opts.relapse = 0;
        queueMicrotask(() => f.underrun(n));
      }
    },
    state: () => f.state_,
    hidden: () => opts.hidden,
    suspend: async () => {
      f.suspends++;
      f.state_ = "suspended";
    },
    resume: async () => {
      f.resumes++;
      if (!opts.resumeWorks) return;
      if (f.state_ === "suspended") {
        events += 4;
        lost += 0.02;
        if (opts.restartClears) extra = 0;
      }
      f.state_ = "running";
    },
    periodMs: () => PERIOD,
    deviceMs: () => opts.device,
    sleep: (ms) => new Promise<void>((go) => waiting.push({ at: f.t + ms, go })),
    log: (l) => f.lines.push(l),
    stuck: (w) => f.stuckCalls.push(w),
    underrun(n = 1) {
      events += n;
      lost += (n * PERIOD) / 1000;
      extra += (n * PERIOD) / 1000;
    },
    async step() {
      await new Promise((r) => setTimeout(r, 0));
      if (waiting.length === 0) return false;
      waiting.sort((a, b) => a.at - b.at);
      const next = waiting.shift()!;
      f.t = Math.max(f.t, next.at);
      next.go();
      return true;
    },
    async settle() {
      for (let i = 0; i < 2000; i++) if (!(await f.step())) return;
      throw new Error("never settled");
    },
  };
  return f;
}

/** norns' startup clear, then levels flat for long enough. */
async function bootGoesQuiet(f: Fake, r: ReturnType<typeof createReclaim>): Promise<void> {
  r.scriptCleared();
  f.t += QUIET_MS + 1;
  r.heard(false);
  await f.settle();
}

describe("giving back the latency an underrun left behind", () => {
  it("leaves alone an output whose only underruns are its own start", async () => {
    // Every Chromium start reads like this, and 29 ms against a device at
    // 24 is nothing to take back.
    const f = fake();
    const r = createReclaim(f);
    await bootGoesQuiet(f, r);
    r.scriptCleared();
    await f.settle();
    expect(f.suspends).toBe(0);
    expect(f.lines).toEqual([]);
    expect(r.verdict).toBe("untried");
  });

  it("restarts the output once the boot has gone quiet, and says what it gained", async () => {
    // The Pixel: 24 ms announced, five underruns of 5 ms, 54 measured.
    const f = fake();
    const r = createReclaim(f);
    f.underrun(5);
    await bootGoesQuiet(f, r);
    expect(f.suspends).toBe(1);
    expect(f.state()).toBe("running");
    expect(r.verdict).toBe("works");
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toContain("underruns had left the output 54.0 ms late");
    expect(f.lines[0]).toContain("gave 25.0 ms back — 29.0 ms now");
    // The browser's count of the gap is named, so a profile is not misread.
    expect(f.lines[0]).toContain("the restart itself is counted as 4 underrun(s), 20 ms");
  });

  it("waits for the startup chime to end", async () => {
    const f = fake();
    const r = createReclaim(f);
    f.underrun(5);
    r.scriptCleared();
    for (let i = 0; i < 40; i++) {
      f.t += 100;
      r.heard(true);
    }
    await f.settle();
    expect(f.suspends).toBe(0);
    f.t += QUIET_MS - 1;
    r.heard(false);
    await f.settle();
    expect(f.suspends).toBe(0);
    f.t += 2;
    r.heard(false);
    await f.settle();
    expect(f.suspends).toBe(1);
  });

  it("never does it for silence alone once a script has been loaded", async () => {
    const f = fake();
    const r = createReclaim(f);
    await bootGoesQuiet(f, r);
    r.scriptCleared(); // a script is loaded; nothing to take back yet
    await f.settle();
    f.underrun(3); // it glitches while playing: the margin is the script's to keep
    for (let i = 0; i < 100; i++) {
      f.t += 1000;
      r.heard(false);
    }
    await f.settle();
    expect(f.suspends).toBe(0);
    // The next script change is where it goes back.
    r.scriptCleared();
    await f.settle();
    expect(f.suspends).toBe(1);
    expect(f.lines[0]).toContain("had left the output 44.0 ms late");
  });

  it("does not take its own restart for an underrun", async () => {
    const f = fake();
    const r = createReclaim(f);
    f.underrun(5);
    await bootGoesQuiet(f, r);
    expect(f.suspends).toBe(1);
    for (let i = 0; i < 5; i++) {
      r.scriptCleared();
      await f.settle();
    }
    expect(f.suspends).toBe(1);
  });

  it("is finer once it has measured a clean figure on this machine", async () => {
    const f = fake();
    const r = createReclaim(f);
    // One callback over, with nothing to compare against but the device's
    // own rounded figure: not enough to act on.
    f.underrun(1);
    await bootGoesQuiet(f, r);
    expect(f.suspends).toBe(0);
    f.underrun(2);
    r.scriptCleared();
    await f.settle();
    expect(f.suspends).toBe(1);
    expect(f.lines[0]).toContain("gave 15.0 ms back — 29.0 ms now");
    // Now 29 ms is known, and a single callback above it is worth taking.
    f.underrun(1);
    r.scriptCleared();
    await f.settle();
    expect(f.suspends).toBe(2);
    expect(f.lines[1]).toContain("had left the output 34.0 ms late");
    expect(f.lines[1]).toContain("gave 5.0 ms back");
  });

  it("tries once where a restart gains nothing, and never again", async () => {
    // Late for a reason a restart does not touch.
    const f = fake({ restartClears: false });
    const r = createReclaim(f);
    f.underrun(5);
    await bootGoesQuiet(f, r);
    expect(f.suspends).toBe(1);
    expect(f.state()).toBe("running");
    expect(r.verdict).toBe("useless");
    expect(f.lines[0]).toContain("gave nothing back on this machine (54.0 ms before, 54.0 ms after)");
    expect(f.lines[0]).toContain("it will not be tried again");
    f.underrun(9);
    r.scriptCleared();
    await f.settle();
    await r.force();
    expect(f.suspends).toBe(1);
    expect(f.lines).toHaveLength(1);
  });

  it("does not judge a restart that underran again straight away", async () => {
    const f = fake({ relapse: 5 });
    const r = createReclaim(f);
    f.underrun(5);
    await bootGoesQuiet(f, r);
    expect(f.suspends).toBe(1);
    expect(r.verdict).toBe("untried");
    expect(f.lines[0]).toContain("it underran again at once (54.0 ms before, 54.0 ms now)");
    // Not given up on: the next underrun and the next script change try again.
    f.underrun(1);
    r.scriptCleared();
    await f.settle();
    expect(f.suspends).toBe(2);
    expect(r.verdict).toBe("works");
  });

  it("calls a restart a success when it gained, even if a block was late while measuring", async () => {
    const f = fake({ relapse: 1 });
    const r = createReclaim(f);
    f.underrun(5);
    await bootGoesQuiet(f, r);
    expect(r.verdict).toBe("works");
    expect(f.lines[0]).toContain("gave 20.0 ms back — 34.0 ms now");
  });

  it("waits for the browser's own figure for the device, and not past a script change", async () => {
    // `outputLatency` reads 0 until audio has flowed.
    const a = fake({ device: 0 });
    const ra = createReclaim(a);
    a.underrun(5);
    await bootGoesQuiet(a, ra);
    expect(a.suspends).toBe(0);
    a.opts.device = 24;
    a.t += LOOK_EVERY_MS + 1;
    ra.heard(false);
    await a.settle();
    expect(a.suspends).toBe(1);

    const b = fake({ device: 0 });
    const rb = createReclaim(b);
    b.underrun(5);
    await bootGoesQuiet(b, rb);
    rb.scriptCleared(); // a script arrives before the figure does
    await b.settle();
    b.opts.device = 24;
    for (let i = 0; i < 20; i++) {
      b.t += 1000;
      rb.heard(false);
    }
    await b.settle();
    expect(b.suspends).toBe(0);
    rb.scriptCleared();
    await b.settle();
    expect(b.suspends).toBe(1);
  });

  it("does nothing where the browser does not count underruns", async () => {
    const f = fake({ stats: false });
    const r = createReclaim(f);
    await bootGoesQuiet(f, r);
    r.scriptCleared();
    await r.force();
    await f.settle();
    expect(f.suspends).toBe(0);
  });

  it("leaves a stopped or hidden page alone", async () => {
    const a = fake({ hidden: true });
    const ra = createReclaim(a);
    a.underrun(5);
    await bootGoesQuiet(a, ra);
    expect(a.suspends).toBe(0);

    const b = fake();
    const rb = createReclaim(b);
    b.underrun(5);
    b.state_ = "suspended"; // the hidden-page watch got there first
    await bootGoesQuiet(b, rb);
    expect(b.suspends).toBe(0);
    expect(b.resumes).toBe(0);
  });

  it("starts the output again even when the stop never answers", async () => {
    const f = fake();
    f.suspend = () => {
      f.suspends++;
      f.state_ = "suspended";
      return new Promise(() => {});
    };
    const r = createReclaim(f);
    f.underrun(5);
    await bootGoesQuiet(f, r);
    expect(f.state()).toBe("running");
    expect(r.verdict).toBe("works");
  });

  it("says so and keeps asking when the output does not come back by itself", async () => {
    const f = fake({ resumeWorks: false });
    const r = createReclaim(f);
    f.underrun(5);
    r.scriptCleared();
    f.t += QUIET_MS + 1;
    r.heard(false);
    // Let it reach the point where it has given up waiting.
    for (let i = 0; i < 200 && f.stuckCalls.length === 0; i++) await f.step();
    expect(f.stuckCalls).toEqual([true]);
    expect(f.lines[0]).toContain("has not restarted by itself — touch the page");
    expect(r.busy).toBe(true);
    const asked = f.resumes;
    // A touch is what the browser was waiting for.
    f.opts.resumeWorks = true;
    await f.settle();
    expect(f.resumes).toBeGreaterThan(asked);
    expect(f.state()).toBe("running");
    expect(f.stuckCalls).toEqual([true, false]);
    expect(r.busy).toBe(false);
  });

  it("measures after the restart has had time to find its level", async () => {
    const f = fake();
    const r = createReclaim(f);
    f.underrun(5);
    r.scriptCleared();
    f.t += QUIET_MS + 1;
    const from = f.t;
    r.heard(false);
    await f.settle();
    expect(f.t - from).toBeGreaterThanOrEqual(AFTER_WAIT_MS + AFTER_MEASURE_MS);
  });
});
