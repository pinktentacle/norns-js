// `faders` and `knobs`, on the wire.
//
// What matters is what a SCRIPT sees. These two carry a mapping — faders on
// CC 32-47, knobs on CC 0-63 across four banks with their switches on
// channel 2 — and a mapping that is off by one is a controller that moves
// the wrong parameter, silently, for ever.

import { describe, expect, it } from "vitest";
import { createFadersMidiPort, FADERS_CC_BASE, FADERS_MIDI_NAME } from "../src/midi/faders.js";
import { createKnobsMidiPort, KNOBS_MIDI_NAME } from "../src/midi/knobs.js";
import type { MidiDevice } from "../src/midi/device.js";

/** A device that records what reaches it, nothing more. */
function sink(): { got: number[][]; device: MidiDevice } {
  const got: number[][] = [];
  return {
    got,
    device: { receive: (bytes: readonly number[]) => void got.push([...bytes]) } as MidiDevice,
  };
}

/** Both ports send on a microtask, as a cable does. */
const settle = (): Promise<void> => new Promise((r) => void queueMicrotask(() => r()));

describe("the names these answer to", () => {
  // THE BUTTONS SAY `faders` AND `knobs`; THE WIRE DOES NOT.
  //
  // Two bundled scripts find their controller by comparing this string
  // exactly, and set themselves up on the match: `flora.lua:110` looks for
  // "16n", and `cheat_codes_2.lua:2093` for "Midi Fighter Twister", after
  // which it turns on its encoder control, its echo and the whole
  // ring-painting half of itself. Renaming either of these is not a
  // cosmetic change — it is auto-detection going away in silence, which is
  // why it is pinned here rather than left to a comment.
  it("is 16n on the wire", () => {
    expect(createFadersMidiPort().descriptor.name).toBe("16n");
    expect(FADERS_MIDI_NAME).toBe("16n");
  });

  it("is Midi Fighter Twister on the wire", () => {
    expect(createKnobsMidiPort().descriptor.name).toBe("Midi Fighter Twister");
    expect(KNOBS_MIDI_NAME).toBe("Midi Fighter Twister");
  });
});

describe("faders", () => {
  it("sends CC 32-47 on channel 1", async () => {
    const s = sink();
    const port = createFadersMidiPort();
    port.attach(s.device);
    port.move(0, 64);
    port.move(15, 127);
    await settle();
    expect(s.got).toEqual([
      [0xb0, FADERS_CC_BASE, 64],
      [0xb0, FADERS_CC_BASE + 15, 127],
    ]);
  });

  it("sends only on a change, because a fader that has not moved has not moved", async () => {
    const s = sink();
    const port = createFadersMidiPort();
    port.attach(s.device);
    port.move(3, 20);
    port.move(3, 20);
    port.move(3, 21);
    await settle();
    expect(s.got.map((m) => m[2])).toEqual([20, 21]);
  });

  it("ignores a fader that is not there, rather than inventing a controller", async () => {
    const s = sink();
    const port = createFadersMidiPort();
    port.attach(s.device);
    port.move(-1, 64);
    port.move(16, 64);
    await settle();
    expect(s.got).toEqual([]);
  });

  it("is asynchronous, because a synchronous one re-enters the script", () => {
    const s = sink();
    const port = createFadersMidiPort();
    port.attach(s.device);
    port.move(0, 64);
    expect(s.got, "arrived inside the caller's own stack").toEqual([]);
  });

  it("has nothing to say back: there is no configuration protocol here", async () => {
    const s = sink();
    const port = createFadersMidiPort();
    port.attach(s.device);
    port.send([0xf0, 0x7d, 0x00, 0x00, 0x0c, 0xf7]);
    await settle();
    expect(s.got).toEqual([]);
  });
});

describe("knobs", () => {
  it("turns on channel 1 and switches on channel 2, same controller", async () => {
    const s = sink();
    const port = createKnobsMidiPort();
    port.attach(s.device);
    port.turn(2, 90);
    port.press(2, true);
    port.press(2, false);
    await settle();
    expect(s.got).toEqual([
      [0xb0, 2, 90],
      [0xb1, 2, 127],
      [0xb1, 2, 0],
    ]);
  });

  it("moves the controller number with the bank", async () => {
    // Four banks of sixteen is CC 0-63, and a script that addresses bank 3
    // writes 32-47 out by hand. Off by a bank is the wrong parameter.
    const s = sink();
    const port = createKnobsMidiPort();
    port.attach(s.device);
    port.setBank(2);
    port.turn(0, 10);
    port.press(1, true);
    await settle();
    expect(s.got).toEqual([
      [0xb0, 32, 10],
      [0xb1, 33, 127],
    ]);
  });

  it("refuses a bank that does not exist", () => {
    const port = createKnobsMidiPort();
    port.setBank(4);
    expect(port.bank()).toBe(0);
    port.setBank(-1);
    expect(port.bank()).toBe(0);
  });

  it("takes the ring from the host as the value, and the colour beside it", () => {
    // The host paints the face and the paint IS the state: that is how a
    // script snaps a control to where the parameter really is.
    const port = createKnobsMidiPort();
    port.attach(sink().device);
    port.send([0xb0, 5, 100]);
    port.send([0xb1, 5, 40]);
    expect(port.values()[5]).toBe(100);
    expect(port.colours()[5]).toBe(40);
  });

  it("keeps each bank's state apart", () => {
    const port = createKnobsMidiPort();
    port.attach(sink().device);
    port.turn(0, 11);
    port.setBank(1);
    expect(port.values()[0], "bank 2 knob 1 is its own knob").toBe(0);
    port.turn(0, 22);
    port.setBank(0);
    expect(port.values()[0]).toBe(11);
  });

  it("says nothing back when the host paints it", async () => {
    const s = sink();
    const port = createKnobsMidiPort();
    port.attach(s.device);
    port.send([0xb0, 5, 100]);
    await settle();
    expect(s.got, "a painted ring is not a turned knob").toEqual([]);
  });

  it("ignores a controller outside its four banks", () => {
    const port = createKnobsMidiPort();
    port.attach(sink().device);
    port.send([0xb0, 100, 64]);
    expect(port.values().every((v) => v === 0)).toBe(true);
  });
});
