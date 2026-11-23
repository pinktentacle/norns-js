// E5-15 — the on-screen arc.
//
// Four rings of 64 LEDs each, drawn as four circles of 64 wedges. It is an
// `ArcTransport` like any other, so a real arc over Web Serial or a remote
// one attaches beside it with nothing above having to know — the same
// arrangement as the grid's view.
//
// AN ENCODER HAS NO POSITION. `_norns.arc.delta(id, n, delta)` carries a
// RELATIVE movement, and that is all a script ever learns: there is no "the
// knob is at 0.7" anywhere in the protocol. So a drag has to be
// differentiated into deltas, and there is nothing to draw for "where the
// knob is" — only the LEDs the script lit. This is why the view has no
// pointer of its own and why letting go leaves the ring exactly as it was.
//
// DRAG IS ANGULAR, NOT LINEAR. A knob turns; the natural gesture is around
// the ring, not across it. The delta is the change in the angle from the
// ring's centre to the pointer, converted to encoder steps. Dragging
// straight across the middle therefore produces very little, which is also
// true of a real encoder.

import { alphaFor, quantise } from "../grid/ramp.js";
import { drawingRatio } from "../ui/dpr.js";
import { LEDS, RINGS, type ArcDescriptor, type ArcTransport } from "./device.js";
import { timed } from "../norns/call-cost.js";

export interface ArcViewOptions {
  readonly canvas: HTMLCanvasElement;
  readonly descriptor: ArcDescriptor;
  /** 0-based ring, a delta in encoder steps. */
  readonly onDelta: (ring: number, delta: number) => void;
  readonly onKey: (ring: number, state: 0 | 1) => void;
  /**
   * Encoder steps per full turn of the pointer around a ring.
   *
   * A monome arc is 64 detents per revolution, which is also one LED each,
   * so a drag that moves the lit LED under the pointer feels right.
   */
  readonly stepsPerTurn?: number;
  /**
   * Ask for a frame. `requestAnimationFrame` unless a test supplies one;
   * with neither, it draws at once.
   */
  readonly frame?: (cb: () => void) => void;
  /** Milliseconds, for the repaint that bounds a skipped frame. See `ledRingMap`. */
  readonly now?: () => number;
}

/** A frame that changes nothing is still painted once in this long. */
export const REPAINT_AFTER_MS = 1000;

/**
 * Where the LEDs are, as fractions of the ring's radius.
 *
 * MEASURED, not invented: in monome's own arc photographs the knobs are
 * large brushed-aluminium cylinders that nearly fill the slab, each sitting
 * in a shallow circular well, and the LEDs shine out of the narrow slot
 * between the knob's base and the wall of that well. So the ring of light is
 * a THIN band around a big knob, not a doughnut with a hole.
 */
const LED_OUTER = 1.0;
const LED_INNER = 0.86;
/** The knob, which stops just inside the lit slot. */
const KNOB = 0.82;
const GAP = 0.004;

export class ArcView implements ArcTransport {
  readonly descriptor: ArcDescriptor;
  private readonly ctx: CanvasRenderingContext2D;
  /** What has been presented: 4 x 64. Written only by `ledRingMap`. */
  private readonly levels = new Uint8Array(RINGS * LEDS);
  private intensity = 15;
  /** Pointer id → the ring it is turning and the angle it was last at. */
  private readonly held = new Map<number, { ring: number; angle: number; moved: number }>();
  private readonly ac = new AbortController();
  /** Geometry, recomputed by `layout()`. */
  private cx = 0;
  private cy = 0;
  private radius = 0;
  private spacing = 0;
  private readonly clock: () => number;
  private paintedAt = -Infinity;
  private drawnFrames = 0;
  private skippedFrames = 0;

  constructor(private readonly opts: ArcViewOptions) {
    this.descriptor = opts.descriptor;
    const ctx = opts.canvas.getContext("2d");
    if (ctx === null) throw new Error("arc view: no 2d context");
    this.ctx = ctx;
    this.clock = opts.now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.attach();
    // A context the browser took back and returned comes back blank, and
    // every cached picture may have gone with it.
    opts.canvas.addEventListener?.(
      "contextrestored",
      () => {
        this.forget();
        this.dirty = true;
        this.flush();
      },
      { signal: this.ac.signal },
    );
    this.layout();
  }

  // --- ArcTransport -----------------------------------------------------

