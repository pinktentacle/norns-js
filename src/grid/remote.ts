// E5-06 — a grid at the other end of a WebSocket.
//
// `GridTransport` is libmonome's narrow waist and nothing more: two calls
// out, one event in (see research/grid-design.md §4). That is what makes
// this file small — there is no protocol to invent, only a way to put three
// things on a wire.
//
// WHY BINARY. A full 16×16 refresh is four quads of 64 levels. As JSON that
// is about 1.4 KB of encode and parse per frame, on the same main thread as
// Fengari and the screen; as bytes it is 4 × 67. The levels are already a
// `Uint8Array` on both sides, so the frame is a copy rather than a
// transformation. §4 rejected serialosc-over-anything for the same reason
// and names the cost.
//
// THE PAGE IS THE CLIENT, always. A browser cannot listen, so whatever is at
// the other end — `../nornsoid`'s core on a phone, a relay in front of a real
// grid, a test harness — is the server. That also settles who re-synchronises
// after a drop: the client reconnects, so the client re-sends its state.
//
// A RECONNECT RE-SENDS EVERYTHING. A grid's LED state is not a stream of
// changes, it is a buffer that `refresh()` presents; a transport that
// reconnects mid-script and waits for the next `refresh()` shows black until
// the script happens to redraw, which for a script that drew once and is
// waiting for a key is for ever. `GridDevice.addTransport` already does this
// for a new sink, and `resend` is the same thing for one that came back.

import type { GridDescriptor, GridTransport } from "./device.js";

/** Out: `0x01` quad, `0x02` intensity, `0x03` tilt. In: `0x10` key, `0x11` tilt. */
export const MSG = {
  /** `[0x01, xOff, yOff, ...64 levels]` — 67 bytes. */
  LED_MAP: 0x01,
  /** `[0x02, level]`. */
  INTENSITY: 0x02,
  /** `[0x03, sensor, on]`. */
  TILT_ENABLE: 0x03,
  /** `[0x10, x, y, state]`, 0-based, device space. */
  KEY: 0x10,
  /** `[0x11, sensor, int16 x, int16 y, int16 z]` — tilt axes are signed. */
  TILT: 0x11,
} as const;

/** Just enough of WebSocket to be supplied by a test. */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
}

export interface RemoteGridOptions {
  readonly url: string;
  readonly descriptor: GridDescriptor;
  /** Device space, 0-based — straight to `GridDevice.key`. */
  readonly onKey: (x: number, y: number, state: 0 | 1) => void;
  readonly onTilt?: (sensor: number, x: number, y: number, z: number) => void;
  readonly log?: (line: string) => void;
  /** Supplied by tests; the browser's `WebSocket` otherwise. */
  readonly open?: (url: string) => SocketLike;
  /** First retry delay. It doubles, capped at `maxBackoffMs`. */
  readonly backoffMs?: number;
  readonly maxBackoffMs?: number;
}

const OPEN = 1;

export class RemoteGridTransport implements GridTransport {
  readonly descriptor: GridDescriptor;
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backoff: number;
  private closed = false;
  /**
   * The last presented frame per quad, so a reconnect has something to send.
   *
   * Kept here rather than read back from the device because a transport is
   * not entitled to reach into one: `GridTransport` is what the device hands
   * it, and this is exactly that, remembered.
   */
  private readonly frames = new Map<number, Uint8Array>();
  private intensity = 15;
  readonly stats = { frames: 0, keys: 0, reconnects: 0, dropped: 0 };

  constructor(private readonly opts: RemoteGridOptions) {
    this.descriptor = opts.descriptor;
    this.backoff = opts.backoffMs ?? 500;
    this.connect();
  }

  // --- GridTransport ----------------------------------------------------

  ledLevelMap(xOff: number, yOff: number, levels: Uint8Array): void {
    const frame = new Uint8Array(3 + 64);
    frame[0] = MSG.LED_MAP;
    frame[1] = xOff;
    frame[2] = yOff;
    frame.set(levels.subarray(0, 64), 3);
    // Keyed by offset, not by quad index: the transport is told where the
    // quad goes, which is the only identity it has for it.
    this.frames.set((xOff << 8) | yOff, frame);
    this.send(frame);
  }

