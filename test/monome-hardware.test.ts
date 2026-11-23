// E9-204 — a real grid, arc or crow on a serial port.
//
// Against simulated devices (`fake-monome.ts`): the handshake libmonome
// does, a port another program holds, a device unplugged, and the whole
// path from a script's `g:led()` to a lit key on the device's side.

import { describe, expect, it } from "vitest";
import { GridDevice } from "../src/grid/device.js";
import { ArcDevice } from "../src/arc/device.js";
import {
  CrowLink,
  MonomeHardware,
  ROUNDS,
  SerialArc,
  SerialGrid,
  identify,
  whyNotOpen,
  type HardwareHooks,
} from "../src/monome/hardware.js";
import { openLink } from "../src/monome/serial-link.js";
import { FakeArc, FakeCrow, FakeGrid, FakePort, FakeSerial } from "./fake-monome.js";

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Bench {
  hw: MonomeHardware;
  serial: FakeSerial;
  lines: string[];
  grids: SerialGrid[];
  arcs: SerialArc[];
  crows: CrowLink[];
  left: string[];
  changes: number;
}

function bench(serial: FakeSerial | null = new FakeSerial()): Bench {
  const b: Bench = {
    serial: serial as FakeSerial,
    lines: [],
    grids: [],
    arcs: [],
    crows: [],
    left: [],
    changes: 0,
    hw: undefined as unknown as MonomeHardware,
  };
  const hooks: HardwareHooks = {
    log: (l) => b.lines.push(l),
    sleep: () => tick(4),
    gridArrived: (g) => b.grids.push(g),
    gridLeft: (g) => b.left.push(`grid ${g.descriptor.name}`),
    arcArrived: (a) => b.arcs.push(a),
    arcLeft: (a) => b.left.push(`arc ${a.descriptor.name}`),
    crowArrived: (c) => b.crows.push(c),
    crowLeft: () => b.left.push("crow"),
    changed: () => void b.changes++,
  };
  b.hw = new MonomeHardware(serial, hooks);
  return b;
}

async function plug(b: Bench, port: FakePort): Promise<void> {
  b.serial.picks.push(port);
  await b.hw.connect();
  await tick();
}

describe("opening the port", () => {
  it("opens it as libmonome does and raises the two lines an FTDI part needs", async () => {
    const b = bench();
    const grid = new FakeGrid(16, 8);
    await plug(b, grid.port);
    expect(grid.port.opened?.baudRate).toBe(115200);
    expect(grid.port.signals).toEqual({ dataTerminalReady: true, requestToSend: true });
  });

  it("says it is serialosc when another program holds the port", async () => {
    const b = bench();
    const grid = new FakeGrid(16, 8);
    grid.port.busy = true;
    await plug(b, grid.port);
    expect(b.grids).toEqual([]);
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]).toContain("another program is holding it");
    expect(b.lines[0]).toContain("serialosc");
    expect(whyNotOpen({ name: "InvalidStateError" })).toContain("already open");
  });

  it("does nothing when the picker is closed, or where there are no serial ports", async () => {
    const b = bench();
    await b.hw.connect();
    expect(b.lines).toEqual([]);
    const none = bench(null);
    expect(none.hw.supported).toBe(false);
    await none.hw.connect();
    await none.hw.restore();
    expect(none.lines).toEqual([]);
  });

  it("leaves alone a port with nothing it knows on it", async () => {
    const b = bench();
    const mute = new FakePort(() => {});
    await plug(b, mute);
    expect(b.lines[0]).toContain("nothing known on that port");
    expect(mute.closed).toBe(true);
    expect(b.hw.list()).toEqual([]);
  });
});

