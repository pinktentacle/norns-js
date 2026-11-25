// E4-11 — the twenty-four that touch a file.
//
// The audio half is measured, not tested: `spike/crone/measure.mjs` runs the
// real wasm and asserts that a buffer clear goes silent, that a file read
// plays, and that a tape recording comes back. What a test can hold is the
// JavaScript either side of that — the staging window, the encoder, and the
// asynchronous gap — because all three fail by producing something plausible
// rather than by throwing.

import { describe, expect, it } from "vitest";
import { NornsRegistry } from "../src/norns/registry.js";
import {
  registerCrone,
  croneFileWriter,
  croneTapeWriter,
  createTapePaths,
} from "../src/crone/register.js";
import { encodeWav, interleave, bitsFromFormat } from "../src/crone/wav.js";
import type { Crone } from "../src/crone/crone.js";
import type { Vfs } from "../src/fs/vfs.js";

const FRAMES = 44100;
const RATE = 44100;

function fakeBuffer(channels = 1, frames = FRAMES, rate = RATE) {
  return {
    numberOfChannels: channels,
    length: frames,
    sampleRate: rate,
    getChannelData: (c: number) => Float32Array.from({ length: frames }, (_v, i) => (i % 100) / 100 + c),
  };
}

function harness(opts: { missing?: boolean; failDecode?: boolean } = {}) {
  const calls: Array<{ entry: string; args: unknown[] }> = [];
  const preloads: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const fed: Float32Array[] = [];

  const crone = {
    call: (entry: string, _t: readonly string[], args: readonly unknown[]) =>
      calls.push({ entry, args: [...args] }),
    preloadFile: async (spec: Record<string, unknown>) => {
      preloads.push(spec);
      return true;
    },
    dropFile: () => {},
    feedTape: (pcm: Float32Array) => fed.push(pcm),
    resetTape: () => {},
    command: () => {},
    param: () => {},
    poll: async () => true,
    node: { port: { postMessage: () => {} } },
  } as unknown as Crone;

  const written: Array<{ path: string; bytes: Uint8Array }> = [];
  const vfs = {
    read: () => (opts.missing ? null : new Uint8Array([1, 2, 3])),
    write: (path: string, bytes: Uint8Array) => written.push({ path, bytes }),
  } as unknown as Vfs;

  const paths = createTapePaths();
  const registry = new NornsRegistry();
  registerCrone(registry, crone, {
    log: (l) => logs.push(l),
    files: {
      vfs,
      paths,
      decode: async () => {
        if (opts.failDecode) throw new Error("unsupported format");
        return fakeBuffer();
      },
    },
  });
  const call = (name: string, ...args: unknown[]): unknown =>
    registry.implementationFor(name)!(...(args as never[]));
  return { calls, preloads, logs, written, vfs, paths, call, fed };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the staging window of a buffer read", () => {
  it("stages from where the read starts, not from the beginning", async () => {
    // Staging from frame 0 spends the size cap on audio nothing will read.
    // The frames are at the FILE's rate, which is why the decoded rate is
    // what the arithmetic uses.
    const h = harness();
    h.call("cut_buffer_read_mono", "/a.wav", 0.25, 0, 0.5, 0, 0, 0, 1);
    await tick();
    expect(h.preloads).toHaveLength(1);
    expect(h.preloads[0]!["firstFrame"]).toBe(Math.floor(0.25 * RATE));
    expect(h.preloads[0]!["totalFrames"]).toBe(FRAMES);
    // Half a second, plus the frame `seek` lands on.
    expect(h.preloads[0]!["frames"]).toBe(Math.ceil(0.5 * RATE) + 1);
  });

  it("a start past the end clamps to the last frame, as upstream does", async () => {
    // `readBufferMono` does `clamp(frSrc, file.frames() - 1)`. Staging an
    // empty window instead would have it seek to that clamped frame, find
    // it outside the window, and abandon the read — which reads as a
    // corrupt file rather than as a file shorter than the script thought.
    const h = harness();
    h.call("cut_buffer_read_mono", "/a.wav", 10, 0, 1, 0, 0, 0, 1);
    await tick();
    expect(h.preloads[0]!["firstFrame"]).toBe(FRAMES - 1);
    expect(h.preloads[0]!["frames"]).toBe(1);
  });

  it("a negative duration means the rest of the file", () => {
    const h = harness();
    h.call("cut_buffer_read_mono", "/a.wav", 0.5, 0, -1, 0, 0, 0, 1);
    return tick().then(() => {
      expect(h.preloads[0]!["frames"]).toBe(FRAMES - Math.floor(0.5 * RATE));
    });
  });

  it("clamps the window to the end of the file", async () => {
    const h = harness();
    h.call("cut_buffer_read_mono", "/a.wav", 0, 0, 10, 0, 0, 0, 1);
    await tick();
    expect(h.preloads[0]!["frames"]).toBe(FRAMES);
  });

  it("calls crone only after the frames are staged", async () => {
    // The order is the whole point: `readBufferMono` runs on the audio
    // thread and cannot wait. Calling first would read a window that is not
    // there yet, and `seek` would fail half way through a sample.
    const h = harness();
    h.call("cut_buffer_read_mono", "/a.wav", 0, 0, 1, 0, 0, 0, 1);
    expect(h.calls).toHaveLength(0);
    await tick();
    expect(h.calls.at(-1)!.entry).toBe("cronejs_cut_buffer_read_mono");
  });

  it("a missing file is logged and nothing is called", async () => {
    const h = harness({ missing: true });
    h.call("cut_buffer_read_mono", "/missing.wav", 0, 0, 1, 0, 0, 0, 1);
    await tick();
    expect(h.calls).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("no such file"))).toBe(true);
  });

  it("a file the browser will not decode names itself", async () => {
    // norns reads whatever libsndfile reads; a browser reads a different
    // set. The difference has to say so rather than appear as a buffer that
    // stayed silent.
    const h = harness({ failDecode: true });
    h.call("cut_buffer_read_mono", "/a.caf", 0, 0, 1, 0, 0, 0, 1);
    await tick();
    expect(h.calls).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("cannot decode"))).toBe(true);
  });
});

