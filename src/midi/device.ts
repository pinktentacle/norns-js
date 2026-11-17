// E5-07 — the MIDI device: a port of `dev_midi` and `device_midi.cc`.
//
// Web MIDI delivers one complete, well-formed message per event, which
// removes most of what `device_midi.cc` does: its buffer, its running-status
// reconstruction, its partial-message state. What it does NOT remove is the
// SHAPE matron hands to Lua, and scripts are written against that shape
// rather than against MIDI.
//
// THE ONE THING THAT LOOKS LIKE A BUG AND IS NOT. `midi_msg_len` returns 3
// for `0xF0`, and the comment in `device_midi.cc:195` says why: "special
// case, deliver sysex to lua in 3 byte chunks". A 40-byte sysex dump does not
// reach `_norns.midi.event` as one 40-byte table. It reaches it as fourteen
// calls of 3 bytes and one of whatever is left. Every script that reads
// sysex -- the Midi Fighter Twister and Faderfox EC4 handlers in
// cheat_codes_2, zxcvbn's DX7 patches -- reassembles it from those chunks.
// Hand such a script one 40-byte message and it sees a malformed stream.
//
// REAL-TIME BYTES GO BOTH WAYS. A byte at or above 0xF8 is passed to the
// clock when `clock_enabled` is set AND delivered to Lua as a one-byte
// message (`device_midi.cc:283-289`). Not either-or: a script can watch the
// clock bytes while the clock subsystem is also following them.

/** What a MIDI device says it is. */
export interface MidiDescriptor {
  /**
   * Stable across a disconnect and reconnect, and the key the browser uses.
   *
   * Web MIDI's `MIDIPort.id` is stable for a given port on a given origin,
   * which is what makes re-pairing on hot-plug possible at all.
   */
  readonly id: string;
  /**
   * What `Midi.new` turns into the Lua-visible name.
   *
   * `vport.get_unique_device_name` appends a counter when two devices share
   * one, so duplicates are upstream's problem and not handled here.
   */
  readonly name: string;
}

/** Where bytes go. One method, because that is all MIDI out is. */
export interface MidiPort {
  readonly descriptor: MidiDescriptor;
  send(bytes: readonly number[]): void;
  close?(): void;
}

/** What a device reports upward. 0-based ids; the callback layer adds the 1. */
export interface MidiInput {
  event(bytes: readonly number[]): void;
  /**
   * A real-time byte, when this device's clock reception is enabled.
   *
   * `atSeconds` is WHEN THE BYTE ARRIVED, not when this ran. Web MIDI
   * timestamps every message, and a MIDI clock's tempo is measured entirely
   * from the gaps between ticks -- so using the handler's own run time would
   * fold every scheduling delay in the page into the tempo.
   */
  clockByte?(byte: number, atSeconds: number): void;
}

/**
 * Split a complete MIDI message the way matron hands it to Lua.
 *
 * Non-sysex messages pass through whole: Web MIDI has already done the
 * reassembly `device_midi.cc` does by hand.
 *
 * A sysex message becomes 3-byte chunks, and the LAST one is whatever is
 * left -- which means the terminating `0xF7` sometimes lands inside a full
 * chunk and sometimes arrives alone. Both are matron's behaviour, traced
 * through `midi_input_msg_acc`:
 *
 *     F0 a b c d e F7  ->  [F0 a b] [c d e] [F7]
 *     F0 a b c d F7    ->  [F0 a b] [c d F7]
 */
export function chunkForLua(bytes: readonly number[]): number[][] {
  if (bytes.length === 0) return [];
  if (bytes[0] !== 0xf0) return [[...bytes]];
  const out: number[][] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    out.push([...bytes.slice(i, i + 3)]);
  }
  return out;
}

/** 0xF8 and above: timing clock, start, continue, stop, sensing, reset. */
export function isRealTime(byte: number): boolean {
  return byte >= 0xf8;
}

/** Monotonic seconds, on the same origin Web MIDI timestamps against. */
function nowSeconds(): number {
  return typeof performance !== "undefined" ? performance.now() / 1000 : Date.now() / 1000;
}

export class MidiDevice {
  readonly descriptor: MidiDescriptor;
  /**
   * `dev_midi.clock_enabled`, and it starts TRUE.
   *
   * `device_midi.cc:108` sets it on construction, so a device delivers clock
   * to the clock subsystem from the moment it appears and
   * `Midi:clock_receive(false)` is how a script opts out. Starting false
   * would mean no external clock until something asked for it, which is not
   * how a norns behaves when you plug a drum machine in.
   */
  private clockEnabled = true;

  constructor(
    readonly id: number,
    private readonly port: MidiPort,
    private readonly input: MidiInput,
  ) {
    this.descriptor = port.descriptor;
  }

  /**
   * `_norns.midi_send`. The bytes go out exactly as Lua built them.
   *
   * No validation: `Midi:send` already turned a table into bytes, and a
   * script sending something malformed should see the device's own reaction,
   * not this layer's opinion. The one thing that IS done here is catching a
   * throw -- Web MIDI raises on a bad message, and an exception here would
   * come out of the middle of a script's `init`.
   */
  send(bytes: readonly number[]): void {
    this.port.send(bytes);
  }

  /** `_norns.midi_clock_receive`. */
  clockReceive(enabled: boolean): void {
    this.clockEnabled = enabled;
  }

  get clockEnabledNow(): boolean {
    return this.clockEnabled;
  }

  /**
   * One complete message from the hardware.
   *
   * Order matters and matches `dev_midi_consume_buffer`: the clock sees the
   * byte first, then Lua sees the message. A script's event handler can take
   * milliseconds, and the clock should not be behind it.
   */
  receive(bytes: readonly number[], atSeconds = nowSeconds()): void {
    if (bytes.length === 0) return;
    if (this.clockEnabled && this.input.clockByte !== undefined) {
      for (const b of bytes) {
        if (isRealTime(b)) this.input.clockByte(b, atSeconds);
      }
    }
    for (const chunk of chunkForLua(bytes)) this.input.event(chunk);
  }

  close(): void {
    this.port.close?.();
  }
}