describe("a grid", () => {
  it("is asked the three things mext_open asks, and answers", async () => {
    const b = bench();
    const grid = new FakeGrid(16, 8);
    await plug(b, grid.port);
    expect(grid.port.written.slice(0, 3)).toEqual([0x00, 0x01, 0x05]);
    expect(b.grids).toHaveLength(1);
    expect(b.grids[0]!.descriptor).toMatchObject({ name: "monome 128", cols: 16, rows: 8, varibright: true });
    expect(b.grids[0]!.descriptor.serial).toMatch(/^m\d{7}$/);
    expect(b.lines).toEqual(["grid: monome 128, 16x8, connected over usb"]);
    expect(b.hw.list()).toEqual([{ kind: "grid", name: "monome 128" }]);
  });

  it("lights what a script draws, and hands its keys back", async () => {
    const b = bench();
    const fake = new FakeGrid(16, 8);
    await plug(b, fake.port);
    const real = b.grids[0]!;
    const keys: number[][] = [];
    // The same object the page's own grid is: a real one is one more sink.
    const dev = new GridDevice(0, { serial: "v0001", name: "virtual grid", cols: 16, rows: 8, varibright: true }, {
      key: (x, y, s) => keys.push([x, y, s]),
      tilt: () => {},
    });
    real.bind({ key: (x, y, s) => dev.key(x, y, s), tilt: () => {}, rotation: () => dev.currentRotation });
    dev.addTransport(real);
    dev.setLed(0, 0, 15, false);
    dev.setLed(15, 7, 4, false);
    dev.setLed(9, 3, 9, false);
    dev.refresh();
    dev.intensity(11);
    await tick();
    expect([fake.led(0, 0), fake.led(15, 7), fake.led(9, 3), fake.led(1, 0)]).toEqual([15, 4, 9, 0]);
    expect(fake.intensity).toBe(11);
    fake.press(15, 7, 1);
    fake.press(15, 7, 0);
    await tick();
    expect(keys).toEqual([
      [15, 7, 1],
      [15, 7, 0],
    ]);
  });

  it("follows the rotation set on the device, as libmonome does", async () => {
    const b = bench();
    const fake = new FakeGrid(16, 8);
    await plug(b, fake.port);
    const real = b.grids[0]!;
    const keys: number[][] = [];
    const dev = new GridDevice(0, real.descriptor, { key: (x, y, s) => keys.push([x, y, s]), tilt: () => {} });
    real.bind({ key: (x, y, s) => dev.key(x, y, s), tilt: () => {}, rotation: () => dev.currentRotation });
    dev.addTransport(real);
    // A quarter turn: the script now has 8 columns and 16 rows.
    dev.setRotation(1);
    expect([dev.cols(), dev.rows()]).toEqual([8, 16]);
    dev.setLed(0, 0, 15, false);
    dev.setLed(7, 15, 6, false);
    dev.refresh();
    await tick();
    // r90_output_cb: x' = y, y' = 7 - x.
    expect(fake.led(0, 7)).toBe(15);
    expect(fake.led(15, 0)).toBe(6);
    fake.press(0, 7, 1);
    fake.press(15, 0, 1);
    await tick();
    expect(keys).toEqual([
      [0, 0, 1],
      [7, 15, 1],
    ]);
  });

  it("does not send a block it does not have", async () => {
    // The page's grid can be a 256 while a 128 is plugged in.
    const b = bench();
    const fake = new FakeGrid(16, 8);
    await plug(b, fake.port);
    const real = b.grids[0]!;
    real.bind({ key: () => {}, tilt: () => {}, rotation: () => 0 });
    const before = fake.maps;
    real.ledLevelMap(0, 8, new Uint8Array(64).fill(15));
    real.ledLevelMap(8, 8, new Uint8Array(64).fill(15));
    await tick();
    expect(fake.maps).toBe(before);
    expect(fake.leds.every((l) => l === 0)).toBe(true);
  });

  it("never falls further behind than one frame of each block", async () => {
    // A script that redraws faster than the port drains must not queue
    // frames that are already out of date.
    const fake = new FakeGrid(16, 8);
    let release: (() => void) | null = null;
    const slow = fake.port;
    const open = slow.open.bind(slow);
    slow.open = async (o) => {
      await open(o);
      const inner = slow.writable!;
      const w = inner.getWriter();
      slow.writable = new WritableStream<Uint8Array>({
        write: async (chunk) => {
          if (chunk[0] === 0x1a) await new Promise<void>((r) => (release = r));
          await w.write(chunk);
        },
      });
    };
    const link = await openLink(slow);
    const grid = new SerialGrid(link, { name: "monome 128", cols: 16, rows: 8 }, "m0000001");
    grid.bind({ key: () => {}, tilt: () => {}, rotation: () => 0 });
    for (let level = 1; level <= 9; level++) grid.ledLevelMap(0, 0, new Uint8Array(64).fill(level));
    for (let i = 0; i < 20; i++) {
      await tick(2);
      const go = release as (() => void) | null;
      release = null;
      go?.();
    }
    // Nine asked for; the first went at once and only the LAST of the rest.
    expect(fake.maps).toBe(2);
    expect(fake.led(0, 0)).toBe(9);
    await link.close();
  });

  it("is noticed when it is unplugged, and comes back by itself when it returns", async () => {
    const b = bench();
    const fake = new FakeGrid(16, 8);
    await plug(b, fake.port);
    fake.port.unplug();
    b.serial.fire("disconnect", fake.port);
    await tick();
    expect(b.left).toEqual(["grid monome 128"]);
    expect(b.lines[1]).toContain("grid: monome 128 is gone");
    expect(b.hw.list()).toEqual([]);
    // Already allowed: no picker the second time.
    b.serial.fire("connect", fake.port);
    await tick(60);
    expect(b.grids).toHaveLength(2);
    expect(b.serial.requests).toBe(1);
  });

  it("gives two grids two serials", async () => {
    const b = bench();
    await plug(b, new FakeGrid(16, 8).port);
    await plug(b, new FakeGrid(16, 8).port);
    expect(b.grids).toHaveLength(2);
    expect(b.grids[0]!.descriptor.serial).not.toBe(b.grids[1]!.descriptor.serial);
  });

  it("refuses a size it does not know rather than guessing", async () => {
    const b = bench();
    await plug(b, new FakeGrid(12, 6, "monome ?").port);
    expect(b.grids).toEqual([]);
    expect(b.lines[0]).toContain("12x6");
  });
});

