// E9-61 — one zoom, for the whole page.
//
// It used to scale the devices on the stage and nothing else: the rail, the
// panels and maiden stayed the size they were, so a person who made the
// norns bigger still read the editor at the size it came. It is the page's
// own zoom now — `zoom` on the document root, which is a LAYOUT scale, so
// hit testing, scrolling and text rendering all follow it.
//
// Two things have to hold for that to be an improvement rather than a
// trade, and both are arithmetic:
//
//   1. the 128×64 screen still lands on whole device pixels, or the
//      browser resamples pixel art and the whole of `canvas.ts` is undone;
//   2. a placement the user arranged is stored in layout pixels, which
//      means the same thing at every zoom — the stage must NOT multiply by
//      the zoom any more, or the page scale and the device scale compound.

import { describe, expect, it } from "vitest";
import { cssPixels, fitScale, SCREEN_W, SCREEN_H } from "../src/ui/canvas.js";
import { createSettings, ZOOM_MIN, ZOOM_MAX } from "../src/ui/settings.js";

/** A store with no storage behind it: the zoom still clamps and reports. */
const store = (): ReturnType<typeof createSettings> => createSettings(null);

describe("the screen under a page zoom", () => {
  it("divides the zoom back out, so the backing store is 1:1", () => {
    // A device pixel is `dpr × zoom` layout pixels. Whatever those are,
    // the visual size has to come back to exactly the backing store.
    for (const dpr of [1, 1.25, 2, 3]) {
      for (const zoom of [0.5, 1, 1.4, 1.5, 2.5]) {
        const scale = 4;
        const css = cssPixels(scale, dpr, zoom);
        expect(css.w * dpr * zoom).toBeCloseTo(SCREEN_W * scale, 6);
        expect(css.h * dpr * zoom).toBeCloseTo(SCREEN_H * scale, 6);
      }
    }
  });

  it("is the old arithmetic exactly when the page is not zoomed", () => {
    expect(cssPixels(4, 2)).toEqual({ w: (SCREEN_W * 4) / 2, h: (SCREEN_H * 4) / 2 });
    expect(cssPixels(4, 2, 1)).toEqual(cssPixels(4, 2));
  });

  it("takes a bigger whole scale as the box grows, which is why it stays crisp", () => {
    // `getBoundingClientRect` reports the ZOOMED box, so the device pixels
    // available grow with the zoom and the integer scale grows with them.
    const box = 300; // layout px of container width
    const dpr = 1.25;
    const at = (zoom: number): number => fitScale(box * zoom * dpr, 400 * zoom * dpr);
    expect(at(1)).toBe(2);
    expect(at(2)).toBe(5);
    expect(at(1)).toBeLessThan(at(2));
  });

  it("refuses a zero or negative ratio rather than dividing by it", () => {
    expect(Number.isFinite(cssPixels(4, 0, 0).w)).toBe(true);
    expect(cssPixels(4, 0, 0).w).toBeGreaterThan(0);
  });
});

describe("the zoom setting itself", () => {
  it("clamps to the range the bars offer", () => {
    const s = store();
    s.setZoom(99);
    expect(s.zoom).toBe(ZOOM_MAX);
    s.setZoom(-1);
    expect(s.zoom).toBe(ZOOM_MIN);
  });

  it("tells everyone, which is how two bars stay one number", () => {
    // The rail's panel and the display tab both read and write this, and
    // neither knows about the other.
    const s = store();
    const seen: number[] = [];
    s.subscribe((st, what) => {
      if (what === "zoom") seen.push(st.zoom);
    });
    s.setZoom(1.4);
    s.setZoom(1);
    expect(seen).toEqual([1.4, 1]);
  });

  it("survives the percent-and-back of a slider without drifting", () => {
    // Both bars are integer percents; a round trip must not leave 1.3999.
    const s = store();
    for (let pct = Math.round(ZOOM_MIN * 100); pct <= Math.round(ZOOM_MAX * 100); pct += 5) {
      s.setZoom(pct / 100);
      expect(Math.round(s.zoom * 100)).toBe(pct);
    }
  });
});
