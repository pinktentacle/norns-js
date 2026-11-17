// E5-24 — `osc_send`, the last one, and the only one that needs something
// outside the browser.
//
// A page cannot open a UDP socket. Not "not yet": there is no API, by design,
// because a page that could send arbitrary datagrams to arbitrary hosts is a
// port scanner. So OSC leaves through a WebSocket to a relay that has a
// socket, exactly as the remote grid does (`src/grid/remote.ts`), and the
// relay is the thing the user chooses to run.
//
// WITHOUT A RELAY, `osc_send` IS HONEST ABOUT IT. It says so once, with the
// address it would have used, and returns — rather than succeeding silently,
// which is what a stub does and what makes someone spend an afternoon on the
// receiving end wondering why nothing arrives.
//
// THE FRAME IS NOT OSC. OSC has no addressing of its own; the host and port
// live in the UDP header, which a WebSocket does not have. So each frame
// carries them in front of the message:
//
//     [u8 hostLen][host, UTF-8][u16 port, big endian][OSC bytes]
//
// and a frame arriving the other way has the same shape, with the sender's
// address in it — which is what `_norns.osc.event(path, args, from)` needs
// for its third argument.

import { decode, encodeMessage, type OscMessage } from "../engine/osc.js";

export interface OscRemoteOptions {
  readonly url: string;
  /** A message arrived: path, arguments, and who sent it. */
  readonly onEvent: (path: string, args: ReadonlyArray<number | string>, from: [string, string]) => void;
  readonly log?: (line: string) => void;
  /** Injected in tests. */
  readonly socketFactory?: (url: string) => WebSocket;
}

export function frameFor(host: string, port: number, osc: Uint8Array): Uint8Array<ArrayBuffer> {
  const h = new TextEncoder().encode(host);
  if (h.length > 255) throw new Error("osc: host name too long");
  const out = new Uint8Array(new ArrayBuffer(1 + h.length + 2 + osc.length));
  out[0] = h.length;
  out.set(h, 1);
  out[1 + h.length] = (port >> 8) & 0xff;
  out[2 + h.length] = port & 0xff;
  out.set(osc, 3 + h.length);
  return out;
}

export function parseFrame(
  bytes: Uint8Array,
): { host: string; port: number; osc: Uint8Array } | null {
  if (bytes.length < 3) return null;
  const hostLen = bytes[0]!;
  if (bytes.length < 3 + hostLen) return null;
  const host = new TextDecoder().decode(bytes.subarray(1, 1 + hostLen));
  const port = (bytes[1 + hostLen]! << 8) | bytes[2 + hostLen]!;
  return { host, port, osc: bytes.subarray(3 + hostLen) };
}

export class OscRemote {
  private socket: WebSocket | null = null;
  private open = false;
  /** Sent once the socket opens. A script does not wait for a connection. */
  private readonly queue: Uint8Array<ArrayBuffer>[] = [];
  private readonly log: (line: string) => void;

  constructor(private readonly opts: OscRemoteOptions) {
    this.log = opts.log ?? ((): void => {});
    this.connect();
  }

  private connect(): void {
    try {
      const make = this.opts.socketFactory ?? ((u: string): WebSocket => new WebSocket(u));
      const s = make(this.opts.url);
      s.binaryType = "arraybuffer";
      s.addEventListener("open", () => {
        this.open = true;
        this.log(`osc: relay connected (${this.opts.url})`);
        for (const f of this.queue.splice(0)) s.send(f);
      });
      s.addEventListener("close", () => {
        this.open = false;
        this.log("osc: relay closed");
      });
      s.addEventListener("error", () => this.log("osc: relay error"));
      s.addEventListener("message", (e: MessageEvent) => this.receive(e.data));
      this.socket = s;
    } catch (err) {
      this.log(`osc: relay unavailable: ${String((err as Error)?.message ?? err)}`);
    }
  }

  private receive(data: unknown): void {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Uint8Array
          ? data
          : null;
    if (!bytes) return;
    const frame = parseFrame(bytes);
    if (!frame) return;
    let msg: OscMessage | { bundle: OscMessage[] };
    try {
      msg = decode(frame.osc);
    } catch {
      return;
    }
    // A bundle is delivered as its messages: norns' own handler takes one
    // path and one argument list, and liblo unpacks bundles before calling
    // it. Flattening here is the same unpacking.
    const all = "bundle" in msg ? msg.bundle : [msg];
    for (const m of all) {
      this.opts.onEvent(
        m.address,
        m.args.filter((a): a is number | string => typeof a !== "object"),
        [frame.host, String(frame.port)],
      );
    }
  }

  send(host: string, port: number, path: string, args: ReadonlyArray<number | string>): void {
    const frame = frameFor(host, port, encodeMessage(path, args));
    if (this.open && this.socket) this.socket.send(frame);
    // A few frames are kept while the socket opens, and only a few: a script
    // that sends sixty messages a second to a relay that is not there should
    // not grow a queue until the tab dies.
    else if (this.queue.length < 64) this.queue.push(frame);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.open = false;
  }
}
