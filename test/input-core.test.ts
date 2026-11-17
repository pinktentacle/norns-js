// E2-08 — the input edge cases.
//
// Each of these is a way for input to go wrong that leaves no trace on screen:
// a stuck key is a norns that believes K1 is held forever, a doubled
// acceleration just feels twitchy, a diagonal drag moves the menu in two
// dimensions and looks like a bug in norns. None of them would be caught by
// looking at the thing.

import { describe, expect, it } from "vitest";
import { createInputCore, type InputAction } from "../src/ui/input-core.js";

const down = (code: string, repeat = false, modifier = false) =>
  ({ t: "keydown", code, repeat, modifier }) as const;
const up = (code: string) => ({ t: "keyup", code }) as const;

describe("keys are edge triggered", () => {
  it("a press is one down, and auto-repeat is not a second press", () => {
    const core = createInputCore();
    expect(core.handle(down("Digit1"))).toEqual([{ a: "key", n: 1, z: 1 }]);
    expect(core.handle(down("Digit1", true))).toEqual([]);
    expect(core.handle(down("Digit1", true))).toEqual([]);
    expect(core.handle(up("Digit1"))).toEqual([{ a: "key", n: 1, z: 0 }]);
  });

  it("two bindings for the same key do not double-fire, or release early", () => {
    // Shift and 1 are both K1. Pressing both and releasing one must NOT tell
    // norns the key came up while the other is still held.
    const core = createInputCore();
    expect(core.handle(down("ShiftLeft"))).toEqual([{ a: "key", n: 1, z: 1 }]);
    expect(core.handle(down("Digit1"))).toEqual([]);
    expect(core.handle(up("ShiftLeft"))).toEqual([]);
    expect(core.held.has(1)).toBe(true);
    expect(core.handle(up("Digit1"))).toEqual([{ a: "key", n: 1, z: 0 }]);
    expect(core.held.has(1)).toBe(false);
  });

  it("a keyup for a key that was never down does nothing", () => {
    // Happens for real: press a key, switch windows, release it elsewhere,
    // come back and release again.
    const core = createInputCore();
    expect(core.handle(up("Digit2"))).toEqual([]);
  });

  it("ignores anything held with a modifier — that is the browser's", () => {
    const core = createInputCore();
    expect(core.handle(down("Digit1", false, true))).toEqual([]);
    expect(core.held.size).toBe(0);
  });

  it("ignores unbound keys", () => {
    const core = createInputCore();
    expect(core.handle(down("KeyP"))).toEqual([]);
  });
});

describe("focus loss", () => {
  it("releases every held key, because keyup never arrives", () => {
    const core = createInputCore();
    core.handle(down("Digit1"));
    core.handle(down("Digit3"));
    const released = core.handle({ t: "blur" });
    expect(released).toHaveLength(2);
    expect(released.every((a) => a.a === "key" && a.z === 0)).toBe(true);
    expect(core.held.size).toBe(0);
  });

  it("drops drags too — a drag cannot continue through an unfocused window", () => {
    const core = createInputCore();
    core.handle({ t: "pointerdown", id: 1, on: { kind: "screen" }, x: 0, y: 0 });
    expect(core.dragging.size).toBe(1);
    core.handle({ t: "blur" });
    expect(core.dragging.size).toBe(0);
    // And a move from the dropped pointer is ignored rather than resuming.
    expect(core.handle({ t: "pointermove", id: 1, x: 0, y: 40 })).toEqual([]);
  });

  it("does not emit a release for a key that was not held", () => {
    const core = createInputCore();
    expect(core.handle({ t: "blur" })).toEqual([]);
  });
});

describe("encoders", () => {
  it("a key press is worth ticksPerStep, and repeats keep passing through", () => {
    // Repeats DO reach norns: holding a key to scroll is the obvious gesture,
    // and core/encoders.lua accelerates on the time between ticks by itself.
    const core = createInputCore({ ticksPerStep: 2 });
    expect(core.handle(down("KeyS"))).toEqual([{ a: "enc", n: 2, delta: 2 }]);
    expect(core.handle(down("KeyS", true))).toEqual([{ a: "enc", n: 2, delta: 2 }]);
    expect(core.handle(down("KeyA"))).toEqual([{ a: "enc", n: 2, delta: -2 }]);
  });

  it("does not accelerate on its own — repeats are all the same size", () => {
    // If this file also accelerated, the two would multiply and a held key
    // would run away.
    const core = createInputCore();
    const deltas: number[] = [];
    for (let i = 0; i < 10; i++) {
      for (const a of core.handle(down("KeyW", i > 0))) {
        if (a.a === "enc") deltas.push(a.delta);
      }
    }
    expect(new Set(deltas).size).toBe(1);
  });

  it("a wheel notch is a detent, worth the same as a key press", () => {
    // It used to emit one tick, which looked finer and was broken: the menu
    // sets sensitivity to 2, so a single notch moved nothing at all.
    const core = createInputCore({ ticksPerStep: 2 });
    expect(core.handle({ t: "wheel", on: { kind: "enc", n: 1 }, delta: 120, shift: false })).toEqual([
      { a: "enc", n: 1, delta: 2 },
    ]);
    expect(core.handle({ t: "wheel", on: { kind: "enc", n: 1 }, delta: -120, shift: false })).toEqual([
      { a: "enc", n: 1, delta: -2 },
    ]);
  });

  it("shift+wheel over the screen is E3, plain wheel is E2", () => {
    const core = createInputCore();
    expect(core.handle({ t: "wheel", on: { kind: "screen" }, delta: 1, shift: false })).toEqual([
      { a: "enc", n: 2, delta: 2 },
    ]);
    expect(core.handle({ t: "wheel", on: { kind: "screen" }, delta: 1, shift: true })).toEqual([
      { a: "enc", n: 3, delta: 2 },
    ]);
  });
});

