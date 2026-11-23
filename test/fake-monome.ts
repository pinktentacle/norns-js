// E9-204 — a grid, an arc and a crow, on the device's side of the wire.
//
// Nobody here has the hardware, so these stand in for it. They are written
// from the DEVICE's point of view and from the same sources as the host —
// libmonome's `mext.h` length tables, matron's `device_crow.c` — which makes
// them a check of the transcription and not of the hardware: a frame the
// host builds wrong and the fake reads wrong the same way would pass. What
// they do settle is everything around the frames: the handshake, a port
// that is busy, bytes that arrive split, a device unplugged mid-script.
//
// Shared by the tests and by a page: `navigator.serial` can be replaced
// with `FakeSerial` to drive the real application end to end.

import type { PortLike } from "../src/monome/serial-link.js";
import type { SerialLike } from "../src/monome/hardware.js";

/** What the host may send, and how long each payload is (`outgoing_payload_lengths`). */
function hostPayload(header: number): number {
  const section = header >> 4;
  const cmd = header & 0x0f;
  if (section === 0x0) return [0, 0, 32, 0, 3, 0, 2, 0, 2][cmd] ?? 0;
  if (section === 0x1) return [2, 2, 0, 0, 10, 3, 3, 1, 3, 1, 34, 6, 6][cmd] ?? 0;
  if (section === 0x9) return [3, 2, 33, 4, 2][cmd] ?? 0;
  if (section === 0x8) return [0, 1, 1][cmd] ?? 0;
  return 0;
}

type Device = (bytes: Uint8Array, reply: (b: Uint8Array) => void) => void;

export class FakePort implements PortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  /** Another program has it: `open()` fails the way Chrome's does. */
  busy = false;
  opened: { baudRate: number } | null = null;
  signals: { dataTerminalReady?: boolean; requestToSend?: boolean } | null = null;
  closed = false;
  /** Every byte the host has sent, in order. */
  readonly written: number[] = [];
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(
    private readonly device: Device,
    private readonly info: { usbVendorId?: number; usbProductId?: number } = {},
  ) {}

  async open(options: { baudRate: number }): Promise<void> {
    if (this.busy) throw Object.assign(new Error("Failed to open serial port."), { name: "NetworkError" });
    if (this.opened !== null && !this.closed) {
      throw Object.assign(new Error("The port is already open."), { name: "InvalidStateError" });
    }
    this.opened = options;
    this.closed = false;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => void (this.controller = c) });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.written.push(...chunk);
        this.device(chunk, (b) => this.emit(b));
      },
    });
  }

  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void> {
    this.signals = signals;
  }

  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    return this.info;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.readable = null;
    this.writable = null;
  }

  /** Device to host. */
  emit(bytes: Uint8Array): void {
    this.controller?.enqueue(bytes);
  }

  /** The cable comes out. */
  unplug(): void {
    const c = this.controller;
    this.controller = null;
    this.readable = null;
    c?.error(Object.assign(new Error("The device has been lost."), { name: "NetworkError" }));
  }
}

const idReply = (name: string): Uint8Array => {
  const out = new Uint8Array(33);
  out[0] = 0x01;
  for (let i = 0; i < Math.min(32, name.length); i++) out[1 + i] = name.charCodeAt(i);
  return out;
};

/** Reads the host's frames whatever way they were cut up. */
function frames(onFrame: (header: number, payload: Uint8Array, reply: (b: Uint8Array) => void) => void): Device {
  let held: number[] = [];
  return (bytes, reply) => {
    held.push(...bytes);
    for (;;) {
      if (held.length === 0) return;
      const n = hostPayload(held[0]!);
      if (held.length < 1 + n) return;
      const header = held[0]!;
      const payload = Uint8Array.from(held.slice(1, 1 + n));
      held = held.slice(1 + n);
      onFrame(header, payload, reply);
    }
  };
}

const unpack = (p: Uint8Array, at: number): Uint8Array => {
  const out = new Uint8Array(64);
  for (let i = 0; i < 32; i++) {
    out[i * 2] = p[at + i]! >> 4;
    out[i * 2 + 1] = p[at + i]! & 0x0f;
  }
  return out;
};

export class FakeGrid {
  readonly port: FakePort;
  /** What the grid is showing, row by row, in ITS OWN orientation. */
  readonly leds: Uint8Array;
  intensity = -1;
  maps = 0;

