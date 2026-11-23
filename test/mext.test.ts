// E9-204 — the serial protocol of a grid or an arc, against libmonome.
//
// Transcribed from `libmonome/src/proto/mext.c`, `mext.h` and `rotation.c`.
// Nobody here has the hardware, so the checks are of two kinds: frames
// compared byte for byte with what those sources produce, and the rotation
// checked against itself — a block turned and sent to where libmonome sends
// it has to land where turning each point one at a time says it should.

import { describe, expect, it } from "vitest";
import {
  GET_GRID_SIZE,
  GET_ID,
  MextParser,
  QUERY,
  gridIntensity,
  levelMap,
  ringIntensity,
  ringMap,
  rotateIn,
  rotateOut,
  tilt,
  type Rotation,
} from "../src/monome/mext.js";

const ROTATIONS: Rotation[] = [0, 1, 2, 3];
/** Physical sizes: cols, rows. */
const GRIDS: [number, number][] = [
  [8, 8],
  [16, 8],
  [16, 16],
];
/** The size the SCRIPT sees: a quarter turn swaps the two. */
const turned = (r: Rotation, cols: number, rows: number): [number, number] =>
  r === 1 || r === 3 ? [rows, cols] : [cols, rows];

describe("the three questions mext_open asks", () => {
  it("are one byte each", () => {
    expect([...QUERY]).toEqual([0x00]);
    expect([...GET_ID]).toEqual([0x01]);
    expect([...GET_GRID_SIZE]).toEqual([0x05]);
  });
});

describe("frames out", () => {
  it("packs a level map as mext_led_level_map does", () => {
    const levels = Uint8Array.from({ length: 64 }, (_, i) => i % 16);
    const f = levelMap(8, 0, levels, 0, 16, 8);
    expect(f.length).toBe(35);
    expect([f[0], f[1], f[2]]).toEqual([0x1a, 8, 0]);
    // pack_nybbles: (even << 4) | odd.
    expect(f[3]).toBe(0x01);
    expect(f[4]).toBe(0x23);
    expect(f[10]).toBe(0xef);
    expect(f[11]).toBe(0x01);
  });

  it("keeps a level inside its nybble", () => {
    const f = levelMap(0, 0, new Uint8Array(64).fill(0xff), 0, 8, 8);
    expect([...f.subarray(3)].every((b) => b === 0xff)).toBe(true);
    expect([...gridIntensity(31)]).toEqual([0x17, 0x0f]);
  });

  it("writes a ring map and the intensity libmonome writes, extra byte included", () => {
    const f = ringMap(2, Uint8Array.from({ length: 64 }, (_, i) => (i === 0 ? 15 : i === 1 ? 3 : 0)));
    expect(f.length).toBe(34);
    expect([f[0], f[1], f[2]]).toEqual([0x92, 2, 0xf3]);
    // Its length table says two for a payload of one, so two are written.
    expect([...ringIntensity(9)]).toEqual([0x94, 9, 0]);
  });

  it("enables and disables a tilt sensor", () => {
    expect([...tilt(0, true)]).toEqual([0x81, 0]);
    expect([...tilt(1, false)]).toEqual([0x82, 1]);
  });
});

