import { describe, expect, it } from "vitest";
import { controlBusView } from "../src/engine/control-buses.js";

// E9-271 — the view sclang's _NornsJsControlBusGet reads through.

describe("controlBusView", () => {
  const makeModule = (offset: number, count: number) => {
    const heap = new Uint8Array(4096);
    return {
      HEAPU8: heap,
      controlBusOffset: () => offset,
      controlBusCount: () => count,
    };
  };

  it("lays the server's control buses out where scsynth says they are", () => {
    const mod = makeModule(1024, 16);
    new Float32Array(mod.HEAPU8.buffer, 1024, 16)[3] = 0.75;
    const view = controlBusView(mod)();
    expect(view).not.toBeNull();
    expect(view!.length).toBe(16);
    expect(view![3]).toBe(0.75);
  });

  it("writes through to the same memory", () => {
    const mod = makeModule(512, 8);
    controlBusView(mod)()!.set([0.25, 0.5], 2);
    const raw = new Float32Array(mod.HEAPU8.buffer, 512, 8);
    expect([raw[2], raw[3]]).toEqual([0.25, 0.5]);
  });

  it("answers null before the world exists, and the view once it does", () => {
    let offset = 0;
    const heap = new Uint8Array(1024);
    const get = controlBusView({ HEAPU8: heap, controlBusOffset: () => offset, controlBusCount: () => 4 });
    expect(get()).toBeNull();
    offset = 256;
    expect(get()?.length).toBe(4);
  });

  it("answers null for a scsynth that does not report the buses", () => {
    expect(controlBusView({ HEAPU8: new Uint8Array(64) })()).toBeNull();
  });

  it("refuses an offset outside the heap or out of alignment", () => {
    expect(controlBusView(makeModule(4090, 16))()).toBeNull();
    expect(controlBusView(makeModule(1026, 4))()).toBeNull();
  });

  it("reuses the view until the heap's buffer is replaced", () => {
    const mod = makeModule(128, 4) as { HEAPU8: Uint8Array; controlBusOffset: () => number; controlBusCount: () => number };
    const get = controlBusView(mod);
    const first = get();
    expect(get()).toBe(first);
    mod.HEAPU8 = new Uint8Array(8192);
    const second = get();
    expect(second).not.toBe(first);
    expect(second!.buffer).toBe(mod.HEAPU8.buffer);
  });
});
