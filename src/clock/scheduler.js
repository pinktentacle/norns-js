// E3-04 / E3-05 / E3-06 / E3-08 — norns' metro table and clock scheduler.
//
// Plain JavaScript with no imports, because this file runs in TWO places: the
// AudioWorkletGlobalScope, where `addModule` loads a CLASSIC script and an
// `import` is a syntax error, and Node, where the tests are. The build
// concatenates it into the processor; the tests import it directly. One copy,
// both places — the same argument that kept a single Fengari.
//
// Everything here is a transcription of matron, with the line numbers to diff
// against. Two of them are the whole of E0-39b:
//
//   * a repeating `clock.sync` computes its next target from the **stored**
//     beat, not from the current one (clock_scheduler.cc:171-173). Measured:
//     the naive version drops 10 of 64 grid points at 0-150 ms lateness.
//   * `fmax` is not `Math.max`. C returns the non-NaN argument; JavaScript
//     propagates NaN. `clock.sync(math.huge)` is reachable from Lua — the
//     only guard is `sync_beat <= 0` — and `ceil(x/inf)*inf` is NaN, so the
//     difference is a coroutine that free-runs versus one that hangs for ever.

/** `<float.h>`'s FLT_EPSILON, as the C uses it. */
export const FLT_EPSILON = 1.1920928955078125e-7;

/** C99 fmax: "if one argument is a NaN, the other argument is returned". */
export function fmax(a, b) {
  return Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b);
}

/** clock_scheduler.cc:44-55 */
export function nextClockBeat(clockBeat, syncBeat, offset = 0) {
  let next = Math.ceil((clockBeat + FLT_EPSILON) / syncBeat) * syncBeat;
  next += offset;
  while (next < clockBeat + FLT_EPSILON) next += syncBeat;
  return fmax(next, 0);
}

export const NUM_CLOCK_EVENTS = 100; // clock_scheduler.h:9
export const MAX_NUM_METROS = 36; // metro.cc:25

export const EVENT_SYNC = 1;
export const EVENT_SLEEP = 2;

/** What a tick produced, for the ring to carry to the main thread. */
export const FIRED_METRO = 1;
export const FIRED_CLOCK = 2;

export class ClockScheduler {
  constructor() {
    this.events = [];
    for (let i = 0; i < NUM_CLOCK_EVENTS; i++) {
      // clock_scheduler.cc:127-136 — static storage, so the doubles start 0.
      this.events.push({
        type: 0,
        ready: false,
        threadId: -1,
        syncBeat: 0,
        syncBeatOffset: 0,
        syncClockBeat: 0,
        sleepTime: 0,
        sleepClockTime: 0,
      });
    }
  }

  /** clock_scheduler.cc:64-85 — the coroutine's slot, or the first free one. */
  findEvent(threadId) {
    let result = -1;
    for (let i = 0; i < NUM_CLOCK_EVENTS; i++) {
      if (this.events[i].threadId === threadId) return this.events[i];
      if (this.events[i].threadId === -1 && result < 0) result = i;
    }
    return result > -1 ? this.events[result] : null;
  }

  /** clock_scheduler.cc:159-192 */
  scheduleSync(threadId, clockBeat, syncBeat, offset = 0) {
    const event = this.findEvent(threadId);
    if (event === null) return false;

    if (event.threadId === threadId) {
      event.ready = true;
      event.syncBeat = syncBeat;
      event.syncBeatOffset = offset;
      if (event.type === EVENT_SYNC) {
        // :171-173 — count from the STORED beat when syncing the same
        // coroutine, so a late resume costs a flam and not a dropped step.
        event.syncClockBeat = nextClockBeat(event.syncClockBeat, syncBeat, offset);
      } else {
        // :174-177 — a preceding clock.sleep breaks the chain.
        event.syncClockBeat = nextClockBeat(clockBeat, syncBeat, offset);
        event.type = EVENT_SYNC;
      }
    } else {
      // :178-184 — a fresh slot, or one recycled from a cancelled coroutine.
      // Upstream does NOT assign sync_beat_offset here; reproduced
      // deliberately, because the port's contract is to match. It is a latent
      // upstream bug: a recycled slot inherits the cancelled coroutine's
      // offset and `rescheduleSyncEvents` then applies it.
      event.threadId = threadId;
      event.ready = true;
      event.syncBeat = syncBeat;
      event.syncClockBeat = nextClockBeat(clockBeat, syncBeat, offset);
      event.type = EVENT_SYNC;
    }
    return event.syncClockBeat;
  }

  /** clock_scheduler.cc:194-213 */
  scheduleSleep(threadId, clockTime, seconds) {
    const event = this.findEvent(threadId);
    if (event === null) return false;
    event.ready = true;
    event.threadId = threadId;
    event.sleepTime = seconds;
    event.sleepClockTime = clockTime + seconds;
    event.type = EVENT_SLEEP;
    return event.sleepClockTime;
  }

