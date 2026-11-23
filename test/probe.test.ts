// E9-200 — the instruments a profile carries back.
//
// What is tested here is that a number, once collected, is REPORTED AS WHAT
// IT WAS: with its count, without a verdict, and never as a zero when the
// truth is that nothing was read. The collecting itself is a callback apiece
// and is checked in a running page.

import { describe, expect, it } from "vitest";
import {
  addHist,
  clockPairNs,
  clockStepMs,
  createProbe,
  HeapWatch,
  makeHist,
  oscName,
  oscNames,
  readPlayback,
  resetHist,
  sayAccount,
  sayBridge,
  sayHist,
  sayPlayback,
  sayTraffic,
  speedGauge,
  Traffic,
  type CallSlot,
  type ProbeSources,
} from "../src/ui/probe.js";
import { encodeMessage } from "../src/engine/osc.js";

const msg = (address: string, args: Array<number | string> = []): Uint8Array =>
  encodeMessage(address, args) as Uint8Array;

const numbered = (command: number, args: Array<number | string> = []): Uint8Array => {
  const out = msg("", args);
  out[3] = command;
  return out;
};

const bundle = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(16 + parts.reduce((n, p) => n + 4 + p.length, 0));
  out.set(new TextEncoder().encode("#bundle"), 0);
  const view = new DataView(out.buffer);
  let o = 16;
  for (const p of parts) {
    view.setInt32(o, p.length);
    out.set(p, o + 4);
    o += 4 + p.length;
  }
  return out;
};

describe("a histogram", () => {
  it("puts a value in the first bucket that holds it, and the edge belongs to the bucket", () => {
    const h = makeHist([1, 2, 5]);
    for (const v of [0, 1, 1.01, 2, 4.9, 5, 5.01, 900]) addHist(h, v);
    expect(h.counts).toEqual([2, 2, 2, 2]);
    expect(h.n).toBe(8);
    expect(h.max).toBe(900);
  });

  it("says none when it is empty, which is not the same as zero", () => {
    // E9-180 was a reading of nothing taken for a reading of silence.
    expect(sayHist(makeHist([1, 2]))).toBe("none");
  });

  it("carries the count, the mean and the worst, and leaves empty buckets out", () => {
    const h = makeHist([0.25, 0.5, 1]);
    for (const v of [0.1, 0.2, 0.2, 0.9]) addHist(h, v);
    const said = sayHist(h);
    expect(said).toContain("n 4");
    expect(said).toContain("mean 0.350");
    expect(said).toContain("max 0.900 ms");
    expect(said).toContain("<=0.25: 3");
    expect(said).toContain("<=1: 1");
    expect(said).not.toContain("<=0.5");
    expect(said).not.toContain("more");
  });

  it("names what fell off the end", () => {
    const h = makeHist([1]);
    addHist(h, 40);
    expect(sayHist(h)).toContain("more: 1");
  });

  it("refuses a reading that is not a number", () => {
    const h = makeHist([1]);
    addHist(h, Number.NaN);
    addHist(h, Infinity);
    expect(h.n).toBe(0);
  });

  it("starts again from nothing", () => {
    const h = makeHist([1]);
    addHist(h, 3);
    resetHist(h);
    expect(sayHist(h)).toBe("none");
    expect(h.max).toBe(0);
  });
});