describe("an arc", () => {
  it("is told from a grid the way matron tells it: no rows and no columns", async () => {
    const b = bench();
    const fake = new FakeArc(4);
    await plug(b, fake.port);
    expect(b.arcs).toHaveLength(1);
    expect(b.arcs[0]!.descriptor.name).toBe("monome arc 4");
    expect(b.arcs[0]!.rings).toBe(4);
    expect(b.lines).toEqual(["arc: monome arc 4, connected over usb"]);
  });

  it("is still an arc when it never says how big it is", async () => {
    const b = bench();
    const fake = new FakeArc(2);
    fake.silentAboutSize = true;
    await plug(b, fake.port);
    await tick(ROUNDS * 6);
    expect(b.arcs).toHaveLength(1);
    expect(b.arcs[0]!.rings).toBe(2);
  });

  it("lights its rings and hands back turns and presses", async () => {
    const b = bench();
    const fake = new FakeArc(2);
    await plug(b, fake.port);
    const real = b.arcs[0]!;
    const got: (string | number)[][] = [];
    const dev = new ArcDevice(0, real.descriptor, {
      delta: (n, d) => got.push(["delta", n, d]),
      key: (n, s) => got.push(["key", n, s]),
    });
    real.bind({ delta: (n, d) => dev.delta(n, d), key: (n, s) => dev.key(n, s) });
    dev.addTransport(real);
    dev.setLed(1, 5, 12, false);
    dev.setLed(3, 0, 15, false); // an arc 2 has no fourth ring
    dev.refresh();
    dev.intensity(7);
    await tick();
    expect(fake.ring[1]![5]).toBe(12);
    expect(fake.intensity).toBe(7);
    expect(fake.port.written.filter((_, i, a) => a[i] === 0x92 && a[i + 1] === 3)).toEqual([]);
    fake.turn(1, -3);
    fake.push(0, 1);
    fake.push(0, 0);
    await tick();
    expect(got).toEqual([
      ["delta", 1, -3],
      ["key", 0, 1],
      ["key", 0, 0],
    ]);
  });
});

