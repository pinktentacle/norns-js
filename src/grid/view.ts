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
import { drawingRatio } from "../ui/dpr.js";
import type { GridDescriptor, GridTransport } from "./device.js";
import { recordCount, timed } from "../norns/call-cost.js";

export interface GridViewOptions {
  readonly canvas: HTMLCanvasElement;
  readonly descriptor: GridDescriptor;
  /** Device-space key, 0-based, straight to `GridDevice.key`. */
  readonly onKey: (x: number, y: number, state: 0 | 1) => void;
  /**
   * Ask for a frame. `requestAnimationFrame` unless a test supplies one,
   * and absent entirely in node — see `draw`.
   */
  readonly frame?: (fn: () => void) => void;
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
    if (level === this.intensity) return;
    this.intensity = level;
    // Intensity scales every alpha, so every sprite is now wrong.
    this.clearSprites();
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
    const dpr = drawingRatio();
    const boxW = canvas.clientWidth || canvas.width;
    const boxH = canvas.clientHeight || canvas.height;
    canvas.width = Math.max(1, Math.round(boxW * dpr));
    canvas.height = Math.max(1, Math.round(boxH * dpr));

    // Square cells, so a 16x8 grid in a wide box is limited by its height.
    this.cell = Math.floor(Math.min(canvas.width / w, canvas.height / h));
    this.originX = Math.floor((canvas.width - this.cell * w) / 2);
    this.originY = Math.floor((canvas.height - this.cell * h) / 2);
    // The sprites are sized by `cell`, so a new layout invalidates all of
    // them. Painted at once rather than next frame: this runs from the
    // constructor, and a grid that appears a frame late flickers in.
    this.clearSprites();
    this.dirty = true;
    this.flush();
  }

  /**
   * E9-157 / E9-162 — EVERY KEY IS A SPRITE, because there are only
   * thirty-two of them.
   *
   * A `?profile=90` from a Pixel 9 Pro playing `kolor`, after
   * `encodeMessage` was dealt with:
   *
   *     10.2% self   fill
   *      3.4% self   arcTo
   *      3.4% self   addColorStop
   *      1.8% self   save
   *      1.5% self   stroke
   *      1.2% self   createLinearGradient
   *      4.4% self   31.2% total   key
   *
   * A fifth of the page, and all of it in `key`. Every cell built its own
   * linear gradient with three stops, traced eight `arcTo` corners across
   * three paths, and filled and stroked them — sixty-four times a
   * refresh.
   *
   * E9-157 cached the UNLIT key, since most of a grid is dark and every
   * dark key is identical. The next profile said that was half an answer:
   * `kolor` lights most of its surface, `key` was still 19.8% self, and
   * the long way was still being taken for eighty keys out of a hundred
   * and twenty-eight.
   *
   * BUT A KEY HAS ONLY THIRTY-TWO APPEARANCES. What `key` draws is
   * decided entirely by `(pad, r, alpha, down)`, and `pad` and `r` come
   * from the layout: within one layout there are sixteen levels — the
   * grid quantises to them — times held or not. So all thirty-two are
   * rendered once, on demand, and the loop blits. Nothing is drawn the
   * long way at all any more, lit or dark.
   *
   * THE MARGIN IS THE GLOW, AND IT IS PER LEVEL. The cushion casts a
   * shadow past its own edge, and a LIT key spills much further —
   * `shadowBlur` of `pad * (0.22 + alpha * 0.5)`, which at full
   * brightness is most of a key again. A single margin big enough for
   * the brightest would make the common dark key six times its own area
   * to blit, so each sprite carries the margin ITS level needs.
   *
   * INVALIDATED BY LAYOUT AND BY INTENSITY, which are the only two other
   * things `key` reads. Rebuilding on demand rather than up front keeps
   * a script that uses three levels to three sprites.
   */
  private sprites: Array<{ img: HTMLCanvasElement; m: number } | null> = [];

  /**
   * What was last drawn into each cell, as the one number `spriteFor`
   * reduces a key to. -1 is "nothing yet". E9-163.
   */
  private drawn = new Int16Array(0);
  /** Set when the canvas cannot be trusted and the whole of it is repainted. */
  private everything = true;

  private clearSprites(): void {
    this.sprites = [];
    // Every cell now holds a picture that is no longer what its number
    // means, so the record of what was drawn is worthless too.
    this.drawn.fill(-1);
    this.everything = true;
  }

  /** The 32 appearances, built the first time each is actually asked for. */
  private spriteFor(level: number, down: boolean): { img: HTMLCanvasElement; m: number } | null {
    const i = level * 2 + (down ? 1 : 0);
    const got = this.sprites[i];
    // `null` is a remembered failure — no document, no context — and must
    // not be retried 128 times a refresh.
    if (got !== undefined) return got;
    const made = this.makeSprite(level, down);
    this.sprites[i] = made;
    return made;
  }

  private makeSprite(level: number, down: boolean): { img: HTMLCanvasElement; m: number } | null {
    const c = this.cell;
    if (c <= 0) return null;
    const gap = Math.max(1, Math.round(c * GAP_RATIO));
    const pad = c - gap;
    if (pad <= 0) return null;
    const r = pad * 0.22;
    const alpha = alphaFor(level, this.intensity);
    // What `key` can put outside the key: the cushion's own shadow, and
    // the LED's glow when there is one. Kept in step with `key` by being
    // written from the same two expressions.
    const spill = Math.max(pad * 0.2, alpha > 0 ? pad * (0.22 + alpha * 0.5) : 0);
    const m = Math.ceil(spill) + 2;
    const doc = this.opts.canvas.ownerDocument;
    if (!doc) return null;
    const off = doc.createElement("canvas");
    off.width = pad + m * 2;
    off.height = pad + m * 2;
    const octx = off.getContext("2d");
    if (!octx) return null;
    // The same routine, into the sprite's own origin — `key` takes its
    // context rather than reaching for the view's, so what is drawn here
    // and what it stands in for cannot drift apart.
    this.key(octx, m, m, pad, r, alpha, down);
    return { img: off, m };
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
  /**
   * E9-162 — ONE DRAW PER FRAME, NOT ONE PER QUAD.
   *
   * `GridDevice.refresh()` sends one `ledLevelMap` per DIRTY QUAD, and a
   * 16x8 grid is two quads. The universal script idiom is `g:all(0)`,
   * draw, `g:refresh()` — which dirties both. So every refresh redrew all
   * 128 keys TWICE, and a 256-key grid four times. Measured on the bench
   * at `spike/grid-bench.html`: `drawsPerRefresh: 2`.
   *
   * It also put the redraw rate under the script's control rather than
   * the display's. A script that refreshes faster than the screen can
   * show it — and a lattice-driven one does — paid for every one of
   * those frames, none of which was ever seen.
   *
   * So a present marks the canvas dirty and asks for a frame; the frame
   * draws once, whatever arrived in the meantime. That is both halves at
   * once: the quads of one refresh coalesce, and so do refreshes that
   * arrive faster than the display.
   *
   * `flush()` IS PUBLIC because a test and a bench need the draw to have
   * happened by the time they look, and because `layout()` must paint
   * synchronously — it runs from the constructor, and a canvas that is
   * blank until the next frame is a grid that flickers in on load.
   *
   * WITHOUT `requestAnimationFrame` IT DRAWS AT ONCE. Node has no rAF,
   * and the node tests draw into a stub context; a view that silently
   * stopped drawing there would pass every assertion by doing nothing.
   */
  private dirty = false;
  private scheduled = false;
  private disposed = false;

  private draw(): void {
    this.dirty = true;
    if (this.scheduled) return;
    const raf = this.opts.frame ?? globalThis.requestAnimationFrame?.bind(globalThis);
    if (raf === undefined) {
      this.flush();
      return;
    }
    this.scheduled = true;
    raf(() => {
      this.scheduled = false;
      if (!this.disposed) this.flush();
    });
  }

  /** Draw now if a present is still pending. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
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

    /**
     * E9-160 — THE HELD SET IS BUILT ONCE, not once per cell.
     *
     * This loop asked `[...this.held.values()].includes(i)` for every
     * cell: a fresh array from a Map, and a linear scan of it, 64 or 128
     * times per refresh — on a grid where `held` is empty unless a finger
     * is down, and never has more than a few entries when it is not.
     *
     * Allocating inside the inner loop of the thing you redraw sixty
     * times a second is the kind of line that reads fine and costs for
     * years. Found by looking at the loop the sprite work had just made
     * the fastest part of this file.
     */
    const heldNow = this.held.size === 0 ? null : new Set(this.held.values());

    /**
     * E9-163 — AND ONLY THE KEYS THAT CHANGED.
     *
     * One draw per frame still redrew all 128 keys. A sequencer changes
     * a handful between frames — a playhead moves one column, a pad
     * lights — and the other hundred and twenty are blitted identically
     * on top of themselves, sixty times a second.
     *
     * WHAT A KEY LOOKS LIKE IS ALREADY ONE NUMBER, because `spriteFor`
     * reduced it to thirty-two appearances. So the last one drawn into
     * each cell is remembered, and a cell whose number has not moved is
     * not touched.
     *
     * THE CLIP IS LOAD-BEARING, not an optimisation. A lit key's glow
     * spills past its own cell and over its neighbours, so repainting a
     * cell means repainting everything that draws into the region —
     * and a neighbour redrawn without clearing first would composite
     * its half-transparent glow over the copy already there and come
     * out brighter. Clipping to the cleared region makes that exact:
     * everything inside it is rebuilt from every contributor, and
     * nothing outside is touched at all.
     *
     * The spill is under one cell wide — the widest margin is
     * `ceil(pad * 0.72) + 2` against a cell of `pad / 0.88` — so the
     * contributors to a region are the changed cells and the ring
     * around them. The ring is taken at two cells for margin, and the
     * clip makes a ring that is too generous cost a few blits rather
     * than a wrong picture.
     */
    const key = (i: number): number => {
      const level = quantise(this.levels[i] ?? 0, this.descriptor.varibright);
      const down = this.latched.has(i) || (heldNow !== null && heldNow.has(i));
      return level * 2 + (down ? 1 : 0);
    };

    const n = w * h;
    if (this.drawn.length !== n) {
      this.drawn = new Int16Array(n).fill(-1);
      this.everything = true;
    }

    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    if (this.everything) {
      x0 = 0;
      y0 = 0;
      x1 = w - 1;
      y1 = h - 1;
    } else {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (this.drawn[i] === key(i)) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) return; // nothing moved; the canvas is already right
      // The ring that can draw into the region the changed cells occupy.
      x0 = Math.max(0, x0 - 2);
      y0 = Math.max(0, y0 - 2);
      x1 = Math.min(w - 1, x1 + 2);
      y1 = Math.min(h - 1, y1 + 2);
    }

    // The region that is about to be rebuilt, in canvas pixels, taken
    // past the cells themselves by the widest glow any of them can cast.
    const spill = Math.ceil(pad * 0.72) + 2;
    const rx = this.originX + x0 * c - spill;
    const ry = this.originY + y0 * c - spill;
    const rw = (x1 - x0 + 1) * c + spill * 2;
    const rh = (y1 - y0 + 1) * c + spill * 2;

    const whole = this.everything;
    this.everything = false;
    if (whole) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      ctx.clearRect(rx, ry, rw, rh);
    }

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        const k = key(i);
        this.drawn[i] = k;
        const level = k >> 1;
        const down = (k & 1) === 1;
        const px = this.originX + x * c;
        const py = this.originY + y * c;
        // E9-162 — THERE ARE ONLY 32 KEYS. See `spriteFor`.
        const s = this.spriteFor(level, down);
        if (s !== null) {
          ctx.drawImage(s.img, px - s.m, py - s.m);
          continue;
        }
        this.key(ctx, px, py, pad, r, alphaFor(level, this.intensity), down);
      }
    }
    if (!whole) ctx.restore();
    /**
     * E9-166 — HOW MANY CELLS, which decides whether E9-163 helped.
     *
     * The dirty region is a BOUNDING BOX, so it pays when the changes
     * are clustered — a playhead moving down a column — and nothing at
     * all when they are scattered, because the box then spans the
     * surface. Measured on the bench: 128 cells to 49.7 for a playhead,
     * 128 to 123.6 for a scatter.
     *
     * Which of those a real script looks like is not something a bench
     * can answer. This counts it on the device, so a log from the Pixel
     * says whether the optimisation is doing anything for `kolor`
     * instead of leaving it to be argued about.
     */
    recordCount("draw:grid cells", (x1 - x0 + 1) * (y1 - y0 + 1));
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
  private key(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    pad: number,
    r: number,
    alpha: number,
    down: boolean,
  ): void {
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
    // A frame already asked for cannot be taken back, but it can be made
    // to do nothing: the canvas belongs to the view that replaced this one.
    this.disposed = true;
    this.dirty = false;
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
