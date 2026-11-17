// E5-12 — the two `_norns` arc functions.
//
// Two, because `monome_refresh` and `monome_intensity` are shared with the
// grid: matron has one `dev_monome` and one pair of functions for both, and
// `src/monome/register.ts` is where they live.

import { luaTruthy } from "../monome/byte.js";
import type { NornsRegistry } from "../norns/registry.js";
import type { ArcManager } from "./manager.js";

export interface ArcRegisterOptions {
  readonly log?: (line: string) => void;
}

export function registerArc(
  registry: NornsRegistry,
  manager: ArcManager,
  opts: ArcRegisterOptions = {},
): void {
  const log = opts.log ?? (() => {});
  const dev = (handle: unknown) => manager.get(Number(handle));

  registry.implement("arc_set_led", (handle, ring, x, val, rel) => {
    // 1-based from Lua, both of them. `weaver.cc:1817-1818` does the
    // subtraction and says so in a comment; the VALUE is not converted.
    dev(handle)?.setLed(Number(ring) - 1, Number(x) - 1, Number(val), luaTruthy(rel));
  });

  registry.implement("arc_all_led", (handle, val, rel) => {
    // `_arc_all_led` is literally `return _grid_all_led(l);` — the same
    // function, walking `md->quads`, which is 4 for an arc.
    dev(handle)?.allLed(Number(val), luaTruthy(rel));
  });

  log("arc: 2 functions bound");
}
