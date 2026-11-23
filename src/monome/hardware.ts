// E9-204 — a real grid, arc or crow, on a serial port the page has opened.
//
// THE WAY A NORNS DOES IT. matron has no serialosc: it opens the device's
// serial port and speaks to it — libmonome's `mext` to a grid or an arc,
// lines of Lua to a crow. Web Serial gives a page the same port, so this is
// the same conversation and not a translation of one.
//
// THE ONE CONDITION is the one a serial port has always had: a single
// program holds it. serialosc is the program that holds a grid or an arc on
// a desktop, so it has to be quit, and a port that will not open says so by
// name.
//
// WHAT IS NOT VERIFIED, and is said here rather than discovered later: none
// of this has been run against the hardware. It was written from libmonome
// and matron, and tested against devices simulated from the same sources.

import type { GridDescriptor, GridTransport } from "../grid/device.js";
import type { ArcDescriptor, ArcTransport } from "../arc/device.js";
import {
  GET_GRID_SIZE,
  GET_ID,
  MextParser,
  QUERY,
  SECTION,
  gridIntensity,
  levelMap,
  ringIntensity,
  ringMap,
  rotateIn,
  tilt,
  type MextEvent,
  type Rotation,
} from "./mext.js";
import { openLink, type Link, type PortLike } from "./serial-link.js";

export type Found =
  | { readonly kind: "grid"; readonly name: string; readonly cols: number; readonly rows: number }
  | { readonly kind: "arc"; readonly name: string; readonly rings: number }
  | { readonly kind: "crow"; readonly identity: string }
  | { readonly kind: "unknown"; readonly why: string };

/** crow's USB identity: an STM32 virtual COM port. Not unique to it, so it is only a hint. */
const CROW_VID = 0x0483;
const CROW_PID = 0x5740;

/** `mext_open` waits 250 ms a round, for ever. This gives up after two seconds. */
export const ROUND_MS = 250;
export const ROUNDS = 8;

const text = new TextEncoder();

/**
 * Ask what is on the port.
 *
 * Both questions are harmless to the device they are not for — a grid has
 * no handler for the bytes of `^^i`, and crow is only asked first when the
 * port looks like one, so a grid's three query bytes do not end up at the
 * front of crow's next line of Lua.
 */
