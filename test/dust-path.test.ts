// E9-220 — a sample beside a script's class, asked for by the staged path.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { stagedToDust } from "../src/engine/dust-path.js";
import { createBufferLoader } from "../src/engine/buffers.js";
import { Vfs } from "../src/fs/vfs.js";

describe("the staged class library, read as the dust tree", () => {
  it("is where coverts looks for its wavetables", () => {
    expect(stagedToDust("/sc/SCClassLibrary/dust/coverts/lib/../waves/sheep_1.wav")).toBe(
      "/home/we/dust/code/coverts/waves/sheep_1.wav",
    );
  });

  it("is where grd looks for its confetti", () => {
    expect(stagedToDust("/sc/SCClassLibrary/dust/grd/confetti/cel_65.wav")).toBe(
      "/home/we/dust/code/grd/confetti/cel_65.wav",
    );
  });

  it("leaves every other path exactly as it was", () => {
    for (const p of [
      "/home/we/dust/audio/tape/0001.wav",
      "/home/we/dust/code/coverts/waves/sheep_1.wav",
      "/sc/SCClassLibrary/dusty/x.wav",
      "/sc/SCClassLibrary/norns/Crone.sc",
      "relative/thing.wav",
    ]) {
      expect(stagedToDust(p)).toBe(p);
    }
  });

  it("is what the buffer loader reads", async () => {
    const vfs = new Vfs();
    // A minimal mono 16-bit WAV: 257 frames, the size of one coverts wave.
    const frames = 257;
    const wav = new Uint8Array(44 + frames * 2);
    const dv = new DataView(wav.buffer);
    const ascii = (o: number, s: string) => [...s].forEach((c, i) => (wav[o + i] = c.charCodeAt(0)));
    ascii(0, "RIFF");
    dv.setUint32(4, 36 + frames * 2, true);
    ascii(8, "WAVEfmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, 48000, true);
    dv.setUint32(28, 96000, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    ascii(36, "data");
    dv.setUint32(40, frames * 2, true);
    vfs.write("/home/we/dust/code/coverts/waves/sheep_1.wav", wav);

    const toLang: Array<[string, readonly (number | string)[]]> = [];
    const lines: string[] = [];
    const context = {
      sampleRate: 48000,
      decodeAudioData: (b: ArrayBuffer) => {
        expect(b.byteLength, "the file the loader found").toBe(wav.length);
        return Promise.resolve({
          numberOfChannels: 1,
          length: frames,
          sampleRate: 48000,
          duration: frames / 48000,
          getChannelData: () => new Float32Array(frames),
        });
      },
    } as unknown as BaseAudioContext;
    const loader = createBufferLoader({
      vfs,
      context,
      sendToServer: () => {},
      sendToLang: (a, args) => toLang.push([a, args]),
      log: (l) => lines.push(l),
    });
    await loader.read(3, "/sc/SCClassLibrary/dust/coverts/lib/../waves/sheep_1.wav", 0, -1);
    expect(lines.join("\n")).not.toMatch(/no such file/);
    const done = toLang.find(([a]) => a === "/norns-js/buffer/done");
    expect(done?.[1][1], "frames reported to sclang").toBe(frames);
  });

  it("is what SoundFile and File.exists ask the table about, in sclang", () => {
    const sc = fs.readFileSync(
      path.join(__dirname, "..", "src", "engine", "sc-overrides", "SystemOverwrites", "NornsJsSoundFileOverride.sc"),
      "utf8",
    );
    expect(sc).toMatch(/\{ p == "\.\." \} \{ if \(parts\.notEmpty\) \{ parts\.pop \} \}/);
    expect(sc).toMatch(/parts\[0\] == "sc" and: \{ parts\[1\] == "SCClassLibrary" and: \{ parts\[2\] == "dust" \} \}/);
    expect(sc).toMatch(/List\["home", "we", "dust", "code"\] \+\+ parts\.copyToEnd\(3\)/);
  });
});
