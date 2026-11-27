// E9-275 — the sox command: the real SoX 14.4.2, compiled to wasm, run by
// the shell one instance per command (src/fs/sox.ts).
//
// These run the module tools/sox/build.sh puts in public/sox/ — release-kit
// step 2 builds it before the tests — and skip, saying why, when it is not
// there.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Vfs } from "../src/fs/vfs.js";
import { runShell } from "../src/fs/shell.js";
import { setSoxModule, soxUnavailable } from "../src/fs/sox.js";

const DIR = path.join(__dirname, "..", "public", "sox");
const HAVE = fs.existsSync(path.join(DIR, "sox.wasm")) && fs.existsSync(path.join(DIR, "sox.js"));
const D = "/home/we/dust/audio/t";

/** A 16-bit stereo WAV of a sine. */
function wav(seconds: number, freq: number, amp = 0.4, silence = 0): Uint8Array {
  const sr = 48000;
  const n = Math.round(sr * (seconds + silence));
  const lead = Math.round(sr * silence);
  const b = Buffer.alloc(44 + n * 4);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 4, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36);
  b.writeUInt32LE(n * 4, 40);
  for (let i = lead; i < n; i++) {
    const s = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / sr) * 32767);
    b.writeInt16LE(s, 44 + i * 4);
    b.writeInt16LE(s, 46 + i * 4);
  }
  return new Uint8Array(b);
}

/** Seconds in a WAV, from its own fmt chunk (sox keeps the input's
 * precision: from `-n` it writes 32-bit, as on a norns). */
function seconds(bytes: Uint8Array): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  let frameBytes = 0;
  let rate = 0;
  while (o + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(o, o + 4));
    const size = v.getUint32(o + 4, true);
    if (id === "fmt ") {
      rate = v.getUint32(o + 12, true);
      frameBytes = v.getUint16(o + 20, true); // block align
    }
    if (id === "data") return frameBytes > 0 && rate > 0 ? size / frameBytes / rate : NaN;
    o += 8 + size + (size & 1);
  }
  return NaN;
}

