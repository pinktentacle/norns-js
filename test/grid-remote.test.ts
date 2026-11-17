// E5-06 — a grid at the other end of a WebSocket.
//
// The fake socket below is a real one in the only sense that matters here:
// it has a `readyState` that is not OPEN until it opens, it delivers what it
// is given, and it can drop. Those three are where the bugs are — a frame
// sent before the socket opened, a reconnect that shows black, a backoff
// that halves itself because `onerror` and `onclose` both fired.

import { describe, expect, it } from "vitest";
import { GridDevice, type GridDescriptor } from "../src/grid/device.js";
import { RemoteGridTransport, MSG, encodeKey, encodeTilt, type SocketLike } from "../src/grid/remote.js";

const desc: GridDescriptor = {
  serial: "r0001",
  name: "remote grid",
  cols: 16,
  rows: 8,
  varibright: true,
};

class FakeSocket implements SocketLike {
  binaryType = "";
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;

  send(data: ArrayBufferView | ArrayBuffer): void {
    const v = data as ArrayBufferView;
    this.sent.push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  deliver(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}

function wired(opts: { backoffMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const keys: Array<[number, number, number]> = [];
  const tilts: Array<[number, number, number, number]> = [];
  const t = new RemoteGridTransport({
    url: "ws://example.invalid/grid",
    descriptor: desc,
    onKey: (x, y, s) => keys.push([x, y, s]),
    onTilt: (s, x, y, z) => tilts.push([s, x, y, z]),
    backoffMs: opts.backoffMs ?? 10,
    open: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  return { t, sockets, keys, tilts, last: () => sockets[sockets.length - 1]! };
}

describe("the wire", () => {
  it("sends a quad as 67 bytes, offsets first", () => {
    const { t, last } = wired();
    last().open();
    const levels = new Uint8Array(64);
    levels[0] = 15;
    levels[63] = 7;
    t.ledLevelMap(8, 0, levels);
    const f = last().sent.find((b) => b[0] === MSG.LED_MAP)!;
    expect(f.length).toBe(67);
    expect([f[1], f[2], f[3], f[66]]).toEqual([8, 0, 15, 7]);
  });

  it("sends intensity as two bytes", () => {
    const { t, last } = wired();
    last().open();
    // The LAST one: `resend()` on open already sent the current intensity,
    // which is correct and is what the reconnect test below depends on.
    t.ledIntensity(9);
    const all = last().sent.filter((b) => b[0] === MSG.INTENSITY);
    expect([...all[all.length - 1]!]).toEqual([MSG.INTENSITY, 9]);
  });

  it("reads a key back into device space", () => {
    const { keys, last } = wired();
    last().open();
    last().deliver(encodeKey(3, 5, 1));
    last().deliver(encodeKey(3, 5, 0));
    expect(keys).toEqual([
      [3, 5, 1],
      [3, 5, 0],
    ]);
  });

  it("reads a tilt with signed axes", () => {
    const { tilts, last } = wired();
    last().open();
    last().deliver(encodeTilt(0, -120, 300, 0));
    expect(tilts).toEqual([[0, -120, 300, 0]]);
  });

  it("ignores a message it does not know rather than disconnecting", () => {
    const { keys, last } = wired();
    last().open();
    last().deliver(new Uint8Array([0x7f, 1, 2, 3]));
    last().deliver(new Uint8Array([]));
    last().deliver(encodeKey(1, 1, 1));
    expect(keys).toEqual([[1, 1, 1]]);
    expect(last().readyState).toBe(1);
  });

  it("drops a frame sent before the socket is open rather than queueing it", () => {
    // A grid frame is only interesting while it is current. A backlog
    // delivered on connect would replay the last seconds of animation.
    const { t, last } = wired();
    t.ledLevelMap(0, 0, new Uint8Array(64));
    expect(last().sent).toEqual([]);
    expect(t.stats.dropped).toBe(1);
  });
});

describe("coming back", () => {
  it("RE-SENDS THE WHOLE SURFACE on reconnect, not the next change", async () => {
    // A script that drew once and is waiting for a key never draws again.
    // A transport that waits for the next refresh() shows black for ever.
    const { t, sockets, last } = wired({ backoffMs: 1 });
    last().open();
    const a = new Uint8Array(64).fill(3);
    const b = new Uint8Array(64).fill(11);
    t.ledIntensity(4);
    t.ledLevelMap(0, 0, a);
    t.ledLevelMap(8, 0, b);

    last().drop();
    await new Promise((r) => setTimeout(r, 10));
    expect(sockets.length).toBe(2);
    last().open();

    const maps = last().sent.filter((f) => f[0] === MSG.LED_MAP);
    expect(maps.length).toBe(2);
    expect(maps.map((f) => [f[1], f[3]])).toEqual([
      [0, 3],
      [8, 11],
    ]);
    // The intensity too: it is part of what the surface looks like.
    expect(last().sent.some((f) => f[0] === MSG.INTENSITY && f[1] === 4)).toBe(true);
    t.close();
  });

  it("backs off, and one drop is one retry even though onerror fires too", async () => {
    const { t, sockets, last } = wired({ backoffMs: 5 });
    last().open();
    last().onerror?.({});
    last().drop();
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets.length).toBe(2);
    expect(t.stats.reconnects).toBe(1);
    t.close();
  });

  it("stops retrying once closed", async () => {
    const { t, sockets, last } = wired({ backoffMs: 1 });
    last().open();
    t.close();
    last().drop();
    await new Promise((r) => setTimeout(r, 10));
    expect(sockets.length).toBe(1);
  });
});

describe("as a sink on a real device", () => {
  it("receives what refresh() presents, and nothing before it", () => {
    const keys: Array<[number, number, number]> = [];
    const d = new GridDevice(0, desc, { key: (x, y, s) => keys.push([x, y, s]), tilt: () => {} });
    const sockets: FakeSocket[] = [];
    const t = new RemoteGridTransport({
      url: "ws://example.invalid/grid",
      descriptor: desc,
      onKey: (x, y, s) => d.key(x, y, s),
      open: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    sockets[0]!.open();
    d.addTransport(t);
    sockets[0]!.sent.length = 0;

    d.setLed(0, 0, 15, false);
    expect(sockets[0]!.sent.filter((f) => f[0] === MSG.LED_MAP)).toEqual([]);
    d.refresh();
    const f = sockets[0]!.sent.find((x) => x[0] === MSG.LED_MAP)!;
    expect(f[3]).toBe(15);

    // And a key from the far end reaches the device's input.
    sockets[0]!.deliver(encodeKey(2, 1, 1));
    expect(keys).toEqual([[2, 1, 1]]);
    t.close();
  });
});
