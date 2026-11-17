// E5-08 — a virtual MIDI device: a loopback cable, and nothing more.
//
// WHY ONE EXISTS AT ALL. The browser pane here refuses Web MIDI outright,
// and plenty of machines have no MIDI hardware plugged in. That is not a
// cosmetic gap: a script written for MIDI sees `midi.devices` empty and
// behaves as it would on a norns with nothing attached — which for
// `cheat_codes_2` means `ping_midi_devices` building a `for` limit out of a
// nil and failing its whole `init`. A device that exists is the difference
// between exercising the MIDI path and never reaching it.
//
// WHAT IT IS, EXACTLY. A loopback: everything the script sends comes
// straight back in. That is a real piece of equipment — a MIDI cable with
// both ends in the same box — and naming it after one is what keeps this
// honest. It is NOT a synthesiser and it does not invent notes: nothing
// arrives that the script did not send.
//
// IT IS OFF BY DEFAULT, and that is deliberate. A loopback makes a script
// that echoes MIDI through hear itself, and one that sends clock follow its
// own clock. On real hardware that is exactly what a loop cable does and the
// user chose it; having it on by default would make it a surprise instead of
// a choice.

import type { MidiDevice, MidiPort } from "./device.js";

export const VIRTUAL_MIDI_NAME = "virtual midi loopback";

export interface VirtualMidiPort extends MidiPort {
  /**
   * Where the echo goes. Set after the manager has made the device, because
   * the device is what the bytes have to come back through.
   */
  attach(device: MidiDevice): void;
}

export function createVirtualMidiPort(opts: { name?: string; id?: string } = {}): VirtualMidiPort {
  const name = opts.name ?? VIRTUAL_MIDI_NAME;
  let device: MidiDevice | null = null;
  return {
    descriptor: { id: opts.id ?? "virtual-midi", name },
    attach(d) {
      device = d;
    },
    send(bytes) {
      // Asynchronous, and that is not a detail. `Midi:send` is called from
      // inside a script's own code; echoing synchronously would re-enter
      // that script's event handler from the middle of its send, which no
      // cable does and which norns' threads make impossible on hardware.
      const copy = [...bytes];
      queueMicrotask(() => device?.receive(copy));
    },
    close() {
      device = null;
    },
  };
}
