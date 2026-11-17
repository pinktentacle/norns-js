// E5-07 — the two `_norns` MIDI functions.
//
// Two, against the grid's nine, because MIDI's whole output surface is "send
// these bytes": `core/midi.lua` builds every note, cc and clock message in
// Lua and calls `_norns.midi_send` with a table of numbers. The C side never
// knew what a note was.

import type { NornsRegistry } from "../norns/registry.js";
import type { MidiManager } from "./manager.js";

/**
 * `lua_tointeger`, for the one place the boundary reads a number rather than
 * a truth value. A boolean is 0, as it is in Lua 5.3; a numeric string
 * converts, as `lua_tointeger` converts it.
 */
function luaInteger(v: unknown): number {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

export interface MidiRegisterOptions {
  readonly log?: (line: string) => void;
}

export function registerMidi(
  registry: NornsRegistry,
  manager: MidiManager,
  opts: MidiRegisterOptions = {},
): void {
  const log = opts.log ?? (() => {});

  /**
   * A call for a device that has gone is a no-op, not an error.
   *
   * `Midi.vports[i].device` is cleared by `update_devices` on an unplug, but
   * a script that captured the device object keeps sending to it, and
   * `Midi:send` reaches straight through. On hardware the write goes to a
   * closed file descriptor and fails quietly; throwing here would take the
   * script down for unplugging a cable.
   */
  const dev = (handle: unknown) => manager.get(Number(handle));

  registry.implement("midi_send", (handle, data) => {
    const d = dev(handle);
    if (d === undefined) return;
    // `Midi:send` passes either a table built by `Midi.to_data` or whatever
    // the script handed it. Anything that is not a number is dropped rather
    // than coerced: `NaN` reaching Web MIDI is a TypeError, and a script
    // sending `nil` in a table means its own bug, which the log should name.
    const raw = Array.isArray(data) ? data : [];
    const bytes: number[] = [];
    for (const v of raw) {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        log(`midi_send: ${d.descriptor.name} — a non-numeric byte was dropped`);
        continue;
      }
      bytes.push(n & 0xff);
    }
    if (bytes.length > 0) d.send(bytes);
  });

  registry.implement("midi_clock_receive", (handle, enabled) => {
    // NOT lua_toboolean. `weaver.cc:1786` is
    //
    //     int enabled = lua_tointeger(l, 2);
    //     md->clock_enabled = enabled > 0;
    //
    // so 0 DISABLES, which is the opposite of the grid's `rel` and the
    // opposite of what Lua truthiness would give. `Midi.update_clock_receive`
    // passes 1 and 0, which is why upstream works.
    //
    // The consequence worth knowing: `core/midi.lua` documents the argument
    // as `@tparam boolean enabled`, and `lua_tointeger` on a Lua boolean is
    // 0. A script calling `dev:clock_receive(true)` DISABLES its clock, on
    // hardware and here. Reproduced rather than fixed — a script written
    // against that behaviour would break if this one were kinder.
    dev(handle)?.clockReceive(luaInteger(enabled) > 0);
  });

  log("midi: 2 functions bound");
}
