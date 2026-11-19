// E5-01 / E5-03 / E5-05 — the on-screen grid: a transport that is a canvas.
//
// It is a `GridTransport` like any other, which is the point: the device
// does not know it is being drawn rather than lit, and a WebSocket grid or a
// real one over Web Serial attaches beside it with no change above.
//
// ONE CANVAS, NOT 256 ELEMENTS. Cells are hit-tested arithmetically. 256 DOM
// nodes restyled on every present is work this does not need to do, and the
// project already renders norns' screen to a canvas. The cost is the
// accessibility tree, which a playing surface of unlabelled pads would not
// have given anyone anyway.
//
// IT REDRAWS ON PRESENT, NOT ON A FRAME. `ledLevelMap` arrives only from
// `refresh()`, so an idle script costs nothing and a 60 fps one costs sixty
// redraws. There is no animation loop here.

import { alphaFor, quantise } from "./ramp.js";
import type { GridDescriptor, GridTransport } from "./device.js";
import { timed } from "../norns/call-cost.js";

export interface GridViewOptions {
  readonly canvas: HTMLCanvasElement;
  readonly descriptor: GridDescriptor;
  /** Device-space key, 0-based, straight to `GridDevice.key`. */
  readonly onKey: (x: number, y: number, state: 0 | 1) => void;
  /** How wide the surface currently is — `GridDevice.cols()`, rotation included. */
  readonly cols: () => number;
  readonly rows: () => number;
}

/** Pads are square, with a gap that scales with them. */
const GAP_RATIO = 0.12;

export class GridView implements GridTransport {
  readonly descriptor: GridDescriptor;
  private readonly ctx: CanvasRenderingContext2D;
  /** What has been presented. Written only by `ledLevelMap`. */
  private readonly levels: Uint8Array;
  private intensity = 15;
  /** Pointer id → the cell it is currently holding, for slide and for loss. */
  private readonly held = new Map<number, number>();
  /** Cells held by the latch, which has no hardware analogue. */
  private readonly latched = new Set<number>();
  private cell = 0;
  private originX = 0;
  private originY = 0;
  /**
   * One handle on every listener this view owns.
   *
   * A view is REPLACED, not mutated, when the grid changes size or rotates:
   * `GridDevice` reads its shape once, so the honest move is a new device and
   * a new view. That makes disposal load-bearing rather than hygiene -- the
   * canvas is the same element, so an old view left attached keeps answering
   * pointer events and sends keys to the device that was removed. The symptom
   * is `grid.key: no entry for grid 1` from `core/grid.lua`, and the key
   * arrives twice.
   */
  private readonly ac = new AbortController();

  constructor(private readonly opts: GridViewOptions) {
    this.descriptor = opts.descriptor;
    const ctx = opts.canvas.getContext("2d");
    if (ctx === null) throw new Error("grid view: no 2d context");
    this.ctx = ctx;
    this.levels = new Uint8Array(opts.descriptor.rows * opts.descriptor.cols);
    this.attachPointer();
    this.layout();
  }

  // --- GridTransport ----------------------------------------------------

  /**
   * One presented quad.
   *
   * Device space and the view's space are the same frame: matron works in
   * the user frame and `GridDevice` lays its surface out at the rotated
   * width, so there is no rotation arithmetic here. See
   * `GridDevice.copyQuadToLinear`.
   */
  ledLevelMap(xOff: number, yOff: number, levels: Uint8Array): void {
    const w = this.opts.cols();
    const h = this.opts.rows();
    for (let i = 0; i < 64; i++) {
      const x = xOff + (i & 7);
      const y = yOff + (i >> 3);
      if (x >= w || y >= h) continue;
      this.levels[y * w + x] = levels[i]!;
    }
    this.draw();
  }

  ledIntensity(level: number): void {
    this.intensity = level;
    this.draw();
  }

  // --- geometry ---------------------------------------------------------

  /**
   * Size the canvas to its box and work out the cell size.
   *
   * Called on construction, on resize, and whenever the surface changes
   * shape. The canvas backing store is in device pixels so the pads have
   * crisp edges on a scaled display; the CSS size is whatever the layout
   * gave it, and the whole grid is centred in it.
   */
  layout(): void {
    const canvas = this.opts.canvas;
    const w = this.opts.cols();
    const h = this.opts.rows();
    const dpr = globalThis.devicePixelRatio ?? 1;
    const boxW = canvas.clientWidth || canvas.width;
    const boxH = canvas.clientHeight || canvas.height;
    canvas.width = Math.max(1, Math.round(boxW * dpr));
    canvas.height = Math.max(1, Math.round(boxH * dpr));

    // Square cells, so a 16x8 grid in a wide box is limited by its height.
    this.cell = Math.floor(Math.min(canvas.width / w, canvas.height / h));
    this.originX = Math.floor((canvas.width - this.cell * w) / 2);
    this.originY = Math.floor((canvas.height - this.cell * h) / 2);
    this.draw();
  }

