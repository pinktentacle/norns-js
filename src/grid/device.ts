// E5-02 — the grid device: a port of `struct dev_monome` and
// `device_monome.cc`.
//
// matron keeps the LED state itself, in `uint8_t data[4][64]` — four 8×8
// quads of levels — with a `dirty[4]` flag per quad. Scripts write into that
// back buffer and `refresh()` is the present. Everything here exists to
// reproduce that exactly, because scripts depend on the details:
//
//   * `g:all(0)` then draw then `g:refresh()` is the universal idiom, and a
//     view that renders the back buffer live shows a black flash every frame;
//   * `g:led(x, y, 16)` renders as level 0 and `g:led(x, y, 100)` as 4,
//     because an absolute write is NOT clamped — it is narrowed on the way
//     into the buffer and MASKED on the way to the wire, and those are two
//     different places (see src/monome/byte.ts);
//   * a relative write IS clamped to [0, 15]. The asymmetry is upstream's and
//     scripts are written against it.
//
// THE TRANSPORT BOUNDARY IS ONE CALL. The single most useful fact in
// research/grid-design.md: matron only ever emits `monome_led_level_map` and
// `monome_led_intensity`. Never `led_set`, `led_all`, `led_row`, `led_col`.
// So the entire LED output of a norns grid is "here is an 8×8 quad of 4-bit
// levels at this offset", plus a global intensity — which is why
// `GridTransport` is as narrow as it is, and why an on-screen grid, a
// WebSocket grid and a real one over Web Serial are the same interface.

import { narrowLevel, clamp15, wireLevel, luaTruthy } from "../monome/byte.js";

/** What a grid says it is. Stable across a resize — see `GridManager`. */
export interface GridDescriptor {
  /** Stable, and part of the name Lua persists. */
  readonly serial: string;
  /**
   * Must NOT start with "monome arc": `startup.lua` routes on that prefix,
   * and a grid called one would arrive at the arc module.
   */
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  /** False collapses levels to on/off at 8, as a non-varibright grid does. */
  readonly varibright: boolean;
}

/**
 * Where the light goes. Exactly libmonome's narrow waist.
 *
 * Coordinates are DEVICE space and 0-based. Rotation is the view's business:
 * on hardware `monome_set_rotation` makes the device do it, so matron's own
 * buffer stays unrotated and so does this one.
 */
export interface GridTransport {
  readonly descriptor: GridDescriptor;
  /** 64 levels, row-major inside the 8×8 quad at (xOff, yOff). */
  ledLevelMap(xOff: number, yOff: number, levels: Uint8Array): void;
  ledIntensity(level: number): void;
  tiltEnable?(sensor: number, on: boolean): void;
  close?(): void;
}

/** 0-based device-space key and tilt, from any transport. */
export interface GridInput {
  key(x: number, y: number, state: 0 | 1): void;
  tilt(sensor: number, x: number, y: number, z: number): void;
}

const QUAD_XOFF = [0, 8, 0, 8];
const QUAD_YOFF = [0, 0, 8, 8];

export class GridDevice {
  readonly descriptor: GridDescriptor;
  private readonly quads: number;
  /** Back buffer: what scripts write. `quads * 64` levels, quad-major. */
  private readonly back: Uint8Array;
  /** Front buffer: what has been presented. Changes ONLY in `refresh()`. */
  private readonly frontQuads: Uint8Array;
  /** The same thing row-major, for views. Also only changes in `refresh()`. */
  private readonly frontLinear: Uint8Array;
  private readonly dirty: boolean[];
  private readonly transports = new Set<GridTransport>();
  private rotation: 0 | 1 | 2 | 3 = 0;
  private level = 15;
  /** Per-quad offsets, which rotation moves on a 16×8 grid. */
  private xoff: number[];
  private yoff: number[];

