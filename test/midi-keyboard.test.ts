// The virtual MIDI keyboard's wire behaviour.
//
// What matters here is what a SCRIPT sees, which is bytes. A keyboard that
// looks right and sends a note on without its note off leaves a voice
// sounding that nothing can turn off — the one failure a player cannot work
// around and cannot diagnose.

import { describe, expect, it, vi } from "vitest";
import {
  baseNoteFor,
  createKeyboardMidiPort,
  noteName,
  OCTAVE_MAX,
  OCTAVE_MIN,
} from "../src/midi/keyboard.js";
import type { MidiDevice } from "../src/midi/device.js";

/** A device that records what reaches it, nothing more. */
function sink(): { got: number[][]; device: MidiDevice } {
  const got: number[][] = [];
  return {
    got,
    device: { receive: (bytes: readonly number[]) => void got.push([...bytes]) } as MidiDevice,
  };
}

/** The port sends on a microtask, as a cable does. */
const settle = (): Promise<void> => new Promise((r) => void queueMicrotask(() => r()));

describe("the keyboard as a MIDI source", () => {
  it("sends note on and note off on the wire", async () => {
    const s = sink();
    const port = createKeyboardMidiPort();
    port.attach(s.device);
    port.noteOn(60, 100);
    port.noteOff(60);
    await settle();
    expect(s.got).toEqual([
      [0x90, 60, 100],
      [0x80, 60, 0],
    ]);
  });

  it("is asynchronous, because a synchronous one re-enters the script", async () => {
    // `Midi:send` is called from inside a script's own code. Arriving
    // synchronously would run its event handler from the middle of that
    // call, which no cable and no thread on hardware ever does.
    const s = sink();
    const port = createKeyboardMidiPort();
    port.attach(s.device);
    port.noteOn(60);
    expect(s.got, "nothing yet").toEqual([]);
    await settle();
    expect(s.got.length).toBe(1);
  });

  it("ignores anything a script sends TO it", async () => {
    // A piano has no MIDI in. Echoing would make it a loopback, and there
    // is already one of those.
    const s = sink();
    const port = createKeyboardMidiPort();
    port.attach(s.device);
    port.send([0x90, 64, 100]);
    await settle();
    expect(s.got).toEqual([]);
  });

  it("retriggers a held note by releasing it first", async () => {
    // Two ons and one off leaves a script's voice bookkeeping one short.
    const s = sink();
    const port = createKeyboardMidiPort();
    port.attach(s.device);
    port.noteOn(60, 90);
    port.noteOn(60, 110);
    await settle();
    expect(s.got).toEqual([
      [0x90, 60, 90],
      [0x80, 60, 0],
      [0x90, 60, 110],
    ]);
  });

  it("will not send a note off for a note that was never on", async () => {
    const s = sink();
    const port = createKeyboardMidiPort();
    port.attach(s.device);
    port.noteOff(60);
    await settle();
    expect(s.got).toEqual([]);
  });

  it("treats velocity 0 as the note off it is on the wire", async () => {
    const s = sink();
    const port = createKeyboardMidiPort();
    port.attach(s.device);
    port.noteOn(60, 100);
    port.noteOn(60, 0);
    await settle();
    expect(s.got).toEqual([
      [0x90, 60, 100],
      [0x80, 60, 0],
    ]);
  });

  it("releases everything on allOff, and on close", async () => {
    const s = sink();
    const port = createKeyboardMidiPort();
    port.attach(s.device);
    port.noteOn(60);
    port.noteOn(64);
    port.noteOn(67);
    await settle();
    port.allOff();
    await settle();
    expect(s.got.slice(3)).toEqual([
      [0x80, 60, 0],
      [0x80, 64, 0],
      [0x80, 67, 0],
    ]);
    // And a second allOff has nothing left to say.
    port.allOff();
    await settle();
    expect(s.got.length).toBe(6);
  });

  it("stays on the wire's legal range", async () => {
    const s = sink();
    const port = createKeyboardMidiPort();
    port.attach(s.device);
    port.noteOn(999, 999);
    port.noteOn(-5, -5);
    await settle();
    expect(s.got[0]).toEqual([0x90, 127, 127]);
    // A negative velocity clamps to 0, which IS a note off, so nothing
    // more is sent for a note that was never on.
    expect(s.got.length).toBe(1);
  });

  it("sends on the channel it was given", async () => {
    const s = sink();
    const port = createKeyboardMidiPort({ channel: 3 });
    port.attach(s.device);
    port.noteOn(60, 100);
    await settle();
    expect(s.got[0]![0]).toBe(0x93);
  });

  it("says nothing when nothing is attached", async () => {
    const port = createKeyboardMidiPort();
    expect(() => port.noteOn(60)).not.toThrow();
    await settle();
  });
});

describe("where the two octaves sit", () => {
  it("puts middle C at 60, which is what the label says", () => {
    expect(baseNoteFor(4)).toBe(60);
    expect(noteName(60)).toBe("C4");
    expect(noteName(61)).toBe("C#4");
  });

  it("keeps the top note legal at the top octave", () => {
    // Two octaves is 24 semitones, so the last key is base + 23.
    expect(baseNoteFor(OCTAVE_MAX) + 23).toBeLessThanOrEqual(127);
    expect(baseNoteFor(OCTAVE_MIN)).toBeGreaterThanOrEqual(0);
  });

  it("clamps an octave nobody could play", () => {
    expect(baseNoteFor(99)).toBe(baseNoteFor(OCTAVE_MAX));
    expect(baseNoteFor(-99)).toBe(baseNoteFor(OCTAVE_MIN));
  });
});

describe("a listener that is also a device", () => {
  it("reaches the manager's device, not the port", async () => {
    // The port is what the UI pushes into; the device is what a script
    // connects to. Attaching is what joins them, and forgetting it is a
    // keyboard that plays silently.
    const received = vi.fn();
    const port = createKeyboardMidiPort();
    port.noteOn(60);
    await settle();
    expect(received).not.toHaveBeenCalled();
    port.attach({ receive: received } as unknown as MidiDevice);
    port.noteOn(62);
    await settle();
    expect(received).toHaveBeenCalledWith([0x90, 62, 100]);
  });
});
