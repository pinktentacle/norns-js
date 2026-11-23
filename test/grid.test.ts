// E5-02 — the grid device, where every interesting case is a detail of
// upstream that a reasonable implementation would get wrong.

import { describe, expect, it } from "vitest";
import { GridDevice, luaTruthy, type GridDescriptor, type GridTransport } from "../src/grid/device.js";
import { GridManager, type GridLuaBridge } from "../src/grid/manager.js";
import { registerGrid } from "../src/grid/register.js";
import { registerMonome } from "../src/monome/register.js";
import { NornsRegistry } from "../src/norns/registry.js";
import { alphaFor, quantise, BRIGHTNESS } from "../src/grid/ramp.js";

const desc = (cols: number, rows: number): GridDescriptor => ({
  serial: "v0001",
  name: "virtual grid",
  cols,
  rows,
  varibright: true,
});

function recorder() {
  const maps: Array<{ x: number; y: number; levels: number[] }> = [];
  const intensities: number[] = [];
  const t: GridTransport = {
    descriptor: desc(16, 8),
    ledLevelMap: (x, y, levels) => maps.push({ x, y, levels: [...levels] }),
    ledIntensity: (l) => intensities.push(l),
  };
  return { t, maps, intensities };
}

function device(cols = 16, rows = 8) {
  const keys: Array<[number, number, number]> = [];
  const d = new GridDevice(0, desc(cols, rows), {
    key: (x, y, s) => keys.push([x, y, s]),
    tilt: () => {},
  });
  return { d, keys };
}

describe("the buffer and the wire are two places", () => {
  it("keeps the narrowed byte and masks only on the way out", () => {
    // `dev_monome_grid_set_led` ends with `md->data[...] = val` and there is
    // no `& 0x0F` there — libmonome masks when it packs nybbles. So an
    // absolute 16 lights the LED at 0 AND leaves 16 in the buffer, which a
    // relative write after it reads. Masking at store time gives the same
    // LED and the wrong arithmetic.
    const { d } = device();
    d.setLed(0, 0, 16, false);
    d.refresh();
    expect(d.front()[0]).toBe(0); // the wire sees 16 & 0x0F
    d.setLed(0, 0, 1, true); // 16 + 1, clamped to 15
    d.refresh();
    expect(d.front()[0]).toBe(15);
  });

  it("does the same for all()", () => {
    const { d } = device();
    d.allLed(16, false);
    d.refresh();
    expect(d.front()[0]).toBe(0);
    d.setLed(0, 0, 0, true);
    d.refresh();
    expect(d.front()[0]).toBe(15);
  });
});

describe("quad addressing", () => {
  it("puts a key in the quad device_monome.cc would", () => {
    // quad = ((y > 7) << 1) | (x > 7), offset = (y & 7) * 8 + (x & 7)
    const { d } = device(16, 16);
    const { t, maps } = recorder();
    d.addTransport(t);
    maps.length = 0;

    d.setLed(0, 0, 15, false); // quad 0, offset 0
    d.setLed(8, 0, 14, false); // quad 1, offset 0
    d.setLed(0, 8, 13, false); // quad 2, offset 0
    d.setLed(15, 15, 12, false); // quad 3, offset 63
    d.refresh();

    expect(maps.map((m) => [m.x, m.y])).toEqual([
      [0, 0],
      [8, 0],
      [0, 8],
      [8, 8],
    ]);
    expect(maps[0]!.levels[0]).toBe(15);
    expect(maps[1]!.levels[0]).toBe(14);
    expect(maps[2]!.levels[0]).toBe(13);
    expect(maps[3]!.levels[63]).toBe(12);
  });

  it("emits only the quads that changed", () => {
    const { d } = device(16, 16);
    const { t, maps } = recorder();
    d.addTransport(t);
    d.refresh();
    maps.length = 0;

    d.setLed(1, 1, 5, false);
    d.refresh();
    expect(maps).toHaveLength(1);
    expect([maps[0]!.x, maps[0]!.y]).toEqual([0, 0]);

    // Nothing changed since: a refresh with no dirty quad sends nothing.
    // A 60 fps script that draws nothing costs nothing.
    maps.length = 0;
    d.refresh();
    expect(maps).toHaveLength(0);
  });

  it("stacks the two quads of a 16x8 grid when it is turned", () => {
    // `dev_monome_set_rotation`'s fixup: at 90 or 270 the quads are no
    // longer side by side, and the index is built from x and y the other
    // way round. Without it the right half of a rotated 128 draws on the
    // left.
    const { d } = device(16, 8);
    const { t, maps } = recorder();
    d.addTransport(t);
    d.setRotation(1);
    maps.length = 0;

    d.allLed(9, false);
    d.refresh();
    expect(maps.map((m) => [m.x, m.y])).toEqual([
      [0, 0],
      [0, 8],
    ]);
  });
});