  constructor(
    readonly id: number,
    descriptor: GridDescriptor,
    private readonly input: GridInput,
  ) {
    this.descriptor = descriptor;
    this.quads = (descriptor.rows * descriptor.cols) / 64;
    this.back = new Uint8Array(this.quads * 64);
    this.frontQuads = new Uint8Array(this.quads * 64);
    this.frontLinear = new Uint8Array(descriptor.rows * descriptor.cols);
    this.dirty = new Array<boolean>(this.quads).fill(false);
    this.xoff = QUAD_XOFF.slice(0, this.quads);
    this.yoff = QUAD_YOFF.slice(0, this.quads);
  }

  /**
   * Which quad holds (x, y), and where inside it.
   *
   * `device_monome.cc:97-106`. The special case is a 16×8 grid rotated 90 or
   * 270: its two quads then stack vertically rather than side by side, and
   * the index is built from x and y the other way round.
   */
  private quadOf(x: number, y: number): number {
    if (this.quads === 2 && (this.rotation === 1 || this.rotation === 3)) {
      return ((x > 7 ? 1 : 0) << 1) | (y > 7 ? 1 : 0);
    }
    return ((y > 7 ? 1 : 0) << 1) | (x > 7 ? 1 : 0);
  }

  private static offsetIn(x: number, y: number): number {
    return (y & 7) * 8 + (x & 7);
  }

  /**
   * One LED.
   *
   * `rel` adds to what is there and clamps; absolute does not clamp. `z &
   * 0x0F` is not a tidy-up — it is what the C does, via a narrowing to
   * `uint8_t` and the mext nybble packer's mask, and it is why `g:led(x, y,
   * 16)` goes dark.
   */
  setLed(x: number, y: number, z: number, rel: boolean): void {
    if (x < 0 || y < 0 || x >= this.descriptor.cols || y >= this.descriptor.rows) return;
    const q = this.quadOf(x, y);
    if (q >= this.quads) return;
    const at = q * 64 + GridDevice.offsetIn(x, y);
    // NOT `z & 0x0f`. matron stores the narrowed byte and libmonome masks
    // when it packs nybbles for the wire, so the buffer holds 16 after
    // `g:led(x, y, 16)` and a relative write after it reads 16, not 0.
    this.back[at] = rel ? clamp15(this.back[at]! + z) : narrowLevel(z);
    this.dirty[q] = true;
  }

  /** Every LED of every quad, with the same clamp asymmetry. */
  allLed(z: number, rel: boolean): void {
    const v = narrowLevel(z);
    for (let q = 0; q < this.quads; q++) {
      for (let i = 0; i < 64; i++) {
        const at = q * 64 + i;
        this.back[at] = rel ? clamp15(this.back[at]! + z) : v;
      }
      this.dirty[q] = true;
    }
  }

  /**
   * Present. One `ledLevelMap` per dirty quad, then the flags clear.
   *
   * This is the only place the front buffer moves, which is what makes a
   * view cheap: a script that redraws at 60 fps costs 60 presents, and an
   * idle one costs none.
   */
  refresh(): void {
    for (let q = 0; q < this.quads; q++) {
      if (!this.dirty[q]) continue;
      // Masked here, because this is where libmonome masks: the buffer
      // keeps the byte, the wire gets the nybble.
      const quad = new Uint8Array(64);
      for (let i = 0; i < 64; i++) quad[i] = wireLevel(this.back[q * 64 + i]!);
      this.frontQuads.set(quad, q * 64);
      this.copyQuadToLinear(q);
      for (const t of this.transports) t.ledLevelMap(this.xoff[q]!, this.yoff[q]!, quad);
      this.dirty[q] = false;
    }
  }

