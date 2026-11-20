// E4-09 — the record layout, which is a contract between two files that
// cannot fail loudly.
//
// `src/crone/shim/oracle.cpp` writes the records on the audio thread and
// `src/crone/events.js` reads them on the main thread. They agree on a number
// per type and on which slot holds what. Change one and nothing breaks: a
// tape status is decoded as a vu frame, twelve garbage levels reach
// `_norns.vu`, and the meters move to the wrong music.
//
// So the test reads the C++ and checks it against the JavaScript. It is the
// same principle as tools/extract-api.mjs — do not transcribe what upstream
// maintains — applied to the one table this port maintains itself.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { croneEvents } from "../src/crone/register.js";
import type { Callbacks } from "../src/norns/callbacks.js";
import {
  decodeBatch,
  decodeRecord,
  SLOTS,
  EV_VU,
  EV_TAPE_STATUS,
  EV_TAPE_FILE,
  EV_SOFTCUT_PHASE,
  EV_SOFTCUT_POSITION,
  EV_SOFTCUT_RENDER,
} from "../src/crone/events.js";

const ORACLE = readFileSync(new URL("../src/crone/shim/oracle.cpp", import.meta.url), "utf8");

/** The `enum : int { EV_X = 1, ... }` the audio thread writes. */
function cppTypes(): Record<string, number> {
  const open = ORACLE.indexOf("enum : int {");
  expect(open, "oracle.cpp no longer declares `enum : int {`").toBeGreaterThan(-1);
  const body = ORACLE.slice(open, ORACLE.indexOf("};", open));
  const out: Record<string, number> = {};
  for (const m of body.matchAll(/(EV_[A-Z_]+)\s*=\s*(\d+)/g)) out[m[1]!] = Number(m[2]);
  return out;
}

describe("the record types agree with the audio thread", () => {
  const cpp = cppTypes();
  const js: Record<string, number> = {
    EV_VU,
    EV_TAPE_STATUS,
    EV_TAPE_FILE,
    EV_SOFTCUT_PHASE,
    EV_SOFTCUT_POSITION,
    EV_SOFTCUT_RENDER,
  };

  it("names the same six types", () => {
    expect(Object.keys(cpp).sort()).toEqual(Object.keys(js).sort());
  });

  for (const [name, value] of Object.entries(js)) {
    it(`${name} is ${value} on both sides`, () => {
      expect(cpp[name]).toBe(value);
    });
  }

  it("uses the same record width", () => {
    // `constexpr int SLOTS = 16;` — a mismatch here shifts every record
    // after the first, so the first one decodes correctly and the rest do
    // not, which is the hardest shape of this bug to see.
    const m = ORACLE.match(/constexpr int SLOTS\s*=\s*(\d+)/);
    expect(m, "oracle.cpp no longer declares SLOTS").not.toBeNull();
    expect(Number(m![1])).toBe(SLOTS);
  });
});

describe("decoding", () => {
  const record = (...v: number[]) => {
    const r = new Float32Array(SLOTS);
    r.set(v);
    return r;
  };

  it("reads a vu frame as twelve levels, in order", () => {
    const r = record(EV_VU, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
    expect(decodeRecord(r)).toEqual({ type: "vu", levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
  });

  it("keeps softcut voices 0-based", () => {
    // The +1 for Lua happens once, in callbacks.ts. Doing it here as well
    // would address the wrong voice, and six voices means it would usually
    // still be a voice that exists.
    expect(decodeRecord(record(EV_SOFTCUT_PHASE, 0, 0.25))).toEqual({
      type: "softcutPhase",
      voice: 0,
      value: 0.25,
    });
  });

  it("reads tape status as six fields, not five", () => {
    const r = record(EV_TAPE_STATUS, 1, 2.5, 60, 0, 0, 1);
    expect(decodeRecord(r)).toEqual({
      type: "tapeStatus",
      playState: 1,
      playPos: 2.5,
      playLen: 60,
      recState: 0,
      recPos: 0,
      loop: 1,
    });
  });

  it("returns null for a type it does not know", () => {
    // A record this build has no shape for is a version skew between the
    // wasm and this file. Inventing a shape would hand Lua garbage; null
    // drops it, and the drop is visible because the batch is shorter.
    expect(decodeRecord(record(99, 1, 2))).toBeNull();
  });

  it("decodes a batch in arrival order and skips the unknown", () => {
    const batch = new Float32Array(SLOTS * 3);
    batch.set(record(EV_SOFTCUT_PHASE, 0, 0.1), 0);
    batch.set(record(99), SLOTS);
    batch.set(record(EV_TAPE_FILE, 1), SLOTS * 2);
    const out = decodeBatch(batch);
    expect(out.map((e) => e.type)).toEqual(["softcutPhase", "tapeFile"]);
  });

  it("ignores a trailing partial record rather than reading past it", () => {
    const batch = new Float32Array(SLOTS + 3);
    batch.set(record(EV_SOFTCUT_POSITION, 2, 0.5), 0);
    batch[SLOTS] = EV_VU; // the start of a record that was never finished
    expect(decodeBatch(batch)).toHaveLength(1);
  });
});

// E9-174 — twenty a second, for a tape that is not running.
//
// `MixerClient.cpp:62` polls the tape every 50 ms whether or not
// anything is playing, and every one of those crossed into Lua. On a
// Pixel 9 Pro running `molly_the_poly` — which has no tape in it at all
// — that came to 105 ms over 1559 calls, the same cost as rendering the
// whole grid, spent reporting six numbers that never changed.
describe("the tape poll that never stops", () => {
  function listening() {
    const seen: number[][] = [];
    const cb = {
      tapeStatus: (...a: number[]) => void seen.push(a),
    } as unknown as Callbacks;
    return { seen, events: croneEvents(cb) };
  }

  const still = { playState: 0, playPos: 0, playLen: 0, recState: 0, recPos: 0, loop: 0 };

  it("passes the first reading through", () => {
    const h = listening();
    h.events.tapeStatus?.(still);
    expect(h.seen).toHaveLength(1);
  });

  it("drops a reading identical to the last one", () => {
    const h = listening();
    for (let i = 0; i < 40; i++) h.events.tapeStatus?.(still);
    expect(h.seen, "two seconds of a stopped tape is one call").toHaveLength(1);
  });

  it("passes anything that actually moved", () => {
    const h = listening();
    h.events.tapeStatus?.(still);
    h.events.tapeStatus?.({ ...still, playPos: 1 });
    h.events.tapeStatus?.({ ...still, playPos: 2 });
    expect(h.seen.map((a) => a[1])).toEqual([0, 1, 2]);
  });

  // Each field on its own, because a dedupe that misses one reports a
  // tape as stopped while it is recording.
  it("notices every field", () => {
    for (const k of ["playState", "playPos", "playLen", "recState", "recPos", "loop"] as const) {
      const h = listening();
      h.events.tapeStatus?.(still);
      h.events.tapeStatus?.({ ...still, [k]: 1 });
      expect(h.seen, `${k} was dropped`).toHaveLength(2);
    }
  });

  // A consumer that has reset its own state is waiting to be told where
  // the tape is, and this file cannot know whether there is one.
  it("says it again anyway, every two seconds", () => {
    vi.useFakeTimers();
    try {
      const h = listening();
      h.events.tapeStatus?.(still);
      vi.advanceTimersByTime(1900);
      h.events.tapeStatus?.(still);
      expect(h.seen, "not yet").toHaveLength(1);
      vi.advanceTimersByTime(200);
      h.events.tapeStatus?.(still);
      expect(h.seen, "the heartbeat").toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
