// E9-267 — audiowaveform, against numbers worked out by hand from its source.

import { describe, expect, it } from "vitest";
import {
  HELP,
  decodeDat,
  decodeWav16,
  encodeDat,
  generatePeaks,
  parseAwfArgs,
  peakCount,
  produce,
  renderPeaks,
  rescalePeaks,
  samplesPerPixelFor,
  type Peaks,
} from "../src/fs/audiowaveform.js";
import { encodeWav } from "../src/crone/wav.js";
import { decodePngSync } from "../src/screen/png-sync.js";

const pairs = (p: Peaks): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i < p.data.length; i += 2) out.push([p.data[i]!, p.data[i + 1]!]);
  return out;
};

describe("peaks (WaveformGenerator)", () => {
  it("mixes to mono with an integer mean and keeps the last partial pixel", () => {
    const data = Int16Array.from([100, 0, -101, 1, 50, 50, -3, -4, 7, 7]);
    const p = generatePeaks({ sampleRate: 48000, channels: 2, data }, 2);
    // means: 50, -50, 50, -3 (trunc of -3.5), 7
    expect(pairs(p)).toEqual([
      [-50, 50],
      [-3, 50],
      [7, 7],
    ]);
    expect(p.channels).toBe(1);
    expect(p.samplesPerPixel).toBe(2);
  });

  it("refuses a zoom under 2, as the program does", () => {
    expect(() => generatePeaks({ sampleRate: 48000, channels: 1, data: new Int16Array(4) }, 1)).toThrow(/minimum 2/);
  });
});

describe(".dat (WaveformBuffer)", () => {
  it("writes version 1 with the 8-bit flag, value/256 truncated, and reads back value*256", () => {
    const p: Peaks = { sampleRate: 44100, samplesPerPixel: 2, channels: 1, data: Int16Array.from([-300, 300, -100, 100]) };
    const bytes = encodeDat(p, 8);
    const v = new DataView(bytes.buffer);
    expect([v.getInt32(0, true), v.getUint32(4, true), v.getInt32(8, true), v.getInt32(12, true), v.getUint32(16, true)]).toEqual([1, 1, 44100, 2, 2]);
    expect(Array.from(new Int8Array(bytes.buffer, 20))).toEqual([-1, 1, 0, 0]);
    expect(pairs(decodeDat(bytes))).toEqual([
      [-256, 256],
      [0, 0],
    ]);
  });

  it("round-trips 16 bits exactly", () => {
    const p: Peaks = { sampleRate: 48000, samplesPerPixel: 256, channels: 1, data: Int16Array.from([-32768, 32767, -5, 9]) };
    expect(pairs(decodeDat(encodeDat(p, 16)))).toEqual(pairs(p));
  });

  it("rejects what the program rejects", () => {
    const bad = new Uint8Array(24);
    new DataView(bad.buffer).setInt32(0, 3, true);
    expect(() => decodeDat(bad)).toThrow(/version: 3/);
  });
});

describe("rescaling (WaveformRescaler)", () => {
  const input: Peaks = {
    sampleRate: 48000,
    samplesPerPixel: 2,
    channels: 1,
    data: Int16Array.from([-1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8]),
  };
  it("merges whole pixels when the zoom is a multiple", () => {
    expect(pairs(rescalePeaks(input, 4))).toEqual([
      [-2, 2],
      [-4, 4],
      [-6, 6],
      [-8, 8],
    ]);
  });
  it("cuts at x * samples_per_pixel when it is not", () => {
    // Boundaries at samples 0, 3, 6, 9, 12, 15 are input points 0, 1, 3, 4, 6, 7:
    // worked through the program's loop by hand, last pixel included.
    expect(pairs(rescalePeaks(input, 3))).toEqual([
      [-1, 1],
      [-3, 3],
      [-4, 4],
      [-6, 6],
      [-7, 7],
      [-8, 8],
    ]);
  });
});