describe("what an OSC packet is called", () => {
  it("reads an address without reading anything after it", () => {
    expect(oscName(msg("/n_go", [1000, 1, -1, -1, 0]))).toBe("/n_go");
    expect(oscName(msg("/command/hz", [440]))).toBe("/command/hz");
  });

  it("names a numbered command and keeps the number beside the name", () => {
    // sclang sends a note as `server.sendMsg(9, ...)`. If the table were
    // wrong about a name the number would still be the fact.
    expect(oscName(numbered(9, ["PolyPerc", 1, 0, 1]))).toBe("#9 s_new");
    expect(oscName(numbered(15, [1, "cutoff", 2]))).toBe("#15 n_set");
    expect(oscName(numbered(11, [1]))).toBe("#11 n_free");
    expect(oscName(numbered(200))).toBe("#200 ?");
  });

  it("does not print bytes that are not text", () => {
    expect(oscName(Uint8Array.from([0x2f, 0x61, 0xff, 0x01, 0, 0, 0, 0]))).toBe("/a??");
  });

  it("does not follow an address that never ends", () => {
    const long = new Uint8Array(400).fill(0x61);
    long[0] = 0x2f;
    expect(oscName(long).length).toBe(40);
  });

  it("says a packet too short to have a name is short", () => {
    expect(oscName(Uint8Array.from([0x2f, 0x61]))).toBe("(short)");
  });

  it("opens a bundle and names what is in it", () => {
    const b = bundle(numbered(9, ["x", 1, 0, 1]), msg("/sync", [4]));
    expect(oscNames(b)).toEqual(["#9 s_new", "/sync"]);
    expect(oscNames(bundle(bundle(msg("/a/b"))))).toEqual(["/a/b"]);
    expect(oscNames(bundle())).toEqual(["#bundle (empty)"]);
  });
});

describe("traffic, by address", () => {
  it("counts each name and shares the bytes of a bundle between its elements", () => {
    const t = new Traffic();
    const note = numbered(9, ["PolyPerc", 1, 0, 1]);
    t.note(note);
    t.note(note);
    t.note(bundle(msg("/n_set", [1, "a", 2]), msg("/n_set", [1, "b", 3])));
    expect(t.packets).toBe(3);
    const rows = t.top();
    // Equal counts are ordered by bytes, so the order is not the point.
    expect(new Map(rows.map((r) => [r.name, r.n]))).toEqual(
      new Map([
        ["#9 s_new", 2],
        ["/n_set", 2],
      ]),
    );
    // Nothing is lost and nothing is counted twice.
    const total = rows.reduce((n, r) => n + r.bytes, 0);
    expect(total).toBeCloseTo(note.length * 2 + bundle(msg("/n_set", [1, "a", 2]), msg("/n_set", [1, "b", 3])).length, 6);
  });

  it("says none when nothing passed, and how many names it left out", () => {
    const t = new Traffic();
    expect(sayTraffic(t)).toBe("none");
    for (let i = 0; i < 12; i++) t.note(msg(`/a${i}`, [1]));
    const said = sayTraffic(t, 8);
    expect(said).toContain("12 packet(s)");
    expect(said).toContain("and 4 other address(es)");
    t.reset();
    expect(sayTraffic(t)).toBe("none");
  });
});

describe("the clocks, measured rather than assumed", () => {
  it("finds the step of a clock that moves in steps", () => {
    let calls = 0;
    // Advances by 0.005 every third read: the smallest step is 0.005.
    const now = (): number => Math.floor(calls++ / 3) * 0.005;
    expect(clockStepMs(now)).toBeCloseTo(0.005, 9);
  });

  it("answers zero for a clock that never moved, rather than infinity", () => {
    expect(clockStepMs(() => 7)).toBe(0);
  });

  it("prices an empty span as the part of two reads that falls between them", () => {
    // Each read advances the clock 40 ns, so two reads are 40 ns apart.
    let t = 0;
    const now = (): number => (t += 40e-6);
    expect(clockPairNs(now, 1000)).toBeCloseTo(40, 6);
  });

  it("times a fixed loop in nanoseconds an iteration", () => {
    let reads = 0;
    // 2 ms for the loop, whatever it did.
    const now = (): number => (reads++ === 0 ? 10 : 12);
    expect(speedGauge(now, 200_000)).toBeCloseTo(10, 6);
  });
});

describe("the account, in full", () => {
  it("prints a path that never reached a millisecond, which the old line dropped", () => {
    const lines = sayAccount([
      { path: "metro", calls: 300, ms: 23.4, worstMs: 0.9 },
      { path: "osc:to-sclang", calls: 120, ms: 0.6, worstMs: 0.02 },
    ]);
    expect(lines[0]).toContain("2 of 2 timed path(s)");
    const sclang = lines.find((l) => l.includes("osc:to-sclang"))!;
    // 0.6 ms over 120 calls is five microseconds a message.
    expect(sclang).toContain("0.60 /    120 =     5.00 us");
    expect(sclang).toContain("worst 0.02");
  });

  it("says so when nothing ran", () => {
    expect(sayAccount([])).toEqual(["account: nothing timed ran"]);
  });
});

