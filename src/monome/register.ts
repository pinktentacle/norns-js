// `monome_refresh` and `monome_intensity` — the two functions a grid and an
// arc share.
//
// They are shared in matron too: both devices are a `struct dev_monome`,
// `dev_monome_refresh` walks `md->quads` for either, and
// `dev_monome_intensity` branches on `md->type` at the last moment. So a
// `dev` handle arriving here may be either, and the lookup has to try both
// tables rather than assume.
//
// This is also why the two managers share an id counter. If each minted its
// own, a grid and an arc would eventually hold the same id and a refresh
// would land on the wrong device — the kind of fault that only appears when
// someone plugs in both.

import type { NornsRegistry } from "../norns/registry.js";

/** What either device can be asked to do through a `dev` handle. */
export interface MonomeDevice {
  refresh(): void;
  intensity(level: number): void;
}

export interface MonomeRegisterOptions {
  readonly log?: (line: string) => void;
}

/**
 * @param lookups one per device table, tried in order.
 */
export function registerMonome(
  registry: NornsRegistry,
  lookups: ReadonlyArray<(id: number) => MonomeDevice | undefined>,
  opts: MonomeRegisterOptions = {},
): void {
  const find = (handle: unknown): MonomeDevice | undefined => {
    const id = Number(handle);
    for (const look of lookups) {
      const d = look(id);
      if (d !== undefined) return d;
    }
    return undefined;
  };

  registry.implement("monome_refresh", (handle) => {
    // A refresh for a device that has gone is a no-op, not an error:
    // `Grid.cleanup` and `Arc.cleanup` both walk every device they ever saw
    // calling `all(0)` and `refresh()`, so a removed device is routinely
    // addressed — on hardware too.
    find(handle)?.refresh();
  });

  registry.implement("monome_intensity", (handle, i) => {
    find(handle)?.intensity(Number(i));
  });

  opts.log?.("monome: 2 shared functions bound");
}
