// E9-228 — an archive, whatever it is: zip, tar, or tar.gz.
//
// E9-226 taught the shell `unzip`, and the relay (E9-227) brought GitHub
// release downloads within reach. The sample-pack sweep then found the
// other half of the same habit: lorenzos-drums installs its samples with
// `wget … .tar.gz && tar -xzvf …`, amenbreak with a `.tar` and a `.tar.gz`.
// The bytes arrive; nothing could open them.
//
// One entry point that looks at the bytes rather than the name, because a
// name says what its author meant and the first bytes say what it is:
// `PK` is a zip, `1f 8b` is gzip (inflated here by the browser's own
// DecompressionStream, then read again), and a tar is recognised by its
// first header's checksum — `ustar` is absent from the old v7 format, and a
// checksum is what tar itself checks.

import { unzip, type ZipEntry } from "./zip.js";

const BLOCK = 512;

/** gzip, inflated by the platform (browsers and Node 18+ both have it). */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const text = (b: Uint8Array): string => {
  const end = b.indexOf(0);
  return new TextDecoder().decode(end < 0 ? b : b.subarray(0, end));
};

/** A tar number: octal text, or (GNU, for files over 8 GB) base-256 with the top bit set. */
function num(b: Uint8Array): number {
  if ((b[0]! & 0x80) !== 0) {
    let n = b[0]! & 0x7f;
    for (let i = 1; i < b.length; i++) n = n * 256 + b[i]!;
    return n;
  }
  const t = text(b).trim();
  return t === "" ? 0 : parseInt(t, 8);
}

/** Whether a 512-byte block is a tar header: its checksum says so. */
function isHeader(h: Uint8Array): boolean {
  if (h.length < BLOCK) return false;
  const stored = num(h.subarray(148, 156));
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === stored;
}

/** The PAX records of an `x` header: `<len> <key>=<value>\n`. */
function pax(b: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const t = new TextDecoder().decode(b);
  let at = 0;
  while (at < t.length) {
    const sp = t.indexOf(" ", at);
    if (sp < 0) break;
    const len = Number(t.slice(at, sp));
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = t.slice(sp + 1, at + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    at += len;
  }
  return out;
}

/** The regular files of a tar, with the paths it gives them (ustar prefix, PAX and GNU long names). */
export function untar(bytes: Uint8Array): ZipEntry[] {
  const out: ZipEntry[] = [];
  let at = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  let paxSize: number | null = null;
  while (at + BLOCK <= bytes.length) {
    const h = bytes.subarray(at, at + BLOCK);
    if (h.every((v) => v === 0)) break; // the end: two zero blocks, one is enough to stop
    if (!isHeader(h)) throw new Error(`not a tar file: no valid header at byte ${at}`);
    const type = String.fromCharCode(h[156]!);
    const size = paxSize ?? num(h.subarray(124, 136));
    const data = bytes.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "L") {
      longName = text(data);
      continue;
    }
    if (type === "x") {
      const p = pax(data);
      paxPath = p.get("path") ?? null;
      const s = p.get("size");
      paxSize = s !== undefined ? Number(s) : null;
      continue;
    }
    if (type === "g") continue; // global PAX: nothing a file needs
    const magic = text(h.subarray(257, 263));
    const prefix = magic.startsWith("ustar") ? text(h.subarray(345, 500)) : "";
    const name = paxPath ?? longName ?? (prefix !== "" ? `${prefix}/${text(h.subarray(0, 100))}` : text(h.subarray(0, 100)));
    longName = null;
    paxPath = null;
    paxSize = null;
    // Regular files only: directories are made by the files in them, and a
    // link, a device or a fifo is nothing a dust folder can hold.
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    out.push({ path: name, bytes: data.slice() });
  }
  return out;
}

/**
 * The files of an archive — zip, tar or tar.gz, told apart by their bytes.
 * Throws, naming what it saw, for anything else.
 */
export async function unpack(bytes: Uint8Array): Promise<ZipEntry[]> {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return unzip(bytes);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const inner = await gunzip(bytes);
    if (inner.length >= BLOCK && isHeader(inner.subarray(0, BLOCK))) return untar(inner);
    throw new Error("a gzip file that is not a tar: nothing says what its one file is called");
  }
  if (bytes.length >= BLOCK && isHeader(bytes.subarray(0, BLOCK))) return untar(bytes);
  if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    throw new Error("a bzip2 archive: this build reads zip, tar and tar.gz");
  }
  if (bytes.length >= 6 && bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a) {
    throw new Error("an xz archive: this build reads zip, tar and tar.gz");
  }
  throw new Error("not an archive this build can read (zip, tar, tar.gz)");
}