describe("drag", () => {
  const drag = (core: ReturnType<typeof createInputCore>, pts: Array<[number, number]>, id = 1) => {
    const out: InputAction[] = [];
    for (const [x, y] of pts) out.push(...core.handle({ t: "pointermove", id, x, y }));
    return out;
  };

  it("accumulates sub-tick movement instead of discarding it", () => {
    // A slow drag must still move. Four moves of 1px with 4px per tick is one
    // tick, not four roundings down to zero.
    const core = createInputCore({ pixelsPerTick: 4 });
    core.handle({ t: "pointerdown", id: 1, on: { kind: "enc", n: 2 }, x: 0, y: 0 });
    const out = drag(core, [[1, 0], [2, 0], [3, 0], [4, 0]]);
    expect(out).toEqual([{ a: "enc", n: 2, delta: 1 }]);
  });

  it("locks to one axis on the screen, so a diagonal does not move two", () => {
    const core = createInputCore({ pixelsPerTick: 4, axisLockPixels: 2 });
    core.handle({ t: "pointerdown", id: 1, on: { kind: "screen" }, x: 100, y: 100 });
    // Committed vertical, then wander sideways: still E2 only.
    const out = drag(core, [[100, 108], [140, 116]]);
    expect(out.every((a) => a.a === "enc" && a.n === 2)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });

  it("waits for real movement before choosing an axis", () => {
    const core = createInputCore({ axisLockPixels: 2 });
    core.handle({ t: "pointerdown", id: 1, on: { kind: "screen" }, x: 0, y: 0 });
    // A one-pixel tremble is not a gesture.
    expect(drag(core, [[1, 1]])).toEqual([]);
  });

  it("a second finger does not drive the first finger's drag", () => {
    const core = createInputCore({ pixelsPerTick: 4 });
    core.handle({ t: "pointerdown", id: 1, on: { kind: "enc", n: 3 }, x: 0, y: 0 });
    // Pointer 2 never went down on anything.
    expect(drag(core, [[100, 0]], 2)).toEqual([]);
    expect(drag(core, [[8, 0]], 1)).toEqual([{ a: "enc", n: 3, delta: 2 }]);
  });

  it("a move after the pointer is up is ignored", () => {
    const core = createInputCore({ pixelsPerTick: 4 });
    core.handle({ t: "pointerdown", id: 1, on: { kind: "enc", n: 1 }, x: 0, y: 0 });
    core.handle({ t: "pointerup", id: 1 });
    expect(drag(core, [[40, 0]])).toEqual([]);
  });

  it("pointercancel ends a drag, which is what the browser sends on an interruption", () => {
    const core = createInputCore();
    core.handle({ t: "pointerdown", id: 1, on: { kind: "screen" }, x: 0, y: 0 });
    core.handle({ t: "pointercancel", id: 1 });
    expect(core.dragging.size).toBe(0);
  });

  it("direction is preserved both ways, with no dead zone at zero", () => {
    const core = createInputCore({ pixelsPerTick: 4 });
    core.handle({ t: "pointerdown", id: 1, on: { kind: "enc", n: 2 }, x: 0, y: 0 });
    expect(drag(core, [[-8, 0]])).toEqual([{ a: "enc", n: 2, delta: -2 }]);
    expect(drag(core, [[0, 0]])).toEqual([{ a: "enc", n: 2, delta: 2 }]);
  });
});

describe("keys by pointer", () => {
  it("press and release, including when the pointer slides off", () => {
    const core = createInputCore();
    expect(core.handle({ t: "pointerdown", id: 7, on: { kind: "key" as const, n: 2 }, x: 0, y: 0 })).toEqual([
      { a: "key", n: 2, z: 1 },
    ]);
    // pointerleave is the one that would otherwise leave it stuck.
    expect(core.handle({ t: "pointerleave", id: 7 })).toEqual([{ a: "key", n: 2, z: 0 }]);
  });

  it("a pointer and a keyboard key holding the same key agree on when it is up", () => {
    const core = createInputCore();
    core.handle(down("Digit3"));
    expect(core.handle({ t: "pointerdown", id: 7, on: { kind: "key" as const, n: 3 }, x: 0, y: 0 })).toEqual([]);
    expect(core.handle({ t: "pointerup", id: 7 })).toEqual([]);
    expect(core.handle(up("Digit3"))).toEqual([{ a: "key", n: 3, z: 0 }]);
  });
});
