// E3-03 — a lock-free ring from the audio thread to the main thread.
//
// Plain JavaScript and no imports, for the same reason as scheduler.js: this
// file is concatenated into a classic AudioWorklet script and imported by the
// main thread and by tests.
//
// Why a ring rather than `port.postMessage` per event: the worklet runs on the
// audio thread, where allocation is the thing you do not do. A metro at 100 Hz
// plus a handful of clock coroutines is a steady trickle of messages, each one
// a structured clone and a garbage object. A ring is a pre-allocated
// SharedArrayBuffer written with plain stores.
//
// Single producer, single consumer, so no locks are needed and Atomics are
// used only for the two indices — a relaxed store of the payload followed by a
// release store of the write index is enough to make the payload visible.
//
// SharedArrayBuffer needs cross-origin isolation. Where it is missing the
// caller falls back to postMessage; nothing here pretends otherwise.

/** Fixed-size record: type, then three numbers. */
export const RECORD = 4;
export const HEADER = 8; // read index, write index, and room to grow

export const EV_METRO = 1; // (idx, stage)
export const EV_CLOCK = 2; // (coroId, value)
export const EV_STALL = 3; // (frames, seconds) — a gap the clock noticed

export function ringCapacity(records = 1024) {
  return HEADER * 4 + records * RECORD * 8;
}

/**
 * Create the two views a ring needs over one SharedArrayBuffer.
 *
 * The indices are Int32 because `Atomics` requires it; the payload is Float64
 * because beats, seconds and coroutine ids all fit and nothing has to be
 * packed.
 */
export function ringViews(sab, records = 1024) {
  return {
    idx: new Int32Array(sab, 0, HEADER),
    data: new Float64Array(sab, HEADER * 4, records * RECORD),
    records,
  };
}

const READ = 0;
const WRITE = 1;

/**
 * Append one record. Returns false if the ring is full.
 *
 * A full ring DROPS rather than blocks. Blocking here would be blocking the
 * audio thread, and the only way to fill 1024 records is a main thread that
 * has not run for a long time — in which case the events are already late and
 * the honest thing is to say so. `EV_STALL` is how the drop is reported.
 */
export function ringPush(ring, type, a, b, c = 0) {
  const w = Atomics.load(ring.idx, WRITE);
  const r = Atomics.load(ring.idx, READ);
  const next = (w + 1) % ring.records;
  if (next === r) return false; // full
  const at = w * RECORD;
  ring.data[at] = type;
  ring.data[at + 1] = a;
  ring.data[at + 2] = b;
  ring.data[at + 3] = c;
  // Release: the payload above must be visible before the index that
  // advertises it.
  Atomics.store(ring.idx, WRITE, next);
  return true;
}

/** Drain everything available, calling `fn(type, a, b, c)` for each. */
export function ringDrain(ring, fn) {
  let r = Atomics.load(ring.idx, READ);
  const w = Atomics.load(ring.idx, WRITE);
  let n = 0;
  while (r !== w) {
    const at = r * RECORD;
    fn(ring.data[at], ring.data[at + 1], ring.data[at + 2], ring.data[at + 3]);
    r = (r + 1) % ring.records;
    n++;
  }
  Atomics.store(ring.idx, READ, r);
  return n;
}
