// E5-01/E5-03/E5-05 — the on-screen grid, and the one bug it is easy to ship.
//
// There is no jsdom here on purpose: the project has four runtime
// environments already (node, worklet, worker, browser) and a fifth that
// pretends to be a browser earns its keep only if it tests something real.
// What is real here is the LISTENER LIFETIME, and Node's own `EventTarget`
// implements `addEventListener(..., { signal })` to spec, so a forty-line
// fake canvas exercises exactly the mechanism that was broken.
//
// What was broken: the canvas outlives the view. A grid that changes size is
// a new `GridDevice` (it reads its shape once, on construction), so the view
// is rebuilt -- and the old one, merely dropped, kept its pointer listeners
// on the shared canvas. Both answered. Every key arrived twice, once at a
// device matron had already removed, which Lua reported as
// `grid.key: core/grid.lua:230: no entry for grid 1`.

import { describe, expect, it } from "vitest";
import { GridView, REPAINT_AFTER_MS } from "../src/grid/view.js";
import { GridDevice, type GridDescriptor } from "../src/grid/device.js";

const desc: GridDescriptor = {
  serial: "v0001",
  name: "virtual grid",
  cols: 16,
  rows: 8,
  varibright: true,
};

/** Just enough canvas: a real EventTarget, a stub 2d context, a fixed box. */
class FakeCanvas extends EventTarget {
  width = 640;
  height = 320;
  clientWidth = 640;
  clientHeight = 320;
  readonly style: Record<string, string> = {};
  /** Counted, because a throw here used to swallow the key press. */
  captures = 0;

  getContext(kind: string): unknown {
    if (kind !== "2d") return null;
    // Enough of a 2d context for the view to draw a key: paths, the two
    // gradients and the shadow properties. Nothing is rendered -- what is
    // under test is the input handling and the level bookkeeping -- but the
    // draw must not throw, because a throw in `draw` used to swallow the
    // key press that caused it.
    const gradient = { addColorStop: () => {} };
    return {
      fillStyle: "" as unknown,
      strokeStyle: "" as unknown,
      lineWidth: 0,
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      arc: () => {},
      arcTo: () => {},
      rect: () => {},
      clip: () => {},
      fill: () => {},
      stroke: () => {},
      clearRect: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
    };
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  setPointerCapture(): void {
    this.captures++;
    // A pointer id the browser does not know raises NotFoundError. The view
    // must treat capture as an improvement to the drag, not a precondition.
    throw new Error("NotFoundError");
  }
}

function pointer(type: string, pointerId: number, clientX: number, clientY: number): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerId,
    clientX,
    clientY,
    shiftKey: false,
    preventDefault: () => {},
  });
}

function harness() {
  const canvas = new FakeCanvas();
  const keys: Array<[number, number, number]> = [];
  const d = new GridDevice(1, desc, {
    key: (x, y, s) => keys.push([x, y, s]),
    tilt: () => {},
  });
  const make = (): GridView => {
    const v = new GridView({
      canvas: canvas as unknown as HTMLCanvasElement,
      descriptor: desc,
      cols: () => d.cols(),
      rows: () => d.rows(),
      onKey: (x, y, s) => d.key(x, y, s),
    });
    d.addTransport(v);
    return v;
  };
  return { canvas, keys, d, make };
}

describe("the view as a transport", () => {
  it("maps a pointer to the cell under it, 0-based and in device space", () => {
    const { canvas, keys, make } = harness();
    make();
    // 640 x 320 over 16 x 8 is a 40 px cell. (100, 100) is column 2, row 2.
    canvas.dispatchEvent(pointer("pointerdown", 1, 100, 100));
    canvas.dispatchEvent(pointer("pointerup", 1, 100, 100));
    expect(keys).toEqual([
      [2, 2, 1],
      [2, 2, 0],
    ]);
  });

  it("plays the pad even when the pointer cannot be captured", () => {
    const { canvas, keys, make } = harness();
    make();
    canvas.dispatchEvent(pointer("pointerdown", 7, 10, 10));
    expect(canvas.captures).toBe(1); // it was attempted...
    expect(keys).toEqual([[0, 0, 1]]); // ...and the throw did not swallow it
  });

  it("treats a slide as a lift and a press, which is what hardware does", () => {
    const { canvas, keys, make } = harness();
    make();
    canvas.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    canvas.dispatchEvent(pointer("pointermove", 1, 50, 10));
    canvas.dispatchEvent(pointer("pointerup", 1, 50, 10));
    expect(keys).toEqual([
      [0, 0, 1],
      [0, 0, 0],
      [1, 0, 1],
      [1, 0, 0],
    ]);
  });

  it("lifts a key that is cancelled rather than released", () => {
    const { canvas, keys, make } = harness();
    make();
    canvas.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    canvas.dispatchEvent(pointer("pointercancel", 1, 10, 10));
    expect(keys).toEqual([
      [0, 0, 1],
      [0, 0, 0],
    ]);
  });
});

