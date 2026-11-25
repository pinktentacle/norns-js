// E9-251 — a sound file's samples, decoded by the page for sclang's
// `SoundFile.readData` (grains, twins, timber's waveform).

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createSoundData, interleave } from "../src/engine/sound-data.js";
import { Vfs } from "../src/fs/vfs.js";

/** A 16-bit PCM WAV header for `frames` frames; the samples do not matter here. */
function wav(channels: number, rate: number, frames: number): Uint8Array {
  const data = frames * channels * 2;
  const b = new Uint8Array(44 + data);
  const v = new DataView(b.buffer);
  const s = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  s(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  s(8, "WAVE");
  s(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  s(36, "data");
  v.setUint32(40, data, true);
  return b;
}

function harness(decoded: Float32Array[]) {
  const vfs = new Vfs();
  vfs.write("/home/we/dust/audio/x.wav", wav(2, 44100, 4));
  const files = new Map<string, Uint8Array>();
  const sent: Array<[string, Array<string | number>]> = [];
  let asked: { rate: number; channels: number } | null = null;
  const sd = createSoundData({
    vfs,
    writeLangFile: (p, b) => void files.set(p, b.slice()),
    removeLangFile: (p) => void files.delete(p),
    sendToLang: (a, g) => void sent.push([a, g]),
    decode: async (_b, rate, channels) => {
      asked = { rate, channels };
      return decoded;
    },
  });
  return { sd, files, sent, asked: () => asked };
}

describe("a sound file's samples for sclang", () => {
  it("are interleaved frame by frame", () => {
    expect([...interleave([new Float32Array([1, 2]), new Float32Array([3, 4])], 2)]).toEqual([1, 3, 2, 4]);
  });

  it("are decoded at the file's own rate, written little-endian, and announced", async () => {
    const h = harness([new Float32Array([0.5, -0.5, 0.25, 0]), new Float32Array([1, 0, 0, -1])]);
    await h.sd.serve("/home/we/dust/audio/x.wav", "/tmp/norns-js-sf/1.f32");
    expect(h.asked()).toEqual({ rate: 44100, channels: 2 });
    const bytes = h.files.get("/tmp/norns-js-sf/1.f32")!;
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    expect([...f]).toEqual([0.5, 1, -0.5, 0, 0.25, 0, 0, -1]);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getFloat32(0, true)).toBe(0.5);
    expect(h.sent).toEqual([["/norns-js/soundfile/ready", ["/tmp/norns-js-sf/1.f32", 8]]]);
    h.sd.release("/tmp/norns-js-sf/1.f32");
    expect(h.files.size).toBe(0);
  });

  it("keep to the header's frame count", async () => {
    const h = harness([new Float32Array(10).fill(1), new Float32Array(10).fill(2)]);
    await h.sd.serve("/home/we/dust/audio/x.wav", "/r");
    expect(h.sent[0]![1]).toEqual(["/r", 8]); // 4 frames x 2 channels, not 10
  });

  it("answer 0 for a file that is not there, rather than leave sclang waiting", async () => {
    const h = harness([]);
    await h.sd.serve("/nowhere.wav", "/r");
    expect(h.sent).toEqual([["/norns-js/soundfile/ready", ["/r", 0]]]);
  });
});

describe("the sclang side", () => {
  const sc = fs
    .readFileSync(path.join(__dirname, "..", "src", "engine", "sc-overrides", "SystemOverwrites", "NornsJsSoundFileOverride.sc"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  it("reads what the page wrote, little-endian, from the position seek left", () => {
    expect(sc).toMatch(/f\.seek\(pos \* numChannels \* 4, 0\);\s*f\.readLE\(rawArray\);/);
    expect(sc).toMatch(/'\/norns-js\/soundfile\/data', path\.asString, raw/);
    expect(sc).toMatch(/OSCdef\(\\nornsJsSoundFileReady/);
  });

  it("only waits inside a Routine, and never for ever", () => {
    expect(sc).toMatch(/if \(thisThread\.isKindOf\(Routine\)\.not\) \{ \^nil \};/);
    expect(sc).toMatch(/fork \{ 10\.wait; if \(cond\.test\.not\)/);
  });

  it("is open after openRead and not after close, as isOpen asks", () => {
    expect(sc).toMatch(/fileptr = 0;\s*\^true/);
    expect(sc).toMatch(/fileptr = nil;\s*\^true/);
  });
});