describe("the operations that need no file", () => {
  it("clear_region passes four numbers in order", () => {
    const h = harness();
    h.call("cut_buffer_clear_region", 1, 2, 0.01, 0.5);
    expect(h.calls.at(-1)).toEqual({
      entry: "cronejs_cut_buffer_clear_region",
      args: [1, 2, 0.01, 0.5],
    });
  });

  it("copy_mono passes eight, with reverse last, and its channels from 0 (E9-233)", () => {
    const h = harness();
    h.call("cut_buffer_copy_mono", 1, 2, 0, 2, 3, 0.01, 0, 1);
    expect(h.calls.at(-1)!.args).toEqual([0, 1, 0, 2, 3, 0.01, 0, 1]);
  });
});

describe("the tape", () => {
  it("records the path on open and tells Lua about it", async () => {
    const h = harness();
    h.call("tape_record_open", "/tape/a.wav");
    expect(h.paths.rec).toBe("/tape/a.wav");
    expect(h.calls.at(-1)!.entry).toBe("cronejs_tape_rec_open");
  });

  it("playback prepares the length before opening", async () => {
    // `playbackFramesTotal` feeds the status display, and the reader has no
    // other way to learn it: there is no file on its side to ask.
    const h = harness();
    h.call("tape_play_open", "/tape/b.wav");
    await tick();
    const entries = h.calls.map((c) => c.entry);
    expect(entries.indexOf("cronejs_tape_play_prepare")).toBeLessThan(
      entries.indexOf("cronejs_tape_play_open"),
    );
    expect(h.fed).toHaveLength(1);
  });

  it("stopping playback forgets the queued audio", () => {
    // Otherwise the next open plays the tail of the last file first.
    const h = harness();
    h.call("tape_play_stop");
    expect(h.paths.play).toBeNull();
  });
});

describe("encoding what comes back", () => {
  it("writes 24-bit when crone asked for 24-bit", () => {
    // BufDiskWorker.cpp:449 is SF_FORMAT_WAV | SF_FORMAT_PCM_24. Writing 16
    // would halve the dynamic range of every recording with nothing to say
    // so.
    const written: Array<{ path: string; bytes: Uint8Array }> = [];
    const vfs = { write: (p: string, b: Uint8Array) => written.push({ path: p, bytes: b }) } as unknown as Vfs;
    croneFileWriter(vfs)({
      path: "/out.wav",
      pcm: new Float32Array([0, 0.5, -0.5, 1]),
      channels: 1,
      rate: 48000,
      format: 0x010003,
    });
    expect(written).toHaveLength(1);
    const dv = new DataView(written[0]!.bytes.buffer);
    expect(dv.getUint16(34, true)).toBe(24); // bits per sample
    expect(dv.getUint16(22, true)).toBe(1); // channels
    expect(dv.getUint32(24, true)).toBe(48000);
  });

  it("reads the bit depth out of the format word", () => {
    expect(bitsFromFormat(0x010002)).toBe(16);
    expect(bitsFromFormat(0x010003)).toBe(24);
    expect(bitsFromFormat(0x010006)).toBe(32);
    expect(bitsFromFormat(0)).toBe(24); // crone's default, not an error
  });

  it("clips rather than wrapping", () => {
    // libsndfile is told SFC_SET_CLIPPING. A sample over 1.0 written without
    // it wraps to the opposite extreme, and one frame of that is a click.
    const wav = encodeWav({ channels: 1, sampleRate: 48000, samples: new Float32Array([2.0]), bits: 16 });
    const dv = new DataView(wav.buffer);
    expect(dv.getInt16(44, true)).toBe(32767);
    const neg = encodeWav({ channels: 1, sampleRate: 48000, samples: new Float32Array([-2.0]), bits: 16 });
    expect(new DataView(neg.buffer).getInt16(44, true)).toBe(-32767);
  });

  it("interleaves the channels, in order", () => {
    const out = interleave(fakeBuffer(2, 3, RATE));
    // Channel 1's fake data is channel 0's plus one, so odd slots are the
    // right channel. A transposed interleave swaps left and right, which is
    // not audible on a mono source and very audible later.
    expect(out).toHaveLength(6);
    expect(out[1]! - out[0]!).toBeCloseTo(1, 6);
  });

  it("the tape writer concatenates its blocks and writes once", () => {
    const written: Array<{ path: string; bytes: Uint8Array }> = [];
    const vfs = { write: (p: string, b: Uint8Array) => written.push({ path: p, bytes: b }) } as unknown as Vfs;
    const paths = createTapePaths();
    paths.rec = "/tape/x.wav";
    const w = croneTapeWriter(vfs, paths, 48000);
    w.onTapeData(new Float32Array([0.1, 0.2]));
    w.onTapeData(new Float32Array([0.3, 0.4]));
    w.onTapeFinished(0);
    expect(written).toHaveLength(1);
    const dv = new DataView(written[0]!.bytes.buffer);
    expect(dv.getUint16(22, true)).toBe(2); // stereo
    expect(dv.getUint32(40, true)).toBe(2 * 2 * 3); // 2 frames x 2 ch x 3 bytes

    // And a second stop with nothing recorded writes nothing, rather than a
    // file of zero frames over the one just made.
    w.onTapeFinished(0);
    expect(written).toHaveLength(1);
  });
});
