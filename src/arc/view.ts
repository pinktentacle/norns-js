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
import { LEDS, RINGS, type ArcDescriptor, type ArcTransport } from "./device.js";

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
}

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

  constructor(private readonly opts: ArcViewOptions) {
    this.descriptor = opts.descriptor;
    const ctx = opts.canvas.getContext("2d");
    if (ctx === null) throw new Error("arc view: no 2d context");
    this.ctx = ctx;
    this.attach();
    this.layout();
  }

  // --- ArcTransport -----------------------------------------------------

  ledRingMap(ring: number, levels: Uint8Array): void {
    this.levels.set(levels.subarray(0, LEDS), (ring & 3) * LEDS);
    this.draw();
  }

  ledIntensity(level: number): void {
    this.intensity = level;
    this.draw();
  }

  close(): void {
    this.dispose();
  }

  /** Stop answering the canvas. See the grid view for why this matters. */
  dispose(): void {
    this.releaseAll();
    this.ac.abort();
  }

  // --- geometry ---------------------------------------------------------

  layout(): void {
    const canvas = this.opts.canvas;
    const dpr = globalThis.devicePixelRatio ?? 1;
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
    this.draw();
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

  private draw(): void {
    const ctx = this.ctx;
    const canvas = this.opts.canvas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let ring = 0; ring < RINGS; ring++) {
      this.ring(this.cx + ring * this.spacing, ring);
    }
  }

  /** One encoder: the well, the lit slot at its circumference, then the knob. */
  private ring(cx: number, ring: number): void {
    const ctx = this.ctx;
    const cy = this.cy;
    const R = this.radius;
    const outer = R * LED_OUTER;
    const inner = R * LED_INNER;
    const step = (Math.PI * 2) / LEDS;

    // The well the knob sits in. Its wall is what the light reflects off,
    // and without it the ring of LEDs floats.
    const well = ctx.createRadialGradient(cx, cy, outer * 0.9, cx, cy, outer * 1.1);
    well.addColorStop(0, "rgba(90, 88, 84, 0.30)");
    well.addColorStop(0.6, "rgba(120, 118, 113, 0.18)");
    well.addColorStop(1, "rgba(255, 255, 255, 0.0)");
    ctx.beginPath();
    ctx.arc(cx, cy, outer * 1.1, 0, Math.PI * 2);
    ctx.fillStyle = well;
    ctx.fill();

    for (let i = 0; i < LEDS; i++) {
      // LED 0 at the TOP, clockwise: that is where a monome arc's first LED
      // is, and a script drawing a position from 12 o'clock expects to see
      // it there.
      const a0 = -Math.PI / 2 + i * step + GAP;
      const a1 = a0 + step - GAP * 2;
      const level = quantise(this.levels[ring * LEDS + i] ?? 0, true);
      const alpha = alphaFor(level, this.intensity);

      ctx.beginPath();
      ctx.arc(cx, cy, outer, a0, a1);
      ctx.arc(cx, cy, inner, a1, a0, true);
      ctx.closePath();
      // The unlit LED is drawn, so an idle arc looks like an arc rather than
      // an empty box -- but DARK, because the slot is a recess: in monome's
      // photographs an arc that is not lit shows a shadowed ring around each
      // knob, not a white one.
      ctx.fillStyle = "rgba(74, 72, 68, 0.22)";
      ctx.fill();

      if (alpha > 0) {
        ctx.save();
        // The slot spills light onto the wall of the well, which is why one
        // lit LED on an arc looks like a soft point rather than a hard tick.
        ctx.shadowColor = `rgba(255, 243, 219, ${(alpha * 0.9).toFixed(3)})`;
        ctx.shadowBlur = R * (0.05 + alpha * 0.09);
        ctx.fillStyle = `rgba(255, 251, 240, ${alpha.toFixed(3)})`;
        ctx.fill();
        ctx.restore();
      }
    }

    // The knob: a flat-topped aluminium cylinder, turned on a lathe. The
    // contact shadow is what puts it above the slab rather than in it.
    const kr = R * KNOB;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.38)";
    ctx.shadowBlur = kr * 0.16;
    ctx.shadowOffsetY = kr * 0.05;
    ctx.beginPath();
    ctx.arc(cx, cy, kr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(183, 181, 175, 0.98)";
    ctx.fill();
    ctx.restore();

    // The turned finish. A conic gradient is the honest shape for it: the
    // tone of brushed metal depends on the angle you see it from, which is
    // the angle AROUND the piece, not the distance from its centre.
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

    // The light across the cap, upper left as everywhere else on this page.
    const face = ctx.createLinearGradient(cx - kr, cy - kr, cx + kr, cy + kr);
    face.addColorStop(0, "rgba(255, 255, 255, 0.26)");
    face.addColorStop(0.5, "rgba(255, 255, 255, 0.02)");
    face.addColorStop(1, "rgba(104, 102, 97, 0.26)");
    ctx.beginPath();
    ctx.arc(cx, cy, kr, 0, Math.PI * 2);
    ctx.fillStyle = face;
    ctx.fill();

    // The bevel at the top edge of the cylinder: a bright thread on the lit
    // side, a dark one opposite. It is the detail that makes the knob read
    // as solid rather than as a printed circle.
    ctx.beginPath();
    ctx.arc(cx, cy, kr * 0.97, 0, Math.PI * 2);
    const bevel = ctx.createLinearGradient(cx - kr, cy - kr, cx + kr, cy + kr);
    bevel.addColorStop(0, "rgba(255, 255, 255, 0.7)");
    bevel.addColorStop(0.5, "rgba(255, 255, 255, 0.1)");
    bevel.addColorStop(1, "rgba(70, 68, 64, 0.55)");
    ctx.strokeStyle = bevel;
    ctx.lineWidth = Math.max(1, kr * 0.055);
    ctx.stroke();

    // The circle turned into the top of the cap.
    ctx.beginPath();
    ctx.arc(cx, cy, kr * 0.74, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(120, 118, 113, 0.22)";
    ctx.lineWidth = Math.max(1, kr * 0.015);
    ctx.stroke();

    // A held knob is PRESSED, and the press is a switch the script reads, so
    // it has to be visible. A ring inside the cap is the one mark that does
    // not fight with the LEDs for the same pixels.
    if ([...this.held.values()].some((h) => h.ring === ring)) {
      ctx.beginPath();
      ctx.arc(cx, cy, kr * 0.84, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(38, 38, 44, 0.45)";
      ctx.lineWidth = Math.max(1, kr * 0.05);
      ctx.stroke();
    }
  }

  // --- input ------------------------------------------------------------

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