  /**
   * The presented quad, into the row-major surface a view reads.
   *
   * The stride is the CURRENT width, not the descriptor's. matron works in
   * the user frame, not the physical one — libmonome rotates on the way to
   * the hardware and un-rotates keys on the way back — and the proof is the
   * quad fixup above: a 16×8 turned 90° moves quad 1 to (0, 8), which only
   * makes sense on a surface 8 wide and 16 tall. Indexing with the
   * descriptor's 16 would fold the lower half back onto the upper.
   *
   * It also means a view has no rotation arithmetic of its own: it draws
   * `front()` as `cols() × rows()` and passes keys back in the same frame.
   */
  private copyQuadToLinear(q: number): void {
    const x0 = this.xoff[q]!;
    const y0 = this.yoff[q]!;
    const w = this.cols();
    const h = this.rows();
    for (let i = 0; i < 64; i++) {
      const x = x0 + (i & 7);
      const y = y0 + (i >> 3);
      if (x >= w || y >= h) continue;
      this.frontLinear[y * w + x] = this.frontQuads[q * 64 + i]!;
    }
  }

  /** 0..15, clamped, and remembered so a new transport can be told. */
  intensity(level: number): void {
    this.level = level > 15 ? 15 : level < 0 ? 0 : level;
    for (const t of this.transports) t.ledIntensity(this.level);
  }

  get currentIntensity(): number {
    return this.level;
  }

  /**
   * 0, 1, 2 or 3 quarter-turns.
   *
   * On a 16×8 grid the quads stop sitting side by side, so their offsets
   * move — `dev_monome_set_rotation` does exactly this fixup before telling
   * the device. Everything presented after this uses the new offsets, so a
   * `refresh()` is needed for the change to be seen; that is upstream's
   * behaviour too.
   */
  setRotation(r: 0 | 1 | 2 | 3): void {
    if (r === this.rotation) return;
    this.rotation = r;
    if (this.quads === 2 && (r === 1 || r === 3)) {
      this.xoff = [0, 0];
      this.yoff = [0, 8];
    } else {
      this.xoff = QUAD_XOFF.slice(0, this.quads);
      this.yoff = QUAD_YOFF.slice(0, this.quads);
    }
    // The surface changed shape, so what was presented has to be laid out
    // again at the new stride. Not a re-present: the FRONT buffer's contents
    // do not change, only where they sit.
    this.frontLinear.fill(0);
    for (let q = 0; q < this.quads; q++) this.copyQuadToLinear(q);
  }

  get currentRotation(): 0 | 1 | 2 | 3 {
    return this.rotation;
  }

  /** Swapped under a quarter turn, as `monome_get_rows` reports it. */
  rows(): number {
    return this.rotation === 1 || this.rotation === 3
      ? this.descriptor.cols
      : this.descriptor.rows;
  }

  cols(): number {
    return this.rotation === 1 || this.rotation === 3
      ? this.descriptor.rows
      : this.descriptor.cols;
  }

  tiltEnable(sensor: number): void {
    for (const t of this.transports) t.tiltEnable?.(sensor, true);
  }

  tiltDisable(sensor: number): void {
    // The same call with `on` false: the transport interface has one tilt
    // method, because libmonome has one message with a flag.
    for (const t of this.transports) t.tiltEnable?.(sensor, false);
  }

  /**
   * Add a sink, and bring it up to date.
   *
   * A transport attached to a device that has already drawn would otherwise
   * show black until the script's next `refresh()` — which, for a script
   * that draws once and waits for input, is for ever.
   */
  addTransport(t: GridTransport): void {
    this.transports.add(t);
    t.ledIntensity(this.level);
    for (let q = 0; q < this.quads; q++) {
      t.ledLevelMap(this.xoff[q]!, this.yoff[q]!, this.frontQuads.subarray(q * 64, q * 64 + 64));
    }
  }

  removeTransport(t: GridTransport): void {
    this.transports.delete(t);
  }

  /** Input, device space, 0-based. Straight on to the host's event queue. */
  key(x: number, y: number, state: 0 | 1): void {
    this.input.key(x, y, state);
  }

  tilt(sensor: number, x: number, y: number, z: number): void {
    this.input.tilt(sensor, x, y, z);
  }

  /** What has been presented, row-major, `rows * cols`. For views and tests. */
  front(): Readonly<Uint8Array> {
    return this.frontLinear;
  }
}

// `luaTruthy` lives in src/monome/byte.ts now, shared with the arc.
export { luaTruthy };

