// E2-03 / E2-05 — the parts of the presentation and input layers that can be
// decided without a browser.
//
// The rest was verified in a real one: the menu renders, `s` moves the
// selection, `w` changes panel, the wheel scrolls, a vertical drag scrolls,
// K3 enters PSET and K2 goes back. A jsdom canvas would have tested none of
// that — it has no rasteriser and no pointer capture — so it is not pretended
// here. What IS testable without a DOM is the arithmetic and the map, and
// those are exactly the two places a silent mistake would be invisible on
// screen: a scale of 3 where 4 fits just looks small, and a wrong key mapping
// just feels wrong.

import { describe, expect, it } from "vitest";
import { fitScale, SCREEN_W, SCREEN_H } from "../src/ui/canvas.js";
import { KEYBOARD } from "../src/ui/input.js";
import { bind, codesFor, DEFAULT_KEYMAP, sanitise } from "../src/ui/keymap.js";

describe("integer scaling", () => {
  it("picks the largest whole multiple that fits", () => {
    expect(fitScale(SCREEN_W * 4, SCREEN_H * 4)).toBe(4);
    expect(fitScale(SCREEN_W * 4 + 10, SCREEN_H * 4 + 10)).toBe(4);
    expect(fitScale(SCREEN_W * 5 - 1, SCREEN_H * 5 - 1)).toBe(4);
  });

  it("is limited by whichever axis runs out first", () => {
    // A wide, short box: height decides.
    expect(fitScale(SCREEN_W * 10, SCREEN_H * 2)).toBe(2);
    expect(fitScale(SCREEN_W * 2, SCREEN_H * 10)).toBe(2);
  });

  it("never returns a fraction, which is the whole point", () => {
    for (let w = 100; w < 2000; w += 37) {
      const s = fitScale(w, w / 2);
      expect(Number.isInteger(s)).toBe(true);
    }
  });

  it("floors at 1 rather than disappearing", () => {
    // Below 1x the honest choice is to overflow the box, not to drop pixels.
    expect(fitScale(10, 10)).toBe(1);
    expect(fitScale(0, 0)).toBe(1);
  });

  it("respects a maximum when one is given", () => {
    expect(fitScale(SCREEN_W * 8, SCREEN_H * 8, 3)).toBe(3);
    expect(fitScale(SCREEN_W * 2, SCREEN_H * 2, 3)).toBe(2);
  });
});

describe("the keyboard map", () => {
  it("covers all three keys and all three encoders in both directions", () => {
    const keys = new Set<number>();
    const encs = new Map<number, Set<number>>();
    for (const m of Object.values(KEYBOARD)) {
      if (m.key) keys.add(m.key);
      if (m.enc && m.dir) {
        if (!encs.has(m.enc)) encs.set(m.enc, new Set());
        encs.get(m.enc)!.add(m.dir);
      }
    }
    expect([...keys].sort()).toEqual([1, 2, 3]);
    expect([...encs.keys()].sort()).toEqual([1, 2, 3]);
    for (const [n, dirs] of encs) {
      expect([...dirs].sort(), `encoder ${n} needs both directions`).toEqual([-1, 1]);
    }
  });

  it("never binds one physical key to both a key and an encoder", () => {
    for (const [code, m] of Object.entries(KEYBOARD)) {
      expect(Boolean(m.key) && Boolean(m.enc), `${code} is bound twice`).toBe(false);
    }
  });

  it("gives the encoders the q/a/z and w/s/x columns, left turns down", () => {
    // The layout is the mnemonic: three columns of a keyboard standing in for
    // three knobs, minus on the left and plus on the right.
    expect(KEYBOARD["KeyQ"]).toEqual({ enc: 1, dir: -1 });
    expect(KEYBOARD["KeyW"]).toEqual({ enc: 1, dir: 1 });
    expect(KEYBOARD["KeyA"]).toEqual({ enc: 2, dir: -1 });
    expect(KEYBOARD["KeyS"]).toEqual({ enc: 2, dir: 1 });
    expect(KEYBOARD["KeyZ"]).toEqual({ enc: 3, dir: -1 });
    expect(KEYBOARD["KeyX"]).toEqual({ enc: 3, dir: 1 });
  });

  it("a code does one thing: binding it again moves it", () => {
    // Two actions on one key is not a map, it is the moment two handlers
    // both fire and nobody can say which was meant.
    const moved = bind(DEFAULT_KEYMAP, "KeyQ", "k3");
    expect(codesFor(moved, "e1-")).not.toContain("KeyQ");
    expect(codesFor(moved, "k3")).toContain("KeyQ");
  });

  it("drops what it does not recognise when reading storage back", () => {
    // Storage outlives a release. A map written by a version with different
    // actions has to come back as something this version can use.
    const map = sanitise({ KeyJ: { key: 2 }, KeyK: { enc: 9, dir: 1 }, "": { key: 1 } });
    expect(map).not.toBeNull();
    expect(Object.keys(map!)).toEqual(["KeyJ"]);
    expect(sanitise("nonsense")).toBeNull();
    expect(sanitise({ KeyJ: { enc: 4 } })).toBeNull();
  });
});