describe("the clamp asymmetry, which scripts depend on", () => {
  it("does NOT clamp an absolute write: 16 goes dark, 100 is 4", () => {
    // `int z` is narrowed and the nybble packer masks it. This is why
    // `g:led(x, y, 16)` is a dark pad on hardware, and a script that uses
    // 16 as "full" is already wrong there.
    const { d } = device(8, 8);
    const { t, maps } = recorder();
    d.addTransport(t);
    maps.length = 0;

    d.setLed(0, 0, 16, false);
    d.setLed(1, 0, 100, false);
    d.setLed(2, 0, 15, false);
    d.refresh();
    expect(maps[0]!.levels.slice(0, 3)).toEqual([0, 4, 15]);
  });

  it("DOES clamp a relative write", () => {
    const { d } = device(8, 8);
    const { t, maps } = recorder();
    d.addTransport(t);
    maps.length = 0;

    d.setLed(0, 0, 10, false);
    d.setLed(0, 0, 10, true); // 20 -> 15
    d.setLed(1, 0, 5, false);
    d.setLed(1, 0, -10, true); // -5 -> 0
    d.refresh();
    expect(maps[0]!.levels.slice(0, 2)).toEqual([15, 0]);
  });

  it("treats 0 as true for rel, because Lua does", () => {
    // `lua_toboolean(l, 5)`. Only nil and false are false. A binding that
    // writes `rel === true`, or that coerces a number, sends a script that
    // passed 0 into the other mode.
    expect(luaTruthy(0)).toBe(true);
    expect(luaTruthy("")).toBe(true);
    expect(luaTruthy(false)).toBe(false);
    expect(luaTruthy(null)).toBe(false);
    expect(luaTruthy(undefined)).toBe(false);
  });
});

describe("the front buffer moves only on refresh", () => {
  it("a draw is invisible until it is presented", () => {
    // The universal script idiom is `all(0)` then draw then `refresh()`. A
    // view that reads the back buffer shows the `all(0)` — a black flash on
    // every frame.
    const { d } = device(8, 8);
    d.setLed(0, 0, 15, false);
    expect(d.front()[0]).toBe(0);
    d.refresh();
    expect(d.front()[0]).toBe(15);

    d.allLed(0, false);
    expect(d.front()[0]).toBe(15);
    d.refresh();
    expect(d.front()[0]).toBe(0);
  });

  it("lays the front buffer out row-major across quads", () => {
    const { d } = device(16, 8);
    d.setLed(8, 0, 11, false); // first column of the second quad
    d.refresh();
    expect(d.front()[8]).toBe(11);
  });
});

describe("rotation", () => {
  it("re-lays the surface at the new width", () => {
    // matron works in the USER frame — libmonome rotates on the way to the
    // hardware — so the row-major surface a view reads is cols() wide, not
    // the descriptor's. A 16x8 turned 90 is 8 wide and 16 tall, and the
    // quad fixup that puts quad 1 at (0, 8) only makes sense on that shape.
    const { d } = device(16, 8);
    d.allLed(0, false);
    d.setLed(8, 0, 12, false); // first cell of the second quad
    d.refresh();
    expect(d.front()[8]).toBe(12); // 16 wide: row 0, column 8

    d.setRotation(1);
    // Now 8 wide and 16 tall: that quad starts at (0, 8), so row 8 col 0.
    expect(d.front()[8 * 8]).toBe(12);
    expect(d.front()[8]).toBe(0);
  });

  it("lights the lower half of a 16x8 turned a quarter", () => {
    // E9-204. The bounds were the unturned 16 and 8, so on a grid that is
    // 8 wide and 16 tall every `g:led(x, y)` with y past 8 was dropped,
    // and x past 8 was let through.
    const { d } = device(16, 8);
    d.setRotation(1);
    d.setLed(7, 15, 6, false);
    d.setLed(0, 8, 3, false);
    d.setLed(12, 0, 9, false); // a column that is not there any more
    d.refresh();
    expect(d.front()[15 * 8 + 7]).toBe(6);
    expect(d.front()[8 * 8]).toBe(3);
    expect([...d.front()].filter((l) => l === 9)).toEqual([]);
  });

  it("swaps rows and cols on a quarter turn", () => {
    // `Grid:rotation` re-reads both straight after setting it.
    const { d } = device(16, 8);
    expect([d.cols(), d.rows()]).toEqual([16, 8]);
    d.setRotation(1);
    expect([d.cols(), d.rows()]).toEqual([8, 16]);
    d.setRotation(2);
    expect([d.cols(), d.rows()]).toEqual([16, 8]);
  });
});

describe("a transport joining late", () => {
  it("is shown what is already on the grid", () => {
    // A script that draws once and waits for input is normal. A view
    // attached afterwards would otherwise be black until the next input.
    const { d } = device(8, 8);
    d.setLed(3, 3, 7, false);
    d.refresh();
    d.intensity(9);

    const { t, maps, intensities } = recorder();
    d.addTransport(t);
    expect(intensities).toEqual([9]);
    expect(maps).toHaveLength(1);
    expect(maps[0]!.levels[3 * 8 + 3]).toBe(7);
  });
});

