// E9-156 — the OSC encoder, which had no test of its own until it became
// the hottest function in the page.
//
// A `?profile=90` from a Pixel 9 Pro playing `kolor` put `encodeMessage`
// at 30.1% self time, three times the next entry. It allocated a
// `Uint8Array` AND a `DataView` per argument, and `kolor`'s engine
// command is
//
//     kolorplay iffffffffffffffffffffffffffffffffffffffffffffffff
//
// — forty-eight arguments, sent on every trigger of a running lattice.
//
// The rewrite measures first and writes once. These check that it still
// produces the same bytes, because the wire format is the one thing that
// cannot be allowed to drift: sclang and scsynth are on the other end and
// neither of them is ours.

import { describe, expect, it } from "vitest";
import { encodeMessage, decode } from "../src/engine/osc.js";

/** The four-byte alignment OSC requires, which is most of the format. */
const isAligned = (b: Uint8Array): boolean => b.length % 4 === 0;

describe("encoding an OSC message", () => {
  it("writes the address, the tag string and nothing else for no args", () => {
    const b = encodeMessage("/status");
    expect(isAligned(b)).toBe(true);
    // "/status" is 7 + NUL = 8, "," is 1 + NUL = 2 -> 4.
    expect(b.length).toBe(12);
    expect(new TextDecoder().decode(b.subarray(0, 7))).toBe("/status");
    expect(b[7], "the address is not terminated").toBe(0);
    expect(String.fromCharCode(b[8]!)).toBe(",");
  });

  it("tags an integer i and a fraction f, and writes them big-endian", () => {
    const b = encodeMessage("/a", [1, 1.5]);
    const tags = new TextDecoder().decode(b.subarray(4, 8)).replace(/\0+$/, "");
    expect(tags).toBe(",if");
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(v.getInt32(8, false), "not big-endian").toBe(1);
    expect(v.getFloat32(12, false)).toBe(1.5);
  });

  it("round-trips the types decode reads", () => {
    const b = encodeMessage("/mix", [7, -0.25, "hello"]);
    const m = decode(b) as { address: string; args: unknown[] };
    expect(m.address).toBe("/mix");
    expect(m.args[0]).toBe(7);
    expect(m.args[1]).toBeCloseTo(-0.25, 6);
    expect(m.args[2]).toBe("hello");
  });

  // THE SHAPE THAT MADE THIS WORTH REWRITING.
  it("round-trips kolor's forty-eight-argument command", () => {
    const args: Array<number> = [3];
    for (let i = 0; i < 47; i++) args.push(i / 7);
    const b = encodeMessage("/kolorplay", args);
    expect(isAligned(b)).toBe(true);
    const m = decode(b) as { address: string; args: number[] };
    expect(m.args).toHaveLength(48);
    expect(m.args[0]).toBe(3);
    for (let i = 0; i < 47; i++) expect(m.args[i + 1]).toBeCloseTo(i / 7, 5);
  });

  it("pads every part to four bytes, whatever the lengths are", () => {
    for (const addr of ["/a", "/ab", "/abc", "/abcd", "/abcde"]) {
      for (const s of ["", "x", "xy", "xyz", "xyzw"]) {
        const b = encodeMessage(addr, [s, 1]);
        expect(isAligned(b), `${addr} ${s}`).toBe(true);
        const m = decode(b) as { address: string; args: unknown[] };
        expect(m.address).toBe(addr);
        expect(m.args[0]).toBe(s);
        expect(m.args[1]).toBe(1);
      }
    }
  });

  it("refuses an argument it has no tag for, rather than writing nonsense", () => {
    expect(() => encodeMessage("/a", [true as unknown as number])).toThrow(/unsupported/);
  });

  /**
   * A blob's length field is its REAL length; the padding after it is not
   * counted. Getting that wrong desynchronises everything after it.
   *
   * CHECKED IN THE BYTES, not through `decode`, because `decode` has
   * never read a blob — it answers `<unhandled tag b>` and stops. That is
   * not an omission: blobs go OUT, as the SynthDefs sclang sends, and
   * nothing norns receives contains one. Writing them correctly still
   * matters, so this reads the wire directly.
   */
  it("writes a blob's true length, and pads after it", () => {
    const b = encodeMessage("/d", [new Uint8Array([9, 9, 9]), 1]);
    expect(isAligned(b)).toBe(true);
    // "/d" -> 4, ",bi" -> 4, then the blob at 8.
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(v.getInt32(8, false), "the length field counts the padding").toBe(3);
    expect(Array.from(b.subarray(12, 15))).toEqual([9, 9, 9]);
    expect(b[15], "the pad byte is not zero").toBe(0);
    expect(v.getInt32(16, false), "the argument after a blob is misplaced").toBe(1);
  });
});

describe("decoding what matron hands Lua (E9-238)", () => {
  /** The args of a decoded message, as the loose values decode returns. */
  const argsOf = (bytes: Uint8Array): unknown[] => (decode(bytes) as { args: unknown[] }).args;

  it("reads a blob as its bytes and goes on to the argument after it", () => {
    // eterna's engine: ['/waveform', Int8Array, buffer index]
    const args = argsOf(encodeMessage("/waveform", [new Uint8Array([1, 2, 255, 128, 7]), 4]));
    expect(args).toHaveLength(2);
    expect(Array.from(args[0] as Uint8Array)).toEqual([1, 2, 255, 128, 7]);
    expect(args[1]).toBe(4);
  });

  it("reads the types a hand-built message can carry, in matron's terms", () => {
    // ,hScmTFNIi — int64, symbol, char, midi, true, false, nil, infinitum, then an int
    const str = (s: string): Uint8Array => {
      const b = new Uint8Array(Math.ceil((s.length + 1) / 4) * 4);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      return b;
    };
    const i32 = (n: number): Uint8Array => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setInt32(0, n, false);
      return b;
    };
    const i64 = (n: number): Uint8Array => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigInt64(0, BigInt(n), false);
      return b;
    };
    const parts: Uint8Array[] = [str("/x"), str(",hScmTFNIi"), i64(2 ** 40 + 3), str("sym"), i32(65), new Uint8Array([0, 0x90, 60, 100]), i32(9)];
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    const args = argsOf(bytes);
    expect(args[0]).toBe(2 ** 40 + 3);
    expect(args[1]).toBe("sym");
    expect(args[2]).toBe("A");
    expect(Array.from(args[3] as Uint8Array)).toEqual([0, 0x90, 60, 100]);
    expect(args.slice(4, 8)).toEqual([true, false, null, Infinity]);
    expect(args[8]).toBe(9);
  });
});
