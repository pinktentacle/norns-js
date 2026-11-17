// E6-08 — a zip reader and writer, because a tree has to be able to leave.
//
// Everything a user makes here lives in one origin's storage: a script they
// wrote, the psets they saved, a tape they recorded. Clear the site data and
// it is gone, with no warning and no copy. So there has to be a way out, and
// a way back in — and the format has to be one that other things can open,
// which means zip rather than something of our own.
//
// WRITTEN BY HAND, and the reason is the usual one for this project: a zip
// writer that only has to do what we need is about two hundred lines, and
// the alternative is a dependency whose job is to handle ninety-six things
// we will never produce. What is NOT handled is said out loud at the bottom.
//
// DEFLATE COMES FROM THE PLATFORM. `CompressionStream("deflate-raw")` is in
// every browser this targets and in Node 18, so the one genuinely hard part
// is not ours. A file that will not compress is STORED instead, which is
// both smaller and what every zip writer does.

/** One file in an archive. Paths are relative and use forward slashes. */
export interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** CRC-32, the one every zip entry carries. */
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * MS-DOS date and time, which is what a zip carries and which cannot hold a
 * year before 1980. Anything earlier is clamped rather than wrapped: a file
 * dated 1970 is a file with no date, not a file from 2058.
 */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export async function zip(entries: readonly ZipEntry[], when = new Date()): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const { time, date } = dosTime(when);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.path);
    const crc = crc32(e.bytes);
    const packed = await deflate(e.bytes);
    // STORED when deflate did not help, which happens for anything already
    // compressed and for very short files. Every reader handles both.
    const useDeflate = packed.length < e.bytes.length;
    const body = useDeflate ? packed : e.bytes;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;

    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, e.bytes.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra
    local.set(name, 30);
    local.set(body, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, e.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of [...locals, ...centrals, eocd]) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/**
 * Read an archive, from its CENTRAL DIRECTORY and not by scanning for local
 * headers.
 *
 * The central directory is the authority: a local header may carry zeroes
 * for the sizes with the real values in a trailing descriptor (bit 3 of the
 * flags), and a scanner that trusted it would read the wrong number of
 * bytes. Reading the directory first costs nothing and never has that
 * problem.
 */
export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The EOCD is at the end, possibly behind a comment of up to 64 KB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file: no end-of-central-directory record");

  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(at, true) !== SIG_CENTRAL) throw new Error("zip: bad central directory");
    const method = dv.getUint16(at + 10, true);
    const crc = dv.getUint32(at + 16, true);
    const csize = dv.getUint32(at + 20, true);
    const usize = dv.getUint32(at + 24, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const localAt = dv.getUint32(at + 42, true);
    const path = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    if (dv.getUint32(localAt, true) !== SIG_LOCAL) throw new Error(`zip: bad entry ${path}`);
    const lNameLen = dv.getUint16(localAt + 26, true);
    const lExtraLen = dv.getUint16(localAt + 28, true);
    const bodyAt = localAt + 30 + lNameLen + lExtraLen;
    const body = bytes.subarray(bodyAt, bodyAt + csize);

    // A directory entry: zero bytes and a trailing slash. Kept out, because
    // what comes back is a list of FILES and the caller makes the folders.
    if (path.endsWith("/")) continue;

    let data: Uint8Array;
    if (method === METHOD_STORE) data = body.slice();
    else if (method === METHOD_DEFLATE) data = await inflate(body);
    else throw new Error(`zip: ${path} uses compression method ${method}`);

    if (data.length !== usize) throw new Error(`zip: ${path} is the wrong length`);
    // CHECKED, not assumed. A zip that survived a bad transfer looks exactly
    // like a good one until something reads the contents.
    if (crc32(data) !== crc) throw new Error(`zip: ${path} failed its checksum`);
    out.push({ path, bytes: data });
  }
  return out;
}

// NOT HANDLED, and each one would be noticed rather than silently wrong:
//
//   * zip64 — archives over 4 GB or with more than 65535 entries. The EOCD
//     fields saturate, and `unzip` would read a short count rather than
//     failing. A dust tree reaching either is not a case worth carrying.
//   * encryption — refused by the method check.
//   * anything but store and deflate — refused by the method check.
//   * file modes and symlinks — external attributes are written as zero, so
//     a tree that leaves and comes back is all regular files. The VFS has
//     no modes either, so nothing is lost on the round trip.
