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

/**
 * Encode an OSC message. Args are inferred: number->f unless Number.isInteger.
 *
 * E9-156 — ONE BUFFER AND ONE DataView, measured into existence.
 *
 * A `?profile=90` from a Pixel 9 Pro, playing `kolor`:
 *
 *     30.1% self   31.1% total   encodeMessage
 *
 * The hottest function in the page by a factor of three, and the version
 * it replaces allocated per ARGUMENT: a four-byte `Uint8Array` and — the
 * expensive half — a `DataView` over it, for every number. `kolor`'s
 * engine command is
 *
 *     kolorplay iffffffffffffffffffffffffffffffffffffffffffffffff
 *
 * one int and forty-seven floats, sent on every trigger of a running
 * lattice. That is ninety-six objects per message before the tag string,
 * the `bodies` array, the spread into `parts`, the reduce and the final
 * copy: something near a hundred and fifty allocations to produce two
 * hundred and sixty bytes.
 *
 * So: measure, allocate once, write in place. The sizes are arithmetic —
 * a string pads to four, a number is four, a blob is four plus its own
 * padded length — and knowing them up front removes every intermediate.
 * The tag string is built into an array and joined, which is one string
 * instead of forty-eight.
 *
 * The wire format is unchanged and `decode` is untouched; the round trip
 * is what the tests check.
 */
export function encodeMessage(address, args = []) {
  const addr = enc.encode(address);
  const addrLen = pad4(addr.length + 1);

  // PASS ONE: how big, and what each argument is. Strings are encoded
  // here rather than twice, because `TextEncoder` is not free either.
  const tags = new Array(args.length + 1);
  tags[0] = ",";
  const strings = [];
  let bodyLen = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === "string") {
      const b = enc.encode(a);
      strings.push(b);
      tags[i + 1] = "s";
      bodyLen += pad4(b.length + 1);
    } else if (typeof a === "number") {
      tags[i + 1] = Number.isInteger(a) ? "i" : "f";
      bodyLen += 4;
    } else if (a instanceof Uint8Array) {
      // A BLOB: int32 length, the bytes, then padding to four. sclang
      // sends SynthDefs this way, so an encoder that cannot write one
      // cannot reproduce the traffic it is meant to speak.
      tags[i + 1] = "b";
      bodyLen += 4 + pad4(a.length);
    } else {
      throw new Error(`unsupported OSC arg: ${typeof a}`);
    }
  }
  const tagStr = tags.join("");
  const tagLen = pad4(tagStr.length + 1);

  const out = new Uint8Array(addrLen + tagLen + bodyLen);
  const view = new DataView(out.buffer);
  out.set(addr, 0);
  // `encodeInto` writes straight into the buffer; the NUL terminator and
  // the padding are already zero because the array was allocated so.
  enc.encodeInto(tagStr, out.subarray(addrLen, addrLen + tagLen));

  // PASS TWO: the bodies, in order, into the space already counted.
  let o = addrLen + tagLen;
  let str = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const t = tags[i + 1];
    if (t === "s") {
      const b = strings[str++];
      out.set(b, o);
      o += pad4(b.length + 1);
    } else if (t === "i") {
      view.setInt32(o, a, false); // OSC is big-endian
      o += 4;
    } else if (t === "f") {
      view.setFloat32(o, a, false);
      o += 4;
    } else {
      view.setInt32(o, a.length, false);
      out.set(a, o + 4);
      o += 4 + pad4(a.length);
    }
  }
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
    // E9-238 — every type matron's `w_handle_osc_event` hands Lua, as it
    // hands it. Only i, f, s and d were read, and anything else ended the
    // message with a string saying so: eterna's engine sends its waveform as
    // an Int8Array — a BLOB — followed by the buffer it belongs to, and the
    // script got one argument, "<unhandled tag b>", and no buffer at all.
    // A blob is a Lua string byte for byte (lua_pushlstring), which is what a
    // Uint8Array becomes on the way in (lua.ts).
    for (const t of tags.slice(1)) {
      if (t === "i") { args.push(view.getInt32(o, false)); o += 4; }
      else if (t === "f") { args.push(view.getFloat32(o, false)); o += 4; }
      else if (t === "s" || t === "S") { const [s, no] = readString(view, bytes, o); args.push(s); o = no; }
      else if (t === "d") { args.push(view.getFloat64(o, false)); o += 8; }
      else if (t === "b") {
        const n = view.getInt32(o, false);
        o += 4;
        args.push(bytes.slice(o, o + n));
        o += (n + 3) & ~3;
      }
      else if (t === "h") { args.push(Number(view.getBigInt64(o, false))); o += 8; }
      else if (t === "c") { args.push(String.fromCharCode(view.getInt32(o, false) & 0xff)); o += 4; }
      else if (t === "m") { args.push(bytes.slice(o, o + 4)); o += 4; }
      else if (t === "t") { args.push(null); o += 8; } // matron has no case for a timetag: nil
      else if (t === "T") args.push(true);
      else if (t === "F") args.push(false);
      else if (t === "N") args.push(null);
      else if (t === "I") args.push(Infinity);
      else { args.push(null); break; } // a size nobody knows: nil, as matron, and nothing after it
    }
  }
  return { address, args };
}