describe("the bridge", () => {
  const slot = (calls: number, timed: number, ms: number, max = 0): CallSlot => ({ calls, timed, ms, max });

  it("estimates a total from the calls that were timed, with the clock's own cost taken off", () => {
    // 8000 calls, 1000 timed at 0.25 us each as measured; the clock reads
    // account for 50 ns of that, so a call is 200 ns and the lot is 1.6 ms.
    const lines = sayBridge([["screen_level", slot(8000, 1000, 0.25)]], 50);
    expect(lines[0]).toContain("8000 call(s) to 1 function(s), about 1.60 ms");
    expect(lines[1]).toContain("screen_level");
    expect(lines[1]).toContain("8000 x    200 ns (1000 timed, worst 0.0 us)");
  });

  it("puts the dearest first, by what it cost and not by how often it was called", () => {
    const lines = sayBridge(
      [
        ["screen_level", slot(8000, 1000, 0.1)],
        ["screen_update", slot(60, 7, 0.07)],
      ],
      0,
    );
    // 60 x 10 us is 0.6 ms; 8000 x 0.1 us is 0.8 ms.
    expect(lines[1]).toContain("screen_level");
    expect(lines[2]).toContain("screen_update");
    expect(lines[2]).toContain("(7 timed");
  });

  it("never reports a negative cost because the clock was dearer than the call", () => {
    const lines = sayBridge([["cheap", slot(800, 100, 0.001)]], 80);
    expect(lines[1]).toContain("x      0 ns");
  });

  it("says so when Lua called nothing, and counts what it leaves out", () => {
    expect(sayBridge([["x", slot(0, 0, 0)]], 0)).toEqual(["bridge: Lua called nothing"]);
    const many: Array<[string, CallSlot]> = [];
    for (let i = 0; i < 20; i++) many.push([`f${i}`, slot(8, 1, 0.001)]);
    const lines = sayBridge(many, 0, 14);
    expect(lines[lines.length - 1]).toContain("and 6 more, 48 call(s)");
  });
});

describe("the heap, watched", () => {
  it("adds up what was allocated and counts a fall as a collection", () => {
    const h = new HeapWatch();
    const mb = 1048576;
    for (const v of [40, 42, 45, 41, 43, 47, 40]) h.sample(v * mb);
    // Up 2, up 3, DOWN 4, up 2, up 4, DOWN 7.
    expect(h.allocated).toBe(11 * mb);
    expect(h.collections).toBe(2);
    expect(h.freed).toBe(11 * mb);
    const said = h.say(10);
    expect(said).toContain("js heap 40.0 MB");
    expect(said).toContain("11.0 MB allocated (1.10 MB/s)");
    expect(said).toContain("2 collection(s) freeing 11.0 MB");
  });

  it("does not call the allocator settling a collection", () => {
    const h = new HeapWatch();
    h.sample(10_000_000);
    h.sample(9_900_000);
    expect(h.collections).toBe(0);
  });

  it("keeps its last reading across a reset, so the first delta of a span is not lost", () => {
    const h = new HeapWatch();
    h.sample(10 * 1048576);
    h.reset();
    h.sample(13 * 1048576);
    expect(h.allocated).toBe(3 * 1048576);
  });

  it("says the browser cannot be read, not that nothing was allocated", () => {
    const h = new HeapWatch();
    h.sample(null);
    expect(h.say(5)).toBe("js heap not readable in this browser");
  });
});

