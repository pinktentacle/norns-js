// A virtual MIDI keyboard: two octaves you can play with a pointer.
//
// NOT A LOOPBACK. `virtual.ts` echoes whatever a script sends back at it,
// which is a cable. This ORIGINATES messages: nothing a script sends to it
// comes back, because nothing a script sends to a keyboard happens on a real
// one either. A piano has no MIDI in.
//
// OFF BY DEFAULT, like the loopback and the arc. A device that is simply
// there is a surprise; a device you plug in is a choice. `Midi.add` fires on
// attach and `Midi.remove` on detach, so a running script sees a hot-plug —
// the same path a USB keyboard takes.
//
// WHY IT SENDS RAW BYTES rather than calling a note helper: norns' `midi`
// layer parses the stream itself, and a script that reads `msg.type` is
// reading the result of that parse. Anything that skipped it would work for
// the scripts that use `midi.to_msg` and silently fail for the ones that
// read bytes.

import type { MidiDevice, MidiPort } from "./device.js";

export const KEYBOARD_MIDI_NAME = "virtual midi keyboard";

/** Note 60 is middle C, which puts octave 4 at base 60. */
export const MIDDLE_C = 60;
/** Two octaves plus the top C would be 25; two octaves is 24 semitones. */
export const KEYBOARD_SEMITONES = 24;
/** Low enough for a bass part, high enough that the top note stays legal. */
export const OCTAVE_MIN = -1;
export const OCTAVE_MAX = 7;

export interface KeyboardMidiPort extends MidiPort {
  /** Where notes go. Set after the manager has made the device. */
  attach(device: MidiDevice): void;
  /** 0..127, with 0 velocity meaning note off — as the wire does. */
  noteOn(note: number, velocity?: number): void;
  noteOff(note: number): void;
  /** Everything currently held, released. For an octave change or a detach. */
  allOff(): void;
}

/** The lowest note of a two-octave keyboard set to `octave`. */
export function baseNoteFor(octave: number): number {
  const clamped = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, Math.round(octave)));
  return (clamped + 1) * 12;
}

/** `C4`, `F#-1` — how the octave button reads. */
export function noteName(note: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}

export function createKeyboardMidiPort(
  opts: { name?: string; id?: string; channel?: number } = {},
): KeyboardMidiPort {
  const channel = Math.max(0, Math.min(15, opts.channel ?? 0));
  const held = new Set<number>();
  let device: MidiDevice | null = null;

  const push = (status: number, a: number, b: number): void => {
    // Asynchronous for the same reason the loopback is: a note that arrived
    // synchronously would re-enter a script from the middle of whatever it
    // was doing, which no cable and no thread on hardware ever does.
    const bytes = [status | channel, a, b];
    queueMicrotask(() => device?.receive(bytes));
  };

  return {
    descriptor: { id: opts.id ?? "virtual-midi-keyboard", name: opts.name ?? KEYBOARD_MIDI_NAME },
    attach(d) {
      device = d;
    },
    send() {
      // A keyboard has no MIDI in. Dropped rather than echoed: echoing would
      // make it a loopback, and there is already one of those.
    },
    noteOn(note, velocity = 100) {
      const n = Math.max(0, Math.min(127, Math.round(note)));
      const v = Math.max(0, Math.min(127, Math.round(velocity)));
      if (v === 0) {
        this.noteOff(n);
        return;
      }
      // A second press of a held note sends note off first, so a script's
      // voice bookkeeping cannot end up with two ons and one off.
      if (held.has(n)) push(0x80, n, 0);
      held.add(n);
      push(0x90, n, v);
    },
    noteOff(note) {
      const n = Math.max(0, Math.min(127, Math.round(note)));
      if (!held.delete(n)) return;
      push(0x80, n, 0);
    },
    allOff() {
      for (const n of [...held]) {
        held.delete(n);
        push(0x80, n, 0);
      }
    },
    close() {
      this.allOff();
      device = null;
    },
  };
}
