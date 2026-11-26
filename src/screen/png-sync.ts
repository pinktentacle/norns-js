// E9-264 — A PNG DECODED ON THE SPOT, AS CAIRO DOES ON A NORNS.
//
// `screen.load_png` on a norns is `cairo_image_surface_create_from_png`:
// the pixels are there when it returns. Ours went through the browser's
// decoder, which is asynchronous, so the first draw of a picture drew
// nothing and asked for a redraw (images.ts). For a picture that is only
// LOOKED AT that is one blank frame. For a script that READS it, it is the
// whole picture: `esper` turns a 64x64 image into a 64-step sequence by
// drawing it a pixel at a time with `display_image_region` and reading each
// back with `screen.peek`, all in `init` — every pixel read 0, the grid was
// empty and nothing ever played.
//
// So a PNG whose bytes are already in memory is decoded here, synchronously:
// zlib inflate, the five scanline filters, and every colour type and bit
// depth the format has. Interlaced files (Adam7) answer null and keep the
// asynchronous path; they are rare and a picture that arrives a frame late
// still arrives. Gamma and colour profiles are ignored, as cairo's PNG
// loader ignores them.

export interface PngPixels {
  readonly width: number;
  readonly height: number;
  /** Straight (not premultiplied) RGBA, 8 bits a channel, row major. */
  readonly rgba: Uint8Array;
}

// --- inflate (RFC 1951) ------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** The order the code-length code's lengths are sent in. */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code: how many codes of each length, and the symbols in code order. */
interface Huffman {
  readonly count: Uint16Array;
  readonly symbol: Uint16Array;
}

function huffman(lengths: ArrayLike<number>, n: number): Huffman {
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]!]!++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len]! + count[len]!;
  const symbol = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbol[offs[lengths[i]!]!++] = i;
  return { count, symbol };
}

let FIXED: { lit: Huffman; dist: Huffman } | null = null;
function fixed(): { lit: Huffman; dist: Huffman } {
  if (FIXED === null) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144);
    l.fill(9, 144, 256);
    l.fill(7, 256, 280);
    l.fill(8, 280, 288);
    FIXED = { lit: huffman(l, 288), dist: huffman(new Uint8Array(30).fill(5), 30) };
  }
  return FIXED;
}

class Inflater {
  private pos: number;
  private buf = 0;
  private cnt = 0;
  out: Uint8Array;
  len = 0;

  constructor(
    private readonly src: Uint8Array,
    start: number,
    expected: number,
  ) {
    this.pos = start;
    this.out = new Uint8Array(Math.max(1024, expected));
  }

  private bits(n: number): number {
    let v = this.buf;
    while (this.cnt < n) {
      if (this.pos >= this.src.length) throw new Error("inflate: ran out of input");
      v |= this.src[this.pos++]! << this.cnt;
      this.cnt += 8;
    }
    this.buf = v >>> n;
    this.cnt -= n;
    return v & ((1 << n) - 1);
  }

  private decode(h: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= this.bits(1);
      const count = h.count[len]!;
      if (code - count < first) return h.symbol[index + (code - first)]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error("inflate: bad code");
  }

  private room(n: number): void {
    if (this.len + n <= this.out.length) return;
    let size = this.out.length * 2;
    while (size < this.len + n) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.out.subarray(0, this.len));
    this.out = grown;
  }

  private stored(): void {
    this.buf = 0;
    this.cnt = 0;
    if (this.pos + 4 > this.src.length) throw new Error("inflate: short stored block");
    const n = this.src[this.pos]! | (this.src[this.pos + 1]! << 8);
    const check = this.src[this.pos + 2]! | (this.src[this.pos + 3]! << 8);
    if ((n ^ 0xffff) !== check) throw new Error("inflate: stored block length");
    this.pos += 4;
    if (this.pos + n > this.src.length) throw new Error("inflate: short stored block");
    this.room(n);
    this.out.set(this.src.subarray(this.pos, this.pos + n), this.len);
    this.len += n;
    this.pos += n;
  }

  private codes(lit: Huffman, dist: Huffman): void {
    for (;;) {
      const sym = this.decode(lit);
      if (sym < 256) {
        this.room(1);
        this.out[this.len++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        const li = sym - 257;
        if (li >= 29) throw new Error("inflate: bad length");
        const n = LEN_BASE[li]! + this.bits(LEN_EXTRA[li]!);
        const di = this.decode(dist);
        if (di >= 30) throw new Error("inflate: bad distance");
        const d = DIST_BASE[di]! + this.bits(DIST_EXTRA[di]!);
        if (d > this.len) throw new Error("inflate: distance too far back");
        this.room(n);
        const o = this.out;
        // Byte by byte: a copy may overlap what it is writing.
        for (let i = 0; i < n; i++, this.len++) o[this.len] = o[this.len - d]!;
      }
    }
  }

  private dynamic(): void {
    const nlen = this.bits(5) + 257;
    const ndist = this.bits(5) + 1;
    const ncode = this.bits(4) + 4;
    if (nlen > 286 || ndist > 30) throw new Error("inflate: bad counts");
    const lengths = new Uint8Array(320);
    for (let i = 0; i < ncode; i++) lengths[CL_ORDER[i]!] = this.bits(3);
    const cl = huffman(lengths, 19);
    lengths.fill(0);
    let i = 0;
    while (i < nlen + ndist) {
      const sym = this.decode(cl);
      if (sym < 16) {
        lengths[i++] = sym;
        continue;
      }
      let len = 0;
      let rep: number;
      if (sym === 16) {
        if (i === 0) throw new Error("inflate: repeat with nothing before it");
        len = lengths[i - 1]!;
        rep = 3 + this.bits(2);
      } else if (sym === 17) rep = 3 + this.bits(3);
      else rep = 11 + this.bits(7);
      if (i + rep > nlen + ndist) throw new Error("inflate: too many lengths");
      while (rep--) lengths[i++] = len;
    }
    this.codes(huffman(lengths, nlen), huffman(lengths.subarray(nlen), ndist));
  }

  run(): Uint8Array {
    let last = 0;
    while (!last) {
      last = this.bits(1);
      const type = this.bits(2);
      if (type === 0) this.stored();
      else if (type === 1) this.codes(fixed().lit, fixed().dist);
      else if (type === 2) this.dynamic();
      else throw new Error("inflate: bad block type");
    }
    return this.out.subarray(0, this.len);
  }
}

