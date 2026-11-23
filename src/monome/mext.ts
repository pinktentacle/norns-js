// E9-204 — the serial protocol of a monome grid or arc, as libmonome speaks it.
//
// A real norns has no serialosc: matron links libmonome and talks to the
// device over its serial port, and its whole device-facing surface is two
// output calls and a handful of input events (research/grid-design.md §1.4).
// This file is those, transcribed from `libmonome/src/proto/mext.c`, `mext.h`
// and `rotation.c`, so that what reaches the wire is what a norns would send.
//
// FIXED-LENGTH FRAMES, NO FRAMING. One header byte, `(section << 4) | command`,
// then a payload whose length depends on the header alone. A header this
// file does not know has no payload — which is exactly what `mext_read_msg`
// does with its length table of zeroes.
//
// THE OLD GRIDS ARE NOT HERE. `40h` and `series` are different protocols
// without variable brightness; libmonome emulates the levels for them and
// this does not. A grid from 2012 on speaks `mext`.
//
// ROTATION IS THE PROTOCOL'S JOB, not the device object's: matron calls
// `monome_led_level_map(m, x_off, y_off, data)` in the script's own space
// and `mext.c` turns the block and its origin before packing. So does this.

/** Sections of the header's high nybble. */
const SYSTEM = 0x0;
const LED_GRID = 0x1;
const KEY_GRID = 0x2;
const ENCODER = 0x5;
const TILT = 0x8;
const LED_RING = 0x9;

export type Rotation = 0 | 1 | 2 | 3;

/** `0x00` query · `0x01` get id · `0x05` get grid size — what `mext_open` asks. */
export const QUERY = Uint8Array.of(0x00);
export const GET_ID = Uint8Array.of(0x01);
export const GET_GRID_SIZE = Uint8Array.of(0x05);

/**
 * `ROTATE_COORDS` — a position in the script's space to one on the device.
 *
 * `cols` and `rows` are the ROTATED size, as `monome_get_cols` returns it:
 * a 16x8 turned a quarter is 8 wide and 16 tall to the script.
 */
export function rotateOut(r: Rotation, x: number, y: number, cols: number, rows: number): [number, number] {
  switch (r) {
    case 1:
      return [y, cols - 1 - x];
    case 2:
      return [cols - 1 - x, rows - 1 - y];
    case 3:
      return [rows - 1 - y, x];
    default:
      return [x, y];
  }
}

/** `UNROTATE_COORDS` — a key on the device to the script's space. */
export function rotateIn(r: Rotation, x: number, y: number, cols: number, rows: number): [number, number] {
  const mod = (v: number, n: number): number => ((v % n) + n) % n;
  switch (r) {
    case 1:
      return [mod(cols - 1 - y, cols), x];
    case 2:
      return [mod(cols - 1 - x, cols), mod(rows - 1 - y, rows)];
    case 3:
      return [y, mod(rows - 1 - x, rows)];
    default:
      return [x, y];
  }
}

/** `level_map_cb` — one 8x8 block of levels, turned. */
export function rotateLevelMap(r: Rotation, src: Uint8Array): Uint8Array {
  const dst = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    switch (r) {
      case 1:
        dst[i] = src[7 - (i >> 3) + ((i & 7) << 3)]!;
        break;
      case 2:
        dst[63 - i] = src[i]!;
        break;
      case 3:
        dst[i] = src[(i >> 3) + ((7 - (i & 7)) << 3)]!;
        break;
      default:
        dst[i] = src[i]!;
    }
  }
  return dst;
}

/** `pack_nybbles` — sixty-four levels of 0..15 into thirty-two bytes. */
function pack(levels: Uint8Array, into: Uint8Array, at: number): void {
  for (let i = 0; i < 32; i++) {
    into[at + i] = ((levels[i * 2]! & 0x0f) << 4) | (levels[i * 2 + 1]! & 0x0f);
  }
}

/**
 * `mext_led_level_map` — `0x1A x y` and 32 bytes.
 *
 * The origin is turned like any other point and SENT AS IT COMES OUT: half
 * a turn of a 16x8 sends its first block to (15, 7). libmonome does exactly
 * that and the grid takes the block that point is in.
 */
export function levelMap(
  xOff: number,
  yOff: number,
  levels: Uint8Array,
  r: Rotation,
  cols: number,
  rows: number,
): Uint8Array {
  const out = new Uint8Array(35);
  const [x, y] = rotateOut(r, xOff, yOff, cols, rows);
  out[0] = (LED_GRID << 4) | 0xa;
  out[1] = x & 0xff;
  out[2] = y & 0xff;
  pack(rotateLevelMap(r, levels), out, 3);
  return out;
}

/** `mext_led_intensity` — `0x17 level`. */
export function gridIntensity(level: number): Uint8Array {
  return Uint8Array.of((LED_GRID << 4) | 0x7, level & 0x0f);
}

