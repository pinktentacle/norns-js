// E6-10 — what the page remembers, and what it does when it cannot.
//
// The interesting cases are all failures: storage that throws, storage that
// comes back corrupt, and a stored value from a version that no longer
// exists. None of them may take the page down, and each has to leave the user
// with the defaults rather than with half a layout.

import { describe, expect, it, vi } from "vitest";
import {
  createSettings,
  dbToGain,
  STORAGE_KEY,
  VOLUME_MAX_DB,
  VOLUME_MIN_DB,
  type StorageLike,
} from "../src/ui/settings.js";
import { bind, DEFAULT_KEYMAP, codesFor } from "../src/ui/keymap.js";
import { createInputCore } from "../src/ui/input-core.js";

function memory(initial?: string): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(STORAGE_KEY, initial);
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("keeping settings", () => {
  it("starts at the defaults and writes nothing until asked", () => {
    const s = memory();
    const store = createSettings(s);
    expect(store.keymap).toEqual(DEFAULT_KEYMAP);
    expect(store.layout).toEqual({});
    expect(s.data.size).toBe(0);
  });

  it("survives a reload", () => {
    const s = memory();
    const a = createSettings(s);
    a.setKeymap(bind(a.keymap, "KeyJ", "k3"));
    a.setPlacement("grid", { x: 40, y: 120, w: 700 });

    const b = createSettings(s);
    expect(codesFor(b.keymap, "k3")).toContain("KeyJ");
    expect(b.layout.grid).toEqual({ x: 40, y: 120, w: 700 });
  });

  it("works with no storage at all, and SAYS so", () => {
    // A private window is not an error state the user should discover by
    // finding their layout gone.
    const store = createSettings(null);
    expect(store.persisted).toBe(false);
    store.setPlacement("norns", { x: 1, y: 2, w: 300 });
    expect(store.layout.norns).toEqual({ x: 1, y: 2, w: 300 });
  });

  it("keeps working when the write is refused, and stops claiming it is kept", () => {
    const s = memory();
    const store = createSettings(s);
    expect(store.persisted).toBe(true);
    s.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    store.setPlacement("arc", { x: 5, y: 5, w: 500 });
    expect(store.persisted).toBe(false);
    expect(store.layout.arc).toEqual({ x: 5, y: 5, w: 500 });
  });

  it("falls back to the defaults on a corrupt value rather than throwing", () => {
    const store = createSettings(memory("{not json"));
    expect(store.keymap).toEqual(DEFAULT_KEYMAP);
    expect(store.layout).toEqual({});
  });

  it("drops a placement that would make a device unreachable", () => {
    // A width of zero is a device nobody can see or grab again. A missing
    // coordinate is a shape from another version.
    const store = createSettings(
      memory(
        JSON.stringify({
          layout: { norns: { x: 0, y: 0, w: 0 }, grid: { x: 1, w: 400 }, arc: { x: 2, y: 3, w: 400 } },
        }),
      ),
    );
    expect(store.layout.norns).toBeUndefined();
    expect(store.layout.grid).toBeUndefined();
    expect(store.layout.arc).toEqual({ x: 2, y: 3, w: 400 });
  });

  it("resets each half on its own", () => {
    const s = memory();
    const store = createSettings(s);
    store.setKeymap(bind(store.keymap, "KeyJ", "k3"));
    store.setPlacement("grid", { x: 1, y: 2, w: 300 });

    store.resetKeymap();
    expect(store.keymap).toEqual(DEFAULT_KEYMAP);
    expect(store.layout.grid).toEqual({ x: 1, y: 2, w: 300 });

    store.clearLayout();
    expect(store.layout).toEqual({});
  });

  it("tells its listener which half moved", () => {
    const store = createSettings(memory());
    const seen = vi.fn();
    store.subscribe(seen);
    store.setPlacement("arc", { x: 0, y: 0, w: 400 });
    expect(seen).toHaveBeenCalledWith(expect.anything(), "layout");
    store.resetKeymap();
    expect(seen).toHaveBeenCalledWith(expect.anything(), "keymap");
  });
});

