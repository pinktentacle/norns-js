// E5-12 … E5-17 — the arc.
//
// The interesting cases are the ones where an arc is NOT a grid: it folds
// out-of-range coordinates instead of discarding them, its `all` is
// literally the grid's function, and `Arc:segment` is Lua that writes 64
// LEDs with anti-aliased ends.

import { describe, expect, it } from "vitest";
import { ArcDevice, LEDS, RINGS, type ArcDescriptor, type ArcTransport } from "../src/arc/device.js";
import { ArcManager } from "../src/arc/manager.js";
import { registerArc } from "../src/arc/register.js";
import { registerMonome } from "../src/monome/register.js";
import { GridManager } from "../src/grid/manager.js";
import { NornsRegistry } from "../src/norns/registry.js";
import { narrowLevel } from "../src/monome/byte.js";

const desc: ArcDescriptor = { serial: "a0001", name: "monome arc 4" };

function recorder() {
  const rings: Array<{ ring: number; levels: number[] }> = [];
  const intensities: number[] = [];
  const t: ArcTransport = {
    descriptor: desc,
    ledRingMap: (ring, levels) => rings.push({ ring, levels: [...levels] }),
    ledIntensity: (l) => intensities.push(l),
  };
  return { t, rings, intensities };
}

function device() {
  const deltas: Array<[number, number]> = [];
  const keys: Array<[number, number]> = [];
  const d = new ArcDevice(0, desc, {
    delta: (r, v) => deltas.push([r, v]),
    key: (r, s) => keys.push([r, s]),
  });
  return { d, deltas, keys };
}

describe("addressing", () => {
  it("WRAPS a ring and an LED instead of discarding them", () => {
    // `data[n & 3][x & 63]`. The grid drops an out-of-range coordinate; the
    // arc folds it, and scripts that index modularly rely on that.
    const { d } = device();
    d.setLed(4, 0, 15, false); // ring 4 is ring 0
    d.setLed(0, 64, 9, false); // LED 64 is LED 0... which is the same cell
    d.refresh();
    expect(d.presented()[0]).toBe(9);

    d.setLed(1, 65, 7, false);
    d.refresh();
    expect(d.presented()[LEDS + 1]).toBe(7);
  });

  it("clamps a relative write and narrows an absolute one", () => {
    const { d } = device();
    d.setLed(0, 0, 20, false);
    d.setLed(0, 0, 10, true); // 20 + 10, clamped
    d.refresh();
    expect(d.presented()[0]).toBe(15);
  });

  it("keeps the byte, masks the wire", () => {
    // matron stores the narrowed value and libmonome masks when packing.
    // So an absolute 16 shows as 0 and a relative write after it reads 16.
    const { dev, rings } = recorderDevice();
    dev.setLed(0, 0, 16, false);
    dev.refresh();
    expect(rings[rings.length - 1]!.levels[0]).toBe(0);
    dev.setLed(0, 0, 1, true);
    dev.refresh();
    expect(rings[rings.length - 1]!.levels[0]).toBe(15); // 16 + 1 clamped
  });

  function recorderDevice() {
    const r = recorder();
    const { d } = device();
    d.addTransport(r.t);
    r.rings.length = 0;
    return { dev: d, rings: r.rings };
  }
});

describe("presenting", () => {
  it("sends one ring map per dirty ring and then stops", () => {
    const r = recorder();
    const { d } = device();
    d.addTransport(r.t);
    r.rings.length = 0;

    d.setLed(2, 5, 15, false);
    expect(r.rings).toEqual([]); // nothing until refresh
    d.refresh();
    expect(r.rings.length).toBe(1);
    expect(r.rings[0]!.ring).toBe(2);
    expect(r.rings[0]!.levels[5]).toBe(15);

    d.refresh();
    expect(r.rings.length).toBe(1); // the flag cleared
  });

  it("brings a new transport up to date, so a drawn arc is not black", () => {
    const { d } = device();
    d.setLed(1, 1, 12, false);
    d.refresh();
    const r = recorder();
    d.addTransport(r.t);
    expect(r.rings.length).toBe(RINGS);
    expect(r.rings[1]!.levels[1]).toBe(12);
    expect(r.intensities).toEqual([15]);
  });

  it("all() touches every ring, because _arc_all_led IS _grid_all_led", () => {
    const r = recorder();
    const { d } = device();
    d.addTransport(r.t);
    r.rings.length = 0;
    d.allLed(9, false);
    d.refresh();
    expect(r.rings.map((x) => x.ring)).toEqual([0, 1, 2, 3]);
    expect(r.rings.every((x) => x.levels.every((v) => v === 9))).toBe(true);
  });
});

