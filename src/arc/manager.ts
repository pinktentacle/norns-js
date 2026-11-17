// E5-13 / E5-16 — the arc device table and the bridge into Lua.
//
// Ids are monotonic and never reused, as `GridManager`'s are and for the
// same reason: `core/arc.lua:228` indexes `Arc.devices[id]` and a recycled
// id would deliver an encoder turn to the wrong script handler.
//
// IT ADDS THROUGH `monome.add`, NOT `arc.add`. Matron never calls
// `_norns.arc.add` itself — every monome device arrives through
// `_norns.monome.add` and `startup.lua:68-73` routes it on the name prefix
// `"monome arc"`. Calling `arc.add` from here would bypass the one place
// that decides what a device is, and would then disagree with it the moment
// the prefix rule changed.

import { ArcDevice, type ArcDescriptor } from "./device.js";

/** The callbacks, as the callback layer exposes them. 0-based ids in. */
export interface ArcLuaBridge {
  /** `_norns.monome.add` — the router, never `arc.add`. */
  monomeAdd(id0: number, serial: string, name: string, dev: unknown): void;
  monomeRemove(id0: number): void;
  arcDelta(id0: number, ring0: number, delta: number): void;
  arcKey(id0: number, ring0: number, state: number): void;
}

export class ArcManager {
  private readonly devices = new Map<number, ArcDevice>();

  /**
   * Shared with whatever else hands out monome ids.
   *
   * An arc and a grid are the same `dev_monome` to matron and they are
   * looked up from one table by `monome_refresh` and `monome_intensity`. Two
   * managers minting ids independently would collide the moment both have a
   * device, and the symptom would be a grid refresh landing on an arc.
   */
  constructor(
    private readonly lua: ArcLuaBridge,
    private readonly nextId: () => number,
  ) {}

  add(descriptor: ArcDescriptor): ArcDevice {
    const id = this.nextId();
    const device = new ArcDevice(id, descriptor, {
      delta: (ring, d) => this.lua.arcDelta(id, ring, d),
      key: (ring, state) => this.lua.arcKey(id, ring, state),
    });
    this.devices.set(id, device);
    this.lua.monomeAdd(id, descriptor.serial, descriptor.name, id);
    return device;
  }

  remove(id: number): void {
    const d = this.devices.get(id);
    if (d === undefined) return;
    this.devices.delete(id);
    d.close();
    this.lua.monomeRemove(id);
  }

  get(id: number): ArcDevice | undefined {
    return this.devices.get(id);
  }

  list(): ArcDevice[] {
    return [...this.devices.values()];
  }
}