  constructor(
    readonly cols: number,
    readonly rows: number,
    readonly name = cols === 8 ? "monome 64" : rows === 8 ? "monome 128" : "monome 256",
    info: { usbVendorId?: number; usbProductId?: number } = { usbVendorId: 0x0403, usbProductId: 0x6015 },
  ) {
    this.leds = new Uint8Array(cols * rows);
    this.port = new FakePort(
      frames((header, p, reply) => {
        if (header === 0x00) {
          reply(Uint8Array.of(0x00, 1, 1));
          reply(Uint8Array.of(0x00, 2, 1));
        } else if (header === 0x01) reply(idReply(this.name));
        else if (header === 0x05) reply(Uint8Array.of(0x03, cols, rows));
        else if (header === 0x17) this.intensity = p[0]!;
        else if (header === 0x1a) {
          // The grid takes the block the origin is IN.
          const x0 = p[0]! & 0xf8;
          const y0 = p[1]! & 0xf8;
          const levels = unpack(p, 2);
          this.maps++;
          for (let i = 0; i < 64; i++) {
            const x = x0 + (i & 7);
            const y = y0 + (i >> 3);
            if (x < cols && y < rows) this.leds[y * cols + x] = levels[i]!;
          }
        }
      }),
      info,
    );
  }

  /** A finger, in the grid's own orientation. */
  press(x: number, y: number, state: 0 | 1): void {
    this.port.emit(Uint8Array.of(state === 1 ? 0x21 : 0x20, x, y));
  }

  led(x: number, y: number): number {
    return this.leds[y * this.cols + x]!;
  }
}

export class FakeArc {
  readonly port: FakePort;
  readonly ring: Uint8Array[];
  intensity = -1;
  /** An arc that never says how big its grid is. */
  silentAboutSize = false;

  constructor(
    readonly rings = 4,
    readonly name = `monome arc ${rings}`,
  ) {
    this.ring = Array.from({ length: rings }, () => new Uint8Array(64));
    this.port = new FakePort(
      frames((header, p, reply) => {
        if (header === 0x00) {
          reply(Uint8Array.of(0x00, 5, rings));
          reply(Uint8Array.of(0x00, 9, rings));
        } else if (header === 0x01) reply(idReply(this.name));
        else if (header === 0x05) {
          if (!this.silentAboutSize) reply(Uint8Array.of(0x03, 0, 0));
        } else if (header === 0x92) {
          const r = this.ring[p[0]!];
          if (r !== undefined) r.set(unpack(p, 1));
        } else if (header === 0x94) this.intensity = p[0]!;
      }),
      { usbVendorId: 0x0403, usbProductId: 0x6015 },
    );
  }

  turn(n: number, delta: number): void {
    this.port.emit(Uint8Array.of(0x50, n, delta & 0xff));
  }

  push(n: number, state: 0 | 1): void {
    this.port.emit(Uint8Array.of(state === 1 ? 0x52 : 0x51, n));
  }
}

export class FakeCrow {
  readonly port: FakePort;
  /** Every complete line the host sent, without its newline. */
  readonly lines: string[] = [];
  private held = "";

  constructor(info: { usbVendorId?: number; usbProductId?: number } = { usbVendorId: 0x0483, usbProductId: 0x5740 }) {
    this.port = new FakePort((bytes, reply) => {
      this.held += String.fromCharCode(...bytes);
      for (;;) {
        const at = this.held.indexOf("\n");
        if (at < 0) return;
        const line = this.held.slice(0, at);
        this.held = this.held.slice(at + 1);
        this.lines.push(line);
        if (line.endsWith("^^i")) reply(new TextEncoder().encode("^^identity('0x1234abcd')\n\r"));
      }
    }, info);
  }

  /** Something crow prints on its own. */
  say(text: string): void {
    this.port.emit(new TextEncoder().encode(text));
  }
}

/** `navigator.serial`, with a picker that hands over whatever was put in it. */
export class FakeSerial implements SerialLike {
  /** What the picker will return next. Null is the user closing it. */
  picks: (PortLike | null)[] = [];
  /** Ports already allowed. */
  granted: PortLike[] = [];
  requests = 0;
  private readonly listeners: Record<string, ((e: { target: unknown }) => void)[]> = {};

  async requestPort(): Promise<PortLike> {
    this.requests++;
    const p = this.picks.shift() ?? null;
    if (p === null) throw Object.assign(new Error("No port selected by the user."), { name: "NotFoundError" });
    if (!this.granted.includes(p)) this.granted.push(p);
    return p;
  }

  async getPorts(): Promise<PortLike[]> {
    return [...this.granted];
  }

  addEventListener(type: "connect" | "disconnect", listener: (e: { target: unknown }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  fire(type: "connect" | "disconnect", port: PortLike): void {
    for (const l of this.listeners[type] ?? []) l({ target: port });
  }
}
