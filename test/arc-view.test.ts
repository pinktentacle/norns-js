// E9-207 — the on-screen arc paints once a frame, and not at all for nothing.
//
// It used to paint from inside `ledRingMap` — every ring, whole — and
// `ArcDevice.refresh()` calls `ledRingMap` once per ring, so a script lighting
// all four rings painted the instrument four times for one picture, and
// painted it again for a frame identical to the last. The grid's view has
// done neither since E9-199; this is the same rule for the arc.
//
// What is counted here is PAINTS, on a canvas that renders nothing: the
// picture itself is checked in the page, where there is one.

import { describe, expect, it } from "vitest";
import { ArcDevice, LEDS, RINGS, type ArcDescriptor } from "../src/arc/device.js";
import { ArcView, REPAINT_AFTER_MS } from "../src/arc/view.js";

const desc: ArcDescriptor = { serial: "v0001", name: "monome arc 4" };

interface Counts {
  clears: number;
  /** Lit LEDs painted with their glow, straight onto the canvas. */
  glows: number;
  strokes: number;
}

class FakeCanvas extends EventTarget {
  width = 800;
  height = 220;
  clientWidth = 800;
  clientHeight = 220;
  readonly style: Record<string, string> = {};
  readonly counts: Counts = { clears: 0, glows: 0, strokes: 0 };