  /** Canvas pixel → cell index, or -1 outside the surface. */
  private cellAt(px: number, py: number): number {
    if (this.cell <= 0) return -1;
    const x = Math.floor((px - this.originX) / this.cell);
    const y = Math.floor((py - this.originY) / this.cell);
    if (x < 0 || y < 0 || x >= this.opts.cols() || y >= this.opts.rows()) return -1;
    return y * this.opts.cols() + x;
  }

  // --- drawing ----------------------------------------------------------

  /**
   * E9-149 — TIMED, because a log said the cost was not in Lua.
   *
   * 17 seconds of a pinned main thread on a Pixel, and the callback
   * account came to 978 ms of it — under six per cent. What is left is
   * drawing, and this is one of the two places it happens: a grid redraw
   * runs once per `refresh()`, so a script at 60 fps draws 256 rounded
   * rectangles sixty times a second.
   *
   * `timed` is `call-cost.ts`, the same accounting the Lua callbacks use,
   * so the line that reports a busy span names this beside them instead
   * of leaving a hole where the answer should be.
   */
  private draw(): void {
    timed("draw:grid", () => this.drawNow());
  }

  private drawNow(): void {
    const ctx = this.ctx;
    const canvas = this.opts.canvas;
    const w = this.opts.cols();
    const h = this.opts.rows();
    const c = this.cell;
    const gap = Math.max(1, Math.round(c * GAP_RATIO));
    const pad = c - gap;
    // A monome key is a rounded square, not a square: the silicone is moulded
    // with a generous corner and that shape is most of what you recognise.
    const r = pad * 0.22;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const level = quantise(this.levels[i] ?? 0, this.descriptor.varibright);
        const px = this.originX + x * c;
        const py = this.originY + y * c;
        const down = this.latched.has(i) || [...this.held.values()].includes(i);
        this.key(px, py, pad, r, alphaFor(level, this.intensity), down);
      }
    }
  }

  /**
   * One key: a translucent white silicone pad, domed, with the LED under it.
   *
   * THE PAD IS DRAWN EVEN WHEN DARK, and not as a black square. On the
   * hardware the keys are pale translucent silicone sitting proud of a pale
   * aluminium plate — an unlit grid is light, not dark, and the thing you see
   * is the relief of 128 little cushions. The canvas is transparent so the
   * slab under it (index.html) is the plate.
   */
  private key(px: number, py: number, pad: number, r: number, alpha: number, down: boolean): void {
    const ctx = this.ctx;
    const round = (x: number, y: number, s: number, rad: number): void => {
      ctx.beginPath();
      // `roundRect` is not in every engine this might run in, and the path is
      // four arcs; writing them is cheaper than a feature test that lies.
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + s, y, x + s, y + s, rad);
      ctx.arcTo(x + s, y + s, x, y + s, rad);
      ctx.arcTo(x, y + s, x, y, rad);
      ctx.arcTo(x, y, x + s, y, rad);
      ctx.closePath();
    };

    // The shadow the cushion casts on the plate, which is what makes it sit
    // ON the surface rather than in it.
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.30)";
    ctx.shadowBlur = Math.max(1, pad * 0.12);
    ctx.shadowOffsetY = Math.max(1, pad * 0.06);
    round(px, py, pad, r);
    // THE DARK KEY IS NOT WHITE. It is a pale grey a shade above the plate,
    // and that is not a styling preference: the LED under it is white too,
    // so a key that starts at white has nowhere to go and the low levels --
    // which scripts use as a background layer under a bright foreground --
    // all collapse into the same bright square.
    ctx.fillStyle = "rgba(198, 196, 190, 0.95)";
    ctx.fill();
    ctx.restore();

    // The dome. Light comes from the upper left, as it does in every monome
    // photograph, so the gradient runs from a bright corner to a dim one.
    const dome = ctx.createLinearGradient(px, py, px + pad, py + pad);
    dome.addColorStop(0, "rgba(255, 255, 255, 0.42)");
    dome.addColorStop(0.5, "rgba(255, 255, 255, 0.04)");
    dome.addColorStop(1, "rgba(140, 138, 132, 0.28)");
    round(px, py, pad, r);
    ctx.fillStyle = dome;
    ctx.fill();

    // The LED, under the silicone. It is white and it SPILLS: the diffuser is
    // the key itself, so a lit pad is brightest in the middle and glows a
    // little past its own edge.
    if (alpha > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(255, 250, 238, ${(alpha * 0.9).toFixed(3)})`;
      ctx.shadowBlur = pad * (0.22 + alpha * 0.5);
      const lit = ctx.createRadialGradient(
        px + pad * 0.5,
        py + pad * 0.46,
        pad * 0.06,
        px + pad * 0.5,
        py + pad * 0.5,
        pad * 0.72,
      );
      lit.addColorStop(0, `rgba(255, 253, 247, ${alpha.toFixed(3)})`);
      lit.addColorStop(0.62, `rgba(255, 249, 236, ${(alpha * 0.88).toFixed(3)})`);
      lit.addColorStop(1, `rgba(252, 240, 222, ${(alpha * 0.66).toFixed(3)})`);
      round(px, py, pad, r);
      ctx.fillStyle = lit;
      ctx.fill();
      ctx.restore();
    }

    // The rim: bright along the top edge where the silicone catches the
    // light, dark along the bottom where it meets the plate.
    round(px + 0.5, py + 0.5, pad - 1, r);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
    ctx.lineWidth = Math.max(1, pad * 0.045);
    ctx.stroke();

    // A held pad gets an OUTLINE, not a brightness change: the brightness
    // belongs to the script, and overwriting it would hide what the script is
    // doing at exactly the moment you are playing it. On a pale key the ring
    // has to be dark to be visible, lit or not.
    if (down) {
      const inset = Math.max(1, pad * 0.1);
      round(px + inset, py + inset, pad - inset * 2, Math.max(1, r - inset * 0.5));
      ctx.strokeStyle = "rgba(38, 38, 44, 0.55)";
      ctx.lineWidth = Math.max(1, pad * 0.07);
      ctx.stroke();
    }
  }

  // --- input ------------------------------------------------------------

  private attachPointer(): void {
    const canvas = this.opts.canvas;
    const signal = this.ac.signal;
    canvas.style.touchAction = "none"; // or the browser scrolls instead

    const toCell = (e: PointerEvent): number => {
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / (r.width || 1);
      return this.cellAt((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
    };

    canvas.addEventListener("pointerdown", (e) => {
      const i = toCell(e);
      if (i < 0) return;
      // Capture so a finger that leaves the canvas still reports its lift.
      // It can throw — a pointer id the browser does not recognise raises
      // NotFoundError — and a throw here would swallow the key press
      // itself. Capture is an improvement to the drag, not a precondition
      // for the pad working.
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* uncapturable pointer; the pad still plays */
      }
      e.preventDefault();

      // The latch has no hardware analogue, and it is a modifier rather than
      // a mode so that one pointer can build a chord for a script that wants
      // several keys at once. Shift-click toggles; everything else plays.
      if (e.shiftKey) {
        if (this.latched.has(i)) {
          this.latched.delete(i);
          this.send(i, 0);
        } else {
          this.latched.add(i);
          this.send(i, 1);
        }
        this.draw();
        return;
      }
      this.held.set(e.pointerId, i);
      this.send(i, 1);
      this.draw();
    }, { signal });

    canvas.addEventListener("pointermove", (e) => {
      const from = this.held.get(e.pointerId);
      if (from === undefined) return;
      const to = toCell(e);
      if (to === from) return;
      // SLIDE IS FAITHFUL. On hardware each pad is its own switch, so a
      // finger dragged across them really does lift one and press the next.
      this.send(from, 0);
      if (to >= 0) {
        this.held.set(e.pointerId, to);
        this.send(to, 1);
      } else {
        this.held.delete(e.pointerId);
      }
      this.draw();
    }, { signal });

    const release = (e: PointerEvent): void => {
      const i = this.held.get(e.pointerId);
      if (i === undefined) return;
      this.held.delete(e.pointerId);
      this.send(i, 0);
      this.draw();
    };
    canvas.addEventListener("pointerup", release, { signal });
    // `pointercancel` is the one that matters: a touch that becomes a
    // system gesture never sends `pointerup`, and the key would be held for
    // ever — a stuck note in whatever the script was doing.
    canvas.addEventListener("pointercancel", release, { signal });

    const releaseAll = (): void => {
      if (this.held.size === 0) return;
      for (const i of this.held.values()) this.send(i, 0);
      this.held.clear();
      this.draw();
    };
    globalThis.addEventListener?.("blur", releaseAll, { signal });
    globalThis.document?.addEventListener(
      "visibilitychange",
      () => {
        if (globalThis.document?.hidden) releaseAll();
      },
      { signal },
    );
  }

  private send(index: number, state: 0 | 1): void {
    const w = this.opts.cols();
    this.opts.onKey(index % w, Math.floor(index / w), state);
  }

  /**
   * Let go of the canvas for good.
   *
   * Lifts anything still held FIRST, because the listeners are about to stop
   * answering and a pad released after the abort would never report its lift
   * -- a stuck key in whatever the script was doing.
   */
  dispose(): void {
    this.releaseAll();
    this.ac.abort();
  }

  /** Let go of everything, for a script change or a resize. */
  releaseAll(): void {
    for (const i of this.held.values()) this.send(i, 0);
    for (const i of this.latched) this.send(i, 0);
    this.held.clear();
    this.latched.clear();
    this.draw();
  }
}
