// E9-15 — the sound card list, and the one thing it must never do.
//
// A picker is only as honest as the list under it, and the browser hands
// back two very different lists depending on a permission: three real
// devices, or ONE PLACEHOLDER with an empty id and no label. The second is
// not a device. Offering it puts a row in the picker that does nothing when
// chosen, and `setSinkId("")` means "the system default" — so a user who
// picked the nameless entry would silently get the default and believe they
// had chosen something.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canChooseOutput,
  listAudioDevices,
  setOutputDevice,
  watchDevices,
} from "../src/ui/audio-devices.js";

type Info = { kind: string; deviceId: string; label: string };

/** A navigator with the two things this file reads. */
function fakeNavigator(devices: Info[], permission = "granted"): void {
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal("navigator", {
    mediaDevices: {
      enumerateDevices: async () => devices,
      addEventListener: (t: string, fn: () => void) => {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t)?.add(fn);
      },
      removeEventListener: (t: string, fn: () => void) => void listeners.get(t)?.delete(fn),
      __fire: (t: string) => listeners.get(t)?.forEach((fn) => fn()),
    },
    permissions: { query: async () => ({ state: permission }) },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("listing the sound cards", () => {
  it("drops the placeholder, which is not a device", () => {
    // What the browser returns when the microphone is refused: one of each,
    // with nothing to identify them by. Measured in Chromium 156.
    fakeNavigator(
      [
        { kind: "audiooutput", deviceId: "", label: "" },
        { kind: "audioinput", deviceId: "", label: "" },
      ],
      "denied",
    );
    return listAudioDevices().then((l) => {
      expect(l.outputs).toEqual([]);
      expect(l.inputs).toEqual([]);
      expect(l.named, "and the panel can say WHY it is empty").toBe(false);
      expect(l.permission).toBe("denied");
    });
  });

  it("keeps the real ones, and falls back to the id when a label is missing", () => {
    fakeNavigator([
      { kind: "audiooutput", deviceId: "default", label: "Default - Speakers" },
      { kind: "audiooutput", deviceId: "7933f4", label: "" },
      { kind: "audioinput", deviceId: "b62b47", label: "Line In" },
      { kind: "videoinput", deviceId: "cam", label: "Camera" },
    ]);
    return listAudioDevices().then((l) => {
      expect(l.outputs).toEqual([
        { id: "default", label: "Default - Speakers" },
        { id: "7933f4", label: "7933f4" },
      ]);
      expect(l.inputs, "a camera is not a sound card").toEqual([
        { id: "b62b47", label: "Line In" },
      ]);
      expect(l.named).toBe(true);
    });
  });

  it("survives a browser that refuses to enumerate at all", () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () => {
          throw new Error("no");
        },
      },
      permissions: {
        query: async () => {
          throw new Error("nor this");
        },
      },
    });
    return listAudioDevices().then((l) => {
      expect(l).toEqual({ outputs: [], inputs: [], named: false, permission: "unknown" });
    });
  });
});

describe("choosing an output", () => {
  it("says no rather than throwing when the browser cannot", async () => {
    const ctx = {} as AudioContext;
    const r = await setOutputDevice(ctx, "abc");
    expect(r.ok).toBe(false);
    expect(r.why).toContain("cannot choose");
  });

  it("passes the id through, and an empty id means the default", async () => {
    const seen: string[] = [];
    const ctx = { setSinkId: async (id: string) => void seen.push(id) } as unknown as AudioContext;
    expect(await setOutputDevice(ctx, "7933f4")).toEqual({ ok: true });
    expect(await setOutputDevice(ctx, "")).toEqual({ ok: true });
    expect(seen).toEqual(["7933f4", ""]);
  });

  it("reports a card that was pulled out between the list and the choice", async () => {
    const ctx = {
      setSinkId: async () => {
        const e = new Error("the device is gone");
        e.name = "NotFoundError";
        throw e;
      },
    } as unknown as AudioContext;
    const r = await setOutputDevice(ctx, "gone");
    expect(r.ok).toBe(false);
    expect(r.why).toContain("NotFoundError");
  });
});

describe("watching", () => {
  it("calls back when a card is plugged in, and unsubscribes", () => {
    fakeNavigator([]);
    const md = (globalThis.navigator as unknown as { mediaDevices: { __fire: (t: string) => void } })
      .mediaDevices;
    let hits = 0;
    const stop = watchDevices(() => hits++);
    md.__fire("devicechange");
    expect(hits).toBe(1);
    stop();
    md.__fire("devicechange");
    expect(hits, "and stops when told").toBe(1);
  });

  it("is a no-op where there is no mediaDevices at all", () => {
    vi.stubGlobal("navigator", {});
    expect(() => watchDevices(() => {})()).not.toThrow();
  });
});

describe("whether this browser can choose at all", () => {
  // Node has no AudioContext, so it is stubbed: the point of the test is
  // that the answer is read off the PROTOTYPE at call time rather than
  // captured once at import, because a panel built before the audio graph
  // would otherwise cache a "no" for the life of the page.
  it("reads setSinkId off the prototype, at call time", () => {
    class Ctx {}
    vi.stubGlobal("AudioContext", Ctx);
    expect(canChooseOutput()).toBe(false);
    (Ctx.prototype as { setSinkId?: unknown }).setSinkId = () => {};
    expect(canChooseOutput()).toBe(true);
  });
});