describe("what the output device says", () => {
  const stats = (events: number, lost: number, total: number) => ({
    underrunEvents: events,
    underrunDuration: lost,
    totalDuration: total,
    averageLatency: 0.0625,
    minimumLatency: 0.06,
    maximumLatency: 0.0645,
  });

  it("reads the current shape", () => {
    const r = readPlayback({ playbackStats: stats(2, 0.019645, 226.1) });
    expect(r?.underrunEvents).toBe(2);
    expect(r?.underrunDuration).toBeCloseTo(0.019645, 9);
    expect(r?.averageLatency).toBeCloseTo(0.0625, 9);
  });

  it("reads the older shape, which counted milliseconds under other names", () => {
    const r = readPlayback({
      playoutStats: {
        fallbackFramesEvents: 3,
        fallbackFramesDuration: 30,
        totalFramesDuration: 5000,
        averageLatency: 62.5,
        minimumLatency: 60,
        maximumLatency: 64.5,
      },
    });
    expect(r?.underrunEvents).toBe(3);
    expect(r?.underrunDuration).toBeCloseTo(0.03, 9);
    expect(r?.totalDuration).toBeCloseTo(5, 9);
    expect(r?.averageLatency).toBeCloseTo(0.0625, 9);
  });

  it("is null where the browser has neither, and the line says what that costs", () => {
    expect(readPlayback({})).toBeNull();
    expect(readPlayback(null)).toBeNull();
    expect(sayPlayback(null, null)).toContain("underruns are not being counted");
  });

  it("reports a span as the difference between two readings", () => {
    const said = sayPlayback(
      readPlayback({ playbackStats: stats(2, 0.02, 100) }),
      readPlayback({ playbackStats: stats(5, 0.065, 105) }),
    );
    expect(said).toContain("3 underrun(s) losing 45.0 ms of 5.0 s played");
    expect(said).toContain("avg 62.5, min 60.0, max 64.5 ms");
  });

  it("counts from zero when there was no reading before", () => {
    expect(sayPlayback(null, readPlayback({ playbackStats: stats(2, 0.02, 100) }))).toContain(
      "2 underrun(s) losing 20.0 ms of 100.0 s played",
    );
  });
});

