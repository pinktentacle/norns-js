// E5-02 — the device registry, and the two callbacks that tell Lua about it.
//
// A port of `dev_list` plus the weaver glue. Small, but two of its rules are
// load-bearing:
//
// IDS ARE MONOTONIC AND NEVER REUSED (`device_list.cc:70`,
// `d->base.id = id++`). A grid that is removed and re-added is a NEW id.
// Reusing one would hand Lua a device it already has a stale reference to.
//
// IDENTITY IS STABLE ACROSS A RESIZE. `grid.vports[i].name` is persisted to
// `system.state` (`state.lua:163`) and `Grid.new` composes it as
// `name .. " " .. serial`. So resizing an on-screen grid is a `remove` and an
// `add` with the SAME serial and name — `Grid.new` re-reads `grid_rows` and
// `grid_cols` on the way in, and the saved vport binding survives. Putting
// the size in the name, `virtual grid 128`, would silently unbind every saved
// PSET the moment the user switched size.

import { GridDevice, type GridDescriptor, type GridInput } from "./device.js";

/**
 * Into Lua. Every index 1-based, pushed exactly as `weaver.cc` pushes it.
 *
 * `makeCallbacks` already has these and does the +1; this is the subset the
 * grid needs, so a test can supply it without a Lua state.
 */
export interface GridLuaBridge {
  /** `_norns.monome.add`. matron only ever calls monome.add, never grid.add. */
  monomeAdd(id0: number, serial: string, name: string, dev: unknown): void;
  monomeRemove(id0: number): void;
  gridKey(id0: number, x0: number, y0: number, state: number): void;
  /** Five arguments pushed; `lua/core` consumes four. Upstream's bug, kept. */
  gridTilt(id0: number, sensor0: number, x0: number, y0: number, z0: number): void;
}

export class GridManager {
  private readonly devices = new Map<number, GridDevice>();
  private ownNextId = 0;

  /**
   * `mintId` is shared with the arc manager when there is one.
   *
   * An arc and a grid are the same `dev_monome` to matron and are looked up
   * from one table by `monome_refresh`. Two managers minting ids
   * independently would collide as soon as both had a device, and a grid
   * refresh would land on an arc. The default keeps a lone grid working
   * exactly as before.
   */
  constructor(
    private readonly lua: GridLuaBridge,
    private readonly mintId: () => number = () => this.ownNextId++,
  ) {}

  /**
   * Register a device and tell Lua.
   *
   * `dev` — the handle Lua stores and hands back to every `grid_*` call — is
   * the id, a plain number. The design note suggested a handle object; a
   * number is simpler, certainly survives the Fengari boundary, and makes
   * the lookup on the way back a map read rather than an identity check.
   * `grid.lua` only ever stores it and passes it on, so nothing depends on
   * it being anything richer.
   */
  add(descriptor: GridDescriptor): GridDevice {
    const id = this.mintId();
    const input: GridInput = {
      key: (x, y, state) => this.lua.gridKey(id, x, y, state),
      tilt: (s, x, y, z) => this.lua.gridTilt(id, s, x, y, z),
    };
    const device = new GridDevice(id, descriptor, input);
    this.devices.set(id, device);
    this.lua.monomeAdd(id, descriptor.serial, descriptor.name, id);
    return device;
  }

  remove(id: number): void {
    const d = this.devices.get(id);
    if (d === undefined) return;
    this.devices.delete(id);
    this.lua.monomeRemove(id);
  }

  get(id: number): GridDevice | undefined {
    return this.devices.get(id);
  }

  list(): GridDevice[] {
    return [...this.devices.values()];
  }

  /**
   * Resize: remove, then add with the same identity.
   *
   * Deliberately NOT a mutation of the existing device. `Grid.new` reads the
   * size once, on add, so a device that changed shape underneath Lua would
   * keep reporting the old one — and the vport binding survives only because
   * the serial and name are unchanged.
   */
  resize(id: number, cols: number, rows: number): GridDevice | undefined {
    const old = this.devices.get(id);
    if (old === undefined) return undefined;
    this.remove(id);
    return this.add({ ...old.descriptor, cols, rows });
  }
}