describe("the master mute", () => {
  it("starts OFF: the output is live", () => {
    // It used to start muted. A browser will not start an AudioContext
    // before a user gesture anyway, so muting as well asked permission
    // twice and cost a click before anyone could hear a norns at all.
    expect(createSettings(memory()).muted).toBe(false);
    expect(createSettings(null).muted).toBe(false);
  });

  it("only an explicit true mutes, so an old stored value does not", () => {
    // The version that defaulted to muted wrote `true` for people who
    // never chose it. Reading anything-but-false as muted would keep those
    // pages silent for a choice nobody made.
    expect(createSettings(memory(JSON.stringify({}))).muted).toBe(false);
    expect(createSettings(memory(JSON.stringify({ muted: true }))).muted).toBe(true);
    expect(createSettings(memory(JSON.stringify({ muted: "yes" }))).muted).toBe(false);
  });

  it("remembers being muted", () => {
    const s = memory();
    createSettings(s).setMuted(true);
    expect(createSettings(s).muted).toBe(true);
  });
});

describe("encoder sensitivity", () => {
  it("is one by default, bounded, and remembered", () => {
    const s = memory();
    const store = createSettings(s);
    expect(store.encoderSensitivity).toBe(1);
    store.setEncoderSensitivity(8);
    expect(store.encoderSensitivity, "clamped at the top").toBe(4);
    store.setEncoderSensitivity(0);
    expect(store.encoderSensitivity, "never zero: the knob must do something").toBe(0.25);
    store.setEncoderSensitivity(2);
    expect(createSettings(s).encoderSensitivity).toBe(2);
  });

  it("scales a key press, and never below one tick", () => {
    const store = createSettings(memory());
    const core = createInputCore({ sensitivity: () => store.encoderSensitivity });
    const turn = (): number => {
      const out = core.handle({ t: "keydown", code: "KeyS", repeat: false, modifier: false });
      return (out[0] as { delta: number }).delta;
    };
    expect(turn()).toBe(2);
    store.setEncoderSensitivity(4);
    expect(turn()).toBe(8);
    store.setEncoderSensitivity(0.25);
    // 2 * 0.25 rounds to 1, not to 0: a detent that does nothing is a
    // broken knob, not a fine one.
    expect(turn()).toBe(1);
  });

  it("scales a DRAG the other way round, so the two agree", () => {
    // More sensitive means fewer pixels per tick. Scaling only the key
    // press would make the mouse and the keyboard disagree about the knob.
    const store = createSettings(memory());
    const core = createInputCore({ sensitivity: () => store.encoderSensitivity });
    const drag = (dx: number): number => {
      core.handle({ t: "pointerdown", id: 1, on: { kind: "enc", n: 2 }, x: 0, y: 0 });
      const out = core.handle({ t: "pointermove", id: 1, x: dx, y: 0 });
      core.handle({ t: "pointerup", id: 1 });
      return out.reduce((n, a) => n + ((a as { delta?: number }).delta ?? 0), 0);
    };
    const atOne = drag(40);
    store.setEncoderSensitivity(2);
    const atTwo = drag(40);
    expect(atTwo).toBeGreaterThan(atOne);
  });
});

describe("zoom, and the keyboard's two numbers", () => {
  it("start at their defaults and are remembered", () => {
    const st = memory();
    const a = createSettings(st);
    expect(a.zoom).toBe(1);
    expect(a.midiOctave).toBe(4);
    expect(a.midiVelocity).toBe(100);
    a.setZoom(1.5);
    a.setMidiOctave(2);
    a.setMidiVelocity(40);
    const b = createSettings(st);
    expect([b.zoom, b.midiOctave, b.midiVelocity]).toEqual([1.5, 2, 40]);
  });

  it("are bounded, and velocity never reaches zero", () => {
    // A velocity of 0 is a note OFF on the wire, so a keyboard that could
    // be set to it would have a silent setting that also broke every note.
    const s = createSettings(memory());
    s.setZoom(99);
    expect(s.zoom).toBe(2.5);
    s.setZoom(0);
    expect(s.zoom).toBe(0.5);
    s.setMidiVelocity(0);
    expect(s.midiVelocity).toBe(1);
    s.setMidiVelocity(999);
    expect(s.midiVelocity).toBe(127);
    s.setMidiOctave(99);
    expect(s.midiOctave).toBe(7);
  });

  it("falls back rather than storing nonsense from another version", () => {
    const s = createSettings(
      memory(JSON.stringify({ zoom: "big", midiOctave: null, midiVelocity: [] })),
    );
    expect([s.zoom, s.midiOctave, s.midiVelocity]).toEqual([1, 4, 100]);
  });

  it("tells its listener which half moved", () => {
    const s = createSettings(memory());
    const seen = vi.fn();
    s.subscribe(seen);
    s.setZoom(1.2);
    expect(seen).toHaveBeenCalledWith(expect.anything(), "zoom");
    s.setMidiVelocity(50);
    expect(seen).toHaveBeenCalledWith(expect.anything(), "midi");
  });
});

