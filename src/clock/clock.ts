// E3-01 / E3-04 / E3-05 / E3-10 — the clock, from the main thread's side.
//
// Two backends behind one interface:
//
//   * `createWorkletClock` — the real one. An AudioWorkletNode counting
//     `currentFrame`, a SharedArrayBuffer ring back, drained per animation
//     frame.
//   * `createManualClock` — the same scheduler and metro table driven by an
//     explicit `step()`. Not a mock: it is the SAME code, which is what makes
//     a test about scheduling meaningful. What it does not test is whether the
//     audio thread is pulled, and that is E0-39a's job, already measured.
//
// `clock_get_tempo` and `clock_get_time_beats` are SYNCHRONOUS in Lua, so the
// main thread keeps a mirror of beat and tempo rather than asking the worklet
// and waiting. The mirror is advanced from `AudioContext.currentTime`, which
// is the same clock the worklet counts, so it cannot drift from it by more
// than a quantum.

import { ClockCore } from "./core.js";
import { ClockScheduler, MetroTable } from "./scheduler.js";
import { ringViews, ringDrain, ringCapacity, EV_METRO, EV_CLOCK, EV_STALL } from "./ring.js";

export interface ClockEvents {
  /** Both 0-based here; the callback layer adds the 1. */
  onMetro(idx: number, stage: number): void;
  onClock(coroId: number, beat: number): void;
  /** Wall time that passed with no audio behind it — a suspension (E3-07). */
  onStall?(seconds: number, frames: number): void;
  /**
   * Metro ticks thrown away because the main thread was asleep (E9-182).
   *
   * The opposite stall from `onStall`: there, audio time stopped while
   * wall time ran; here, the audio thread kept perfect time and nobody
   * was listening. Reported rather than silent, because a script that
   * skipped forty steps should say so.
   */
  onBacklog?(dropped: number, gapMs: number): void;
  /**
   * How long a metro tick or a clock resume took to get here (E9-200).
   *
   * The worklet stamps each event with the audio time of the block it
   * fired in, and this is `ctx.currentTime` minus that when it is about
   * to be handed to Lua. It moves in steps of one block, so it is a
   * count of blocks that went by rather than a fine delay — which is
   * the right unit: a sequencer step delivered two blocks late is heard
   * as five milliseconds of swing nobody asked for.
   *
   * Only called when given, and only `?profile` gives it.
   */
  onLate?(ms: number, type: number): void;
}

export interface Clock {
  metroStart(idx: number, seconds: number, count: number, stage: number): void;
  metroStop(idx: number): void;
  metroSetTime(idx: number, seconds: number): void;
  setTempo(bpm: number): void;
  /**
   * Follow an external clock: `clock_update_source_reference`.
   *
   * Both halves together, because an external clock says where the beat is
   * as well as how fast it is going.
   */
  setSourceReference(beat: number, beatDuration: number): void;
  transportStart(): void;
  transportStop(): void;
  scheduleSync(coroId: number, beat: number, offset: number): void;
  scheduleSleep(coroId: number, seconds: number): void;
  cancel(coroId: number): void;
  /** What `clock_get_time_beats` returns. */
  readonly beat: number;
  readonly tempo: number;
  destroy(): void;
}

// --------------------------------------------------------------- worklet ---

export interface WorkletClockOptions extends ClockEvents {
  readonly context: AudioContext;
  /** Where `npm run clock` wrote the processor. */
  readonly moduleUrl?: string;
  readonly records?: number;
}

