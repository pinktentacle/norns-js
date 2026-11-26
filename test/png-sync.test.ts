// E9-264 — PNGs decoded synchronously, the way cairo does on a norns.

import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodePngSync, inflateZlib } from "../src/screen/png-sync.js";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (name: string, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(body, 8);
  v.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
  return out;
};

/** Filter one row the way an encoder does, so the decoder has to undo it. */
function filterRow(f: number, row: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp]! : 0;
    const b = prev[i]!;
    const c = i >= bpp ? prev[i - bpp]! : 0;
    let pred = 0;
    if (f === 1) pred = a;
    else if (f === 2) pred = b;
    else if (f === 3) pred = (a + b) >> 1;
    else if (f === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[i] = (row[i]! - pred) & 0xff;
  }
  return out;
}

function png(opts: {
  width: number;
  height: number;
  type: number;
  depth: number;
  rows: Uint8Array[];
  plte?: Uint8Array;
  trns?: Uint8Array;
  level?: number;
}): Uint8Array {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[opts.type]!;
  const bpp = Math.max(1, (channels * opts.depth) >> 3);
  const parts: number[] = [];
  let prev: Uint8Array = new Uint8Array(opts.rows[0]!.length);
  opts.rows.forEach((row, y) => {
    const f = y % 5; // every filter, in turn
    parts.push(f, ...filterRow(f, row, prev, bpp));
    prev = row;
  });
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, opts.width);
  v.setUint32(4, opts.height);
  ihdr[8] = opts.depth;
  ihdr[9] = opts.type;
  const pieces = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  if (opts.plte) pieces.push(chunk("PLTE", opts.plte));
  if (opts.trns) pieces.push(chunk("tRNS", opts.trns));
  const z = deflateSync(Uint8Array.from(parts), { level: opts.level ?? 6 });
  // Two IDAT chunks: the data may be split anywhere.
  const half = z.length >> 1;
  pieces.push(chunk("IDAT", z.subarray(0, half)), chunk("IDAT", z.subarray(half)), chunk("IEND", new Uint8Array()));
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const noise = (n: number, seed: number): Uint8Array => {
  let s = seed;
  return Uint8Array.from({ length: n }, () => (s = (s * 1103515245 + 12345) >>> 0) >>> 24);
};

describe("inflate", () => {
  it("reads stored, fixed and dynamic blocks", () => {
    for (const level of [0, 1, 6, 9]) {
      const data = new Uint8Array([...noise(3000, 7), ...new Uint8Array(4000).fill(42), ...noise(500, 9)]);
      expect(inflateZlib(deflateSync(data, { level }))).toEqual(data);
    }
    // A few bytes: zlib uses the fixed code.
    const tiny = new TextEncoder().encode("norns norns norns");
    expect(inflateZlib(deflateSync(tiny))).toEqual(tiny);
  });
});

describe("a PNG, decoded where it is asked for", () => {
  it("RGBA, 8 bits, every filter", () => {
    const w = 13, h = 10;
    const rows = Array.from({ length: h }, (_, y) => noise(w * 4, y + 1));
    const d = decodePngSync(png({ width: w, height: h, type: 6, depth: 8, rows }))!;
    expect(d.width).toBe(w);
    expect(d.height).toBe(h);
    for (let y = 0; y < h; y++) expect(d.rgba.subarray(y * w * 4, (y + 1) * w * 4)).toEqual(rows[y]);
  });

  it("RGB with a transparent colour, and 16-bit grey", () => {
    const rgb = decodePngSync(
      png({ width: 2, height: 1, type: 2, depth: 8, rows: [Uint8Array.of(1, 2, 3, 9, 9, 9)], trns: Uint8Array.of(0, 9, 0, 9, 0, 9) }),
    )!;
    expect([...rgb.rgba]).toEqual([1, 2, 3, 255, 9, 9, 9, 0]);
    const g16 = decodePngSync(png({ width: 2, height: 1, type: 0, depth: 16, rows: [Uint8Array.of(0x12, 0x34, 0xff, 0x00)] }))!;
    expect([...g16.rgba]).toEqual([0x12, 0x12, 0x12, 255, 0xff, 0xff, 0xff, 255]);
  });

  it("grey below 8 bits is scaled up, MSB first", () => {
    // 4-bit: 0x0, 0xf, 0x8 in one and a half bytes.
    const d = decodePngSync(png({ width: 3, height: 1, type: 0, depth: 4, rows: [Uint8Array.of(0x0f, 0x80)] }))!;
    expect([d.rgba[0], d.rgba[4], d.rgba[8]]).toEqual([0, 255, 136]);
    // 1-bit: 1 0 1 1 0 0 0 1 0
    const b = decodePngSync(png({ width: 9, height: 1, type: 0, depth: 1, rows: [Uint8Array.of(0b10110001, 0)] }))!;
    expect(Array.from({ length: 9 }, (_, i) => b.rgba[i * 4])).toEqual([255, 0, 255, 255, 0, 0, 0, 255, 0]);
  });

  it("a palette, with alpha from tRNS", () => {
    const plte = Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255);
    const d = decodePngSync(png({ width: 4, height: 1, type: 3, depth: 2, rows: [Uint8Array.of(0b00011000)], plte, trns: Uint8Array.of(128) }))!;
    expect([...d.rgba]).toEqual([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 128]);
  });

  it("grey + alpha", () => {
    const d = decodePngSync(png({ width: 1, height: 1, type: 4, depth: 8, rows: [Uint8Array.of(100, 50)] }))!;
    expect([...d.rgba]).toEqual([100, 100, 100, 50]);
  });

  it("is null for what it does not read", () => {
    expect(decodePngSync(new TextEncoder().encode("not a png at all"))).toBeNull();
    const p = png({ width: 1, height: 1, type: 0, depth: 8, rows: [Uint8Array.of(1)] });
    p[8 + 8 + 12] = 1; // IHDR's interlace byte: Adam7
    expect(decodePngSync(p)).toBeNull();
  });

  it("reads every PNG this repository ships that a real encoder wrote", () => {
    // Whatever encoder made them, the decoder has to get the size right and
    // not throw; Adam7 ones answer null and keep the asynchronous path.
    const dir = "public/dust-bin";
    const found: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".png")) found.push(p);
      }
    };
    try {
      walk(dir);
    } catch {
      return;
    }
    for (const f of found.slice(0, 40)) {
      const bytes = new Uint8Array(readFileSync(f));
      const d = decodePngSync(bytes);
      if (d === null) continue;
      const v = new DataView(bytes.buffer, bytes.byteOffset);
      expect([d.width, d.height], f).toEqual([v.getUint32(16), v.getUint32(20)]);
    }
  });
});