/** `mext_led_ring_map` — `0x92 ring` and 32 bytes. */
export function ringMap(ring: number, levels: Uint8Array): Uint8Array {
  const out = new Uint8Array(34);
  out[0] = (LED_RING << 4) | 0x2;
  out[1] = ring & 0xff;
  pack(levels, out, 2);
  return out;
}

/**
 * `mext_led_ring_intensity` — `0x94 level` and one byte more.
 *
 * The extra byte is libmonome's: its length table says two for a payload of
 * one, so two are written. Sent as it is, because the arc has only ever
 * been spoken to this way.
 */
export function ringIntensity(level: number): Uint8Array {
  return Uint8Array.of((LED_RING << 4) | 0x4, level & 0x0f, 0);
}

/** `mext_tilt_enable` / `_disable` — `0x81 n` / `0x82 n`. */
export function tilt(sensor: number, on: boolean): Uint8Array {
  return Uint8Array.of((TILT << 4) | (on ? 0x1 : 0x2), sensor & 0xff);
}

export type MextEvent =
  | { readonly type: "query"; readonly section: number; readonly count: number }
  | { readonly type: "id"; readonly name: string }
  | { readonly type: "size"; readonly cols: number; readonly rows: number }
  | { readonly type: "key"; readonly x: number; readonly y: number; readonly state: 0 | 1 }
  | { readonly type: "delta"; readonly n: number; readonly delta: number }
  | { readonly type: "enckey"; readonly n: number; readonly state: 0 | 1 }
  | { readonly type: "tilt"; readonly n: number; readonly x: number; readonly y: number; readonly z: number };

/** `incoming_payload_lengths`, and zero for everything it does not name. */
function payloadLength(header: number): number {
  const section = header >> 4;
  const cmd = header & 0x0f;
  if (section === SYSTEM) return [2, 32, 3, 2, 2][cmd] ?? (cmd === 0xf ? 8 : 0);
  if (section === KEY_GRID) return cmd <= 1 ? 2 : 0;
  if (section === ENCODER) return cmd === 0 ? 2 : cmd <= 2 ? 1 : 0;
  if (section === TILT) return cmd === 0 ? 1 : cmd === 1 ? 7 : 0;
  return 0;
}

const int8 = (b: number): number => (b << 24) >> 24;
const int16 = (lo: number, hi: number): number => ((((hi << 8) | lo) << 16) >> 16);

/**
 * Bytes in, events out — across any chunking.
 *
 * A serial port hands over whatever has arrived, so a frame is routinely
 * split and several routinely come together. The remainder is kept.
 */
export class MextParser {
  private held = new Uint8Array(0);

  feed(chunk: Uint8Array): MextEvent[] {
    let buf = chunk;
    if (this.held.length > 0) {
      buf = new Uint8Array(this.held.length + chunk.length);
      buf.set(this.held);
      buf.set(chunk, this.held.length);
    }
    const out: MextEvent[] = [];
    let at = 0;
    while (at < buf.length) {
      const header = buf[at]!;
      const n = payloadLength(header);
      if (at + 1 + n > buf.length) break;
      const p = buf.subarray(at + 1, at + 1 + n);
      at += 1 + n;
      const section = header >> 4;
      const cmd = header & 0x0f;
      if (section === SYSTEM) {
        if (cmd === 0x0) out.push({ type: "query", section: p[0]!, count: p[1]! });
        else if (cmd === 0x1) {
          const end = p.indexOf(0);
          const raw = end < 0 ? p : p.subarray(0, end);
          out.push({ type: "id", name: String.fromCharCode(...raw).trim() });
        } else if (cmd === 0x3) out.push({ type: "size", cols: p[0]!, rows: p[1]! });
      } else if (section === KEY_GRID && cmd <= 1) {
        out.push({ type: "key", x: p[0]!, y: p[1]!, state: cmd === 1 ? 1 : 0 });
      } else if (section === ENCODER) {
        if (cmd === 0) out.push({ type: "delta", n: p[0]!, delta: int8(p[1]!) });
        else if (cmd === 1) out.push({ type: "enckey", n: p[0]!, state: 0 });
        else if (cmd === 2) out.push({ type: "enckey", n: p[0]!, state: 1 });
      } else if (section === TILT && cmd === 1) {
        out.push({ type: "tilt", n: p[0]!, x: int16(p[1]!, p[2]!), y: int16(p[3]!, p[4]!), z: int16(p[5]!, p[6]!) });
      }
    }
    this.held = at < buf.length ? buf.slice(at) : new Uint8Array(0);
    return out;
  }
}

/** Sections a query reply can name, for telling a grid from an arc. */
export const SECTION = { LED_GRID, KEY_GRID, ENCODER, LED_RING } as const;