export async function createWorkletClock(opts: WorkletClockOptions): Promise<Clock> {
  const ctx = opts.context;
  const records = opts.records ?? 1024;
  await ctx.audioWorklet.addModule(opts.moduleUrl ?? "/clock-processor.js");

  // SharedArrayBuffer needs cross-origin isolation. Without it the processor
  // falls back to postMessage, which allocates on the audio thread — worse,
  // but a working clock beats no clock, and the fallback is visible here
  // rather than silent.
  let sab: SharedArrayBuffer | null = null;
  if (typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated) {
    sab = new SharedArrayBuffer(ringCapacity(records));
  }

  const node = new AudioWorkletNode(ctx, "norns-clock", {
    // Measured in E0-39a: {0,0} throws, and a zero-output node attached to
    // nothing is pulled every quantum. See processor.js.
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: { sab, records },
  });

  const state = { tempo: 120 };
  const ring = sab ? ringViews(sab, records) : null;

  /**
   * E9-181 — THE BEAT IS COMPUTED ON READ, NOT ADVANCED IN A FRAME.
   *
   * `clock_get_time_beats` is synchronous in Lua, so this mirror exists
   * instead of asking the worklet and waiting. It used to be a stored
   * number recomputed inside the animation-frame pump, which made every
   * beat in every script depend on the page being painted. Measured
   * with the tab behind another in the same pane:
   *
   *     ctx.currentTime   +5.011 s over 5.003 s of wall time
   *     clock.beat        +0.000
   *     rAF               0 frames in 8 s
   *
   * The audio thread kept perfect time and the mirror was frozen at
   * whatever instant the tab lost focus — so `clock.sync` in a running
   * script was computing against a stopped clock, silently, for as long
   * as the tab stayed behind. `document.hidden` was FALSE throughout,
   * which is the same lie `startAudio` was caught by in E9-16x.
   *
   * `ctx.currentTime` is the clock the worklet counts and it never
   * stops, so there is nothing to keep in step and nothing to pump.
   */
  let startedAt = ctx.currentTime;
  let beatAtStart = 0;
  const beatNow = (): number =>
    beatAtStart + ((ctx.currentTime - startedAt) * state.tempo) / 60;

  const dispatch = (type: number, a: number, b: number, firedAt = 0): void => {
    // E9-200 — BEFORE the callback, so what is measured is the delivery
    // and not the delivery plus whatever Lua then did with it.
    if (firedAt > 0 && opts.onLate !== undefined && type !== EV_STALL) {
      opts.onLate((ctx.currentTime - firedAt) * 1000, type);
    }
    if (type === EV_METRO) opts.onMetro(a, b);
    // The beat carried by EV_CLOCK is the beat the event was SCHEDULED
    // for, which is behind `ctx.currentTime` by however long delivery
    // took. Re-anchoring to it would step the mirror backwards, so the
    // reading stays derived and this is passed through unused.
    else if (type === EV_CLOCK) opts.onClock(a, b);
    else if (type === EV_STALL) opts.onStall?.(a, b);
  };

  /**
   * E9-182 — A BACKLOG IS NOT REPLAYED, IT IS CAUGHT UP WITH.
   *
   * When the main thread stops taking events out, the audio thread does
   * not stop putting them in: it keeps perfect time whether or not
   * anybody is listening. Everything that accumulated used to be
   * delivered in one go the moment the page came back, so a 20 Hz metro
   * asleep for ten seconds fired two hundred callbacks inside a single
   * millisecond — reported from a real session as a pile of sound
   * being unstacked at speed on return, which is exactly what it is.
   *
   * Replaying is the wrong answer musically AND semantically. A
   * sequencer should be where it would have been, not play the last ten
   * seconds in one burst. So for each metro only the LAST tick in the
   * batch is delivered: `stage` is carried by the event, so the script
   * lands on the step it would have reached rather than on the step it
   * left.
   *
   * ONLY AFTER A REAL GAP. A drain every 16 ms legitimately carries two
   * ticks of a 100 Hz metro, and coalescing those would halve a rate the
   * script asked for. `STALL_MS` is far longer than any interval this is
   * called at, so an ordinary batch is delivered whole.
   *
   * CLOCK RESUMES ARE NEVER DROPPED. A coroutine waiting on
   * `clock.sleep` has exactly one resume scheduled at a time — it cannot
   * pile up — and discarding one would hang that coroutine for the rest
   * of the session.
   */
  const STALL_MS = 500;
  const now = (): number =>
    typeof performance !== "undefined" ? performance.now() : Date.now();
  let lastDrainAt = now();
  const batch: Array<[number, number, number, number]> = [];

  const drain = (): void => {
    if (!ring) return;
    const at = now();
    const gap = at - lastDrainAt;
    lastDrainAt = at;
    if (gap <= STALL_MS) {
      ringDrain(ring, (t, a, b, c) => dispatch(t, a, b, c));
      return;
    }
    batch.length = 0;
    ringDrain(ring, (t, a, b, c) => void batch.push([t, a, b, c]));
    // Where each metro index last appears, so everything before it is
    // known to be superseded before anything is delivered.
    const lastOf = new Map<number, number>();
    for (let i = 0; i < batch.length; i++) {
      const ev = batch[i]!;
      if (ev[0] === EV_METRO) lastOf.set(ev[1], i);
    }
    let dropped = 0;
    for (let i = 0; i < batch.length; i++) {
      const ev = batch[i]!;
      if (ev[0] === EV_METRO && lastOf.get(ev[1]) !== i) {
        dropped++;
        continue;
      }
      dispatch(ev[0], ev[1], ev[2], ev[3]);
    }
    batch.length = 0;
    if (dropped > 0) opts.onBacklog?.(dropped, gap);
  };

  node.port.onmessage = (e: MessageEvent) => {
    const m = e.data as { t: string; type?: number; a?: number; b?: number; c?: number; beat?: number; tempo?: number };
    // A wake, because requestAnimationFrame does not run in a hidden or
    // unfocused tab and the audio thread does not stop with it.
    if (m.t === "wake") drain();
    else if (m.t === "event") dispatch(m.type!, m.a!, m.b!, m.c ?? 0);
    else if (m.t === "state") {
      // The worklet's own answer to a tempo or transport message this
      // side just sent, so it RE-ANCHORS the mirror rather than being
      // stored beside it: `beatNow` derives everything from the anchor,
      // and a number written anywhere else would be overwritten by the
      // next read. One message hop of lateness, which is 0.01 beats at
      // 120 BPM, against a mirror that would otherwise never be
      // corrected by the thread that actually counts.
      if (m.beat !== undefined) {
        beatAtStart = m.beat;
        startedAt = ctx.currentTime;
      }
      state.tempo = m.tempo ?? state.tempo;
    }
  };

  // Drained per animation frame because a frame is when the screen is going
  // to be redrawn anyway, so an event delivered now is seen at the first
  // opportunity.
  let raf = 0;
  const pump = (): void => {
    drain();
    raf = requestAnimationFrame(pump);
  };
  raf = requestAnimationFrame(pump);

  /**
   * E9-181 — AND A TIMER BEHIND BOTH OF THEM.
   *
   * There were two ways for a pushed event to reach Lua: the frame pump
   * above, and the `wake` message the processor posts on the first push
   * of a burst. Both were measured failing together in a background
   * tab — zero frames in eight seconds, and zero metro callbacks at
   * 20 Hz, while `ctx.currentTime` advanced 5.011 s over 5.003 s of
   * wall time and the ring filled behind them.
   *
   * A timer is throttled in a hidden page — Chrome gives it about one
   * wake-up a second — so this does NOT make a background tab punctual
   * and nothing on the main thread can, because that is where Lua runs.
   * What it does is turn "never" into "about once a second", which is
   * the difference between a script that resumes when you come back and
   * one that has to be restarted.
   *
   * 16 ms matches the `refresh` interval in `main.ts` and matron's own
   * screen thread. `drain` on an empty ring is two `Atomics.load`, so
   * the redundant case costs nothing worth measuring.
   */
  const DRAIN_MS = 16;
  const drainTimer: ReturnType<typeof setInterval> = setInterval(drain, DRAIN_MS);

  const send = (m: unknown): void => node.port.postMessage(m);

  return {
    metroStart: (idx, seconds, count, stage) =>
      send({ t: "metro_start", idx, seconds, count, stage }),
    metroStop: (idx) => send({ t: "metro_stop", idx }),
    metroSetTime: (idx, seconds) => send({ t: "metro_set_time", idx, seconds }),
    setTempo: (bpm) => {
      // Read at the OLD tempo before changing it: re-anchoring is what
      // stops every past second being recounted at the new rate.
      beatAtStart = beatNow();
      startedAt = ctx.currentTime;
      state.tempo = bpm;
      send({ t: "tempo", bpm });
    },
    setSourceReference: (beat, beatDuration) => {
      // The mirror is re-anchored to the SAME values the worklet is about to
      // take, so `clock_get_time_beats` on the main thread does not report
      // the old position for the quantum it takes the message to arrive.
      beatAtStart = beat;
      startedAt = ctx.currentTime;
      state.tempo = 60 / beatDuration;
      send({ t: "source_ref", beat, beatDuration });
    },
    transportStart: () => {
      beatAtStart = 0;
      startedAt = ctx.currentTime;
      send({ t: "transport_start" });
    },
    transportStop: () => send({ t: "transport_stop" }),
    scheduleSync: (id, beat, offset) => send({ t: "sync", id, beat, offset }),
    scheduleSleep: (id, seconds) => send({ t: "sleep", id, seconds }),
    cancel: (id) => send({ t: "cancel", id }),
    get beat() {
      return beatNow();
    },
    get tempo() {
      return state.tempo;
    },
    destroy() {
      cancelAnimationFrame(raf);
      clearInterval(drainTimer);
      node.port.onmessage = null;
      node.disconnect();
    },
  };
}

