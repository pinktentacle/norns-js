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
import { GridView } from "../src/grid/view.js";
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

// E9-163 — and only the keys that changed.
//
// One draw per frame still blitted all 128 keys. A sequencer moves a
// playhead and lights a pad; the other 120 were drawn identically on top
// of themselves. What a key looks like is already one number — the
// thirty-two appearances `spriteFor` reduced it to — so a cell whose
// number has not moved can be left alone.
describe("redrawing only what moved", () => {
  function counting() {
    let blits = 0;
    let clears = 0;
    let clipped = 0;
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
      clip: () => void clipped++,
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
      createElement: () => ({ width: 0, height: 0, getContext: () => ctx() }),
    };
    canvas.getContext = (k: string) => (k === "2d" ? ctx() : null);
    const v = new GridView({
      canvas: canvas as unknown as HTMLCanvasElement,
      descriptor: desc,
      cols: () => 16,
      rows: () => 8,
      onKey: () => {},
      frame: () => {},
    });
    return {
      view: v,
      blits: () => blits,
      clears: () => clears,
      clipped: () => clipped,
      reset: () => void ((blits = 0), (clears = 0), (clipped = 0)),
      press: (id: number, x: number, y: number) =>
        canvas.dispatchEvent(pointer("pointerdown", id, x, y)),
      lift: (id: number, x: number, y: number) =>
        canvas.dispatchEvent(pointer("pointerup", id, x, y)),
      /** Present a whole surface, then make sure it has been drawn. */
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

  it("paints every key the first time, because nothing is known yet", () => {
    // The constructor lays out and paints, so the surface is already
    // complete before a script presents anything.
    const c = counting();
    expect(c.blits(), "128 cells, none of them drawn before").toBe(128);
    c.reset();
    c.present(() => 0);
    expect(c.blits(), "and presenting the same dark surface changes nothing").toBe(0);
  });

  it("blits nothing at all when a refresh changes nothing", () => {
    const c = counting();
    c.present(() => 4);
    c.reset();
    c.present(() => 4); // the same surface again, as `g:refresh()` sends it
    expect(c.blits()).toBe(0);
    expect(c.clears(), "and the canvas is not touched either").toBe(0);
  });

  it("paints one changed key and its neighbours, not the whole surface", () => {
    const c = counting();
    c.present(() => 0);
    c.reset();
    // One cell, in the middle, where its ring is not clipped by an edge.
    c.present((i) => (i === 5 * 16 + 8 ? 15 : 0));
    // A 5x5 ring around one cell: the changed key, plus the two cells
    // around it that a glow can reach.
    expect(c.blits()).toBe(25);
    expect(c.blits()).toBeLessThan(128);
  });

  it("clips to the region it clears, or a glow would be composited twice", () => {
    const c = counting();
    c.present(() => 0);
    c.reset();
    c.present((i) => (i === 5 * 16 + 8 ? 15 : 0));
    expect(c.clipped(), "a partial repaint must be clipped").toBe(1);
    expect(c.clears(), "one region, cleared once").toBe(1);
  });

  it("paints the whole surface when the intensity changes all of them", () => {
    const c = counting();
    c.present(() => 7);
    c.reset();
    c.view.ledIntensity(5);
    c.view.flush();
    expect(c.blits(), "every key is a different key now").toBe(128);
  });

  // A held key is drawn differently at the SAME level, so the record of
  // what was drawn has to carry the press as well as the brightness.
  // Carrying only the level would leave the ring on screen after the
  // finger lifted, which is the bug this test exists for.
  it("notices a key that is held, not only one that is lit", () => {
    const c = counting();
    c.present(() => 0);
    c.reset();
    c.press(1, 10, 10);
    c.view.flush();
    const afterDown = c.blits();
    expect(afterDown, "the pressed cell and its ring").toBeGreaterThan(0);
    expect(afterDown, "and not the whole surface").toBeLessThan(128);
    c.reset();
    c.lift(1, 10, 10);
    c.view.flush();
    expect(c.blits(), "the ring has to be taken off again").toBeGreaterThan(0);
  });
});