describe("the registry", () => {
  function bridge() {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const b: GridLuaBridge = {
      monomeAdd: (...a) => calls.push({ name: "add", args: a }),
      monomeRemove: (...a) => calls.push({ name: "remove", args: a }),
      gridKey: (...a) => calls.push({ name: "key", args: a }),
      gridTilt: (...a) => calls.push({ name: "tilt", args: a }),
    };
    return { b, calls };
  }

  it("never reuses an id", () => {
    // `device_list.cc:70` is `d->base.id = id++`, unique over the process
    // lifetime. Reusing one hands Lua a device it holds a stale handle to.
    const { b } = bridge();
    const m = new GridManager(b);
    const a = m.add(desc(8, 8));
    m.remove(a.id);
    const c = m.add(desc(8, 8));
    expect(c.id).not.toBe(a.id);
  });

  it("keeps serial and name across a resize", () => {
    // `grid.vports[i].name` is persisted, and `Grid.new` composes it from
    // name and serial. Encoding the size into either silently unbinds every
    // saved PSET when the user switches size.
    const { b, calls } = bridge();
    const m = new GridManager(b);
    const a = m.add(desc(8, 8));
    const r = m.resize(a.id, 16, 8)!;
    expect(r.descriptor.serial).toBe("v0001");
    expect(r.descriptor.name).toBe("virtual grid");
    expect(r.cols()).toBe(16);
    expect(calls.map((c) => c.name)).toEqual(["add", "remove", "add"]);
  });

  it("hands Lua a device handle it can give back", () => {
    const { b, calls } = bridge();
    const m = new GridManager(b);
    const d = m.add(desc(8, 8));
    const handle = calls[0]!.args[3];
    expect(m.get(Number(handle))).toBe(d);
  });
});

describe("the _norns functions", () => {
  function harness() {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const b: GridLuaBridge = {
      monomeAdd: () => {},
      monomeRemove: () => {},
      gridKey: (...a) => calls.push({ name: "key", args: a }),
      gridTilt: (...a) => calls.push({ name: "tilt", args: a }),
    };
    const m = new GridManager(b);
    const d = m.add(desc(16, 8));
    const registry = new NornsRegistry();
    registerGrid(registry, m);
    // `monome_refresh` and `monome_intensity` are shared with the arc and
    // live in their own module, because a `dev` handle reaching them may be
    // either device.
    registerMonome(registry, [(id) => m.get(id)]);
    const call = (name: string, ...args: unknown[]): unknown =>
      registry.implementationFor(name)!(...(args as never[]));
    return { m, d, call, calls };
  }

  it("takes x and y 1-based", () => {
    const { d, call } = harness();
    call("grid_set_led", d.id, 1, 1, 15, false);
    call("monome_refresh", d.id);
    expect(d.front()[0]).toBe(15);
  });

  it("returns rows and cols, and follows a rotation", () => {
    // Two of the few functions in the surface that return anything.
    const { d, call } = harness();
    expect(call("grid_cols", d.id)).toEqual([16]);
    expect(call("grid_rows", d.id)).toEqual([8]);
    call("grid_set_rotation", d.id, 1);
    expect(call("grid_cols", d.id)).toEqual([8]);
    expect(call("grid_rows", d.id)).toEqual([16]);
  });

  it("is a no-op for a device that has gone", () => {
    // `Grid.cleanup` walks every device it ever saw on every script load,
    // calling all(0) and refresh(). Throwing here takes the script down on
    // an unplug.
    const { m, d, call } = harness();
    m.remove(d.id);
    expect(() => call("grid_set_led", d.id, 1, 1, 15, false)).not.toThrow();
    expect(call("grid_rows", d.id)).toEqual([0]);
  });

  it("passes 0 for rel through as relative", () => {
    const { d, call } = harness();
    call("grid_set_led", d.id, 1, 1, 9, false);
    call("grid_set_led", d.id, 1, 1, 9, 0); // Lua: 0 is true
    call("monome_refresh", d.id);
    expect(d.front()[0]).toBe(15);
  });
});

describe("the brightness ramp", () => {
  it("is sixteen entries from 0 to 1", () => {
    expect(BRIGHTNESS).toHaveLength(16);
    expect(BRIGHTNESS[0]).toBe(0);
    expect(BRIGHTNESS[15]).toBe(1);
  });

  it("separates the low levels, which linear alpha does not", () => {
    // The whole reason the ramp exists: scripts use 1-4 as a background
    // layer. Linear would put them at 0.067, 0.133, 0.2, 0.267 — four greys
    // nobody can tell apart on a lit screen.
    const steps = [1, 2, 3, 4].map((l) => BRIGHTNESS[l]!);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]! - steps[i - 1]!).toBeGreaterThan(0.05);
    }
  });

  it("scales the whole surface with intensity, keeping the ratios", () => {
    const full = alphaFor(15, 15) / alphaFor(5, 15);
    const dim = alphaFor(15, 5) / alphaFor(5, 5);
    expect(dim).toBeCloseTo(full, 6);
  });

  it("collapses to on/off at 8 when the grid is not varibright", () => {
    expect(quantise(7, false)).toBe(0);
    expect(quantise(8, false)).toBe(15);
    expect(quantise(7, true)).toBe(7);
  });
});
