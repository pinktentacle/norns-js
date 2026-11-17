// The record layout crone's audio thread writes and the main thread reads.
//
// Plain JavaScript and no imports, for the same reason as src/clock/ring.js:
// this file is concatenated into a classic AudioWorklet script AND imported
// by the main thread and by tests. One definition, three readers.
//
// The numbers here are the other half of a pair. `src/crone/shim/oracle.cpp`
// holds the first half, and changing one without the other does not fail —
// it reinterprets a payload. A tape status becomes a vu frame, silently. So
// both sides name the types rather than writing `case 2:`, and the test in
// test/crone-events.test.ts reads the C++ and checks they still agree.

export const EV_VU = 1;
export const EV_TAPE_STATUS = 2;
export const EV_TAPE_FILE = 3;
export const EV_SOFTCUT_PHASE = 4;
export const EV_SOFTCUT_POSITION = 5;
export const EV_SOFTCUT_RENDER = 6;

/** Floats per record. 16 because `vu` carries twelve levels in one. */
export const SLOTS = 16;

/**
 * Turn one record into something named.
 *
 * `r` is a Float32Array view of SLOTS floats. The return is `null` for a type
 * this build does not know, which is deliberate: an unknown type is a version
 * skew between the wasm and this file, and inventing a shape for it would
 * hand Lua twelve arguments of garbage rather than nothing.
 */
export function decodeRecord(r) {
  switch (r[0]) {
    case EV_VU:
      // Twelve separate levels, in matron's order: in, out, engine, monitor,
      // cut, tape — left then right for each. `_norns.vu` takes them as
      // twelve arguments, not a table (weaver.cc, w_handle_poll_io_levels).
      return { type: "vu", levels: [r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12]] };
    case EV_TAPE_STATUS:
      return {
        type: "tapeStatus",
        playState: r[1] | 0,
        playPos: r[2],
        playLen: r[3],
        recState: r[4] | 0,
        recPos: r[5],
        loop: r[6] | 0,
      };
    case EV_TAPE_FILE:
      // A TYPE, not a name: 0 = play_close, 1 = rec_close.
      return { type: "tapeFile", kind: r[1] | 0 };
    case EV_SOFTCUT_PHASE:
      // 0-based here. The +1 for Lua happens once, in callbacks.ts, and
      // doing it twice is the kind of bug that shows up as a grid light in
      // the wrong row three stories later.
      return { type: "softcutPhase", voice: r[1] | 0, value: r[2] };
    case EV_SOFTCUT_POSITION:
      return { type: "softcutPosition", voice: r[1] | 0, value: r[2] };
    case EV_SOFTCUT_RENDER:
      return {
        type: "softcutRender",
        channel: r[1] | 0,
        secPerSample: r[2],
        start: r[3],
        count: r[4] | 0,
      };
    default:
      return null;
  }
}

/** Every record in a drained batch, in order. */
export function decodeBatch(records) {
  const out = [];
  for (let i = 0; i + SLOTS <= records.length; i += SLOTS) {
    const ev = decodeRecord(records.subarray(i, i + SLOTS));
    if (ev !== null) out.push(ev);
  }
  return out;
}
