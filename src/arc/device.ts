// E5-12 / E5-14 — the arc device.
//
// It is `dev_monome` with `quads = 4` and different addressing, which is not
// a simplification: `device_monome.cc` really does give an arc the same
// `uint8_t data[4][64]` back buffer, the same `dirty[4]` and the same
// `dev_monome_refresh`. Four rings of 64 ARE four quads of 64. See
// `research/arc-design.md` §1.
//
// So the transport gains exactly one method — `ledRingMap(ring, levels)` in
// place of `ledLevelMap(xOff, yOff, levels)` — and loses nothing. ADR-06
// said that would be the shape and it is.
//
// RING AND LED WRAP, THEY DO NOT CLAMP. `data[n & 3][x & 63]`, so
// `arc:led(5, 1, 15)` lights ring 1 and `arc:led(1, 65, 15)` lights LED 1.
// The grid discards an out-of-range coordinate; the arc folds it. That is
// upstream's and scripts that index modularly depend on it.

import { narrowLevel, clamp15, wireLevel } from "../monome/byte.js";

/** What an arc says it is. The NAME decides it is an arc — see below. */
export interface ArcDescriptor {
  readonly serial: string;
  /**
   * MUST start with "monome arc".
   *
   * `startup.lua:68-73` routes on that prefix and nothing else does: matron
   * never calls `_norns.arc.add` itself, every device arrives through
   * `monome.add`, and Lua decides on a string. A virtual arc called anything
   * else arrives at the grid module and is never seen as an arc.
   */
  readonly name: string;
}

/** Where the light goes. One call, because an arc has one kind of output. */
export interface ArcTransport {
  readonly descriptor: ArcDescriptor;
  /** 64 levels for one ring, 0-based. */
  ledRingMap(ring: number, levels: Uint8Array): void;
  ledIntensity(level: number): void;
  close?(): void;
}

/** 0-based ring, and a DELTA rather than a position. */
export interface ArcInput {
  delta(ring: number, delta: number): void;
  key(ring: number, state: 0 | 1): void;
}

export const RINGS = 4;
export const LEDS = 64;

export class ArcDevice {
  readonly descriptor: ArcDescriptor;
  /** Back buffer: `data[4][64]`, what scripts write. */
  private readonly back = new Uint8Array(RINGS * LEDS);
  /** Front buffer: what has been presented. Moves only in `refresh()`. */
  private readonly front = new Uint8Array(RINGS * LEDS);
  private readonly dirty = new Array<boolean>(RINGS).fill(false);
  private readonly transports = new Set<ArcTransport>();
  private level = 15;

  constructor(
    readonly id: number,
    descriptor: ArcDescriptor,
    private readonly input: ArcInput,
  ) {
    this.descriptor = descriptor;
  }

  /**
   * One LED. `ring` and `x` are 0-based here; weaver.cc did the subtraction.
   *
   * The asymmetry is the grid's: `rel` adds and clamps to [0, 15], absolute
   * narrows and does not clamp. See `src/monome/byte.ts` for why the
   * absolute path stores a byte rather than a nybble.
   */
  setLed(ring: number, x: number, val: number, rel: boolean): void {
    const at = (ring & 3) * LEDS + (x & 63);
    this.back[at] = rel ? clamp15(this.back[at]! + val) : narrowLevel(val);
    this.dirty[ring & 3] = true;
  }

  /**
   * Every LED of every ring.
   *
   * `_arc_all_led` is literally `return _grid_all_led(l);` in weaver.cc, and
   * `dev_monome_all_led` walks `md->quads`, which is 4 here. The same code,
   * not a near-copy, so this is the same loop the grid's `allLed` runs.
   */
  allLed(val: number, rel: boolean): void {
    const v = narrowLevel(val);
    for (let r = 0; r < RINGS; r++) {
      for (let i = 0; i < LEDS; i++) {
        const at = r * LEDS + i;
        this.back[at] = rel ? clamp15(this.back[at]! + val) : v;
      }
      this.dirty[r] = true;
    }
  }

  /**
   * Present. One `ledRingMap` per dirty ring, then the flags clear.
   *
   * The levels handed out are MASKED, because that is where libmonome masks
   * them: the buffer keeps the byte, the wire gets the nybble.
   */
  refresh(): void {
    for (let r = 0; r < RINGS; r++) {
      if (!this.dirty[r]) continue;
      const from = r * LEDS;
      const quad = new Uint8Array(LEDS);
      for (let i = 0; i < LEDS; i++) quad[i] = wireLevel(this.back[from + i]!);
      this.front.set(quad, from);
      for (const t of this.transports) t.ledRingMap(r, quad);
      this.dirty[r] = false;
    }
  }

  /** `monome_led_ring_intensity`. Clamped, and remembered for a new sink. */
  intensity(level: number): void {
    this.level = level > 15 ? 15 : level < 0 ? 0 : level;
    for (const t of this.transports) t.ledIntensity(this.level);
  }

  get currentIntensity(): number {
    return this.level;
  }

  addTransport(t: ArcTransport): void {
    this.transports.add(t);
    t.ledIntensity(this.level);
    for (let r = 0; r < RINGS; r++) {
      t.ledRingMap(r, this.front.subarray(r * LEDS, (r + 1) * LEDS));
    }
  }

  removeTransport(t: ArcTransport): void {
    this.transports.delete(t);
  }

  /** Input. 0-based ring; the callback layer adds the 1. */
  delta(ring: number, d: number): void {
    this.input.delta(ring, d);
  }

  key(ring: number, state: 0 | 1): void {
    this.input.key(ring, state);
  }

  /** What has been presented, 4 x 64, masked. For views and tests. */
  presented(): Readonly<Uint8Array> {
    return this.front;
  }

  close(): void {
    for (const t of this.transports) t.close?.();
    this.transports.clear();
  }
}
