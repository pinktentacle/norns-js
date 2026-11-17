// `faders`: a virtual MIDI fader bank, sixteen of them.
//
// INSPIRED BY the 16n (github.com/16n-faderbank/16n), which is the
// controller norns scripts assume when they assume anything — `mi-eng`'s
// five scripts build their default PMAP around it, starting at CC 32
// (`macro-b.lua:32`).
//
// IT IS CALLED `faders` ON THE PAGE AND "16n" ON THE WIRE, and the split is
// deliberate. The button says what the thing is to whoever is looking at
// it; the descriptor says what a SCRIPT has to hear. `flora.lua:110` is
// `if midi.devices[i].name == "16n"`, an exact string compare, and a
// device that answers anything else is a device flora will never find.
// Rename the constant below and that auto-detection goes away silently.
//
// WHAT IT SENDS. Faders 1-16 as CC 32-47 on MIDI channel 1, which is the
// 16n's factory default and therefore what a script's PMAP already expects.
//
// IT ANSWERS NOTHING. A real 16n can be asked for its channel and CC
// assignments over SysEx and told new ones; the two frame layouts in the
// wild do not agree — `flora`'s writer sends sixteen channels and sixteen
// CCs after `F0 7D 00 00 0C`, where the firmware's own frame carries USB
// and TRS assignments both — and a parser written from a guess would
// silently remap sixteen faders to the wrong controllers. So incoming bytes
// are dropped and the mapping above is the whole specification.
//
// OFF BY DEFAULT, like the arc, the keyboard and the loopback: a device
// that is simply there is a surprise, one you plug in is a choice.

import type { MidiDevice, MidiPort } from "./device.js";

/**
 * What it calls itself in `midi.devices` and in SYSTEM > DEVICES.
 *
 * NOT the name on the button. Scripts match this string exactly — see the
 * header — so it is the hardware's name and a test pins it.
 */
export const FADERS_MIDI_NAME = "16n";
export const FADERS_COUNT = 16;
/** Fader 1 is CC 32, fader 16 is CC 47. */
export const FADERS_CC_BASE = 32;

export interface FadersMidiPort extends MidiPort {
  /** Where the CCs go. Set after the manager has made the device. */
  attach(device: MidiDevice): void;
  /**
   * Move one fader, 0-based, to a value in 0..127.
   *
   * Sends only on a CHANGE, because a fader sends on movement and a pointer
   * dragged across one pixel of a 128-step track has not moved it.
   */
  move(fader: number, value: number): void;
  /** What each fader is at, for a view that has just been built. */
  values(): readonly number[];
}

export function createFadersMidiPort(
  opts: { name?: string; id?: string; channel?: number; ccBase?: number } = {},
): FadersMidiPort {
  const channel = Math.max(0, Math.min(15, opts.channel ?? 0));
  const ccBase = Math.max(0, Math.min(127 - FADERS_COUNT + 1, opts.ccBase ?? FADERS_CC_BASE));
  const at = new Array<number>(FADERS_COUNT).fill(0);
  let device: MidiDevice | null = null;

  return {
    descriptor: { id: opts.id ?? "virtual-faders", name: opts.name ?? FADERS_MIDI_NAME },
    attach(d) {
      device = d;
    },
    send() {
      // See the header: there is no configuration protocol here to answer.
    },
    move(fader, value) {
      const i = Math.trunc(fader);
      if (i < 0 || i >= FADERS_COUNT) return;
      const v = Math.max(0, Math.min(127, Math.round(value)));
      if (at[i] === v) return;
      at[i] = v;
      // Asynchronous, for the reason the keyboard and the loopback are: a
      // message delivered inside the caller's own stack would re-enter a
      // script from the middle of whatever it was doing, which no cable and
      // no thread on hardware ever does.
      const bytes = [0xb0 | channel, ccBase + i, v];
      queueMicrotask(() => device?.receive(bytes));
    },
    values() {
      return at;
    },
  };
}