describe("rotation", () => {
  it("comes back to where it started, for every key of every grid", () => {
    for (const [pc, pr] of GRIDS) {
      for (const r of ROTATIONS) {
        const [cols, rows] = turned(r, pc, pr);
        const seen = new Set<number>();
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const [px, py] = rotateOut(r, x, y, cols, rows);
            expect(px >= 0 && px < pc && py >= 0 && py < pr, `${pc}x${pr} r${r} (${x},${y})`).toBe(true);
            seen.add(py * pc + px);
            expect(rotateIn(r, px, py, cols, rows)).toEqual([x, y]);
          }
        }
        // Every physical key is reached exactly once.
        expect(seen.size).toBe(pc * pr);
      }
    }
  });

  it("is libmonome's, on a 16x8", () => {
    // r90_output_cb: x' = y, y' = COLS - x, with COLS the turned width less one.
    expect(rotateOut(1, 0, 0, 8, 16)).toEqual([0, 7]);
    expect(rotateOut(1, 7, 15, 8, 16)).toEqual([15, 0]);
    // r180: both mirrored.
    expect(rotateOut(2, 0, 0, 16, 8)).toEqual([15, 7]);
    // r270_output_cb: x' = ROWS - y, y' = x.
    expect(rotateOut(3, 0, 0, 8, 16)).toEqual([15, 0]);
  });

  it("puts a turned block where turning each point puts it", () => {
    // The block is turned AND its origin is turned, and the grid takes the
    // block the origin lands in. Lit that way, every LED has to be the one
    // the point-by-point rule names.
    for (const [pc, pr] of GRIDS) {
      for (const r of ROTATIONS) {
        const [cols, rows] = turned(r, pc, pr);
        const level = (x: number, y: number): number => (x * 3 + y * 5 + 1) % 16;
        const physical = new Uint8Array(pc * pr).fill(0xee);
        for (let yOff = 0; yOff < rows; yOff += 8) {
          for (let xOff = 0; xOff < cols; xOff += 8) {
            const block = Uint8Array.from({ length: 64 }, (_, i) => level(xOff + (i & 7), yOff + (i >> 3)));
            const f = levelMap(xOff, yOff, block, r, cols, rows);
            const x0 = f[1]! & 0xf8;
            const y0 = f[2]! & 0xf8;
            for (let i = 0; i < 64; i++) {
              const b = f[3 + (i >> 1)]!;
              physical[(y0 + (i >> 3)) * pc + x0 + (i & 7)] = i % 2 === 0 ? b >> 4 : b & 0x0f;
            }
          }
        }
        for (let py = 0; py < pr; py++) {
          for (let px = 0; px < pc; px++) {
            const [x, y] = rotateIn(r, px, py, cols, rows);
            expect(physical[py * pc + px], `${pc}x${pr} r${r} physical (${px},${py})`).toBe(level(x, y));
          }
        }
      }
    }
  });
});

describe("frames in", () => {
  it("reads keys, down and up", () => {
    const p = new MextParser();
    expect(p.feed(Uint8Array.of(0x21, 3, 5, 0x20, 3, 5))).toEqual([
      { type: "key", x: 3, y: 5, state: 1 },
      { type: "key", x: 3, y: 5, state: 0 },
    ]);
  });

  it("puts back together a frame the port cut in two", () => {
    const p = new MextParser();
    expect(p.feed(Uint8Array.of(0x21, 3))).toEqual([]);
    expect(p.feed(Uint8Array.of(5, 0x20))).toEqual([{ type: "key", x: 3, y: 5, state: 1 }]);
    expect(p.feed(Uint8Array.of(15, 7))).toEqual([{ type: "key", x: 15, y: 7, state: 0 }]);
  });

  it("reads the three answers of the handshake", () => {
    const p = new MextParser();
    const id = new Uint8Array(33);
    id[0] = 0x01;
    id.set(new TextEncoder().encode("monome 128"), 1);
    expect(p.feed(Uint8Array.of(0x00, 1, 1, 0x00, 2, 1))).toEqual([
      { type: "query", section: 1, count: 1 },
      { type: "query", section: 2, count: 1 },
    ]);
    expect(p.feed(id)).toEqual([{ type: "id", name: "monome 128" }]);
    expect(p.feed(Uint8Array.of(0x03, 16, 8))).toEqual([{ type: "size", cols: 16, rows: 8 }]);
  });

  it("reads an encoder turning either way, and its key", () => {
    const p = new MextParser();
    expect(p.feed(Uint8Array.of(0x50, 2, 0xfd, 0x50, 0, 4, 0x52, 1, 0x51, 1))).toEqual([
      { type: "delta", n: 2, delta: -3 },
      { type: "delta", n: 0, delta: 4 },
      { type: "enckey", n: 1, state: 1 },
      { type: "enckey", n: 1, state: 0 },
    ]);
  });

  it("reads tilt as three signed sixteen-bit numbers", () => {
    const p = new MextParser();
    expect(p.feed(Uint8Array.of(0x81, 0, 0x10, 0x00, 0xff, 0xff, 0x00, 0x80))).toEqual([
      { type: "tilt", n: 0, x: 16, y: -1, z: -32768 },
    ]);
  });

  it("steps over a header it does not know, as mext_read_msg does", () => {
    // A length table of zeroes: an unknown header has no payload.
    const p = new MextParser();
    expect(p.feed(Uint8Array.of(0x5e, 0x69, 0x0a, 0x21, 1, 2))).toEqual([{ type: "key", x: 1, y: 2, state: 1 }]);
  });
});