describe("one report", () => {
  function session(over: Partial<ProbeSources> = {}) {
    let t = 1000;
    const slots = new Map<string, CallSlot>([["screen_level", { calls: 80, timed: 10, ms: 0.002, max: 0.0004 }]]);
    const src: ProbeSources = {
      now: () => t,
      heap: () => 50 * 1048576,
      bridge: () => slots,
      costs: () => [{ path: "metro", calls: 10, ms: 2, worstMs: 0.5 }],
      audio: () => null,
      grid: () => ({ drawn: 30, skipped: 270 }),
      heaps: () => [["lua", 16 * 1048576]],
      notes: () => ["pressure: nominal"],
      ...over,
    };
    return { probe: createProbe(src), slots, advance: (ms: number) => void (t += ms), at: () => t };
  }

  it("carries every instrument, and names the ones that read nothing", () => {
    const { probe } = session();
    const said = probe.report().join("\n");
    for (const part of [
      "account: 1 of 1 timed path(s)",
      "bridge: 80 call(s) to 1 function(s)",
      "osc into sclang: none",
      "osc out of sclang: none",
      "osc into scsynth: none",
      "osc out of scsynth: none",
      "sclang round trip (ping, ms): none",
      "sclang answering a command (ms): none",
      "clock delivery, audio time from firing to Lua (ms): none",
      "timer lateness, 5 ms timer (ms): none",
      "frame spacing (ms): none",
      "input delay, event to first handler (ms): none",
      "audio out: playback statistics not available",
      "no audio context yet",
      "memory: js heap 50.0 MB",
      "wasm lua 16 MB",
      "grid: 30 present(s) drawn, 270 skipped as identical",
      "pressure: nominal",
      "machine:",
      "ns an iteration of the fixed loop",
    ]) {
      expect(said, part).toContain(part);
    }
  });

  it("clears the bridge slots it read, so the next span starts from nothing", () => {
    const { probe, slots } = session();
    probe.report();
    expect(slots.get("screen_level")).toEqual({ calls: 0, timed: 0, ms: 0, max: 0 });
    expect(probe.report().join("\n")).toContain("bridge: Lua called nothing");
  });

  it("times a ping from when it left to when it came back, and forgets it", () => {
    const { probe, advance } = session();
    probe.pingSent(1);
    advance(0.2);
    probe.pong(1);
    probe.pong(1); // a second answer to the same question is not a reading
    probe.pong(99); // nor is an answer to one never asked
    const said = probe.report().join("\n");
    expect(said).toContain("sclang round trip (ping, ms): n 1 · mean 0.200 · max 0.200 ms");
    expect(probe.report().join("\n")).toContain("sclang round trip (ping, ms): none");
  });

  it("says how many pings never came home", () => {
    const { probe, advance } = session();
    probe.pingSent(1);
    advance(6000);
    probe.pingSent(2);
    expect(probe.report().join("\n")).toContain("1 never answered");
  });

  it("times a command from the first one sent to the next packet back", () => {
    const { probe, advance } = session();
    probe.commandSent();
    advance(0.1);
    probe.commandSent(); // a burst is timed from where it began
    advance(0.1);
    probe.osc("from-lang", numbered(9, ["PolyPerc", 1, 0, 1]));
    const said = probe.report().join("\n");
    expect(said).toContain("sclang answering a command (ms): n 1 · mean 0.200");
    expect(said).toContain("osc out of sclang: 1 packet(s): #9 s_new 1");
  });

  it("does not count a packet that came long after as the answer", () => {
    const { probe, advance } = session();
    probe.commandSent(); // a cutoff, say, which sends nothing on
    advance(300);
    probe.osc("from-lang", msg("/status"));
    const said = probe.report().join("\n");
    expect(said).toContain("sclang answering a command (ms): none · 1 over 100 ms, not counted as answers");
  });

  it("measures frames by the gap between them, and not across a mark", () => {
    const { probe } = session();
    probe.frame(100);
    probe.frame(116.7);
    probe.frame(150);
    expect(probe.report().join("\n")).toContain("frame spacing (ms): n 2");
    // The frame after a mark has no predecessor in its own span.
    probe.frame(5000);
    expect(probe.report().join("\n")).toContain("frame spacing (ms): none");
  });

  it("names the kinds of input beside how long they waited", () => {
    const { probe } = session();
    probe.input("pointerdown", 3);
    probe.input("pointermove", 1);
    probe.input("pointermove", 40);
    const said = probe.report().join("\n");
    expect(said).toContain("input delay, event to first handler (ms): n 3");
    expect(said).toContain("max 40.0 ms");
    expect(said).toContain("pointerdown 1, pointermove 2");
  });

  it("reports the grid as what happened in the span, and survives a new view", () => {
    let g = { drawn: 30, skipped: 270 };
    const { probe } = session({ grid: () => g });
    probe.report();
    g = { drawn: 40, skipped: 500 };
    expect(probe.report().join("\n")).toContain("grid: 10 present(s) drawn, 230 skipped as identical");
    // The grid was resized: a new view, counting from nothing.
    g = { drawn: 3, skipped: 0 };
    expect(probe.report().join("\n")).toContain("grid: 3 present(s) drawn, 0 skipped as identical");
  });

  it("says the same of the arc, and nothing when there is none", () => {
    // E9-207. No arc attached is the ordinary case, and a line about an
    // instrument that is not there would be noise in every mark.
    const none = session({});
    expect(none.probe.report().join("\n")).not.toContain("arc:");
    let a = { drawn: 12, skipped: 100 };
    const { probe } = session({ arc: () => a });
    expect(probe.report().join("\n")).toContain("arc: 12 frame(s) painted, 100 ring update(s) skipped as identical");
    a = { drawn: 15, skipped: 104 };
    expect(probe.report().join("\n")).toContain("arc: 3 frame(s) painted, 4 ring update(s) skipped as identical");
  });

  it("reads the audio context only when asked, because it does not exist yet when this is built", () => {
    let asked = 0;
    session({
      audio: () => {
        asked++;
        return null;
      },
    });
    expect(asked).toBe(0);
  });
});

describe("a mean that one call made", () => {
  it("prints the worst timed call beside it", () => {
    // Ten timed calls came to 0.34 ms, which reads as 34 us each. Nine of
    // them were under a microsecond and one loaded a font.
    const lines = sayBridge([["screen_text", { calls: 78, timed: 10, ms: 0.34, max: 0.331 }]], 0);
    expect(lines[1]).toContain("78 x  34000 ns (10 timed, worst 331 us)");
  });

  it("says a call nobody timed has no cost, rather than a cost of nothing", () => {
    const lines = sayBridge([["rare", { calls: 3, timed: 0, ms: 0, max: 0 }]], 0);
    expect(lines[1]).toContain("3 x      ? ns (0 timed");
  });
});