  /**
   * E9-207 — A RING THAT HAS NOT CHANGED IS NOT DRAWN AGAIN.
   *
   * `ArcDevice.refresh()` sends one of these per ring a script TOUCHED,
   * which is not the same as a ring that changed: the ordinary shape is
   * `a:all(0)`, light what should be lit, `a:refresh()`, thirty times a
   * second, and most of those frames are the frame before. The grid's view
   * has skipped them since E9-199 and this one drew every one — four times
   * over, see `draw`.
   *
   * Bounded the way the grid's is: a frame that changes nothing is still
   * painted if a second has gone by since the last paint, so a picture the
   * browser dropped without saying so cannot stay wrong for longer.
   */
  ledRingMap(ring: number, levels: Uint8Array): void {
    const from = (ring & 3) * LEDS;
    let changed = false;
    for (let i = 0; i < LEDS; i++) {
      const v = levels[i] ?? 0;
      if (this.levels[from + i] !== v) {
        this.levels[from + i] = v;
        changed = true;
      }
    }
    if (changed || this.clock() - this.paintedAt >= REPAINT_AFTER_MS) {
      this.draw();
      return;
    }
    this.skippedFrames++;
  }

  ledIntensity(level: number): void {
    if (level === this.intensity) return;
    this.intensity = level;
    // Intensity scales every alpha, so every lit sprite is now wrong.
    this.lit = [];
    this.draw();
  }

  /** How many frames were painted, and how many were the one before. */
  stats(): { drawn: number; skipped: number } {
    return { drawn: this.drawnFrames, skipped: this.skippedFrames };
  }

  close(): void {
    this.dispose();
  }

  /** Stop answering the canvas. See the grid view for why this matters. */
  dispose(): void {
    this.disposed = true;
    this.releaseAll();
    this.ac.abort();
  }

  // --- geometry ---------------------------------------------------------

  layout(): void {
    const canvas = this.opts.canvas;
    const dpr = drawingRatio();
    const boxW = canvas.clientWidth || canvas.width;
    const boxH = canvas.clientHeight || canvas.height;
    canvas.width = Math.max(1, Math.round(boxW * dpr));
    canvas.height = Math.max(1, Math.round(boxH * dpr));

    // Four rings side by side, as an arc's four encoders are.
    this.spacing = canvas.width / RINGS;
    // The knobs nearly touch on the hardware; the slab is a frame around
    // them rather than a panel they are mounted on.
    this.radius = Math.min(this.spacing, canvas.height) * 0.46;
    this.cx = this.spacing / 2;
    this.cy = canvas.height / 2;
    // Everything cached is sized by the radius, and setting a canvas's
    // size has just cleared it: paint now, not at the next frame.
    this.forget();
    this.dirty = true;
    this.flush();
  }

  /** Which ring a point is on, and at what angle. */
  private hit(px: number, py: number): { ring: number; angle: number } | null {
    const ring = Math.floor(px / this.spacing);
    if (ring < 0 || ring >= RINGS) return null;
    const dx = px - (this.cx + ring * this.spacing);
    const dy = py - this.cy;
    const r = Math.hypot(dx, dy);
    // Anywhere inside the ring's circle counts, not just the lit band: a
    // knob is grabbed, not aimed at.
    if (r > this.radius * 1.15) return null;
    return { ring, angle: Math.atan2(dy, dx) };
  }

  // --- drawing ----------------------------------------------------------
  //
  // E9-207 — ONE PAINT A FRAME, AND MOST OF IT FROM MEMORY.
  //
  // This used to paint from inside `ledRingMap`: every ring, whole, with a
  // blurred shadow under each lit LED — and `refresh()` calls `ledRingMap`
  // once per ring, so a script lighting all four painted the instrument
  // FOUR TIMES for one picture, inside the script's own callback.
  //
  // Measured on the development machine, all four rings changing:
  //
  //     lit LEDs a ring              8        24        64
  //     main thread, a refresh    0.67 ms   1.00 ms   1.52 ms    before
  //                               0.035     0.11      0.26       now
  //     with the raster forced    3.1       3.9       6.0        before
  //     (no graphics card)        0.78      2.1       5.5        now
  //
  // Of the "now" on the main thread, 0.006 ms is in the script's callback;
  // the rest is the paint, which is in the frame. The last two rows are
  // the worst case for THIS design — a turned sprite is dear without a
  // graphics card — and it is still under the old figure with every LED
  // lit. With one, a sprite is a textured quad.
  //
  // Three things, all of them the grid view's:
  //
  //   * a present marks the picture stale and asks for ONE frame;
  //   * what never changes is painted once and kept — the well with its 64
  //     dark LEDs under, the knob over, the same two pictures for all four
  //     rings;
  //   * a lit LED is a sprite per LEVEL, drawn turned to its place. The
  //     blur is paid when a level is first used, not 256 times a frame.
  //
  // The whole instrument is still painted each frame, never one ring of
  // it: a lit LED's glow reaches a little way into its neighbour's column,
  // and a ring repainted alone would cut that glow off at the line.

