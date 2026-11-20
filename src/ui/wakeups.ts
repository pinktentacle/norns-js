/**
 * E9-182 — IS THIS PAGE BEING WOKEN OFTEN ENOUGH TO KEEP TIME?
 *
 * The decision to stop the sound, kept apart from the page so it can be
 * tested. It stops an instrument mid-performance, which is the kind of
 * thing that must not be able to misfire, and the path it lives on
 * cannot be exercised from a browser pane: nothing there can make
 * `document.hidden` true.
 *
 * WHY NOT JUST READ `document.hidden`. Because it is the wrong signal
 * and the measurement says so. In this app's own browser pane, with the
 * tab behind another:
 *
 *     requestAnimationFrame    0 per second
 *     setInterval(16 ms)       62.5 per second — not throttled at all
 *     metro at 20 Hz           160 callbacks in 8.02 s, exact
 *     document.hidden          false
 *
 * A page that is not painted can be perfectly punctual, and stopping
 * that one would be a fault rather than a kindness. A page the browser
 * has genuinely hidden is throttled to roughly one wake-up a second,
 * and twenty metro ticks a second cannot be delivered by a thread that
 * wakes once — so what matters is the RATE, which is a measurement,
 * rather than the flag, which is a guess about one.
 *
 * It only ever decides once per spell of being hidden. A page that is
 * throttled produces a slow tick every time it is allowed to wake, and
 * suspending an already-suspended context on each of them would be a
 * log line a second saying the same thing.
 */

export interface WakeupWatch {
  /** The page went away. Start timing how often we are let back in. */
  away(atMs: number): void;
  /**
   * One watch tick, from a timer of the caller's choosing.
   *
   * Returns the gap that proved the page is too slow — a number to put
   * in the log — or null, which is every ordinary tick.
   */
  tick(atMs: number): number | null;
  /**
   * The page is back. Returns true when the sound was stopped and has
   * to be started again, false when nothing was ever stopped.
   */
  back(): boolean;
  /** Whether a tick would do anything. */
  readonly watching: boolean;
  /** Whether this watch believes the sound is currently stopped. */
  readonly stopped: boolean;
}

/**
 * @param thresholdMs A tick slower than this means the page is being
 * throttled. 600 ms sits well above any interval worth driving this
 * with and well under the ~1 s a hidden page is held to.
 */
export function createWakeupWatch(thresholdMs = 600): WakeupWatch {
  let watching = false;
  let stopped = false;
  let last = 0;

  return {
    away(atMs) {
      // Re-arming mid-spell must not re-decide: `stopped` is deliberately
      // left alone, so a second `visibilitychange` to hidden cannot stop
      // an already-stopped context again.
      watching = true;
      last = atMs;
    },
    tick(atMs) {
      if (!watching) return null;
      const gap = atMs - last;
      last = atMs;
      if (gap < thresholdMs) return null;
      // Decided. One spell of being away, one decision.
      watching = false;
      if (stopped) return null;
      stopped = true;
      return gap;
    },
    back() {
      watching = false;
      if (!stopped) return false;
      stopped = false;
      return true;
    },
    get watching() {
      return watching;
    },
    get stopped() {
      return stopped;
    },
  };
}