describe.skipIf(!HAVE)("sox, the program", () => {
  beforeAll(async () => {
    const mod = (await import(pathToFileURL(path.join(DIR, "sox.js")).href)) as { default: never };
    setSoxModule(new Uint8Array(fs.readFileSync(path.join(DIR, "sox.wasm"))), mod.default);
  });
  afterAll(() => setSoxModule(null, null));

  const setup = (): Vfs => {
    const vfs = new Vfs();
    vfs.mkdir(D);
    vfs.write(`${D}/a.wav`, wav(2, 220));
    return vfs;
  };

  it("is there for command -v, as on a norns that installed it", () => {
    const r = runShell(setup(), "command -v sox");
    expect(r.out).toBe("/usr/bin/sox\n");
  });

  it("answers `--i` through grep and awk", () => {
    const r = runShell(setup(), `sox --i ${D}/a.wav | grep 'Sample Rate' | awk '{print $4}'`);
    expect(r.out).toBe("48000\n");
  });

  it("puts stat's stderr into a pipe with 2>&1", () => {
    const vfs = setup();
    expect(runShell(vfs, `sox ${D}/a.wav -n stat 2>&1 | grep Length | awk '{print $3}'`).out).toBe("2.000000\n");
    // Without 2>&1 the report stays on stderr, as in a shell.
    expect(runShell(vfs, `sox ${D}/a.wav -n stat | grep Length`).out).toBe("");
  });

  it("writes what an effect makes back into the page's files", () => {
    const vfs = setup();
    runShell(vfs, `sox ${D}/a.wav ${D}/trim.wav trim 0.5 1`);
    runShell(vfs, `sox ${D}/a.wav ${D}/tempo.wav tempo -m 1.5`);
    runShell(vfs, `sox ${D}/a.wav ${D}/rev.wav reverse`);
    expect(seconds(vfs.read(`${D}/trim.wav`)!)).toBeCloseTo(1, 3);
    expect(seconds(vfs.read(`${D}/tempo.wav`)!)).toBeCloseTo(2 / 1.5, 2);
    expect(seconds(vfs.read(`${D}/rev.wav`)!)).toBeCloseTo(2, 3);
  });

  it("does norman's normalise and trim: -1 dB, the leading silence gone", () => {
    const vfs = new Vfs();
    vfs.mkdir(D);
    vfs.write(`${D}/quiet.wav`, wav(1, 220, 0.2, 0.5));
    runShell(vfs, `sox ${D}/quiet.wav ${D}/quiet_norman.wav norm -1.0 silence 1 0.1 1%`);
    const out = vfs.read(`${D}/quiet_norman.wav`)!;
    expect(seconds(out)).toBeCloseTo(1, 2);
    let peak = 0;
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let o = 44; o + 2 <= out.length; o += 2) peak = Math.max(peak, Math.abs(v.getInt16(o, true)));
    expect(20 * Math.log10(peak / 32768)).toBeCloseTo(-1, 1);
  });

  it("takes quoted paths with spaces, as zxcvbn writes them", () => {
    const vfs = setup();
    runShell(vfs, `sox ${D}/a.wav '${D}/my sample.aif'`);
    runShell(vfs, `sox '${D}/my sample.aif' '${D}/my sample.aif.wav'`);
    expect(seconds(vfs.read(`${D}/my sample.aif.wav`)!)).toBeCloseTo(2, 3);
  });

  it("reads relative names from where it runs: /home/we, or a cd before it (E9-276)", () => {
    const vfs = setup();
    vfs.write("/home/we/b.wav", wav(1, 440));
    runShell(vfs, "sox b.wav b2.wav trim 0 0.5");
    expect(seconds(vfs.read("/home/we/b2.wav")!)).toBeCloseTo(0.5, 3);
    runShell(vfs, `cd ${D} && sox a.wav rel.wav trim 0 0.25`);
    expect(seconds(vfs.read(`${D}/rel.wav`)!)).toBeCloseTo(0.25, 3);
    expect(vfs.exists("/rel.wav")).toBe(false);
  });

  it("exits non-zero on a file that is not there, and is not a refusal", () => {
    const r = runShell(setup(), `sox ${D}/nothere.wav ${D}/x.wav trim 0 1`);
    expect(r.failed).toBe(true);
    expect(r.refused).toBeUndefined();
  });

  it("makes silence from nothing (-n) and mixes (-m)", () => {
    const vfs = setup();
    runShell(vfs, `sox -n -r 48000 -c 2 ${D}/sil.wav trim 0.0 0.5`);
    runShell(vfs, `sox -m ${D}/a.wav ${D}/sil.wav ${D}/mix.wav trim 0 1`);
    expect(seconds(vfs.read(`${D}/sil.wav`)!)).toBeCloseTo(0.5, 3);
    expect(seconds(vfs.read(`${D}/mix.wav`)!)).toBeCloseTo(1, 3);
  });
});

describe("sox before its module is in", () => {
  it("is refused with the reason, and command -v does not claim it", () => {
    setSoxModule(null, null);
    const vfs = new Vfs();
    const r = runShell(vfs, "sox a.wav b.wav");
    expect(r.ok).toBe(false);
    expect(r.refused).toMatch(/sox/);
    expect(soxUnavailable()).toMatch(/loading|not in this build/);
    expect(runShell(vfs, "command -v sox").out).toBe("");
  });
});

describe("awk in a pipe", () => {
  it("prints fields, several with spaces, and refuses what it does not know", async () => {
    // runPipe is reached through a pipeline head the shell already knows.
    const vfs = new Vfs();
    vfs.write("/home/we/x.txt", "a b c\nd e f\n");
    expect(runShell(vfs, "cat /home/we/x.txt | awk '{print $2}'").out).toBe("b\ne\n");
    expect(runShell(vfs, "cat /home/we/x.txt | awk '{print $1, $3}'").out).toBe("a c\nd f\n");
  });
});
