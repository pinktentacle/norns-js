/**
 * E9-163 — HOW MANY PIXELS THE PLAYING SURFACES ARE WORTH.
 *
 * A canvas backing store is sized in DEVICE pixels, so a surface laid out
 * at 390 CSS pixels wide on a Pixel 9 Pro — `devicePixelRatio` about 2.6 —
 * is rasterised at a bit over a thousand. The cost of every fill, every
 * blit and every composite is in those pixels, and it is the SQUARE of
 * the ratio: 2.6 against 2.0 is not thirty per cent more work, it is
 * seventy.
 *
 * THE SURFACES THIS APPLIES TO ARE PADS AND RINGS. A monome key is a
 * rounded square with a soft shadow and no detail finer than its own
 * corner radius; an arc ring is a band of light. Neither carries text or
 * a hairline, which are the things that actually show a difference
 * between 2x and 2.6x. Capping them is the trade the user asked for on
 * 2026-11-20 — graphics may be less pretty if it buys responsiveness —
 * except that at this ratio there is no "less pretty" to see.
 *
 * NOT THE NORNS SCREEN. That canvas is 128x64 backing pixels scaled by a
 * whole number, so its sharpness IS the integer scale and capping the
 * ratio would blur the one surface in the project whose pixels are
 * meant to be visible. `ui/canvas.ts` keeps the real ratio on purpose.
 *
 * TWO, AND NOT ONE. A ratio of 1 on a phone is visibly soft on a rounded
 * edge — the keys get a stepped corner — and the gain from 2 to 1 is
 * another four times less area, which is not needed if 2 is already
 * enough. If it is not, this is the one number to change.
 */
export const MAX_DRAWING_RATIO = 2;

/**
 * The device pixel ratio to rasterise a playing surface at.
 *
 * `?dpr=` overrides it, because the only way to find out what a ratio
 * costs on a particular phone is to run that phone at two of them, and
 * the person holding it cannot rebuild the page.
 */
export function drawingRatio(search?: string): number {
  const real = globalThis.devicePixelRatio ?? 1;
  const query = search ?? globalThis.location?.search ?? "";
  const asked = new URLSearchParams(query).get("dpr");
  if (asked !== null) {
    const n = Number(asked.trim());
    // A ratio of zero or less is a canvas with no pixels in it, and
    // anything past the device's own is upscaling a surface to no end.
    if (Number.isFinite(n) && n > 0) return Math.min(n, real);
  }
  return Math.min(real, MAX_DRAWING_RATIO);
}
