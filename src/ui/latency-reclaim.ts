/**
 * E9-202 — LATENCY AN UNDERRUN LEFT BEHIND, GIVEN BACK WHEN NOBODY IS LISTENING.
 *
 * A Pixel announced 29 ms from the graph to the speaker and measured 52.
 * Both were right. With an AudioWorklet, Chromium's device thread pulls
 * from a FIFO the worklet thread fills, and every underrun of that FIFO
 * raises the amount kept in it by one device callback, for good
 * (`PushPullFIFO::PullAndUpdateEarmarkedFrames`). `outputLatency` is the
 * device and one callback; only `playbackStats` sees the FIFO. Five
 * underruns while booting, five milliseconds each, and the instrument is
 * 25 ms later for the rest of the session — under every key, whatever
 * the page does.
 *
 * `suspend()` then `resume()` restarts the destination and the margin
 * with it. Measured on a desktop with the same path forced: 82.7 ms,
 * three underruns, 112.6 ms and staying there, 82.6 ms after.
 *
 * THE MARGIN IS ALSO WHAT ABSORBS THE NEXT LATE BLOCK. So this never
 * takes it back while a script plays: an underrun mid-performance bought
 * that margin and keeps it. It is given back at the two moments where a
 * gap cannot be heard and time has nothing to stay in step with — once
 * the boot has gone quiet, and when norns clears a script.
 *
 * IT DECIDES ON THE LATENCY, NOT ON THE COUNT. Every start of the output
 * is itself counted as three or four underruns that leave nothing
 * behind, so a count above zero says nothing. What says something is
 * the measured figure standing well above what the device accounts for —
 * or above what this very machine measured after an earlier restart.
 *
 * AND IT CHECKS ITS OWN WORK. Where a restart gains nothing, one attempt
 * says so and there is no second.
 */

import type { PlaybackReading } from "./probe.js";

