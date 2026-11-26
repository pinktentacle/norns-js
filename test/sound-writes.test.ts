// E9-268 — the sound files scsynth writes, carried into the page's filesystem.

import { describe, expect, it } from "vitest";
import { encodeMessage } from "../src/engine/osc.js";
import { createWriteTracker, writesIn } from "../src/engine/sound-writes.js";

const harness = () => {
  const did: string[] = [];
  const files = new Map<string, Uint8Array>();
  const t = createWriteTracker({
    mkdir: (d) => did.push(`mkdir ${d}`),
    readFile: (p) => (p.endsWith("missing.wav") ? null : new Uint8Array([1, 2, 3])),
    unlink: (p) => did.push(`unlink ${p}`),
    onFile: (p, b) => files.set(p, b),
    log: (l) => did.push(`log ${l}`),
  });
  return { t, did, files };
};

describe("which packets ask for a write", () => {
  it("finds one alone, in a bundle, and as a completion message that is not the last argument", () => {
    const w = encodeMessage("/b_write", [4, "/home/we/dust/audio/a.wav", "wav", "int16", -1, 0, 0, 0]);
    expect(writesIn(w)).toEqual([{ bufnum: 4, path: "/home/we/dust/audio/a.wav", leaveOpen: false }]);
    // Recorder, as measured: `,iiibf` — the sample rate comes after the completion.
    const rec = encodeMessage("/b_write", [1, "/home/we/dust/audio/r.aiff", "aiff", "int24", 0, 0, 1, 0]);
    expect(writesIn(encodeMessage("/b_alloc", [1, 65536, 2, rec, 48000]))).toEqual([
      { bufnum: 1, path: "/home/we/dust/audio/r.aiff", leaveOpen: true },
    ]);
  });

  it("leaves everything else alone, on its first bytes", () => {
    expect(writesIn(encodeMessage("/s_new", ["sine", 1000, 0, 1]))).toEqual([]);
    expect(writesIn(encodeMessage("/b_alloc", [1, 1024, 1]))).toEqual([]);
    expect(writesIn(new Uint8Array([0, 0, 0, 9]))).toEqual([]);
  });
});

describe("before and after a write", () => {
  it("makes the folder first and carries a whole file out at its /done", () => {
    const { t, did, files } = harness();
    t.fromLang(encodeMessage("/b_write", [4, "/home/we/dust/audio/grains/save.wav", "wav", "int24", -1, 0, 0, 0]));
    expect(did).toEqual(["mkdir /home/we/dust/audio/grains"]);
    expect(files.size).toBe(0);
    t.fromServer("/done", ["/b_write", 4]);
    expect([...files.keys()]).toEqual(["/home/we/dust/audio/grains/save.wav"]);
    expect(did).toContain("unlink /home/we/dust/audio/grains/save.wav");
  });

  it("waits for /b_close for a file left open for DiskOut, and not a moment before", () => {
    const { t, files } = harness();
    const w = encodeMessage("/b_write", [1, "/home/we/dust/audio/dronecaster/d.aiff", "aiff", "int24", 0, 0, 1, 0]);
    t.fromLang(encodeMessage("/b_alloc", [1, 65536, 2, w, 48000]));
    t.fromServer("/done", ["/b_alloc", 1]);
    t.fromServer("/done", ["/b_write", 1]);
    expect(files.size).toBe(0);
    t.fromServer("/done", ["/b_close", 1]);
    expect([...files.keys()]).toEqual(["/home/we/dust/audio/dronecaster/d.aiff"]);
    t.fromServer("/done", ["/b_free", 1]);
    expect(files.size).toBe(1);
  });

  it("takes /b_free as the close when it comes first, and says when a file is not there", () => {
    const { t, did, files } = harness();
    t.fromLang(encodeMessage("/b_write", [2, "/tmp/missing.wav", "wav", "int16", 0, 0, 1, 0]));
    t.fromServer("/done", ["/b_free", 2]);
    expect(files.size).toBe(0);
    expect(did.join("\n")).toMatch(/not there/);
  });

  it("matches several writes of one buffer in order, and logs a refusal", () => {
    const { t, did, files } = harness();
    t.fromLang(encodeMessage("/b_write", [5, "/a/1.wav", "wav", "int16", -1, 0, 0, 0]));
    t.fromLang(encodeMessage("/b_write", [5, "/a/2.wav", "wav", "int16", -1, 0, 0, 0]));
    t.fromServer("/done", ["/b_write", 5]);
    expect([...files.keys()]).toEqual(["/a/1.wav"]);
    t.fromServer("/done", ["/b_write", 5]);
    expect([...files.keys()]).toEqual(["/a/1.wav", "/a/2.wav"]);
    t.fromServer("/fail", ["/b_write", "could not open file"]);
    expect(did.join("\n")).toMatch(/could not write it — could not open file/);
  });
});