  private dirty = false;
  private scheduled = false;
  private disposed = false;
  /** One ring's unchanging parts, kept as pictures. Null where there is no document. */
  private under: { img: HTMLCanvasElement; half: number } | null | undefined;
  private over: { img: HTMLCanvasElement; half: number } | null | undefined;
  /** A lit LED at twelve o'clock, by quantised level. */
  private lit: Array<{ img: HTMLCanvasElement; w: number; top: number } | null> = [];

  private forget(): void {
    this.under = undefined;
    this.over = undefined;
    this.lit = [];
  }

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

  /** Paint now if anything is waiting. Public for a test and a bench. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.paintedAt = this.clock();
    this.drawnFrames++;
    timed("draw:arc", () => this.drawNow());
  }

  private offscreen(w: number, h: number): { img: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    const doc = this.opts.canvas.ownerDocument;
    if (!doc || !(w > 0) || !(h > 0)) return null;
    const img = doc.createElement("canvas");
    img.width = w;
    img.height = h;
    const ctx = img.getContext("2d");
    return ctx ? { img, ctx } : null;
  }

  private layer(which: "under" | "over"): { img: HTMLCanvasElement; half: number } | null {
    const got = this[which];
    if (got !== undefined) return got;
    // The well reaches 1.1 radii; the knob's shadow falls a little past it.
    const half = Math.ceil(this.radius * (which === "under" ? 1.12 : 1.05)) + 2;
    const off = this.offscreen(half * 2, half * 2);
    let made: { img: HTMLCanvasElement; half: number } | null = null;
    if (off !== null) {
      if (which === "under") this.paintUnder(off.ctx, half, half);
      else this.paintOver(off.ctx, half, half);
      made = { img: off.img, half };
    }
    this[which] = made;
    return made;
  }

  /** The angle one LED covers, less the hairline between two. */
  private static readonly STEP = (Math.PI * 2) / LEDS;

  private litFor(level: number): { img: HTMLCanvasElement; w: number; top: number } | null {
    const got = this.lit[level];
    if (got !== undefined) return got;
    const alpha = alphaFor(level, this.intensity);
    const R = this.radius;
    const outer = R * LED_OUTER;
    const blur = R * (0.05 + alpha * 0.09);
    // Room for the glow and no more: a blur of B is a gaussian of sigma
    // B/2, and past three sigmas there is nothing. THE SIZE IS THE COST —
    // where the canvas is drawn without a graphics card every pixel of a
    // turned sprite is paid for, lit or empty, and the first cut of this
    // left two and a half blurs all round: nine thousand pixels for a
    // wedge of two hundred, and slower than the painting it replaced.
    const m = Math.ceil(blur * 1.6) + 2;
    const half = Math.ceil(outer * Math.sin(ArcView.STEP / 2)) + m;
    const height = Math.ceil(outer - R * LED_INNER) + m * 2;
    const off = this.offscreen(half * 2, height);
    let made: { img: HTMLCanvasElement; w: number; top: number } | null = null;
    if (off !== null) {
      // The ring's centre sits `outer + m` below the top edge, mid-width.
      this.paintLit(off.ctx, half, outer + m, -Math.PI / 2 - ArcView.STEP / 2, alpha);
      made = { img: off.img, w: half * 2, top: outer + m };
    }
    this.lit[level] = made;
    return made;
  }