  /** The beat a coroutine's next sync is aimed at. Used by the tests. */
  findEventBeat(threadId) {
    const e = this.findEvent(threadId);
    return e ? e.syncClockBeat : NaN;
  }

  /** :215-226 — leaves `type` and `syncClockBeat` behind, deliberately. */
  clear(threadId) {
    for (const e of this.events) {
      if (e.threadId === threadId) {
        e.ready = false;
        e.threadId = -1;
      }
    }
  }

  /** :239-255 — on a clock SOURCE change. */
  rescheduleSyncEvents(clockBeat) {
    for (const e of this.events) {
      if (e.ready && e.type === EVENT_SYNC) {
        e.syncClockBeat = nextClockBeat(clockBeat, e.syncBeat, e.syncBeatOffset);
      }
    }
  }

  /** :257-271 — on transport start. */
  resetSyncEvents() {
    for (const e of this.events) if (e.ready && e.type === EVENT_SYNC) e.syncClockBeat = 0;
  }

  /**
   * One pass of upstream's 1 ms poll loop, clock_scheduler.cc:102-118.
   *
   * Note the asymmetry, which is upstream's and is reproduced: SYNC fires on
   * `>` and SLEEP on `>=`. It is why nothing fires at exactly beat 1.0 for
   * `sync(1)` scheduled at 0.
   */
  tick(clockBeat, clockTime, out) {
    for (const e of this.events) {
      if (!e.ready) continue;
      if (e.type === EVENT_SYNC) {
        if (clockBeat > e.syncClockBeat) {
          e.ready = false;
          out.push(e.threadId);
        }
      } else if (clockTime >= e.sleepClockTime) {
        e.ready = false;
        out.push(e.threadId);
      }
    }
  }
}

/**
 * metro.cc's table of 36.
 *
 * The loop upstream runs is: sleep, then check `stage >= count`, then bang and
 * increment (metro.cc:metro_thread_loop). So the FIRST bang happens one period
 * after the start, with stage 0 — not immediately — and a metro with
 * `count = n` fires exactly n times. Both are easy to get wrong by one.
 *
 * Timing is absolute: upstream takes the current time once and adds the period
 * to it, so a late wake-up does not push the next one later. Accumulating a
 * target rather than scheduling from "now" is what makes a metro not drift.
 */
export class MetroTable {
  constructor() {
    this.slots = [];
    for (let i = 0; i < MAX_NUM_METROS; i++) {
      // metros_init: stopped, and one second until told otherwise.
      this.slots.push({ running: false, seconds: 1.0, count: -1, stage: 0, next: 0 });
    }
  }

  /**
   * metro.cc:71-91. `seconds <= 0` means reuse the previous value, `count < 0`
   * means forever, and `stage` is already 0-based here.
   */
  start(idx, seconds, count, stage, now) {
    if (idx < 0 || idx >= MAX_NUM_METROS) return false;
    const m = this.slots[idx];
    if (seconds > 0.0) m.seconds = seconds;
    m.count = count;
    m.stage = stage > 0 ? stage : 0;
    m.running = true;
    m.next = now + m.seconds; // sleep first, then bang
    return true;
  }

  stop(idx) {
    if (idx < 0 || idx >= MAX_NUM_METROS) return false;
    this.slots[idx].running = false;
    return true;
  }

  /** metro.cc:107-113. Takes effect from the next period. */
  setTime(idx, seconds) {
    if (idx < 0 || idx >= MAX_NUM_METROS) return false;
    this.slots[idx].seconds = seconds;
    return true;
  }

  /**
   * Advance to `now`, appending `[idx, stage]` pairs for everything due.
   *
   * A metro whose period is shorter than the render quantum fires more than
   * once per tick, which is correct and matters: `metro.init(…, 0.001)` is
   * legal on norns and 1 ms is well under one 2.9 ms quantum.
   */
  tick(now, out) {
    for (let i = 0; i < MAX_NUM_METROS; i++) {
      const m = this.slots[i];
      if (!m.running) continue;
      // Bound the catch-up: after a long stall, firing thousands of times
      // would block the audio thread, which is the one thing this design
      // exists to protect.
      let guard = 0;
      while (m.running && now >= m.next && guard++ < 64) {
        if (m.count > 0 && m.stage >= m.count) {
          m.running = false;
          break;
        }
        out.push(i, m.stage);
        m.stage += 1;
        m.next += m.seconds; // absolute, so it cannot drift
      }
      // If the guard tripped, the metro is hopelessly behind; resynchronise
      // to now rather than spending the next several ticks catching up.
      if (guard >= 64) m.next = now + m.seconds;
    }
  }
}