  getContext(kind: string): unknown {
    if (kind !== "2d") return null;
    const counts = this.counts;
    const gradient = { addColorStop: () => {} };
    const ctx = {
      fillStyle: "" as unknown,
      strokeStyle: "" as unknown,
      lineWidth: 0,
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      save: () => {},
      restore: () => void (ctx.shadowBlur = 0),
      beginPath: () => {},
      closePath: () => {},
      arc: () => {},
      // A fill under a blur and in the LEDs' own white is a lit LED.
      fill: () => {
        if (ctx.shadowBlur > 0 && String(ctx.fillStyle).startsWith("rgba(255, 251, 240")) counts.glows++;
      },
      stroke: () => void counts.strokes++,
      clearRect: () => void counts.clears++,
      setTransform: () => {},
      drawImage: () => {},
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
    };
    return ctx;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  setPointerCapture(): void {}
}

function arc(opts: { frame?: boolean } = {}) {
  const canvas = new FakeCanvas();
  const frames: (() => void)[] = [];
  let t = 0;
  const view = new ArcView({
    canvas: canvas as unknown as HTMLCanvasElement,
    descriptor: desc,
    onDelta: () => {},
    onKey: () => {},
    now: () => t,
    ...(opts.frame === false ? {} : { frame: (cb: () => void) => void frames.push(cb) }),
  });
  const device = new ArcDevice(0, desc, { delta: () => {}, key: () => {} });
  device.addTransport(view);
  const runFrames = (): number => {
    const due = frames.splice(0);
    for (const f of due) f();
    return due.length;
  };
  runFrames();
  // What the construction and the first picture cost is not what is measured.
  canvas.counts.clears = 0;
  canvas.counts.glows = 0;
  const base = view.stats();
  return {
    canvas,
    view,
    device,
    frames,
    runFrames,
    advance: (ms: number) => void (t += ms),
    drawn: () => view.stats().drawn - base.drawn,
    skipped: () => view.stats().skipped - base.skipped,
  };
}

/** What a script does every frame: clear, light, refresh. */
function redraw(device: ArcDevice, at: number): void {
  device.allLed(0, false);
  for (let ring = 0; ring < RINGS; ring++) {
    for (let i = 0; i < 8; i++) device.setLed(ring, (at + i) % LEDS, 15, false);
  }
  device.refresh();
}

describe("the arc on screen", () => {
  it("paints once for a refresh that changes all four rings", () => {
    const a = arc();
    redraw(a.device, 0);
    // Four ring maps arrived; nothing has been painted yet, and one frame is asked for.
    expect(a.drawn()).toBe(0);
    expect(a.frames).toHaveLength(1);
    a.runFrames();
    expect(a.drawn()).toBe(1);
    expect(a.canvas.counts.clears).toBe(1);
    // 4 rings x 8 lit LEDs, each painted once — it used to be four times.
    expect(a.canvas.counts.glows).toBe(32);
  });

  it("does not paint a frame that is the one before", () => {
    // `a:all(0)`, light the same LEDs, `a:refresh()` — every ring is
    // touched, so every ring is sent, and nothing has changed.
    const a = arc();
    redraw(a.device, 0);
    a.runFrames();
    for (let i = 0; i < 30; i++) redraw(a.device, 0);
    expect(a.frames).toHaveLength(0);
    expect(a.drawn()).toBe(1);
    expect(a.skipped()).toBe(30 * RINGS);
  });

  it("paints when one LED of one ring changes", () => {
    const a = arc();
    redraw(a.device, 0);
    a.runFrames();
    a.device.setLed(2, 40, 9, false);
    a.device.refresh();
    expect(a.runFrames()).toBe(1);
    expect(a.drawn()).toBe(2);
  });

  it("paints an unchanged frame once a second has gone by, and no sooner", () => {
    // A picture the browser dropped without saying so must not stay wrong.
    const a = arc();
    redraw(a.device, 0);
    a.runFrames();
    a.advance(REPAINT_AFTER_MS - 1);
    redraw(a.device, 0);
    expect(a.runFrames()).toBe(0);
    a.advance(1);
    redraw(a.device, 0);
    expect(a.runFrames()).toBe(1);
    expect(a.drawn()).toBe(2);
  });

  it("keeps up with a script that never repeats itself", () => {
    const a = arc();
    for (let k = 0; k < 10; k++) {
      redraw(a.device, k);
      a.runFrames();
    }
    expect(a.drawn()).toBe(10);
    expect(a.skipped()).toBe(0);
  });

  it("takes several refreshes inside one frame as one picture, the last", () => {
    const a = arc();
    redraw(a.device, 0);
    redraw(a.device, 1);
    redraw(a.device, 2);
    expect(a.frames).toHaveLength(1);
    a.runFrames();
    expect(a.drawn()).toBe(1);
    expect(a.canvas.counts.glows).toBe(32);
  });

  it("repaints for a new intensity, and not for the same one again", () => {
    const a = arc();
    redraw(a.device, 0);
    a.runFrames();
    a.device.intensity(8);
    expect(a.runFrames()).toBe(1);
    a.device.intensity(8);
    expect(a.runFrames()).toBe(0);
    expect(a.drawn()).toBe(2);
  });

  it("paints at once after a layout, which has just cleared the canvas", () => {
    const a = arc();
    redraw(a.device, 0);
    a.runFrames();
    a.view.layout();
    expect(a.drawn()).toBe(2);
    expect(a.frames).toHaveLength(0);
  });

  it("paints again when the browser hands the canvas back", () => {
    const a = arc();
    redraw(a.device, 0);
    a.runFrames();
    a.canvas.dispatchEvent(new Event("contextrestored"));
    expect(a.drawn()).toBe(2);
  });

  it("shows a pressed knob without waiting for the script", () => {
    const a = arc();
    const before = a.canvas.counts.strokes;
    const down = Object.assign(new Event("pointerdown"), { pointerId: 1, clientX: 100, clientY: 110 });
    a.canvas.dispatchEvent(down);
    expect(a.runFrames()).toBe(1);
    // The knob's own lines, and one more for the ring that is held.
    const pressed = a.canvas.counts.strokes - before;
    a.canvas.dispatchEvent(Object.assign(new Event("pointerup"), { pointerId: 1, clientX: 100, clientY: 110 }));
    const mid = a.canvas.counts.strokes;
    expect(a.runFrames()).toBe(1);
    expect(pressed - (a.canvas.counts.strokes - mid)).toBe(1);
  });

  it("draws at once where there are no frames to ask for", () => {
    const a = arc({ frame: false });
    redraw(a.device, 0);
    // No requestAnimationFrame in this runtime: each changed ring paints.
    expect(a.drawn()).toBeGreaterThan(0);
  });

  it("stops painting once it is disposed", () => {
    const a = arc();
    redraw(a.device, 0);
    a.view.dispose();
    a.runFrames();
    expect(a.drawn()).toBe(0);
  });
});
