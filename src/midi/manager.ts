// E5-07 — the MIDI device table, and the bridge into Lua.
//
// The same shape as `GridManager`, for the same reasons: ids are monotonic
// and NEVER REUSED, because `core/midi.lua:461` indexes `Midi.devices[id]`
// and raises `no entry for midi N` for one it does not know. A recycled id
// delivered to the wrong script handler would be worse than that error.

import { MidiDevice, type MidiDescriptor, type MidiPort } from "./device.js";

/** The three `_norns.midi.*` callbacks, as the callback layer exposes them. */
export interface MidiLuaBridge {
  midiAdd(id0: number, name: string, dev: unknown): void;
  midiRemove(id0: number): void;
  midiEvent(id0: number, bytes: readonly number[]): void;
  /** Not a norns callback: where real-time bytes go. E3-09 consumes it. */
  clockByte?(id0: number, byte: number, atSeconds: number): void;
}

export class MidiManager {
  private readonly devices = new Map<number, MidiDevice>();
  /** Browser port id → our device id, so a reconnect can be recognised. */
  private readonly byPortId = new Map<string, number>();
  private nextId = 0;

  constructor(private readonly lua: MidiLuaBridge) {}

  /**
   * Attach a port.
   *
   * A port id that is already attached returns the existing device rather
   * than adding a second: Web MIDI fires `statechange` for both halves of a
   * device and for transitions that are not really changes, and two
   * `_norns.midi.add` calls for one piece of hardware would show up twice in
   * SYSTEM > DEVICES and take two vports.
   */
  add(port: MidiPort): MidiDevice {
    const existing = this.byPortId.get(port.descriptor.id);
    if (existing !== undefined) {
      const d = this.devices.get(existing);
      if (d !== undefined) return d;
    }
    const id = this.nextId++;
    const device = new MidiDevice(id, port, {
      event: (bytes) => this.lua.midiEvent(id, bytes),
      clockByte: (byte, at) => this.lua.clockByte?.(id, byte, at),
    });
    this.devices.set(id, device);
    this.byPortId.set(port.descriptor.id, id);
    this.lua.midiAdd(id, port.descriptor.name, id);
    return device;
  }

  remove(id: number): void {
    const d = this.devices.get(id);
    if (d === undefined) return;
    this.devices.delete(id);
    this.byPortId.delete(d.descriptor.id);
    d.close();
    this.lua.midiRemove(id);
  }

  /** By browser port id, which is what a `statechange` gives. */
  removeByPortId(portId: string): void {
    const id = this.byPortId.get(portId);
    if (id !== undefined) this.remove(id);
  }

  get(id: number): MidiDevice | undefined {
    return this.devices.get(id);
  }

  has(portId: string): boolean {
    return this.byPortId.has(portId);
  }

  list(): MidiDevice[] {
    return [...this.devices.values()];
  }

  descriptors(): MidiDescriptor[] {
    return this.list().map((d) => d.descriptor);
  }
}
