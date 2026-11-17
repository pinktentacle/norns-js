// E2-03 — put the 128x64 screen on a canvas, crisply.
//
// The whole difficulty is that 128x64 is tiny and everything a browser does by
// default to make a small image bigger is wrong for it. Three rules:
//
//   1. **Integer scale only.** At 3.7x, some source pixels cover 4 device
//      pixels and some cover 3, so a one-pixel line is thicker in places. The
//      norns UI is built out of one-pixel lines.
//   2. **No smoothing.** `imageSmoothingEnabled = false` on the destination
//      context, or the browser interpolates and the result is a blur of a
//      display whose entire character is that it is not blurry.
//   3. **Scale from a backing canvas, not from ImageData.** `putImageData`
//      ignores the transform entirely — it writes device pixels. So the frame
//      goes into a 128x64 backing canvas and that is drawn scaled.
//
// Device pixel ratio is handled by sizing the canvas in device pixels and
// letting CSS size it in layout pixels, so a 2x display gets 2x the scale
// rather than a scaled-up blur of a 1x rendering.

export const SCREEN_W = 128;
export const SCREEN_H = 64;

export interface PanelState {
  /** 0-15, what a script asked for. */
  brightness: number;
  /** 0-255. */
  contrast: number;
  gamma: number;
  inverted: boolean;
}

/**
 * The largest integer scale that fits, in device pixels.
 *
 * Integer only, and never zero. At 3.7x some source pixels would cover four
 * device pixels and others three, so a one-pixel line comes out thicker in
 * places — and the norns UI is built out of one-pixel lines. Below 1x there
 * is nothing sensible to do, so 1 is the floor and the screen overflows its
 * box rather than losing pixels.
 */
export function fitScale(availW: number, availH: number, maxScale = 0): number {
  const s = Math.min(Math.floor(availW / SCREEN_W), Math.floor(availH / SCREEN_H));
  const clamped = Math.max(1, Number.isFinite(s) ? s : 1);
  return maxScale > 0 ? Math.min(clamped, maxScale) : clamped;
}

/**
 * The CSS size, in layout pixels, for a backing store of `SCREEN_* × scale`.
 *
 * E9-61. A layout pixel under `zoom: 1.5` is one and a half of the pixels
 * the compositor draws, so the zoom divides out here or the browser
 * resamples 128x64 pixel art — the one thing this file exists to prevent.
 * Exported because it is the whole of the arithmetic and a canvas is a
 * clumsy place to test it.
 */
export function cssPixels(scale: number, dpr: number, zoom = 1): { w: number; h: number } {
  const eff = Math.max(0.1, dpr) * Math.max(0.1, zoom);
  return { w: (SCREEN_W * scale) / eff, h: (SCREEN_H * scale) / eff };
}

export interface CanvasOptions {
  /**
   * The lit colour, as [r, g, b]. norns' OLED is white; this is a parameter
   * rather than a constant because the panel colour is a property of the
   * hardware someone owns, not of norns.
   */
  colour?: readonly [number, number, number];
  /** Maximum integer scale. 0 or undefined means "as large as it fits". */
  maxScale?: number;
  /**
   * E9-61 — the page's own zoom, read fresh.
   *
   * The CSS size below is in LAYOUT pixels, and a layout pixel under
   * `zoom: 1.5` is one and a half of the pixels the compositor draws. The
   * available width measures right either way — `getBoundingClientRect`
   * reports the zoomed box — so the scale chosen is correct and only the
   * size written back would be one zoom too big, which is the browser
   * resampling 128x64 pixel art. Divided out here, the backing store lands
   * 1:1 on the device at every zoom.
   */
  zoom?: () => number;
}

export interface ScreenCanvas {
  readonly canvas: HTMLCanvasElement;
  /** Draw one frame from a 128*64 buffer of 4-bit levels. */
  draw(grey: Uint8Array, panel?: PanelState): void;
  /** Recompute the scale for the current container size. Returns the scale. */
  resize(): number;
  readonly scale: number;
  destroy(): void;
}

export function createScreenCanvas(
  container: HTMLElement,
  opts: CanvasOptions = {},
): ScreenCanvas {
  const colour = opts.colour ?? ([255, 255, 255] as const);

  const canvas = document.createElement("canvas");
  canvas.className = "norns-screen";
  // Crispness has to be asserted in CSS as well as in the 2D context: the
  // canvas is also scaled by the compositor when its backing size and its CSS
  // size differ, and that scaling is the browser's, not ours.
  canvas.style.imageRendering = "pixelated";
  canvas.style.display = "block";
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("no 2d context");

  // 128x64 backing store. putImageData ignores transforms, so the frame lands
  // here at 1:1 and is then drawn scaled.
  const backing = document.createElement("canvas");
  backing.width = SCREEN_W;
  backing.height = SCREEN_H;
  const bctx = backing.getContext("2d", { alpha: false });
  if (!bctx) throw new Error("no 2d context for the backing canvas");
  const frame = bctx.createImageData(SCREEN_W, SCREEN_H);

  let scale = 1;

  const resize = (): number => {
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    // Device pixels available, then the largest integer scale that fits.
    const availW = Math.max(1, Math.floor(rect.width * dpr));
    const availH = Math.max(1, Math.floor(rect.height * dpr));
    const s = fitScale(availW, availH, opts.maxScale ?? 0);
    scale = s;

    canvas.width = SCREEN_W * s;
    canvas.height = SCREEN_H * s;
    // CSS size in layout pixels so the backing store is 1:1 with the
    // device, zoom included — see `cssPixels`.
    const css = cssPixels(s, dpr, opts.zoom?.() ?? 1);
    canvas.style.width = `${css.w}px`;
    canvas.style.height = `${css.h}px`;
    ctx.imageSmoothingEnabled = false;
    return s;
  };

  resize();

  const draw = (grey: Uint8Array, panel?: PanelState): void => {
    // brightness 0-15 scales the lit colour. Upstream sends it to the panel's
    // pre-charge voltage, which is not a linear dimming, so this is an
    // approximation and is marked as one: E2 does not claim to reproduce the
    // OLED's response curve, only the pixel values that reach it.
    const b = panel ? (panel.brightness + 1) / 16 : 1;
    const invert = panel?.inverted ?? false;
    const data = frame.data;

    for (let i = 0, p = 0; p < grey.length; p++, i += 4) {
      const level = invert ? 15 - grey[p]! : grey[p]!;
      const v = (level / 15) * b;
      data[i] = colour[0] * v;
      data[i + 1] = colour[1] * v;
      data[i + 2] = colour[2] * v;
      data[i + 3] = 255;
    }
    bctx.putImageData(frame, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(backing, 0, 0, SCREEN_W, SCREEN_H, 0, 0, canvas.width, canvas.height);
  };

  const onResize = (): void => void resize();
  window.addEventListener("resize", onResize);

  return {
    canvas,
    draw,
    resize,
    get scale() {
      return scale;
    },
    destroy() {
      window.removeEventListener("resize", onResize);
      canvas.remove();
    },
  };
}