export async function identify(
  link: Link,
  info: { usbVendorId?: number; usbProductId?: number },
  sleep: (ms: number) => Promise<void>,
): Promise<Found> {
  const asMext = async (): Promise<Found | null> => {
    const parser = new MextParser();
    const events: MextEvent[] = [];
    link.onData = (b) => void events.push(...parser.feed(b));
    let name: string | null = null;
    let size: { cols: number; rows: number } | null = null;
    let queried = false;
    let encoders = 0;
    for (let round = 0; round < ROUNDS; round++) {
      if (!queried) await link.write(QUERY);
      if (name === null) await link.write(GET_ID);
      if (size === null) await link.write(GET_GRID_SIZE);
      await sleep(ROUND_MS);
      for (const e of events.splice(0)) {
        if (e.type === "query") {
          queried = true;
          if (e.section === SECTION.ENCODER) encoders = e.count;
        } else if (e.type === "id") name = e.name;
        else if (e.type === "size") size = { cols: e.cols, rows: e.rows };
      }
      if (name !== null && size !== null && queried) break;
      // An arc that never reports a size is still an arc.
      if (name !== null && /arc/i.test(name) && round >= 2) break;
      if (!link.open) return null;
    }
    if (name === null && size === null && !queried) return null;
    const label = name !== null && name !== "" ? name : "monome";
    if ((size !== null && size.cols === 0 && size.rows === 0) || /arc/i.test(label) || (size === null && encoders > 0)) {
      const digits = /(\d)\s*$/.exec(label);
      const rings = encoders > 0 ? encoders : digits ? Number(digits[1]) : 4;
      // norns tells an arc from a grid by this prefix and nothing else.
      return { kind: "arc", name: label.startsWith("monome arc") ? label : `monome arc ${rings}`, rings };
    }
    if (size === null) return { kind: "unknown", why: `it answered as ${label} and never said how big it is` };
    if (![8, 16].includes(size.cols) || ![8, 16].includes(size.rows)) {
      return { kind: "unknown", why: `it reports ${size.cols}x${size.rows}, which is no grid this knows` };
    }
    return { kind: "grid", name: label, cols: size.cols, rows: size.rows };
  };

  const asCrow = async (): Promise<Found | null> => {
    const decoder = new TextDecoder();
    let heard = "";
    link.onData = (b) => void (heard += decoder.decode(b, { stream: true }));
    await link.write(text.encode("^^i\n"));
    for (let i = 0; i < 10; i++) {
      await sleep(60);
      const m = /\^\^identity\(([^)]*)\)/.exec(heard);
      if (m) return { kind: "crow", identity: m[1]!.replace(/['"]/g, "") };
      if (!link.open) return null;
    }
    return null;
  };

  const crowFirst = info.usbVendorId === CROW_VID && info.usbProductId === CROW_PID;
  const found = crowFirst ? ((await asCrow()) ?? (await asMext())) : ((await asMext()) ?? (await asCrow()));
  link.onData = null;
  return found ?? { kind: "unknown", why: "it answered neither as a grid or an arc, nor as a crow" };
}

/**
 * The latest of each thing, in the order first asked.
 *
 * A script that redraws faster than the port drains must not build a queue
 * of frames that are already out of date: a quad that is still waiting when
 * its next frame arrives is REPLACED, so the grid is never further behind
 * than one frame of each quad.
 */
class Latest {
  private readonly waiting = new Map<string, Uint8Array>();
  private busy = false;
  constructor(private readonly link: Link) {}
  put(key: string, frame: Uint8Array): void {
    this.waiting.set(key, frame);
    if (this.busy) return;
    this.busy = true;
    void (async () => {
      for (;;) {
        const next = this.waiting.entries().next();
        if (next.done === true) break;
        this.waiting.delete(next.value[0]);
        await this.link.write(next.value[1]);
      }
      this.busy = false;
    })();
  }
}

/** Where a real grid's keys go, and how the script's grid is turned. */
export interface GridSink {
  key(x: number, y: number, state: 0 | 1): void;
  tilt(sensor: number, x: number, y: number, z: number): void;
  rotation(): Rotation;
}

export class SerialGrid implements GridTransport {
  readonly descriptor: GridDescriptor;
  private readonly out: Latest;
  private sink: GridSink | null = null;

  constructor(
    private readonly link: Link,
    found: { name: string; cols: number; rows: number },
    serial: string,
  ) {
    this.descriptor = { serial, name: found.name, cols: found.cols, rows: found.rows, varibright: true };
    this.out = new Latest(link);
  }

  /** The device this grid is lighting. Null while it is between two. */
  bind(sink: GridSink | null): void {
    this.sink = sink;
  }

  /** The grid's own size as the script sees it: a quarter turn swaps the two. */
  private turned(): { r: Rotation; cols: number; rows: number } {
    const r = this.sink?.rotation() ?? 0;
    const swap = r === 1 || r === 3;
    return {
      r,
      cols: swap ? this.descriptor.rows : this.descriptor.cols,
      rows: swap ? this.descriptor.cols : this.descriptor.rows,
    };
  }

  ledLevelMap(xOff: number, yOff: number, levels: Uint8Array): void {
    const { r, cols, rows } = this.turned();
    // A block this grid does not have: the page's grid can be the bigger one.
    if (xOff >= cols || yOff >= rows) return;
    this.out.put(`${xOff},${yOff}`, levelMap(xOff, yOff, levels, r, cols, rows));
  }

  ledIntensity(level: number): void {
    this.out.put("i", gridIntensity(level));
  }

  tiltEnable(sensor: number, on: boolean): void {
    void this.link.write(tilt(sensor, on));
  }

  handle(e: MextEvent): void {
    if (this.sink === null) return;
    if (e.type === "key") {
      const { r, cols, rows } = this.turned();
      const [x, y] = rotateIn(r, e.x, e.y, cols, rows);
      this.sink.key(x, y, e.state);
    } else if (e.type === "tilt") {
      this.sink.tilt(e.n, e.x, e.y, e.z);
    }
  }
}

export interface ArcSink {
  delta(ring: number, delta: number): void;
  key(ring: number, state: 0 | 1): void;
}

export class SerialArc implements ArcTransport {
  readonly descriptor: ArcDescriptor;
  readonly rings: number;
  private readonly out: Latest;
  private sink: ArcSink | null = null;

  constructor(link: Link, found: { name: string; rings: number }, serial: string) {
    this.descriptor = { serial, name: found.name };
    this.rings = found.rings;
    this.out = new Latest(link);
  }

  bind(sink: ArcSink | null): void {
    this.sink = sink;
  }

  ledRingMap(ring: number, levels: Uint8Array): void {
    // norns keeps four rings whatever the arc; an arc 2 has two.
    if (ring >= this.rings) return;
    this.out.put(`r${ring}`, ringMap(ring, levels));
  }

  ledIntensity(level: number): void {
    this.out.put("i", ringIntensity(level));
  }

  handle(e: MextEvent): void {
    if (this.sink === null) return;
    if (e.type === "delta") this.sink.delta(e.n, e.delta);
    else if (e.type === "enckey") this.sink.key(e.n, e.state);
  }
}

/**
 * crow: lines of Lua out, lines of `^^event(…)` back.
 *
 * `dev_crow_send` writes the string and a newline, and that is all. Coming
 * back, matron hands Lua whatever a `read` returned and `core/crow.lua`
 * reassembles it; here the bytes are cut at the newline first, so Lua is
 * always handed whole lines — which is the case its buffering exists to
 * reach, arrived at one step sooner.
 */
export class CrowLink {
  private held = "";
  private readonly decoder = new TextDecoder();
  onLine: ((line: string) => void) | null = null;

  constructor(
    private readonly link: Link,
    readonly identity: string,
  ) {}

  send(command: string): void {
    void this.link.write(text.encode(`${command}\n`));
  }

  receive(bytes: Uint8Array): void {
    this.held += this.decoder.decode(bytes, { stream: true });
    for (;;) {
      const at = this.held.indexOf("\n");
      if (at < 0) break;
      const line = this.held.slice(0, at + 1);
      this.held = this.held.slice(at + 1);
      if (line.trim() !== "") this.onLine?.(line);
    }
  }
}

/** The part of `navigator.serial` this uses. */
export interface SerialLike {
  requestPort(options?: { filters?: Array<{ usbVendorId: number; usbProductId?: number }> }): Promise<PortLike>;
  getPorts(): Promise<PortLike[]>;
  addEventListener(type: "connect" | "disconnect", listener: (e: { target: unknown }) => void): void;
}

export interface HardwareHooks {
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  gridArrived(grid: SerialGrid): void;
  gridLeft(grid: SerialGrid): void;
  arcArrived(arc: SerialArc): void;
  arcLeft(arc: SerialArc): void;
  crowArrived(crow: CrowLink): void;
  crowLeft(crow: CrowLink): void;
  /** Something came or went: the button says how many are plugged in. */
  changed?(): void;
}

type Attached =
  | { kind: "grid"; link: Link; device: SerialGrid }
  | { kind: "arc"; link: Link; device: SerialArc }
  | { kind: "crow"; link: Link; device: CrowLink };

/** A serial of matron's shape for a device that cannot be asked for its own. */
function serialFor(kind: string, label: string, taken: ReadonlySet<string>): string {
  let h = 0;
  for (const c of `${kind}:${label}`) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  for (let i = 0; ; i++) {
    const s = `m${String((h + i) % 10000000).padStart(7, "0")}`;
    if (!taken.has(s)) return s;
  }
}

/** Why a port would not open, in words that say what to do. */
export function whyNotOpen(e: unknown): string {
  const err = e as { name?: string; message?: string };
  if (err?.name === "InvalidStateError") return "it is already open in this page";
  if (err?.name === "NetworkError" || /failed to open/i.test(err?.message ?? "")) {
    return (
      "another program is holding it. For a grid or an arc that is serialosc: " +
      "quit it (on Windows, stop the serialosc service) and try again"
    );
  }
  return String(err?.message ?? e);
}

export class MonomeHardware {
  private readonly attached = new Map<PortLike, Attached>();
  private readonly opening = new Set<PortLike>();

  constructor(
    private readonly serial: SerialLike | null,
    private readonly hooks: HardwareHooks,
  ) {
    // A port already granted, plugged back in, comes back by itself.
    serial?.addEventListener("connect", (e) => void this.attach(e.target as PortLike));
    serial?.addEventListener("disconnect", (e) => this.left(e.target as PortLike, "it was unplugged"));
  }

  /** Does this browser have serial ports at all? */
  get supported(): boolean {
    return this.serial !== null;
  }

  list(): ReadonlyArray<{ kind: string; name: string }> {
    return [...this.attached.values()].map((a) => ({
      kind: a.kind,
      name: a.kind === "crow" ? "crow" : a.device.descriptor.name,
    }));
  }

  /** The picker. Has to be called from a click: the browser insists. */
  async connect(): Promise<void> {
    if (this.serial === null) return;
    let port: PortLike;
    try {
      port = await this.serial.requestPort();
    } catch {
      return; // the picker was closed
    }
    await this.attach(port);
  }

  /** Every port the user has already allowed, with no picker. */
  async restore(): Promise<void> {
    if (this.serial === null) return;
    let ports: PortLike[] = [];
    try {
      ports = await this.serial.getPorts();
    } catch {
      return;
    }
    for (const p of ports) await this.attach(p, true);
  }

  /** A port somebody already holds: open it and see what answers. */
  adopt(port: PortLike): Promise<void> {
    return this.attach(port);
  }

  private async attach(port: PortLike, quiet = false): Promise<void> {
    if (this.attached.has(port) || this.opening.has(port)) return;
    this.opening.add(port);
    try {
      let link: Link;
      try {
        link = await openLink(port);
      } catch (e) {
        // A port remembered from last time and not plugged in is not news.
        if (!quiet) this.hooks.log(`monome: the port would not open — ${whyNotOpen(e)}`);
        return;
      }
      const found = await identify(link, port.getInfo?.() ?? {}, this.hooks.sleep);
      if (!link.open) return;
      if (found.kind === "unknown") {
        this.hooks.log(`monome: nothing known on that port — ${found.why}`);
        await link.close();
        return;
      }
      const taken = new Set(
        [...this.attached.values()].flatMap((a) => (a.kind === "crow" ? [] : [a.device.descriptor.serial])),
      );
      if (found.kind === "crow") {
        const crow = new CrowLink(link, found.identity);
        link.onData = (b) => crow.receive(b);
        this.attached.set(port, { kind: "crow", link, device: crow });
        this.hooks.log(`crow: connected over usb${found.identity ? ` (${found.identity})` : ""}`);
        this.hooks.crowArrived(crow);
      } else {
        const parser = new MextParser();
        const serial = serialFor(found.kind, found.name, taken);
        if (found.kind === "grid") {
          const grid = new SerialGrid(link, found, serial);
          link.onData = (b) => parser.feed(b).forEach((e) => grid.handle(e));
          this.attached.set(port, { kind: "grid", link, device: grid });
          this.hooks.log(`grid: ${found.name}, ${found.cols}x${found.rows}, connected over usb`);
          this.hooks.gridArrived(grid);
        } else {
          const arc = new SerialArc(link, found, serial);
          link.onData = (b) => parser.feed(b).forEach((e) => arc.handle(e));
          this.attached.set(port, { kind: "arc", link, device: arc });
          this.hooks.log(`arc: ${found.name}, connected over usb`);
          this.hooks.arcArrived(arc);
        }
      }
      link.onClosed = (why) => this.left(port, why);
      this.hooks.changed?.();
    } finally {
      this.opening.delete(port);
    }
  }

  private left(port: PortLike, why: string): void {
    const a = this.attached.get(port);
    if (a === undefined) return;
    this.attached.delete(port);
    void a.link.close();
    if (a.kind === "grid") {
      this.hooks.log(`grid: ${a.device.descriptor.name} is gone — ${why}`);
      this.hooks.gridLeft(a.device);
    } else if (a.kind === "arc") {
      this.hooks.log(`arc: ${a.device.descriptor.name} is gone — ${why}`);
      this.hooks.arcLeft(a.device);
    } else {
      this.hooks.log(`crow: gone — ${why}`);
      this.hooks.crowLeft(a.device);
    }
    this.hooks.changed?.();
  }

  /** Let go of everything: the ports are free for serialosc again. */
  async release(): Promise<void> {
    for (const port of [...this.attached.keys()]) this.left(port, "released");
  }
}