/** A zlib stream (RFC 1950): two header bytes, deflate, a checksum not checked. */
export function inflateZlib(src: Uint8Array, expected = 0): Uint8Array {
  if (src.length < 2 || (src[0]! & 0x0f) !== 8 || ((src[0]! << 8) | src[1]!) % 31 !== 0) {
    throw new Error("inflate: not a zlib stream");
  }
  if (src[1]! & 0x20) throw new Error("inflate: preset dictionary");
  return new Inflater(src, 2, expected).run();
}

// --- PNG ------------------------------------------------------------------

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The pixels of a PNG, or null for what this does not read (Adam7, or not a PNG). */
export function decodePngSync(bytes: Uint8Array): PngPixels | null {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = view.getUint32(p);
    const name = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (body.length !== len) return null;
    if (name === "IHDR") {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      depth = bytes[p + 16]!;
      type = bytes[p + 17]!;
      interlace = bytes[p + 20]!;
    } else if (name === "PLTE") palette = body;
    else if (name === "tRNS") trns = body;
    else if (name === "IDAT") idat.push(body);
    else if (name === "IEND") break;
    p += 12 + len;
  }
  const channels = CHANNELS[type];
  if (channels === undefined || width === 0 || height === 0 || interlace !== 0) return null;
  if (type === 3 && palette === null) return null;
  const bitsPerPixel = channels * depth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);

  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  let at = 0;
  for (const c of idat) {
    z.set(c, at);
    at += c.length;
  }
  const raw = inflateZlib(z, height * (rowBytes + 1));
  if (raw.length < height * (rowBytes + 1)) return null;

  // Unfilter in place, row by row (filter byte, then the row).
  const rows = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (rowBytes + 1)]!;
    const src = y * (rowBytes + 1) + 1;
    const cur = y * rowBytes;
    const prev = cur - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[src + i]!;
      const a = i >= bpp ? rows[cur + i - bpp]! : 0;
      const b = y > 0 ? rows[prev + i]! : 0;
      const c = i >= bpp && y > 0 ? rows[prev + i - bpp]! : 0;
      let v: number;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else return null;
      rows[cur + i] = v & 0xff;
    }
  }

  // To RGBA. A sample below 8 bits is scaled up; a 16-bit one keeps its high byte.
  const max = (1 << Math.min(depth, 8)) - 1;
  const sample = (row: number, index: number): number => {
    if (depth === 8) return rows[row + index]!;
    if (depth === 16) return rows[row + index * 2]!;
    const bit = index * depth;
    return (rows[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & max;
  };
  /** The full-precision sample, for comparing with tRNS. */
  const exact = (row: number, index: number): number =>
    depth === 16 ? (rows[row + index * 2]! << 8) | rows[row + index * 2 + 1]! : sample(row, index);
  const scale = (v: number): number => (depth >= 8 ? v : Math.round((v * 255) / max));
  const trnsAt = (k: number): number => (trns !== null && trns.length >= 2 * (k + 1) ? (trns[2 * k]! << 8) | trns[2 * k + 1]! : -1);

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (type === 0) {
        const g = scale(sample(row, s));
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = exact(row, s) === trnsAt(0) ? 0 : 255;
      } else if (type === 2) {
        rgba[o] = sample(row, s);
        rgba[o + 1] = sample(row, s + 1);
        rgba[o + 2] = sample(row, s + 2);
        const clear =
          trns !== null && exact(row, s) === trnsAt(0) && exact(row, s + 1) === trnsAt(1) && exact(row, s + 2) === trnsAt(2);
        rgba[o + 3] = clear ? 0 : 255;
      } else if (type === 3) {
        const k = sample(row, s);
        rgba[o] = palette![k * 3] ?? 0;
        rgba[o + 1] = palette![k * 3 + 1] ?? 0;
        rgba[o + 2] = palette![k * 3 + 2] ?? 0;
        rgba[o + 3] = trns !== null && k < trns.length ? trns[k]! : 255;
      } else if (type === 4) {
        const g = sample(row, s);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = sample(row, s + 1);
      } else {
        rgba[o] = sample(row, s);
        rgba[o + 1] = sample(row, s + 1);
        rgba[o + 2] = sample(row, s + 2);
        rgba[o + 3] = sample(row, s + 3);
      }
    }
  }
  return { width, height, rgba };
}