export interface ReclaimSources {
  /** Milliseconds, monotonic. */
  now(): number;
  /** Null where the browser does not count underruns: then nothing is ever done. */
  playback(): PlaybackReading | null;
  /** Start the browser's latency average again. */
  resetLatency(): void;
  /** `AudioContext.state`. */
  state(): string;
  hidden(): boolean;
  suspend(): Promise<unknown>;
  resume(): Promise<unknown>;
  /** One device callback in milliseconds — `baseLatency`. */
  periodMs(): number;
  /** `outputLatency` in milliseconds; 0 until the browser knows. */
  deviceMs(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** The output did not come back by itself; `false` when it finally has. */
  stuck(waiting: boolean): void;
}

export type ReclaimVerdict = "untried" | "works" | "useless";

export interface Reclaim {
  /** Every level reading: was anything on the output? */
  heard(loud: boolean): void;
  /** norns printed `# script clear`. The first is its own startup. */
  scriptCleared(): void;
  /** Try now, whatever the moment. For a console and for the tests. */
  force(): Promise<void>;
  readonly verdict: ReclaimVerdict;
  readonly busy: boolean;
  /** How many times the output was stopped and started. */
  readonly attempts: number;
}

/** How long the output has to stay flat after the boot before it counts as over. */
export const QUIET_MS = 1500;
/** How long a stop or a start may take before it is called stuck. */
export const SETTLE_MS = 1500;
/** After the restart: let it count its own start and find its level, then measure. */
export const AFTER_WAIT_MS = 2000;
export const AFTER_MEASURE_MS = 1500;
/** How often the underrun count is looked at. Levels arrive twenty times a second. */
export const LOOK_EVERY_MS = 1000;

const ms1 = (v: number): string => v.toFixed(1);

export function createReclaim(src: ReclaimSources): Reclaim {
  let verdict: ReclaimVerdict = "untried";
  let busy = false;
  let attempts = 0;
  /** The underrun count when the output last settled. Nothing new, nothing to take. */
  let baseline = 0;
  /** The last count seen, to notice a new one. */
  let seen = 0;
  /** What this machine measured after a restart that worked, in ms. */
  let clean: number | null = null;
  let bootSeen = false;
  let quietArmed = false;
  let quietFrom = 0;
  let lookedAt = -Infinity;

  const settles = async (want: string, within: number): Promise<boolean> => {
    const deadline = src.now() + within;
    while (src.now() < deadline) {
      if (src.state() === want) return true;
      await src.sleep(25);
    }
    return src.state() === want;
  };

  /**
   * Bring it back, and do not leave until it is.
   *
   * NOTHING AWAITS `resume()` — see `ensureRunning` in the engine host:
   * Chrome leaves that promise pending for ever when it wants a gesture.
   * A page that had sound and lost it to its own housekeeping would be
   * the worst thing this file could do, so a start that does not take is
   * said out loud and asked again on every touch.
   */
  const bringBack = async (): Promise<void> => {
    const ask = (): void => void Promise.resolve(src.resume()).catch(() => {});
    ask();
    if (await settles("running", SETTLE_MS)) return;
    src.log("audio: the output was stopped to take back latency and has not restarted by itself — touch the page");
    src.stuck(true);
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    for (const e of events) globalThis.addEventListener?.(e, ask, true);
    try {
      while (src.state() !== "running") {
        ask();
        await src.sleep(250);
      }
    } finally {
      for (const e of events) globalThis.removeEventListener?.(e, ask, true);
      src.stuck(false);
    }
  };

  /**
   * How far above an honest figure the output stands, in ms. Null when
   * the browser has not said enough yet.
   *
   * Before anything has been measured here the honest figure is the
   * device's own plus two callbacks: one the FIFO starts with, one for
   * the 8 ms the browser rounds `outputLatency` to. Read on a desktop
   * with the FIFO forced: 2.7 to 22.4 ms over the device when clean,
   * 32.6 to 45 when three underruns had been left in it.
   */
  const excess = (p: PlaybackReading): number | null => {
    const avg = p.averageLatency * 1000;
    if (!(avg > 0)) return null;
    if (clean !== null) return avg - clean;
    const device = src.deviceMs();
    if (!(device > 0)) return null;
    return avg - (device + 2 * src.periodMs());
  };

  /** "later" only when the browser could not say yet: the moment is kept. */
  const attempt = async (): Promise<"done" | "later"> => {
    if (busy || verdict === "useless") return "done";
    const before = src.playback();
    if (before === null) return "done";
    if (src.state() !== "running" || src.hidden()) return "done";
    if (before.underrunEvents - baseline <= 0) return "done";
    const over = excess(before);
    if (over === null) return "later";
    if (over < Math.max(src.periodMs(), 4)) return "done";

    busy = true;
    attempts++;
    try {
      // A stop that hangs is still followed by a start.
      await Promise.race([Promise.resolve(src.suspend()).catch(() => {}), src.sleep(SETTLE_MS)]);
      await bringBack();

      await src.sleep(AFTER_WAIT_MS);
      src.resetLatency();
      const mid = src.playback();
      await src.sleep(AFTER_MEASURE_MS);
      const after = src.playback();
      if (mid === null || after === null) return "done";
      // The browser counts the stop and the start as underruns. They are ours.
      baseline = after.underrunEvents;
      seen = baseline;
      const own = mid.underrunEvents - before.underrunEvents;
      const ownMs = (mid.underrunDuration - before.underrunDuration) * 1000;
      const counted = `the restart itself is counted as ${own} underrun(s), ${ownMs.toFixed(0)} ms`;

      const was = before.averageLatency * 1000;
      const is = after.averageLatency * 1000;
      if (!(is > 0)) {
        src.log(`audio: output restarted to take back latency; the browser gave no figure after it — ${counted}`);
        return "done";
      }
      const gained = was - is;
      if (gained >= Math.max(2, 0.4 * src.periodMs())) {
        verdict = "works";
        clean = clean === null ? is : Math.min(clean, is);
        src.log(
          `audio: underruns had left the output ${ms1(was)} ms late; restarting it gave ` +
            `${ms1(gained)} ms back — ${ms1(is)} ms now, from the graph to the speaker (${counted})`,
        );
      } else if (after.underrunEvents > mid.underrunEvents) {
        // Late blocks while measuring: the figure says nothing either way.
        src.log(
          `audio: output restarted to take back latency, and it underran again at once ` +
            `(${ms1(was)} ms before, ${ms1(is)} ms now) — ${counted}`,
        );
      } else {
        verdict = "useless";
        src.log(
          `audio: restarting the output gave nothing back on this machine ` +
            `(${ms1(was)} ms before, ${ms1(is)} ms after) — it will not be tried again (${counted})`,
        );
      }
      return "done";
    } finally {
      busy = false;
    }
  };

  return {
    heard(loud: boolean): void {
      const now = src.now();
      // A new underrun starts the average again, so that what is read
      // before a restart is the latency SINCE it, not a mean across it.
      if (!busy && now - lookedAt >= LOOK_EVERY_MS) {
        lookedAt = now;
        const p = src.playback();
        if (p !== null && p.underrunEvents !== seen) {
          seen = p.underrunEvents;
          src.resetLatency();
        }
      }
      if (!quietArmed || busy) return;
      if (loud) quietFrom = now;
      if (now - quietFrom < QUIET_MS) return;
      quietArmed = false;
      void attempt().then((r) => {
        // The browser had no figure yet. Still the boot: ask again
        // shortly. "later" is answered before anything is awaited, so no
        // script change can have come in between; the next one disarms.
        if (r === "later") {
          quietArmed = true;
          quietFrom = src.now() - QUIET_MS + LOOK_EVERY_MS;
        }
      });
    },
    scriptCleared(): void {
      if (!bootSeen) {
        // norns' own startup. The chime comes next: wait for it to end.
        bootSeen = true;
        quietArmed = true;
        quietFrom = src.now();
        return;
      }
      quietArmed = false;
      void attempt();
    },
    force: async () => void (await attempt()),
    get verdict() {
      return verdict;
    },
    get busy() {
      return busy;
    },
    get attempts() {
      return attempts;
    },
  };
}