  private drawNow(): void {
    const ctx = this.ctx;
    const canvas = this.opts.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const under = this.layer("under");
    const over = this.layer("over");
    // WHOLE PIXELS. A kept picture drawn half a pixel off is resampled,
    // and the knob's hairlines would soften on three rings out of four.
    const cy = Math.round(this.cy);
    for (let ring = 0; ring < RINGS; ring++) {
      const cx = Math.round(this.cx + ring * this.spacing);
      if (under !== null) ctx.drawImage(under.img, cx - under.half, cy - under.half);
      else this.paintUnder(ctx, cx, cy);

      for (let i = 0; i < LEDS; i++) {
        const level = quantise(this.levels[ring * LEDS + i] ?? 0, true);
        const alpha = alphaFor(level, this.intensity);
        if (!(alpha > 0)) continue;
        const sprite = this.litFor(level);
        if (sprite === null) {
          this.paintLit(ctx, cx, cy, -Math.PI / 2 + i * ArcView.STEP, alpha);
          continue;
        }
        // Turned about the ring's centre to where this LED is.
        const a = (i + 0.5) * ArcView.STEP;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        ctx.setTransform(cos, sin, -sin, cos, cx, cy);
        ctx.drawImage(sprite.img, -sprite.w / 2, -sprite.top);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      if (over !== null) ctx.drawImage(over.img, cx - over.half, cy - over.half);
      else this.paintOver(ctx, cx, cy);

      // A pressed knob sinks a hair. Not kept: it changes with a finger.
      if ([...this.held.values()].some((h) => h.ring === ring)) {
        const kr = this.radius * KNOB;
        ctx.beginPath();
        ctx.arc(cx, cy, kr * 0.84, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(38, 38, 44, 0.45)";
        ctx.lineWidth = Math.max(1, kr * 0.05);
        ctx.stroke();
      }
    }
  }

  /** One LED's wedge, from `from` round by a step. */
  private wedge(ctx: CanvasRenderingContext2D, cx: number, cy: number, from: number): void {
    const R = this.radius;
    const a0 = from + GAP;
    const a1 = a0 + ArcView.STEP - GAP * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R * LED_OUTER, a0, a1);
    ctx.arc(cx, cy, R * LED_INNER, a1, a0, true);
    ctx.closePath();
  }

  /** The well, and the slot round it with every LED dark. */
  private paintUnder(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    const outer = this.radius * LED_OUTER;
    // The well. On the hardware it is a soft machined recess in the same
    // anodised metal as the slab, not a painted ring.
    const well = ctx.createRadialGradient(cx, cy, outer * 0.9, cx, cy, outer * 1.1);
    well.addColorStop(0, "rgba(90, 88, 84, 0.30)");
    well.addColorStop(0.6, "rgba(120, 118, 113, 0.18)");
    well.addColorStop(1, "rgba(255, 255, 255, 0.0)");
    ctx.beginPath();
    ctx.arc(cx, cy, outer * 1.1, 0, Math.PI * 2);
    ctx.fillStyle = well;
    ctx.fill();
    for (let i = 0; i < LEDS; i++) {
      this.wedge(ctx, cx, cy, -Math.PI / 2 + i * ArcView.STEP);
      ctx.fillStyle = "rgba(74, 72, 68, 0.22)";
      ctx.fill();
    }
  }

  /** One lit LED, glow and all, over the dark one already there. */
  private paintLit(ctx: CanvasRenderingContext2D, cx: number, cy: number, from: number, alpha: number): void {
    const R = this.radius;
    this.wedge(ctx, cx, cy, from);
    ctx.save();
    ctx.shadowColor = `rgba(255, 243, 219, ${(alpha * 0.9).toFixed(3)})`;
    ctx.shadowBlur = R * (0.05 + alpha * 0.09);
    ctx.fillStyle = `rgba(255, 251, 240, ${alpha.toFixed(3)})`;
    ctx.fill();
    ctx.restore();
  }

  /** The knob: brushed aluminium, lit from the upper left. */
  private paintOver(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    const kr = this.radius * KNOB;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.38)";
    ctx.shadowBlur = kr * 0.16;
    ctx.shadowOffsetY = kr * 0.05;
    ctx.beginPath();
    ctx.arc(cx, cy, kr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(183, 181, 175, 0.98)";
    ctx.fill();
    ctx.restore();

    if (typeof ctx.createConicGradient === "function") {
      const turn = ctx.createConicGradient(-Math.PI * 0.75, cx, cy);
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const v = 0.5 + 0.5 * Math.cos(t * Math.PI * 4);
        turn.addColorStop(t, `rgba(255, 255, 255, ${(0.02 + v * 0.08).toFixed(3)})`);
      }
      ctx.beginPath();
      ctx.arc(cx, cy, kr, 0, Math.PI * 2);
      ctx.fillStyle = turn;
      ctx.fill();
    }

    const face = ctx.createLinearGradient(cx - kr, cy - kr, cx + kr, cy + kr);
    face.addColorStop(0, "rgba(255, 255, 255, 0.26)");
    face.addColorStop(0.5, "rgba(255, 255, 255, 0.02)");
    face.addColorStop(1, "rgba(104, 102, 97, 0.26)");
    ctx.beginPath();
    ctx.arc(cx, cy, kr, 0, Math.PI * 2);
    ctx.fillStyle = face;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, kr * 0.97, 0, Math.PI * 2);
    const bevel = ctx.createLinearGradient(cx - kr, cy - kr, cx + kr, cy + kr);
    bevel.addColorStop(0, "rgba(255, 255, 255, 0.7)");
    bevel.addColorStop(0.5, "rgba(255, 255, 255, 0.1)");
    bevel.addColorStop(1, "rgba(70, 68, 64, 0.55)");
    ctx.strokeStyle = bevel;
    ctx.lineWidth = Math.max(1, kr * 0.055);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, kr * 0.74, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(120, 118, 113, 0.22)";
    ctx.lineWidth = Math.max(1, kr * 0.015);
    ctx.stroke();
  }

  private attach(): void {
    const canvas = this.opts.canvas;
    const signal = this.ac.signal;
    canvas.style.touchAction = "none";

    const at = (e: PointerEvent): { ring: number; angle: number } | null => {
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / (r.width || 1);
      return this.hit((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
    };

    canvas.addEventListener(
      "pointerdown",
      (e) => {
        const h = at(e);
        if (h === null) return;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          /* uncapturable pointer; the turn still works */
        }
        e.preventDefault();
        this.held.set(e.pointerId, { ring: h.ring, angle: h.angle, moved: 0 });
        this.opts.onKey(h.ring, 1);
        // The pressed knob is part of the picture; it used to wait for the
        // script to light something before it showed.
        this.draw();
      },
      { signal },
    );

    canvas.addEventListener(
      "pointermove",
      (e) => {
        const held = this.held.get(e.pointerId);
        if (held === undefined) return;
        const h = at(e);
        // Leaving the circle does not end the turn: the angle is still
        // defined, and a knob you have hold of does not let go because your
        // hand drifted. Recompute against the SAME ring.
        const r = canvas.getBoundingClientRect();
        const dpr = canvas.width / (r.width || 1);
        const dx = (e.clientX - r.left) * dpr - (this.cx + held.ring * this.spacing);
        const dy = (e.clientY - r.top) * dpr - this.cy;
        const angle = h !== null && h.ring === held.ring ? h.angle : Math.atan2(dy, dx);

        // Shortest way round, so crossing the -pi/pi seam is one small step
        // rather than a full turn backwards.
        let d = angle - held.angle;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        held.angle = angle;

        const perTurn = this.opts.stepsPerTurn ?? LEDS;
        held.moved += (d / (Math.PI * 2)) * perTurn;
        // Whole steps only: an encoder emits detents, not a continuous
        // position, and a script doing `pos = pos + delta` on fractions
        // drifts in a way no hardware would cause.
        const steps = Math.trunc(held.moved);
        if (steps !== 0) {
          held.moved -= steps;
          this.opts.onDelta(held.ring, steps);
        }
      },
      { signal },
    );

    const release = (e: PointerEvent): void => {
      const held = this.held.get(e.pointerId);
      if (held === undefined) return;
      this.held.delete(e.pointerId);
      this.opts.onKey(held.ring, 0);
      this.draw();
    };
    canvas.addEventListener("pointerup", release, { signal });
    canvas.addEventListener("pointercancel", release, { signal });

    const releaseAll = (): void => this.releaseAll();
    globalThis.addEventListener?.("blur", releaseAll, { signal });
    globalThis.document?.addEventListener(
      "visibilitychange",
      () => {
        if (globalThis.document?.hidden) releaseAll();
      },
      { signal },
    );
  }

  releaseAll(): void {
    for (const held of this.held.values()) this.opts.onKey(held.ring, 0);
    this.held.clear();
  }
}