describe("a crow", () => {
  it("is asked who it is first when the port looks like one, with nothing in front", async () => {
    const b = bench();
    const fake = new FakeCrow();
    await plug(b, fake.port);
    expect(fake.lines).toEqual(["^^i"]);
    expect(b.crows).toHaveLength(1);
    expect(b.crows[0]!.identity).toBe("0x1234abcd");
    expect(b.lines).toEqual(["crow: connected over usb (0x1234abcd)"]);
  });

  it("is still found behind a port that does not look like one", async () => {
    const b = bench();
    const fake = new FakeCrow({ usbVendorId: 0x1234, usbProductId: 1 });
    await plug(b, fake.port);
    await tick(ROUNDS * 6);
    expect(b.crows).toHaveLength(1);
    expect(fake.lines[0]!.endsWith("^^i")).toBe(true);
  });

  it("sends a line as matron does: the string, then a newline", async () => {
    const b = bench();
    const fake = new FakeCrow();
    await plug(b, fake.port);
    b.crows[0]!.send("output[1].volts = 5");
    await tick();
    expect(fake.lines).toEqual(["^^i", "output[1].volts = 5"]);
  });

  it("hands Lua whole lines, however the port cut them", async () => {
    const b = bench();
    const fake = new FakeCrow();
    await plug(b, fake.port);
    const got: string[] = [];
    b.crows[0]!.onLine = (l) => got.push(l);
    fake.say("^^stream(1,");
    await tick();
    expect(got).toEqual([]);
    fake.say("2.5)\n\r^^change(2,1)\n");
    await tick();
    expect(got).toEqual(["^^stream(1,2.5)\n", "\r^^change(2,1)\n"]);
    fake.say("\n\n");
    await tick();
    expect(got).toHaveLength(2);
  });
});

describe("ports already allowed", () => {
  it("come back at the next load with no picker", async () => {
    const serial = new FakeSerial();
    const grid = new FakeGrid(16, 16);
    const arc = new FakeArc(4);
    serial.granted.push(grid.port, arc.port);
    const b = bench(serial);
    await b.hw.restore();
    await tick();
    expect(b.grids[0]!.descriptor).toMatchObject({ name: "monome 256", cols: 16, rows: 16 });
    expect(b.arcs).toHaveLength(1);
    expect(serial.requests).toBe(0);
  });

  it("says nothing about one that is remembered and not plugged in", async () => {
    const serial = new FakeSerial();
    const grid = new FakeGrid(16, 8);
    grid.port.busy = true;
    serial.granted.push(grid.port);
    const b = bench(serial);
    await b.hw.restore();
    expect(b.lines).toEqual([]);
  });

  it("lets go of everything when asked", async () => {
    const b = bench();
    const fake = new FakeGrid(16, 8);
    await plug(b, fake.port);
    await b.hw.release();
    await tick();
    expect(fake.port.closed).toBe(true);
    expect(b.left).toEqual(["grid monome 128"]);
  });
});

describe("telling what is on a port", () => {
  it("answers unknown for a port that says nothing", async () => {
    const port = new FakePort(() => {});
    const link = await openLink(port);
    const found = await identify(link, {}, () => tick(2));
    expect(found.kind).toBe("unknown");
    await link.close();
  });
});