// ---------------------------------------------------------------- manual ---

export interface ManualClock extends Clock {
  /** Advance by `frames` and deliver whatever that makes due. */
  step(frames: number, wall?: number): void;
  /** Advance by seconds, in whole quanta, as the audio thread would. */
  advanceSeconds(seconds: number, quantum?: number): void;
  readonly time: number;
}

export function createManualClock(opts: ClockEvents & { sampleRate?: number }): ManualClock {
  const sampleRate = opts.sampleRate ?? 48000;
  const core = new ClockCore(sampleRate);
  const metros = new MetroTable();
  const sched = new ClockScheduler();
  const fired: number[] = [];
  let wall = Date.now();

  const step = (frames: number, w = (wall += (frames / sampleRate) * 1000)): void => {
    const gap = core.advance(frames, w);
    if (gap > 0) opts.onStall?.(gap, core.frames);

    fired.length = 0;
    metros.tick(core.time, fired);
    for (let i = 0; i < fired.length; i += 2) opts.onMetro(fired[i]!, fired[i + 1]!);

    fired.length = 0;
    sched.tick(core.beat, core.time, fired);
    for (const id of fired) opts.onClock(id, core.beat);
  };

  return {
    step,
    advanceSeconds(seconds, quantum = 128) {
      const total = Math.round(seconds * sampleRate);
      for (let done = 0; done < total; done += quantum) {
        step(Math.min(quantum, total - done));
      }
    },
    metroStart: (idx, seconds, count, stage) => void metros.start(idx, seconds, count, stage, core.time),
    metroStop: (idx) => void metros.stop(idx),
    metroSetTime: (idx, seconds) => void metros.setTime(idx, seconds),
    setTempo: (bpm) => core.setTempo(bpm, core.frames),
    setSourceReference: (beat, beatDuration) => {
      core.setSourceReference(beat, beatDuration, core.frames);
      sched.rescheduleSyncEvents(core.beat);
    },
    transportStart: () => {
      core.start();
      sched.resetSyncEvents();
    },
    transportStop: () => core.stop(),
    scheduleSync: (id, beat, offset) => void sched.scheduleSync(id, core.beat, beat, offset),
    scheduleSleep: (id, seconds) => void sched.scheduleSleep(id, core.time, seconds),
    cancel: (id) => sched.clear(id),
    get beat() {
      return core.beat;
    },
    get tempo() {
      return core.tempo;
    },
    get time() {
      return core.time;
    },
    destroy() {},
  };
}
