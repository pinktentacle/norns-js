// Minimal OSC 1.0 encoder/decoder.
//
// sclang-wasm exposes OSC as raw bytes: sendOsc(Uint8Array) in,
// Module.onOsc(Uint8Array) out. There is no socket, so we need to build and
// parse the wire format ourselves. This is the whole of what norns needs:
// int32, float32 and string arguments.

const enc = new TextEncoder();
const dec = new TextDecoder();

const pad4 = (n) => (n + 3) & ~3;

function encString(s) {
  const b = enc.encode(s);
  const out = new Uint8Array(pad4(b.length + 1)); // +1 forces a NUL terminator
  out.set(b);
  return out;
}

/** Encode an OSC message. Args are inferred: number->f unless Number.isInteger. */
export function encodeMessage(address, args = []) {
  const parts = [encString(address)];
  let tags = ",";
  const bodies = [];
  for (const a of args) {
    if (typeof a === "string") {
      tags += "s";
      bodies.push(encString(a));
    } else if (typeof a === "number" && Number.isInteger(a)) {
      tags += "i";
      const b = new Uint8Array(4);
      new DataView(b.buffer).setInt32(0, a, false); // OSC is big-endian
      bodies.push(b);
    } else if (typeof a === "number") {
      tags += "f";
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, a, false);
      bodies.push(b);
    } else if (a instanceof Uint8Array) {
      // A BLOB: int32 length, the bytes, then padding to four. sclang sends
      // SynthDefs this way, so an encoder that cannot write one cannot
      // reproduce the traffic it is meant to speak.
      tags += "b";
      const pad = pad4(a.length) - a.length;
      const b = new Uint8Array(4 + a.length + pad);
      new DataView(b.buffer).setInt32(0, a.length, false);
      b.set(a, 4);
      bodies.push(b);
    } else {
      throw new Error(`unsupported OSC arg: ${typeof a}`);
    }
  }
  parts.push(encString(tags), ...bodies);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function readString(view, bytes, o) {
  let end = o;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return [dec.decode(bytes.subarray(o, end)), pad4(end - o + 1) + o];
}

/** Decode one OSC message or bundle. Returns {address, args} or {bundle:[...]}. */
export function decode(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let [address, o] = readString(view, bytes, 0);

  if (address === "#bundle") {
    o += 8; // skip the NTP timetag
    const bundle = [];
    while (o + 4 <= bytes.length) {
      const size = view.getInt32(o, false);
      o += 4;
      if (size <= 0 || o + size > bytes.length) break;
      bundle.push(decode(bytes.subarray(o, o + size)));
      o += size;
    }
    return { bundle };
  }

  const args = [];
  if (o < bytes.length && bytes[o] === 0x2c /* ',' */) {
    let tags;
    [tags, o] = readString(view, bytes, o);
    for (const t of tags.slice(1)) {
      if (t === "i") { args.push(view.getInt32(o, false)); o += 4; }
      else if (t === "f") { args.push(view.getFloat32(o, false)); o += 4; }
      else if (t === "s") { const [s, no] = readString(view, bytes, o); args.push(s); o = no; }
      else if (t === "d") { args.push(view.getFloat64(o, false)); o += 8; }
      else { args.push(`<unhandled tag ${t}>`); break; }
    }
  }
  return { address, args };
}