describe("a remapped key reaches norns", () => {
  it("takes effect without rebuilding the input", () => {
    // The core asks for the map on every keystroke rather than holding one,
    // because the alternative is tearing down every pointer binding to
    // change one key.
    const store = createSettings(memory());
    const core = createInputCore({ keymap: () => store.keymap });
    expect(core.handle({ t: "keydown", code: "KeyJ", repeat: false, modifier: false })).toEqual([]);

    store.setKeymap(bind(store.keymap, "KeyJ", "k3"));
    expect(core.handle({ t: "keydown", code: "KeyJ", repeat: false, modifier: false })).toEqual([
      { a: "key", n: 3, z: 1 },
    ]);
    expect(core.handle({ t: "keyup", code: "KeyJ" })).toEqual([{ a: "key", n: 3, z: 0 }]);
  });

  it("releases a key held across the rebind that took it away", () => {
    // Holding 1, unbinding 1, letting go. The release is tracked by CODE, so
    // it still arrives -- otherwise norns believes K1 is down forever.
    const store = createSettings(memory());
    const core = createInputCore({ keymap: () => store.keymap });
    expect(core.handle({ t: "keydown", code: "Digit1", repeat: false, modifier: false })).toEqual([
      { a: "key", n: 1, z: 1 },
    ]);
    store.setKeymap({ ...DEFAULT_KEYMAP, Digit1: { key: 3 } });
    expect(core.handle({ t: "keyup", code: "Digit1" })).toEqual([{ a: "key", n: 1, z: 0 }]);
  });

  it("an empty map is inert, which is how arrange mode borrows the arrows", () => {
    const core = createInputCore({ keymap: () => ({}) });
    expect(core.handle({ t: "keydown", code: "ArrowUp", repeat: false, modifier: false })).toEqual([]);
  });
});

// E9-13 — the master level, in decibels.
//
// IT GOES ABOVE ZERO, which a master fader normally should not, and the
// reason is measured rather than stylistic: `amen` arrives about 17 dB
// quieter from the engine in the desktop shell than in a tab, and a control
// that stopped at unity could not make it audible.
describe("the master level", () => {
  it("defaults to unity and converts decibels to gain", () => {
    const s = createSettings(memory());
    expect(s.volumeDb).toBe(0);
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3);
    expect(dbToGain(12)).toBeCloseTo(3.9811, 3);
    expect(dbToGain(VOLUME_MIN_DB)).toBeCloseTo(0.001, 5);
  });

  it("clamps to the range rather than refusing", () => {
    const s = createSettings(memory());
    s.setVolume(99);
    expect(s.volumeDb).toBe(VOLUME_MAX_DB);
    s.setVolume(-999);
    expect(s.volumeDb).toBe(VOLUME_MIN_DB);
    s.setVolume(Number.NaN);
    expect(s.volumeDb, "a broken number is unity, not silence").toBe(0);
  });

  it("is remembered, and survives a settings file written before it existed", () => {
    const store = memory();
    const a = createSettings(store);
    a.setVolume(-9);
    expect(createSettings(store).volumeDb).toBe(-9);
    // A file from the version with no level at all.
    store.setItem(STORAGE_KEY, JSON.stringify({ muted: false }));
    expect(createSettings(store).volumeDb, "the absence means unity").toBe(0);
  });

  it("tells its listeners which thing changed", () => {
    const s = createSettings(memory());
    const seen: string[] = [];
    s.subscribe((_st, what) => seen.push(what));
    s.setVolume(3);
    s.setMuted(true);
    expect(seen).toEqual(["volume", "muted"]);
  });
});