describe("listener lifetime", () => {
  it("stops answering the canvas once disposed", () => {
    const { canvas, keys, make } = harness();
    const v = make();
    v.dispose();
    canvas.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    canvas.dispatchEvent(pointer("pointerup", 1, 10, 10));
    expect(keys).toEqual([]);
  });

  it("lifts what is still held when it is disposed, not after", () => {
    const { canvas, keys, make } = harness();
    const v = make();
    canvas.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    v.dispose();
    expect(keys).toEqual([
      [0, 0, 1],
      [0, 0, 0], // the lift, while the device is still there to hear it
    ]);
  });

  it("delivers each key ONCE after a rebuild on the same canvas", () => {
    // The regression. Rebuild without disposing and every key doubles.
    const { canvas, keys, make } = harness();
    const first = make();
    first.dispose();
    make();
    canvas.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    expect(keys).toEqual([[0, 0, 1]]);
  });
});

// E9-162 — the two things that made a refresh cost what it did.
//
// A Pixel playing `kolor` spent a quarter of the page's JavaScript in
// `drawNow`. Two reasons, both measured on `spike/grid-bench.html`
// before anything was changed: a 16x8 grid is TWO quads and
// `GridDevice.refresh()` sends one `ledLevelMap` for each, so every
// refresh redrew all 128 keys twice (`drawsPerRefresh: 2`); and every
// lit key built three gradients and traced eight corners, at 0.459 ms a
// draw.
describe("what a refresh costs", () => {
  /** A canvas that counts redraws and can make the offscreen sprites. */
  function counting() {
    let draws = 0;
    let made = 0;
    let blits = 0;
    const gradient = { addColorStop: () => {} };
    const ctx = (): unknown => ({
      fillStyle: "" as unknown,
      strokeStyle: "" as unknown,
      lineWidth: 0,
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      arc: () => {},
      arcTo: () => {},
      rect: () => {},
      clip: () => {},
      fill: () => {},
      stroke: () => {},
      clearRect: () => void draws++,
      fillRect: () => {},
      strokeRect: () => {},
      drawImage: () => void blits++,
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
    });
    const canvas = new FakeCanvas() as unknown as {
      ownerDocument: unknown;
      getContext(k: string): unknown;
    } & FakeCanvas;
    // An offscreen canvas factory, so the sprite path is the one under
    // test rather than the fallback a document-less stub forces.
    canvas.ownerDocument = {
      createElement: () => {
        made++;
        return { width: 0, height: 0, getContext: () => ctx() };
      },
    };
    canvas.getContext = (k: string) => (k === "2d" ? ctx() : null);
    return {
      canvas,
      draws: () => draws,
      sprites: () => made,
      blits: () => blits,
      reset: () => void ((draws = 0), (blits = 0)),
    };
  }

  function view(c: ReturnType<typeof counting>, frame?: (fn: () => void) => void) {
    return new GridView({
      canvas: c.canvas as unknown as HTMLCanvasElement,
      descriptor: desc,
      cols: () => 16,
      rows: () => 8,
      onKey: () => {},
      ...(frame === undefined ? {} : { frame }),
    });
  }

  const quad = (level: number): Uint8Array => new Uint8Array(64).fill(level);

  it("draws ONCE for a refresh that arrives as two quads", () => {
    const c = counting();
    const frames: Array<() => void> = [];
    const v = view(c, (fn) => void frames.push(fn));
    c.reset();
    // Exactly what `GridDevice.refresh()` sends for a 16x8 grid.
    v.ledLevelMap(0, 0, quad(5));
    v.ledLevelMap(8, 0, quad(9));
    expect(c.draws(), "a present must not draw on the spot").toBe(0);
    expect(frames).toHaveLength(1);
    frames[0]!();
    expect(c.draws()).toBe(1);
  });

  it("collapses refreshes that arrive faster than the display", () => {
    const c = counting();
    const frames: Array<() => void> = [];
    const v = view(c, (fn) => void frames.push(fn));
    c.reset();
    for (let i = 0; i < 50; i++) {
      v.ledLevelMap(0, 0, quad(i % 16));
      v.ledLevelMap(8, 0, quad(15 - (i % 16)));
    }
    expect(frames, "one frame asked for, not a hundred").toHaveLength(1);
    frames[0]!();
    expect(c.draws()).toBe(1);
  });

  it("draws at once where there is no requestAnimationFrame", () => {
    // Node has none, and a view that silently stopped drawing there would
    // pass every assertion in this file by doing nothing at all.
    const c = counting();
    const v = view(c);
    c.reset();
    v.ledLevelMap(0, 0, quad(3));
    expect(c.draws()).toBe(1);
  });

  it("flushes what is pending, so a caller can make the draw happen", () => {
    const c = counting();
    const v = view(c, () => {});
    c.reset();
    v.ledLevelMap(0, 0, quad(3));
    v.flush();
    expect(c.draws()).toBe(1);
    v.flush();
    expect(c.draws(), "nothing pending, nothing drawn").toBe(1);
  });

  it("does not draw into a canvas it has given up", () => {
    const c = counting();
    const frames: Array<() => void> = [];
    const v = view(c, (fn) => void frames.push(fn));
    c.reset();
    v.ledLevelMap(0, 0, quad(4));
    v.dispose();
    frames[0]!();
    expect(c.draws(), "the canvas belongs to the next view now").toBe(0);
  });

  it("builds one sprite per appearance, not one per key", () => {
    const c = counting();
    const v = view(c);
    const before = c.sprites();
    // Two levels across 128 cells, none of them held.
    v.ledLevelMap(0, 0, quad(5));
    v.ledLevelMap(8, 0, quad(12));
    expect(c.sprites() - before, "two levels, two sprites").toBe(2);
    // And again: the cache is a cache.
    v.ledLevelMap(0, 0, quad(5));
    v.ledLevelMap(8, 0, quad(12));
    expect(c.sprites() - before).toBe(2);
  });

  it("throws the sprites away when intensity changes them all", () => {
    const c = counting();
    const v = view(c);
    v.ledLevelMap(0, 0, quad(5));
    const after = c.sprites();
    v.ledIntensity(15);
    expect(c.sprites(), "the same intensity changes nothing").toBe(after);
    v.ledIntensity(4);
    v.ledLevelMap(0, 0, quad(5));
    expect(c.sprites(), "a dimmer grid is a different key").toBeGreaterThan(after);
  });
});

