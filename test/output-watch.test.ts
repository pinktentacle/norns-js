// E9-166 — where the sound stops, from inside the audio thread.
//
// Three rounds of "there is no sound" were spent narrowing by hand what
// this answers in one line, using a measurement that had been arriving
// every 50 ms with nobody reading it. `MixerClient.cpp:21` reports
// twelve peaks and the ORDER is the whole meaning: `engine` against
// `out` separates "the mixer is eating it" from "scsynth never reached
// crone", which no log could distinguish before.
//
// So the thing this file must get right is that order, and the refusal
// to report a quiet page as a broken one.

import { describe, expect, it } from "vitest";
import {
  describeVu,
  emptyVu,
  foldVu,
  judgeVu,
  type VuWindow,
} from "../src/ui/output-watch.js";

/** Twelve levels in `o_poll_callback_vu` order. */
function vu(o: Partial<Record<"in" | "out" | "eng" | "mon" | "cut" | "tape", number>>): number[] {
  const p = (n = 0): [number, number] => [n, n];
  return [
    ...p(o.in),
    ...p(o.out),
    ...p(o.eng),
    ...p(o.mon),
    ...p(o.cut),
    ...p(o.tape),
  ];
}

function window(levels: number[][]): VuWindow {
  const w = emptyVu();
  for (const l of levels) foldVu(w, l);
  return w;
}

describe("reading the twelve peaks", () => {
  it("puts each pair where it belongs", () => {
    const w = window([vu({ in: 1, out: 2, eng: 3, mon: 4, cut: 5, tape: 6 })]);
    expect(w).toMatchObject({ inMax: 1, outMax: 2, engMax: 3, monMax: 4, cutMax: 5, tapeMax: 6 });
  });

  it("keeps the loudest of the window, not the last", () => {
    const w = window([vu({ out: 40 }), vu({ out: 0 }), vu({ out: 7 })]);
    expect(w.outMax).toBe(40);
    expect(w.polls).toBe(3);
  });

  it("takes the louder of the two channels", () => {
    const w = emptyVu();
    const l = vu({});
    l[4] = 0;
    l[5] = 31; // engine right only
    foldVu(w, l);
    expect(w.engMax).toBe(31);
  });

  // The order IS the meaning. A short reading would shift `engine` into
  // `monitor` and report the exact opposite of the truth, so it is
  // dropped rather than padded.
  it("refuses a reading that is not twelve numbers", () => {
    const w = emptyVu();
    expect(foldVu(w, [1, 2, 3])).toBe(false);
    expect(w.polls).toBe(0);
    expect(foldVu(w, vu({ out: 5 }))).toBe(true);
  });
});

describe("the verdict", () => {
  it("says nothing when sound is coming out", () => {
    expect(judgeVu(window([vu({ eng: 20, out: 18 })]), true, 0)).toBeNull();
  });

  // The case three rounds of this were spent on.
  it("names the mixer when the engine is producing and nothing leaves", () => {
    const v = judgeVu(window([vu({ eng: 33, out: 0 })]), true, 0)!;
    const line = v.line;
    expect(v.kind).toBe("mixer-eats-it");
    expect(line).toContain("engine 33");
    expect(line).toContain("NOTHING leaving it");
    expect(line).toContain("level_ext");
  });

  it("names softcut and tape the same way", () => {
    expect(judgeVu(window([vu({ cut: 12, out: 0 })]), true, 0)!.line).toContain("softcut 12");
    expect(judgeVu(window([vu({ tape: 9, out: 0 })]), true, 0)!.line).toContain("tape 9");
  });

  // A quiet script is not a fault and this cannot know what a script
  // MEANT to do. An instrument that cries wolf at idle is one people
  // learn to scroll past, and then it is not there on the day it matters.
  it("does not call a quiet page broken", () => {
    expect(judgeVu(window([vu({})]), false, 60_000)).toBeNull();
    expect(judgeVu(window([vu({})]), true, 5000)).toBeNull();
  });

  it("mentions a long silence only once a script is loaded and it has lasted", () => {
    const v = judgeVu(window([vu({})]), true, 20_000)!;
    expect(v.kind).toBe("nothing-arrives");
    expect(v.line).toContain("20 s");
    expect(v.line).toContain("live looper");
  });

  // A poll that has stopped is not a silent page, it is a dead audio
  // thread, and those need different answers.
  it("says when crone has stopped reporting at all", () => {
    expect(judgeVu(emptyVu(), true, 0)!.kind).toBe("stopped");
    expect(judgeVu(emptyVu(), true, 0)!.line).toContain("stopped reporting");
  });
});

describe("the line it prints for a person", () => {
  it("reads as a path through the mixer", () => {
    const line = describeVu(window([vu({ in: 1, eng: 2, cut: 3, tape: 4, mon: 5, out: 6 })]));
    expect(line).toBe("in 1, engine 2, softcut 3, tape 4, monitor 5 → out 6 (of 64)");
  });
});

// E9-172 — the kind is what a caller rate-limits on.
//
// The sentence carries an elapsed time, so two readings of the same
// finding three seconds apart are never equal as strings. A caller that
// compared whole sentences printed fifty copies of one finding into a
// log that was already hard to read.
describe("telling two findings apart without reading them", () => {
  it("gives the same kind for the same finding at different times", () => {
    const a = judgeVu(window([vu({})]), true, 20_000)!;
    const b = judgeVu(window([vu({})]), true, 50_000)!;
    expect(a.line).not.toBe(b.line);
    expect(a.kind).toBe(b.kind);
  });

  it("gives different kinds for different findings", () => {
    const kinds = new Set([
      judgeVu(window([vu({ eng: 20, out: 0 })]), true, 0)!.kind,
      judgeVu(window([vu({})]), true, 20_000)!.kind,
      judgeVu(emptyVu(), true, 0)!.kind,
    ]);
    expect(kinds.size).toBe(3);
  });
});
