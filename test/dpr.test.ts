// E9-163 — how many pixels a playing surface is worth.
//
// A canvas backing store is sized in DEVICE pixels, and the cost of
// every fill, blit and composite is the SQUARE of the ratio: a Pixel 9
// Pro at about 2.6 against a cap of 2 is not thirty per cent more work,
// it is seventy. A monome key is a rounded square with a soft shadow
// and nothing finer than its own corner, so there is no detail there to
// lose — which is why this is the cheapest half of the trade the user
// asked for: looks may go if responsiveness comes back.

import { afterEach, describe, expect, it } from "vitest";
import { drawingRatio, MAX_DRAWING_RATIO } from "../src/ui/dpr.js";

const real = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
function device(ratio: number): void {
  Object.defineProperty(globalThis, "devicePixelRatio", { value: ratio, configurable: true });
}
afterEach(() => {
  if (real) Object.defineProperty(globalThis, "devicePixelRatio", real);
  else delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
});

describe("the ratio a pad is drawn at", () => {
  it("caps a phone's ratio", () => {
    device(2.625); // a Pixel 9 Pro
    expect(drawingRatio("")).toBe(MAX_DRAWING_RATIO);
  });

  it("leaves a ratio that is already under the cap alone", () => {
    device(1.25);
    expect(drawingRatio("")).toBe(1.25);
  });

  it("never upscales past the device, whatever is asked for", () => {
    // A surface rasterised above the device's own ratio is pixels nobody
    // can see, paid for in full.
    device(2);
    expect(drawingRatio("?dpr=4")).toBe(2);
  });

  it("takes an override, because a phone cannot be rebuilt in the field", () => {
    device(3);
    expect(drawingRatio("?dpr=1")).toBe(1);
    expect(drawingRatio("?dpr=1.5")).toBe(1.5);
  });

  it("ignores an override that would leave the canvas with no pixels", () => {
    device(2.625);
    expect(drawingRatio("?dpr=0")).toBe(MAX_DRAWING_RATIO);
    expect(drawingRatio("?dpr=-2")).toBe(MAX_DRAWING_RATIO);
    expect(drawingRatio("?dpr=wide")).toBe(MAX_DRAWING_RATIO);
  });

  it("answers 1 on something with no ratio at all", () => {
    delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
    expect(drawingRatio("")).toBe(1);
  });
});