// E9-168 — every cell, every draw.
//
// E9-163 repainted only the cells whose appearance had changed and was
// verified against a from-scratch paint that never exercised a small
// region: thirteen of sixteen single-cell steps differed, by 20,254
// pixels at up to 253 of 255. `spike/grid-steps.html` is the harness
// that found it and reads 0 on all sixteen now. What is left is safe by
// construction — clear the whole canvas, paint every cell, once a frame
// — and that is what these assert.
describe("what one draw covers", () => {
  function counting() {
    let blits = 0;
    let clears = 0;
    let made = 0;
    const gradient = { addColorStop: () => {} };
    const ctx = (): unknown => ({
      fillStyle: "" as unknown,
      strokeStyle: "" as unknown,
      lineWidth: 0,
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      arc: () => {},
      arcTo: () => {},
      rect: () => {},
      clip: () => {},
      fill: () => {},
      stroke: () => {},
      clearRect: () => void clears++,
      fillRect: () => {},
      strokeRect: () => {},
      drawImage: () => void blits++,
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
    });
    const canvas = new FakeCanvas() as unknown as { ownerDocument: unknown } & FakeCanvas;
    canvas.ownerDocument = {
      createElement: () => {
        made++;
        return { width: 0, height: 0, getContext: () => ctx() };
      },
    };
    canvas.getContext = (k: string) => (k === "2d" ? ctx() : null);
    // A clock the test owns, because one of the things under test is how
    // long an unchanged picture may go unpainted. E9-199.
    let at = 0;
    const v = new GridView({
      canvas: canvas as unknown as HTMLCanvasElement,
      descriptor: desc,
      cols: () => 16,
      rows: () => 8,
      onKey: () => {},
      frame: () => {},
      now: () => at,
    });
    return {
      view: v,
      canvas,
      blits: () => blits,
      clears: () => clears,
      sprites: () => made,
      advance: (ms: number) => void (at += ms),
      reset: () => void ((blits = 0), (clears = 0)),
      present(levels: (i: number) => number) {
        for (const q of [0, 8]) {
          const u = new Uint8Array(64);
          for (let i = 0; i < 64; i++) {
            const x = q + (i & 7);
            const y = i >> 3;
            u[i] = levels(y * 16 + x);
          }
          v.ledLevelMap(q, 0, u);
        }
        v.flush();
      },
    };
  }

  it("clears the canvas once and paints all 128 keys", () => {
    const c = counting();
    c.reset();
    c.present(() => 4);
    expect(c.clears(), "one clear, of the whole surface").toBe(1);
    expect(c.blits()).toBe(128);
  });

  // E9-199 — this used to assert the opposite: 128 blits for a refresh
  // that changed nothing, "because there is no record of what was there
  // and deliberately so". The record it refused was the per-cell one the
  // partial repaint needed. What is kept now is the levels the view
  // already held, and the only question asked of them is whether the
  // whole picture is the one on the canvas.
  describe("a refresh that changed nothing", () => {
    it("is not drawn at all", () => {
      const c = counting();
      c.present(() => 4);
      c.reset();
      c.present(() => 4);
      expect(c.clears(), "not even the clear").toBe(0);
      expect(c.blits()).toBe(0);
      // Both quads of the second present, counted as what they were.
      expect(c.view.stats().skipped).toBe(2);
    });

    it("is all or nothing: one changed key repaints all 128", () => {
      // The partial repaint shipped broken (E9-163, E9-168) and this is
      // the assertion that it has not come back by another door.
      const c = counting();
      c.present(() => 4);
      c.reset();
      c.present((i) => (i === 37 ? 9 : 4));
      expect(c.clears(), "one clear, of the whole surface").toBe(1);
      expect(c.blits()).toBe(128);
    });

    it("is repainted anyway once a second has gone by", () => {
      // The bound that makes the skip safe without having to be perfect:
      // a canvas emptied behind the view's back is wrong for a second at
      // most, on any script that keeps refreshing.
      const c = counting();
      c.present(() => 4);
      c.advance(REPAINT_AFTER_MS - 1);
      c.reset();
      c.present(() => 4);
      expect(c.blits(), "still inside the second").toBe(0);
      c.advance(1);
      c.present(() => 4);
      expect(c.clears()).toBe(1);
      expect(c.blits()).toBe(128);
      // And the second starts again from that paint.
      c.reset();
      c.present(() => 4);
      expect(c.blits()).toBe(0);
    });

    it("draws a level that went away and came back inside one frame", () => {
      // `g:all(0)` then the same picture again is two quads that end
      // where they started. The first one changed something, so a draw is
      // owed, and what it paints is whatever is there by then.
      const c = counting();
      c.present(() => 4);
      c.reset();
      c.view.ledLevelMap(0, 0, new Uint8Array(64).fill(0));
      c.view.ledLevelMap(0, 0, new Uint8Array(64).fill(4));
      c.view.flush();
      expect(c.clears()).toBe(1);
      expect(c.blits()).toBe(128);
    });

    it("does not stop the intensity from repainting", () => {
      const c = counting();
      c.present(() => 4);
      c.reset();
      c.view.ledIntensity(7);
      c.view.flush();
      expect(c.blits(), "every sprite is wrong now, so every key is painted").toBe(128);
    });

    it("does not stop a new layout from repainting", () => {
      const c = counting();
      c.present(() => 4);
      c.reset();
      c.view.layout();
      expect(c.blits()).toBe(128);
    });

    it("repaints, sprites and all, when the browser hands back a lost canvas", () => {
      const c = counting();
      c.present(() => 4);
      const before = c.sprites();
      c.reset();
      c.canvas.dispatchEvent(new Event("contextrestored"));
      expect(c.clears()).toBe(1);
      expect(c.blits()).toBe(128);
      // The sprite is its own canvas and may have been lost with this one.
      expect(c.sprites() - before, "the one appearance in use, made again").toBe(1);
    });

    it("stops answering a lost canvas once it is disposed", () => {
      const c = counting();
      c.present(() => 4);
      c.view.dispose();
      c.reset();
      c.canvas.dispatchEvent(new Event("contextrestored"));
      expect(c.blits()).toBe(0);
    });
  });

  it("still only builds one sprite per appearance", () => {
    const c = counting();
    const before = c.sprites();
    c.present((i) => (i < 64 ? 5 : 12));
    expect(c.sprites() - before, "two levels, two sprites").toBe(2);
    c.present((i) => (i < 64 ? 5 : 12));
    expect(c.sprites() - before, "and the cache is a cache").toBe(2);
  });

  it("shows a held key without being told anything changed", () => {
    const c = counting();
    c.present(() => 0);
    c.reset();
    c.canvas.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    c.view.flush();
    expect(c.blits(), "a press repaints the surface").toBe(128);
    // 17 appearances: level 0 unheld, and level 0 held.
    expect(c.sprites()).toBeGreaterThan(1);
  });
});
