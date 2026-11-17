// E0-38 — a ustar reader/writer, dependency-free and isomorphic.
//
// Why hand-rolled rather than a library: the reader is the only part that has
// to run in the browser on every cold load, and it is ~90 lines. Pulling in
// js-untar / tar-stream / fflate to save those lines would add a dependency,
// a licence to track and bytes to the payload we are trying to shrink. The
// format is frozen (POSIX.1-1988) and the subset we emit is the subset GNU
// tar emits for a tree of plain files.
//
// The writer is deterministic on purpose: fixed mtime, uid, gid, mode and
// uname/gname, entries sorted by name. Identical inputs produce a
// byte-identical archive, so sha256(sclang-lib.tar) is a build identity.
//
// Reader scope: regular files ('0' and '\0'), directories ('5', skipped —
// the unpacker creates parents itself), GNU long names ('L'), and pax
// headers ('x'/'g', whose `path=` record is honoured). Anything else is
// skipped and counted. That covers GNU tar, bsdtar and our own writer.

export const BLOCK = 512;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------- writing ----

function octal(value, width) {
  // ustar numeric fields: `width - 1` octal digits then a NUL.
  const s = value.toString(8);
  if (s.length > width - 1) throw new Error(`value ${value} does not fit in ${width} octal bytes`);
  return s.padStart(width - 1, "0") + "\0";
}

function putAscii(buf, offset, limit, text) {
  const b = enc.encode(text);
  if (b.length > limit) throw new Error(`field overflow at ${offset}: ${JSON.stringify(text)}`);
  buf.set(b, offset);
}

/** Split a path into ustar's prefix[155] + name[100], or throw. */
function splitName(name) {
  if (enc.encode(name).length <= 100) return { prefix: "", name };
  for (let i = 0; i < name.length; i++) {
    if (name[i] !== "/") continue;
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(rest).length <= 100) return { prefix, name: rest };
  }
  throw new Error(`path too long for ustar (and we do not emit GNU long names): ${name}`);
}

function header({ name, size, mtime, mode, typeflag }) {
  const h = new Uint8Array(BLOCK);
  const split = splitName(name);
  putAscii(h, 0, 100, split.name);
  putAscii(h, 100, 8, octal(mode, 8));
  putAscii(h, 108, 8, octal(0, 8));          // uid
  putAscii(h, 116, 8, octal(0, 8));          // gid
  putAscii(h, 124, 12, octal(size, 12));
  putAscii(h, 136, 12, octal(mtime, 12));
  h.fill(0x20, 148, 156);                     // checksum field = 8 spaces while summing
  putAscii(h, 156, 1, typeflag);
  putAscii(h, 257, 6, "ustar\0");
  putAscii(h, 263, 2, "00");
  // uname/gname deliberately empty: nothing in the archive is user-specific.
  putAscii(h, 345, 155, split.prefix);
  let sum = 0;
  for (const b of h) sum += b;
  putAscii(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

/**
 * Build a ustar archive.
 *
 * @param entries {{name: string, data: Uint8Array}[]} — sorted internally
 * @param opts    {{mtime?: number, mode?: number}}
 * @returns {Uint8Array}
 */
export function writeTar(entries, opts = {}) {
  const mtime = opts.mtime ?? 0;
  const mode = opts.mode ?? 0o644;
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let total = 0;
  for (const e of sorted) total += BLOCK + Math.ceil(e.data.length / BLOCK) * BLOCK;
  total += 2 * BLOCK;                         // two zero blocks terminate the archive

  const out = new Uint8Array(total);
  let off = 0;
  for (const e of sorted) {
    out.set(header({ name: e.name, size: e.data.length, mtime, mode, typeflag: "0" }), off);
    off += BLOCK;
    out.set(e.data, off);
    off += Math.ceil(e.data.length / BLOCK) * BLOCK;
  }
  return out;
}

// ------------------------------------------------------------- reading ----

function str(bytes, offset, limit) {
  let end = offset;
  const stop = offset + limit;
  while (end < stop && bytes[end] !== 0) end++;
  return dec.decode(bytes.subarray(offset, end));
}

function readOctal(bytes, offset, limit) {
  // GNU base-256 encoding for huge values: high bit of the first byte set.
  if (bytes[offset] & 0x80) {
    let v = bytes[offset] & 0x7f;
    for (let i = offset + 1; i < offset + limit; i++) v = v * 256 + bytes[i];
    return v;
  }
  const s = str(bytes, offset, limit).trim();
  return s === "" ? 0 : parseInt(s, 8);
}

function checksumOk(bytes, off) {
  const stated = readOctal(bytes, off + 148, 8);
  let signed = 0;
  for (let i = off; i < off + BLOCK; i++) {
    const b = i >= off + 148 && i < off + 156 ? 0x20 : bytes[i];
    signed += b;
  }
  return signed === stated;
}

/**
 * Read a ustar archive.
 *
 * @param bytes {Uint8Array}
 * @returns {{entries: {name: string, data: Uint8Array}[], skipped: number}}
 *   `data` views the input buffer; it is not copied.
 */
export function readTar(bytes) {
  const entries = [];
  let skipped = 0;
  let longName = null;
  let paxPath = null;

  for (let off = 0; off + BLOCK <= bytes.length; ) {
    // A header of all zeroes ends the archive.
    let zero = true;
    for (let i = off; i < off + BLOCK; i++) if (bytes[i] !== 0) { zero = false; break; }
    if (zero) break;

    if (!checksumOk(bytes, off)) throw new Error(`tar: bad header checksum at offset ${off}`);

    const nameField = str(bytes, off, 100);
    const prefix = str(bytes, 345 + off, 155);
    const size = readOctal(bytes, off + 124, 12);
    const typeflag = String.fromCharCode(bytes[off + 156] || 0x30);
    const dataOff = off + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataOff + size > bytes.length) throw new Error(`tar: truncated entry at offset ${off}`);

    if (typeflag === "L") {                       // GNU long name for the NEXT entry
      longName = dec.decode(bytes.subarray(dataOff, dataOff + size)).replace(/\0+$/, "");
    } else if (typeflag === "x" || typeflag === "g") {
      const text = dec.decode(bytes.subarray(dataOff, dataOff + size));
      const m = /\d+ path=([^\n]*)\n/.exec(text);
      if (m && typeflag === "x") paxPath = m[1];
    } else if (typeflag === "0" || typeflag === "\0") {
      const name = paxPath ?? longName ?? (prefix ? prefix + "/" + nameField : nameField);
      entries.push({ name, data: bytes.subarray(dataOff, dataOff + size) });
      longName = null;
      paxPath = null;
    } else if (typeflag === "5") {
      longName = null;
      paxPath = null;                              // directories: the unpacker makes parents itself
    } else {
      skipped++;
      longName = null;
      paxPath = null;
    }

    off = dataOff + padded;
  }
  return { entries, skipped };
}
