// E9-235 — channels, frames and rate from a FLAC or an AIFF header, as
// libsndfile gives them to `audio.file_info` on a norns.

import { describe, expect, it } from "vitest";
import { parseAiffHeader, parseFlacHeader, parseSoundHeader } from "../src/fs/wav-header.js";

/** A FLAC stream with just its STREAMINFO block. */
function flac(rate: number, channels: number, bits: number, total: number, id3 = 0): Uint8Array {
  const out = new Uint8Array(id3 + 42);
  if (id3 > 0) {
    out.set([0x49, 0x44, 0x33, 4, 0, 0], 0);
    const size = id3 - 10; // syncsafe
    out.set([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f], 6);
  }
  const a = id3;
  out.set([0x66, 0x4c, 0x61, 0x43], a); // fLaC
  out.set([0x80, 0, 0, 34], a + 4); // last block, STREAMINFO, 34 bytes
  const s = a + 8 + 10;
  out[s] = (rate >> 12) & 0xff;
  out[s + 1] = (rate >> 4) & 0xff;
  out[s + 2] = ((rate & 0x0f) << 4) | ((channels - 1) << 1) | (((bits - 1) >> 4) & 1);
  out[s + 3] = (((bits - 1) & 0x0f) << 4) | Math.floor(total / 2 ** 32);
  const lo = total % 2 ** 32;
  out.set([(lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff], s + 4);
  return out;
}

/** An AIFF with a COMM chunk; the rate as an 80-bit extended float. */
function aiff(rate: number, channels: number, frames: number, kind = "AIFF"): Uint8Array {
  const out = new Uint8Array(12 + 8 + 18);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  put(0, "FORM");
  dv.setUint32(4, out.length - 8);
  put(8, kind);
  put(12, "COMM");
  dv.setUint32(16, 18);
  dv.setUint16(20, channels);
  dv.setUint32(22, frames);
  dv.setUint16(26, 16);
  const e = Math.floor(Math.log2(rate));
  dv.setUint16(28, e + 16383);
  const m = rate * 2 ** (63 - e);
  dv.setUint32(30, Math.floor(m / 2 ** 32));
  dv.setUint32(34, m % 2 ** 32);
  return out;
}

describe("FLAC", () => {
  it("reads STREAMINFO: amenbreak's breaks are stereo 48 kHz", () => {
    expect(parseFlacHeader(flac(48000, 2, 24, 1_234_567))).toEqual({ channels: 2, sampleRate: 48000, frames: 1_234_567 });
    expect(parseFlacHeader(flac(44100, 1, 16, 2 ** 33 + 5))).toEqual({ channels: 1, sampleRate: 44100, frames: 2 ** 33 + 5 });
  });
  it("past an ID3 tag", () => {
    expect(parseFlacHeader(flac(96000, 2, 16, 10, 64))).toEqual({ channels: 2, sampleRate: 96000, frames: 10 });
  });
});

describe("AIFF", () => {
  it("reads COMM, including the extended-float rate", () => {
    expect(parseAiffHeader(aiff(44100, 2, 88200))).toEqual({ channels: 2, sampleRate: 44100, frames: 88200 });
    expect(parseAiffHeader(aiff(48000, 1, 5, "AIFC"))).toEqual({ channels: 1, sampleRate: 48000, frames: 5 });
  });
});

describe("one entry point", () => {
  it("answers for all three and nothing else", () => {
    expect(parseSoundHeader(flac(48000, 2, 16, 3))?.frames).toBe(3);
    expect(parseSoundHeader(aiff(48000, 2, 4))?.frames).toBe(4);
    expect(parseSoundHeader(new TextEncoder().encode("not a sound file at all, really not"))).toBeNull();
  });
});
