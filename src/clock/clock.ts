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

  const state = { beat: 0, tempo: 120 };
  const ring = sab ? ringViews(sab, records) : null;

  const dispatch = (type: number, a: number, b: number): void => {
    if (type === EV_METRO) opts.onMetro(a, b);
    else if (type === EV_CLOCK) {
      state.beat = b;
      opts.onClock(a, b);
    } else if (type === EV_STALL) opts.onStall?.(a, b);
  };

  const drain = (): void => {
    if (ring) ringDrain(ring, (t, a, b) => dispatch(t, a, b));
  };

  node.port.onmessage = (e: MessageEvent) => {
    const m = e.data as { t: string; type?: number; a?: number; b?: number; beat?: number; tempo?: number };
    // A wake, because requestAnimationFrame does not run in a hidden or
    // unfocused tab and the audio thread does not stop with it.
    if (m.t === "wake") drain();
    else if (m.t === "event") dispatch(m.type!, m.a!, m.b!);
    else if (m.t === "state") {
      state.beat = m.beat ?? state.beat;
      state.tempo = m.tempo ?? state.tempo;
    }
  };

  // Drained per animation frame rather than on a timer: a frame is when the
  // screen is going to be redrawn anyway, so an event delivered now is seen
  // at the first opportunity and nothing is gained by waking more often.
  let raf = 0;
  let startedAt = ctx.currentTime;
  let beatAtStart = 0;
  const pump = (): void => {
    drain();
    // Advance the mirror between events, so `clock_get_time_beats` is
    // continuous rather than stepping only when something fires.
    state.beat = beatAtStart + ((ctx.currentTime - startedAt) * state.tempo) / 60;
    raf = requestAnimationFrame(pump);
  };
  raf = requestAnimationFrame(pump);

  const send = (m: unknown): void => node.port.postMessage(m);

  return {
    metroStart: (idx, seconds, count, stage) =>
      send({ t: "metro_start", idx, seconds, count, stage }),
    metroStop: (idx) => send({ t: "metro_stop", idx }),
    metroSetTime: (idx, seconds) => send({ t: "metro_set_time", idx, seconds }),
    setTempo: (bpm) => {
      beatAtStart = state.beat;
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
      state.beat = beat;
      state.tempo = 60 / beatDuration;
      send({ t: "source_ref", beat, beatDuration });
    },
    transportStart: () => {
      beatAtStart = 0;
      startedAt = ctx.currentTime;
      state.beat = 0;
      send({ t: "transport_start" });
    },
    transportStop: () => send({ t: "transport_stop" }),
    scheduleSync: (id, beat, offset) => send({ t: "sync", id, beat, offset }),
    scheduleSleep: (id, seconds) => send({ t: "sleep", id, seconds }),
    cancel: (id) => send({ t: "cancel", id }),
    get beat() {
      return state.beat;
    },
    get tempo() {
      return state.tempo;
    },
    destroy() {
      cancelAnimationFrame(raf);
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