describe("the two _norns functions", () => {
  function harness() {
    const added: Array<[number, string]> = [];
    const deltas: Array<[number, number, number]> = [];
    let next = 0;
    const m = new ArcManager(
      {
        monomeAdd: (id, _serial, name) => added.push([id, name]),
        monomeRemove: () => {},
        arcDelta: (id, ring, d) => deltas.push([id, ring, d]),
        arcKey: () => {},
      },
      () => next++,
    );
    const d = m.add(desc);
    const registry = new NornsRegistry();
    registerArc(registry, m);
    registerMonome(registry, [(id) => m.get(id)]);
    const call = (name: string, ...args: unknown[]): unknown =>
      registry.implementationFor(name)!(...(args as never[]));
    return { m, d, call, added, deltas };
  }

  it("takes ring and LED 1-based, and does NOT convert the value", () => {
    const { d, call } = harness();
    call("arc_set_led", d.id, 1, 1, 15, false);
    call("monome_refresh", d.id);
    expect(d.presented()[0]).toBe(15);
  });

  it("treats Lua's 0 as TRUE for rel, as lua_toboolean does", () => {
    const { d, call } = harness();
    call("arc_set_led", d.id, 1, 1, 5, false);
    call("arc_set_led", d.id, 1, 1, 5, 0); // 0 is relative, not absolute
    call("monome_refresh", d.id);
    expect(d.presented()[0]).toBe(10);
  });

  it("adds through monome.add with a name the router recognises", () => {
    // startup.lua:68-73 routes on the prefix and nothing else does.
    const { added } = harness();
    expect(added[0]![1].startsWith("monome arc")).toBe(true);
  });

  it("is a no-op for a device that has gone", () => {
    const { m, d, call } = harness();
    m.remove(d.id);
    expect(() => call("arc_set_led", d.id, 1, 1, 15, false)).not.toThrow();
    expect(() => call("monome_refresh", d.id)).not.toThrow();
  });
});

describe("sharing the monome id space with the grid", () => {
  it("never gives a grid and an arc the same id", () => {
    // Both are a `dev_monome` to matron and are looked up from one table by
    // monome_refresh. Two counters would collide as soon as both existed,
    // and a grid refresh would land on an arc.
    let next = 0;
    const mint = () => next++;
    const grids = new GridManager(
      { monomeAdd: () => {}, monomeRemove: () => {}, gridKey: () => {}, gridTilt: () => {} },
      mint,
    );
    const arcs = new ArcManager(
      { monomeAdd: () => {}, monomeRemove: () => {}, arcDelta: () => {}, arcKey: () => {} },
      mint,
    );
    const g = grids.add({ serial: "v1", name: "virtual grid", cols: 16, rows: 8, varibright: true });
    const a = arcs.add(desc);
    expect(g.id).not.toBe(a.id);

    const registry = new NornsRegistry();
    registerMonome(registry, [(id) => grids.get(id), (id) => arcs.get(id)]);
    const call = (name: string, ...args: unknown[]): unknown =>
      registry.implementationFor(name)!(...(args as never[]));
    // The shared lookup finds each in its own table.
    a.setLed(0, 0, 15, false);
    call("monome_refresh", a.id);
    expect(a.presented()[0]).toBe(15);
  });
});

describe("the byte rules", () => {
  it("narrows the way an int8 stored into a uint8 does", () => {
    expect(narrowLevel(16)).toBe(16);
    expect(narrowLevel(200)).toBe(200); // int8 -56, back to uint8 200
    expect(narrowLevel(300)).toBe(44); // 300 -> int8 44
    expect(narrowLevel(-1)).toBe(255);
  });
});
