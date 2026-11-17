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
