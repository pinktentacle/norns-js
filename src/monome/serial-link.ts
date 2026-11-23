// E9-204 — one serial port, open, with bytes going both ways.
//
// The thinnest thing that can sit between Web Serial and a protocol: it
// opens the port the way libmonome's `platform/posix.c` does — 115200 8N1,
// no flow control — and turns the two streams into a callback and a call.
//
// DTR AND RTS ARE ASSERTED BY HAND. An FTDI part passes no data until they
// are; on Linux `ftdi_sio` raises them on open, so libmonome never has to,
// and nothing does it for a page. Some CDC drivers refuse the call, which is
// not an error worth stopping for.
//
// `PortLike` is the part of `SerialPort` this uses, so a test can be a grid.

export interface PortLike {
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

export interface Link {
  /** Resolves when the bytes have been handed to the port. Never rejects. */
  write(bytes: Uint8Array): Promise<void>;
  onData: ((bytes: Uint8Array) => void) | null;
  /** Called once, when the port stops for any reason but `close()`. */
  onClosed: ((why: string) => void) | null;
  close(): Promise<void>;
  readonly open: boolean;
}

export const BAUD = 115200;

export async function openLink(port: PortLike, baudRate = BAUD): Promise<Link> {
  await port.open({ baudRate, bufferSize: 4096 });
  try {
    await port.setSignals?.({ dataTerminalReady: true, requestToSend: true });
  } catch {
    /* a CDC driver that will not take them does not need them */
  }

  let closing = false;
  let alive = true;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const writer = port.writable?.getWriter() ?? null;
  let tail: Promise<void> = Promise.resolve();

  const stopped = (why: string): void => {
    if (!alive) return;
    alive = false;
    if (!closing) link.onClosed?.(why);
  };

  const link: Link = {
    onData: null,
    onClosed: null,
    get open() {
      return alive;
    },
    write(bytes) {
      if (!alive || writer === null) return Promise.resolve();
      // One after another, in the order asked: a frame is not a frame if
      // another is written through the middle of it.
      tail = tail
        .then(() => writer.write(bytes))
        .catch((e: unknown) => stopped(`a write failed — ${String((e as Error)?.message ?? e)}`));
      return tail;
    },
    async close() {
      if (closing) return;
      closing = true;
      alive = false;
      try {
        await reader?.cancel();
      } catch {
        /* already gone */
      }
      try {
        writer?.releaseLock();
      } catch {
        /* a write still in flight; closing the port ends it */
      }
      try {
        await port.close();
      } catch {
        /* unplugged before it could be closed */
      }
    },
  };

  // The reader. A serial port reports a framing error or an overrun by
  // failing the read and offering a NEW readable; only a fatal one leaves
  // `readable` null. So the loop is around the reader, not inside it.
  void (async () => {
    let why = "the device went away";
    // A port that fails every read without ever delivering a byte is not
    // recovering, whatever it says about its `readable`.
    let barren = 0;
    while (!closing && port.readable !== null && barren < 5) {
      reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value !== undefined && value.length > 0) {
            barren = 0;
            link.onData?.(value);
          }
        }
        break;
      } catch (e) {
        barren++;
        why = `the port failed — ${String((e as Error)?.message ?? e)}`;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* nothing held */
        }
      }
    }
    stopped(why);
  })();

  return link;
}
