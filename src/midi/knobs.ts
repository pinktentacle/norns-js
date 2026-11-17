// `knobs`: a virtual MIDI encoder bank — four banks of sixteen, each with a
// push switch and a ring the host can light.
//
// INSPIRED BY the Midi Fighter Twister, whose mapping is the one norns
// scripts already speak: `cheat_codes_2` writes its three banks out by hand
// as CCs 0-11, 16-27 and 32-43 (`lib/midicheat.lua:139`) and paints the
// rings back as the sample moves.
//
// IT IS CALLED `knobs` ON THE PAGE AND "Midi Fighter Twister" ON THE WIRE.
// The button says what the thing is to whoever is looking at it; the
// descriptor says what a SCRIPT has to hear. `cheat_codes_2.lua:2093` is an
// exact string compare, and on finding that name it turns on its encoder
// control, its echo, and the whole ring-painting half of itself. A device
// that answers anything else gets none of that.
//
// WHAT IT SENDS:
//   turning  -> CC on MIDI CHANNEL 1, controller (bank * 16) + encoder
//   pressing -> the SAME controller on MIDI CHANNEL 2, 127 down and 0 up
// Four banks of sixteen gives controllers 0-63.
//
// WHAT IT LISTENS TO, which is half of what it is for:
//   CC on channel 1 -> the ring, WHICH IS THE ENCODER'S VALUE
//   CC on channel 2 -> the ring's colour
// The first sets the value rather than shadowing it, because that is what
// the hardware does in its absolute mode: the host's number wins and the
// ring shows it, which is how a script snaps a control to where the
// parameter really is. Keeping a second number for "what the host thinks"
// would be two sources of truth for one knob. Anything else is ignored,
// which is what hardware does with a message it has no setting for.
//
// ABSOLUTE, NOT RELATIVE. Relative would mean choosing an encoding — there
// are three in common use — and getting it wrong is a control that moves
// backwards. Absolute is also what the original ships with.
//
// OFF BY DEFAULT, like every other virtual device here.

import type { MidiDevice, MidiPort } from "./device.js";

/**
 * What it calls itself in `midi.devices` and in SYSTEM > DEVICES.
 *
 * NOT the name on the button. Scripts match this string exactly — see the
 * header — so it is the hardware's name and a test pins it.
 */
export const KNOBS_MIDI_NAME = "Midi Fighter Twister";
export const KNOBS_COUNT = 16;
export const KNOBS_BANKS = 4;

export interface KnobsMidiPort extends MidiPort {
  /** Where the CCs go. Set after the manager has made the device. */
  attach(device: MidiDevice): void;
  /** Which bank the face is showing, 0-based. */
  bank(): number;
  setBank(bank: number): void;
  /** Turn one knob of the CURRENT bank to 0..127. */
  turn(knob: number, value: number): void;
  /** Press or release one knob's switch. */
  press(knob: number, down: boolean): void;
  /** What each knob of the current bank is at. */
  values(): readonly number[];
  /** The colour the host set for each knob of the current bank, or null. */
  colours(): readonly (number | null)[];
  /** Called when the host changed something the face shows. */
  onPaint(fn: () => void): void;
}

const CC_CHANNEL = 0; // MIDI channel 1
const SWITCH_CHANNEL = 1; // MIDI channel 2

export function createKnobsMidiPort(opts: { name?: string; id?: string } = {}): KnobsMidiPort {
  const slots = KNOBS_COUNT * KNOBS_BANKS;
  const at = new Array<number>(slots).fill(0);
  const colour = new Array<number | null>(slots).fill(null);
  let device: MidiDevice | null = null;
  let current = 0;
  let notify: (() => void) | null = null;

  const cc = (bank: number, knob: number): number => bank * KNOBS_COUNT + knob;

  const push = (status: number, controller: number, value: number): void => {
    const bytes = [status, controller, value];
    queueMicrotask(() => device?.receive(bytes));
  };

  return {
    descriptor: { id: opts.id ?? "virtual-knobs", name: opts.name ?? KNOBS_MIDI_NAME },
    attach(d) {
      device = d;
    },
    send(bytes) {
      // The host painting the face. Nothing answers back: the device has no
      // reply to make.
      if (bytes.length < 3) return;
      const status = bytes[0] ?? 0;
      const controller = bytes[1] ?? 0;
      const value = Math.max(0, Math.min(127, bytes[2] ?? 0));
      if (controller >= slots) return;
      if (status === (0xb0 | CC_CHANNEL)) at[controller] = value;
      else if (status === (0xb0 | SWITCH_CHANNEL)) colour[controller] = value;
      else return;
      notify?.();
    },
    bank() {
      return current;
    },
    setBank(bank) {
      const b = Math.trunc(bank);
      if (b < 0 || b >= KNOBS_BANKS || b === current) return;
      current = b;
      notify?.();
    },
    turn(knob, value) {
      const i = Math.trunc(knob);
      if (i < 0 || i >= KNOBS_COUNT) return;
      const slot = cc(current, i);
      const v = Math.max(0, Math.min(127, Math.round(value)));
      if (at[slot] === v) return;
      at[slot] = v;
      push(0xb0 | CC_CHANNEL, slot, v);
    },
    press(knob, down) {
      const i = Math.trunc(knob);
      if (i < 0 || i >= KNOBS_COUNT) return;
      push(0xb0 | SWITCH_CHANNEL, cc(current, i), down ? 127 : 0);
    },
    values() {
      return at.slice(current * KNOBS_COUNT, (current + 1) * KNOBS_COUNT);
    },
    colours() {
      return colour.slice(current * KNOBS_COUNT, (current + 1) * KNOBS_COUNT);
    },
    onPaint(fn) {
      notify = fn;
    },
  };
}
