// A Steam Deck's controls as norns keys and encoders.
//
// None of this has met the hardware, so the tests are the measurement: they
// drive synthetic frames through the core and check the two things a knob
// made out of a spring-loaded stick can get wrong — drifting when nobody is
// touching it, and refusing to move one tick at a time.

import { describe, expect, it } from "vitest";
import { createPadCore, rateFor, type PadFrame } from "../src/ui/gamepad.js";

const frame = (over: Partial<PadFrame> = {}): PadFrame => ({
  buttons: new Array(16).fill(false),
  axes: [0, 0, 0, 0],
  standard: true,
  ...over,
});

const withButton = (i: number): PadFrame => {
  const b = new Array(16).fill(false);
  b[i] = true;
  return frame({ buttons: b });
};

describe("the face buttons", () => {
  it("are K3, K2 and K1, down and up", () => {
    const core = createPadCore();
    expect(core.frame(withButton(0), 16)).toEqual([{ a: "key", n: 3, z: 1 }]);
    expect(core.frame(frame(), 16)).toEqual([{ a: "key", n: 3, z: 0 }]);
    expect(core.frame(withButton(1), 16)).toEqual([{ a: "key", n: 2, z: 1 }]);
    core.frame(frame(), 16);
    expect(core.frame(withButton(2), 16)).toEqual([{ a: "key", n: 1, z: 1 }]);
  });

  it("do not repeat while held, because a norns key does not", () => {
    const core = createPadCore();
    core.frame(withButton(0), 16);
    expect(core.frame(withButton(0), 16)).toEqual([]);
    expect(core.frame(withButton(0), 500)).toEqual([]);
  });

  it("release everything when the pad goes away mid-press", () => {
    // Otherwise norns believes K3 is held down for ever.
    const core = createPadCore();
    core.frame(withButton(0), 16);
    expect(core.frame(null, 16)).toEqual([{ a: "key", n: 3, z: 0 }]);
  });
});

describe("E1 on the d-pad and the bumpers", () => {
  it("steps once on press, then repeats after a pause", () => {
    const core = createPadCore();
    expect(core.frame(withButton(15), 16)).toEqual([{ a: "enc", n: 1, delta: 1 }]);
    expect(core.frame(withButton(15), 100), "still inside the pause").toEqual([]);
    core.frame(withButton(15), 300);
    expect(core.frame(withButton(15), 100)).toEqual([{ a: "enc", n: 1, delta: 1 }]);
  });

  it("goes the other way on the left side", () => {
    expect(createPadCore().frame(withButton(14), 16)).toEqual([{ a: "enc", n: 1, delta: -1 }]);
    expect(createPadCore().frame(withButton(4), 16)).toEqual([{ a: "enc", n: 1, delta: -1 }]);
  });
});

describe("the sticks as encoders", () => {
  it("ignore a drifting stick, which is what a dead zone is for", () => {
    const core = createPadCore();
    expect(rateFor(0.12)).toBe(0);
    let out: unknown[] = [];
    for (let i = 0; i < 60; i++) out = out.concat(core.frame(frame({ axes: [0.12, 0, 0, 0] }), 16));
    expect(out, "a whole second of drift moves nothing").toEqual([]);
  });

  it("give ONE tick for a small push, not a stream of them", () => {
    // The fractional carry is the point: rounding each frame would turn any
    // touch at all into 60 ticks a second.
    const core = createPadCore();
    let total = 0;
    for (let i = 0; i < 60; i++) {
      for (const a of core.frame(frame({ axes: [0.3, 0, 0, 0] }), 16)) {
        if (a.a === "enc") total += a.delta;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(6);
  });

  it("run fast at full deflection, and the right way round", () => {
    const core = createPadCore();
    let total = 0;
    for (let i = 0; i < 60; i++) {
      for (const a of core.frame(frame({ axes: [-1, 0, 0, 0] }), 16)) {
        if (a.a === "enc") total += a.delta;
      }
    }
    expect(total).toBeLessThan(-25);
    expect(total).toBeGreaterThan(-40);
  });

  it("puts the left stick on E2 and the right on E3", () => {
    const core = createPadCore();
    const seen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      for (const a of core.frame(frame({ axes: [1, 0, -1, 0] }), 16)) {
        if (a.a === "enc") seen.add(a.n);
      }
    }
    expect([...seen].sort()).toEqual([2, 3]);
  });

  it("follows the gear's sensitivity, so pad and keyboard agree", () => {
    let s = 1;
    const core = createPadCore({ sensitivity: () => s });
    const run = (): number => {
      let t = 0;
      for (let i = 0; i < 30; i++) {
        for (const a of core.frame(frame({ axes: [0.8, 0, 0, 0] }), 16)) if (a.a === "enc") t += a.delta;
      }
      return t;
    };
    const atOne = run();
    s = 2;
    expect(run()).toBeGreaterThan(atOne);
  });
});

describe("a pad the browser cannot map", () => {
  it("is ignored rather than guessed at", () => {
    // Non-standard mapping means the indices above mean nothing, and acting
    // on them would fire random norns keys.
    const core = createPadCore();
    expect(core.frame(frame({ standard: false, buttons: new Array(16).fill(true) }), 16)).toEqual([]);
  });
});