  ledIntensity(level: number): void {
    this.intensity = level;
    this.send(new Uint8Array([MSG.INTENSITY, level & 0xff]));
  }

  tiltEnable(sensor: number, on: boolean): void {
    this.send(new Uint8Array([MSG.TILT_ENABLE, sensor & 0xff, on ? 1 : 0]));
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }

  // --- the wire ---------------------------------------------------------

  private send(bytes: Uint8Array): void {
    const s = this.socket;
    if (s === null || s.readyState !== OPEN) {
      // Not queued. A grid frame is only interesting when it is current, and
      // a backlog of them delivered on reconnect would play the script's
      // last few seconds of animation at once.
      this.stats.dropped++;
      return;
    }
    try {
      s.send(bytes);
      this.stats.frames++;
    } catch {
      this.stats.dropped++;
    }
  }

  private connect(): void {
    if (this.closed) return;
    const log = this.opts.log ?? (() => {});
    let s: SocketLike;
    try {
      s = (this.opts.open ?? defaultOpen)(this.opts.url);
    } catch (e) {
      log(`grid remote: ${(e as Error).message}`);
      this.retry();
      return;
    }
    s.binaryType = "arraybuffer";
    this.socket = s;

    s.onopen = () => {
      log(`grid remote: connected to ${this.opts.url}`);
      this.backoff = this.opts.backoffMs ?? 500;
      this.resend();
    };
    s.onclose = () => {
      if (this.closed) return;
      this.socket = null;
      this.retry();
    };
    s.onerror = () => {
      // `onclose` always follows, and that is where the retry lives; two
      // retries for one drop would halve the backoff on every failure.
    };
    s.onmessage = (e) => this.receive(e.data);
  }

  private retry(): void {
    if (this.closed || this.timer !== undefined) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 15000);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.stats.reconnects++;
      this.connect();
    }, wait);
  }

  /** Everything the far end needs to show what is on the grid right now. */
  resend(): void {
    this.send(new Uint8Array([MSG.INTENSITY, this.intensity & 0xff]));
    for (const frame of this.frames.values()) this.send(frame);
  }

  private receive(data: unknown): void {
    const bytes = toBytes(data);
    if (bytes === null || bytes.length === 0) return;
    switch (bytes[0]) {
      case MSG.KEY: {
        if (bytes.length < 4) return;
        this.stats.keys++;
        this.opts.onKey(bytes[1]!, bytes[2]!, bytes[3] === 0 ? 0 : 1);
        return;
      }
      case MSG.TILT: {
        if (bytes.length < 8) return;
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.opts.onTilt?.(bytes[1]!, v.getInt16(2), v.getInt16(4), v.getInt16(6));
        return;
      }
      default:
        // Anything else is a newer protocol or another application's traffic.
        // Ignored rather than rejected: a transport that disconnects over an
        // unknown byte is one that cannot be extended.
        return;
    }
  }
}

function defaultOpen(url: string): SocketLike {
  const C = (globalThis as unknown as { WebSocket?: new (u: string) => SocketLike }).WebSocket;
  if (C === undefined) throw new Error("no WebSocket in this environment");
  return new C(url);
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  // A text frame. The protocol is binary, so this is someone else's traffic.
  return null;
}

/** Encode a key press the way a remote grid should send one. */
export function encodeKey(x: number, y: number, state: 0 | 1): Uint8Array {
  return new Uint8Array([MSG.KEY, x & 0xff, y & 0xff, state]);
}

/** Encode a tilt report. The axes are signed, hence int16. */
export function encodeTilt(sensor: number, x: number, y: number, z: number): Uint8Array {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  b[0] = MSG.TILT;
  b[1] = sensor & 0xff;
  v.setInt16(2, x);
  v.setInt16(4, y);
  v.setInt16(6, z);
  return b;
}
