// E9-260 — `/b_read*` sent to the server by hand, done by the page.

import { describe, expect, it } from "vitest";
import { encodeMessage } from "../src/engine/osc.js";
import { rawBufferReadOf } from "../src/engine/raw-buffer-read.js";
import { createBufferLoader } from "../src/engine/buffers.js";
import { Vfs } from "../src/fs/vfs.js";

describe("a /b_read* packet", () => {
  it("is read the way twins writes it: /b_readChannel into a buffer it made, from a frame", () => {
    const r = rawBufferReadOf(encodeMessage("/b_readChannel", [12, "/home/we/dust/audio/x.wav", 1048576, 1048576, 1048576, 0, 1]));
    expect(r).toEqual({
      cmd: "/b_readChannel",
      bufnum: 12,
      path: "/home/we/dust/audio/x.wav",
      fileStart: 1048576,
      numFrames: 1048576,
      bufStart: 1048576,
      alloc: false,
      channels: [1],
      completion: null,
    });
  });

  it("knows the alloc forms, the plain form and a completion message", () => {
    const done = encodeMessage("/s_new", ["x", 1000, 0, 1]);
    expect(rawBufferReadOf(encodeMessage("/b_allocRead", [3, "/a.wav", 0, -1, done]))).toMatchObject({
      alloc: true,
      bufStart: 0,
      channels: [],
      numFrames: -1,
      completion: done,
    });
    expect(rawBufferReadOf(encodeMessage("/b_allocReadChannel", [4, "/a.wav", 10, 100, 0, 1]))).toMatchObject({
      alloc: true,
      fileStart: 10,
      channels: [0, 1],
    });
    expect(rawBufferReadOf(encodeMessage("/b_read", [5, "/a.wav", 0, 500, 250, 0]))).toMatchObject({
      alloc: false,
      bufStart: 250,
      channels: [],
    });
  });

  it("is nothing else", () => {
    expect(rawBufferReadOf(encodeMessage("/b_alloc", [1, 100, 1]))).toBeNull();
    expect(rawBufferReadOf(encodeMessage("/s_new", ["x", 1000]))).toBeNull();
    expect(rawBufferReadOf(encodeMessage("/b_getn", [1, 0, 4]))).toBeNull();
    expect(rawBufferReadOf(new Uint8Array([0, 0, 0, 9]))).toBeNull();
  });
});

describe("the loader, doing one", () => {
  const harness = (frames: number, channels: number) => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/audio/x.wav", new Uint8Array(64));
    const toServer: Array<[string, readonly (number | string)[]]> = [];
    const toLang: Array<[string, readonly (number | string)[]]> = [];
    let decodes = 0;
    const context = {
      sampleRate: 48000,
      decodeAudioData: () => {
        decodes++;
        return Promise.resolve({
          numberOfChannels: channels,
          length: frames,
          sampleRate: 48000,
          duration: frames / 48000,
          getChannelData: (c: number) => Float32Array.from({ length: frames }, (_, i) => (c + 1) * 0.001 * (i + 1)),
        });
      },
    } as unknown as BaseAudioContext;
    const loader = createBufferLoader({
      vfs,
      context,
      sendToServer: (a, g) => void toServer.push([a, g]),
      sendToLang: (a, g) => void toLang.push([a, g]),
    });
    return { loader, toServer, toLang, decodes: () => decodes };
  };

  it("writes into the buffer as it is, from the frame asked, and allocates nothing", async () => {
    const h = harness(100, 2);
    const ok = await h.loader.readRaw(rawBufferReadOf(encodeMessage("/b_readChannel", [7, "/home/we/dust/audio/x.wav", 20, 30, 1000, 0, 1]))!);
    expect(ok).toBe(true);
    expect(h.toServer.some(([a]) => a === "/b_alloc")).toBe(false);
    const setn = h.toServer.filter(([a]) => a === "/b_setn");
    expect(setn[0]![1].slice(0, 3)).toEqual([7, 1000, 30]);
    // Channel 1, frame 20 of the file: (1 + 1) * 0.001 * 21.
    expect(setn[0]![1][3]).toBeCloseTo(0.042, 6);
    // The sclang override's answer is not given: nobody is waiting for it.
    expect(h.toLang).toEqual([]);
  });

  it("allocates for the alloc forms", async () => {
    const h = harness(50, 1);
    await h.loader.readRaw(rawBufferReadOf(encodeMessage("/b_allocRead", [8, "/home/we/dust/audio/x.wav", 0, -1]))!);
    expect(h.toServer[0]).toEqual(["/b_alloc", [8, 50, 1]]);
    expect(h.toLang).toEqual([]);
  });

  it("decodes a file once while it is read in pieces", async () => {
    const h = harness(100, 2);
    for (const [start, ch] of [[0, 0], [0, 1], [50, 0], [50, 1]] as const) {
      await h.loader.readRaw(rawBufferReadOf(encodeMessage("/b_readChannel", [9, "/home/we/dust/audio/x.wav", start, 50, start, 0, ch]))!);
    }
    expect(h.decodes()).toBe(1);
  });
});
