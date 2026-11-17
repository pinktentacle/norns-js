// E5-02 — the nine `_norns` grid functions.
//
// Each one is a lookup and a call. The interesting parts are the conversions
// at the boundary, and there are exactly three:
//
//   1. **x and y are 1-based from Lua.** `weaver.cc:1803-4` subtracts one on
//      the way in; `_call_grid_handler` adds one on the way out.
//   2. **`rel` is Lua truthiness, and `0` is TRUE.** `lua_toboolean(l, 5)`.
//      A JS binding that writes `if (rel)` on a number is right here only by
//      accident; one that writes `rel === true` is wrong. See `luaTruthy`.
//   3. **`grid_rows` and `grid_cols` RETURN a value** — two of the twenty-two
//      functions in the surface that do. `Grid:rotation` re-reads them after
//      a rotation, so returning nothing makes a rotated grid report `nil`
//      rows and every later draw a comparison against nil.
//
// ON RE-ENTRANCY, because research/grid-design.md §1.5 raises it and the
// answer here is different from the one it expects. On hardware, key events
// cross a lock-free queue and are delivered on matron's single event thread
// so they can never interleave with Lua. The note concludes that a DOM
// handler calling into Fengari directly could re-enter Lua mid-metro, and
// that grid input must therefore go through the host's event queue.
//
// In a single-threaded JavaScript runtime it cannot. A `pointerdown` handler
// runs as a task, and a task only starts when the stack is empty; Fengari is
// synchronous, so Lua is never suspended mid-call waiting for one. The
// existing `_norns.key` and `_norns.enc` path has called straight through
// from a DOM handler since E2 for the same reason. The note's requirement is
// right about hardware and about any host with threads — it is not a
// constraint this one has, and adding a queue would add latency to buy
// nothing.

import type { NornsRegistry } from "../norns/registry.js";
import { luaTruthy } from "./device.js";
import type { GridManager } from "./manager.js";

export interface GridRegisterOptions {
  readonly log?: (line: string) => void;
}

export function registerGrid(
  registry: NornsRegistry,
  manager: GridManager,
  opts: GridRegisterOptions = {},
): void {
  const log = opts.log ?? (() => {});

  /**
   * The device a `dev` handle names.
   *
   * A call for a device that has gone is a no-op, not an error. `grid.lua`
   * holds its handle across a disconnect and `Grid.cleanup` walks every
   * device it ever saw calling `all(0)` and `refresh()` — so a removed grid
   * is routinely addressed, on hardware too, and throwing would take the
   * script down on an unplug.
   */
  const dev = (handle: unknown) => {
    const d = manager.get(Number(handle));
    if (d === undefined) return null;
    return d;
  };

  registry.implement("grid_set_led", (handle, x, y, z, rel) => {
    // 1-based from Lua. The subtraction is `weaver.cc:1803-4`.
    dev(handle)?.setLed(Number(x) - 1, Number(y) - 1, Number(z), luaTruthy(rel));
  });

  registry.implement("grid_all_led", (handle, z, rel) => {
    dev(handle)?.allLed(Number(z), luaTruthy(rel));
  });

  // Two of the few `_norns` functions that return something. `Grid:rotation`
  // reads them straight back after `grid_set_rotation`, so a missing return
  // becomes `nil` rows and a comparison against nil in the first redraw.
  registry.implement("grid_rows", (handle) => [dev(handle)?.rows() ?? 0]);
  registry.implement("grid_cols", (handle) => [dev(handle)?.cols() ?? 0]);

  registry.implement("grid_set_rotation", (handle, z) => {
    const r = (Number(z) & 3) as 0 | 1 | 2 | 3;
    dev(handle)?.setRotation(r);
  });

  registry.implement("grid_tilt_enable", (handle, sensor) => {
    dev(handle)?.tiltEnable(Number(sensor));
  });

  registry.implement("grid_tilt_disable", (handle, sensor) => {
    dev(handle)?.tiltDisable(Number(sensor));
  });

  // `monome_refresh` and `monome_intensity` are NOT here: a `dev` handle
  // reaching them may be a grid or an arc, because matron has one
  // `dev_monome` for both. See src/monome/register.ts.
  log(`grid: 7 functions bound`);
}