describe("the picture (GdImageRenderer)", () => {
  const lumaAt = (png: Uint8Array, x: number, y: number): number => {
    const img = decodePngSync(png)!;
    return img.rgba[(y * img.width + x) * 4]!;
  };
  it("draws a full-scale point top to bottom and a silent one as one row", () => {
    const p: Peaks = { sampleRate: 48000, samplesPerPixel: 2, channels: 1, data: Int16Array.from([-32768, 32767, 0, 0]) };
    const png = renderPeaks(p, {
      width: 3,
      height: 8,
      startTime: 0,
      background: { r: 0, g: 0, b: 0 },
      waveform: { r: 255, g: 255, b: 255 },
      amplitudeScale: 1,
    });
    for (let y = 0; y < 8; y++) expect(lumaAt(png, 0, y), `x0 y${y}`).toBe(255);
    // 0 + 32768 -> row 8 - 1 - 32768 * 8 / 65536 = 3
    for (let y = 0; y < 8; y++) expect(lumaAt(png, 1, y), `x1 y${y}`).toBe(y === 3 ? 255 : 0);
    // past the end of the data: background
    for (let y = 0; y < 8; y++) expect(lumaAt(png, 2, y)).toBe(0);
  });

  it("writes an alpha channel only when a colour has one", () => {
    const p: Peaks = { sampleRate: 48000, samplesPerPixel: 2, channels: 1, data: Int16Array.from([0, 0]) };
    const opts = { width: 1, height: 2, startTime: 0, waveform: { r: 1, g: 2, b: 3 }, amplitudeScale: 1 as const };
    expect(renderPeaks(p, { ...opts, background: { r: 0, g: 0, b: 0 } })[25]).toBe(2); // colour type RGB
    const t = renderPeaks(p, { ...opts, background: { r: 255, g: 255, b: 255, a: 0 } });
    expect(t[25]).toBe(6); // RGBA
    const px = decodePngSync(t)!.rgba;
    expect(px[3]).toBe(255); // row 0: the (opaque) waveform
    expect(px[7]).toBe(0); // row 1: the transparent background
  });
});

describe("the command line", () => {
  it("takes amenbreak's two calls, -h being the height", () => {
    const a = parseAwfArgs(["-q", "-i", "/x.flac", "-o", "/x.dat", "-z", "2", "-b", "8"]);
    expect([a.quiet, a.input, a.output, a.zoom, a.bits]).toEqual([true, "/x.flac", "/x.dat", 2, 8]);
    const b = parseAwfArgs(
      "-q -i /x.dat -o /v.png -s 0.0000 -e 1.5000 -w 128 -h 48 --background-color 000000 --waveform-color 757575 --no-axis-labels --compression 9".split(" "),
    );
    expect([b.start, b.end, b.width, b.height, b.axisLabels]).toEqual([0, 1.5, 128, 48, false]);
    expect(b.background).toEqual({ r: 0, g: 0, b: 0 });
    expect(samplesPerPixelFor(b, 48000)).toBe(562); // trunc(72000 / 128)
  });

  it("says what it does not know, in its own words", () => {
    expect(() => parseAwfArgs(["--frobnicate"])).toThrow(/unrecognised option/);
    expect(() => parseAwfArgs(["-z", "4", "-e", "2"])).toThrow(/either --end or --zoom/);
    expect(() => parseAwfArgs(["--split-channels"])).toThrow(/not available here/);
    expect(HELP).toContain("Options");
  });

  it("refuses a zoom finer than the .dat it is given", () => {
    const dat: Peaks = { sampleRate: 48000, samplesPerPixel: 256, channels: 1, data: Int16Array.from([0, 0]) };
    const a = parseAwfArgs(["-i", "/a.dat", "-o", "/a.png", "-z", "64", "--no-axis-labels"]);
    expect(() => produce(a, { peaks: dat })).toThrow(/Invalid zoom, minimum: 256/);
  });
});

describe("WAV in, as libsndfile hands it over", () => {
  it("reads 24-bit by its top 16 and float by 32767", () => {
    const samples = Float32Array.from([0.5, -0.25, 1, -1]);
    const w24 = decodeWav16(encodeWav({ channels: 2, sampleRate: 44100, samples, bits: 24 }))!;
    expect(w24.channels).toBe(2);
    expect(w24.sampleRate).toBe(44100);
    expect(Math.abs(w24.data[0]! - 16384)).toBeLessThanOrEqual(1);
    expect(Math.abs(w24.data[1]! + 8192)).toBeLessThanOrEqual(1);
    const p = generatePeaks(w24, 2);
    expect(peakCount(p)).toBe(1);
  });
});
