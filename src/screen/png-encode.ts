// E9-267 — a PNG, written. audiowaveform draws one for a script to show
// with `screen.display_png`, and the browser has no synchronous encoder.
//
// Truecolour, 8 bits, no interlace, every row filter 0, and the zlib
// stream made of STORED blocks: valid PNG that any decoder reads
// (src/screen/png-sync.ts among them), larger than a compressed one. The
// images are a script's waveform view, a few kilobytes either way, and a
// deflate here would be code with nothing to show for it.

import { crc32 } from "../fs/zip.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib around stored deflate blocks of at most 65535 bytes. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535;
    const len = Math.min(65535, raw.length - start);
    out[at++] = b === blocks - 1 ? 1 : 0;
    out[at++] = len & 0xff;
    out[at++] = len >> 8;
    out[at++] = ~len & 0xff;
    out[at++] = (~len >> 8) & 0xff;
    out.set(raw.subarray(start, start + len), at);
    at += len;
  }
  const ad = adler32(raw);
  out[at++] = ad >>> 24;
  out[at++] = (ad >>> 16) & 0xff;
  out[at++] = (ad >>> 8) & 0xff;
  out[at++] = ad & 0xff;
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * `pixels` is `width * height` pixels, RGB, or RGBA when `alpha`; rows top
 * to bottom.
 */
export function encodePng(width: number, height: number, pixels: Uint8Array, alpha: boolean): Uint8Array {
  const bpp = alpha ? 4 : 3;
  if (pixels.length !== width * height * bpp) throw new Error("encodePng: pixel count does not match the size");
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  const raw = new Uint8Array(height * (1 + width * bpp));
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width * bpp, (y + 1) * width * bpp), y * (1 + width * bpp) + 1);
  }
  const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
