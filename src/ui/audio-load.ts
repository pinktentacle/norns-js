/**
 * E9-183 — THE AUDIO THREAD'S OWN COST, FOLDED OVER A PHASE.
 *
 * The first `_bench` baseline reported `metro 1 ms over 80` for a phase
 * running six softcut voices — the phase timer and nothing else. Six
 * voices measured as free, because every clock in `call-cost.ts` is on
 * the main thread and softcut is not. For a port whose first priority
 * is sound that was the largest hole in the coverage: the instruments
 * measured everything except the thing being optimised for.
 *
 * NOTHING NEW IS MEASURED HERE. crone has timed its own `process()` since
 * E4-14 and reports `blocks / meanMs / maxMs / over / budgetMs` about
 * once a second; scsynth has answered `/status` with its own averaged
 * and peak load since E9-112. Both went into one snapshot variable that
 * `?diagnose` printed and the phase marks never saw. This folds them
 * over a span instead, the same way `output-watch.ts` folds the VU, so
 * a phase can say what it cost the audio thread rather than what it
 * cost the one that was not doing the work.
 *
 * MEAN AND WORST ARE BOTH KEPT, and the worst is the one that matters.
 * A block that misses its deadline is a dropout you can hear; a mean
 * comfortably under budget with a worst over it is exactly the shape of
 * a page that clicks once a second, and a mean alone cannot show it.
 * `over` is crone's own count of those, so it is a fact rather than an
 * inference from the maximum.
 */

export interface AudioLoadWindow {
  /** Blocks crone reported in the span. */
  blocks: number;
  /** Sum of mean x blocks, so the span's mean is an average of work, not of readings. */
  msWeighted: number;
  /** Worst single block in the span. */
  maxMs: number;
  /** Blocks that missed the deadline. Each one is audible. */
  over: number;
  /** One quantum of real time: the deadline every block has. */
  budgetMs: number;
  /** How many `onLoad` reports went in. Zero means crone never spoke. */
  reports: number;
  /** scsynth's own averaged load, highest seen, as a percentage. */
  scAvgMax: number;
  /** scsynth's own peak load, highest seen, as a percentage. */
  scPeakMax: number;
  /** How many `/status` replies went in. */
  scReads: number;
  /**
   * crone timed itself with `Date` rather than `performance.now()`,
   * because Chrome's AudioWorkletGlobalScope has no high-resolution
   * clock (E9-183). The mean survives; the worst block does not.
   */
  coarse: boolean;
}

export function emptyAudioLoad(): AudioLoadWindow {
  return {
    blocks: 0,
    msWeighted: 0,
    maxMs: 0,
    over: 0,
    budgetMs: 0,
    reports: 0,
    scAvgMax: 0,
    scPeakMax: 0,
    scReads: 0,
    coarse: false,
  };
}

/** One of crone's load reports. The shape `CroneLoad` already has. */
export interface CroneReport {
  readonly blocks: number;
  readonly meanMs: number;
  readonly maxMs: number;
  readonly over: number;
  readonly budgetMs: number;
  readonly coarse?: boolean;
}

/**
 * Fold one crone report into a window.
 *
 * A report with no blocks in it is DROPPED: crone sends one on the way
 * up before it has rendered anything, and folding it would put a
 * `budgetMs` in the window with no work behind it, which reads as a
 * phase that ran and cost nothing.
 */
export function foldCrone(into: AudioLoadWindow, r: CroneReport): boolean {
  if (!(r.blocks > 0) || !Number.isFinite(r.meanMs)) return false;
  into.blocks += r.blocks;
  into.msWeighted += r.meanMs * r.blocks;
  into.maxMs = Math.max(into.maxMs, r.maxMs);
  into.over += r.over;
  if (r.budgetMs > 0) into.budgetMs = r.budgetMs;
  // Sticky: one coarse report in a window makes the whole window's worst
  // block untrustworthy, and the qualification has to travel with it.
  if (r.coarse === true) into.coarse = true;
  into.reports++;
  return true;
}

/** Fold one `/status.reply` from scsynth. */
export function foldScsynth(into: AudioLoadWindow, avgCpu: number, peakCpu: number): boolean {
  if (!Number.isFinite(avgCpu) || !Number.isFinite(peakCpu)) return false;
  into.scAvgMax = Math.max(into.scAvgMax, avgCpu);
  into.scPeakMax = Math.max(into.scPeakMax, peakCpu);
  into.scReads++;
  return true;
}

/** The span's mean block, or 0 when nothing was reported. */
export function meanBlockMs(w: AudioLoadWindow): number {
  return w.blocks > 0 ? w.msWeighted / w.blocks : 0;
}

/**
 * What the audio thread cost, in one clause.
 *
 * SILENCE IS NAMED. A window with no reports in it is not "0 ms": it is
 * an instrument that did not report, and the two look identical in every
 * reading that rounds them both to a number. The whole of E9-180 was one
 * of those being mistaken for the other.
 */
export function describeAudioLoad(w: AudioLoadWindow): string {
  const parts: string[] = [];
  if (w.reports === 0) {
    parts.push("crone has not reported");
  } else {
    const mean = meanBlockMs(w);
    const share = w.budgetMs > 0 ? ` (${((mean / w.budgetMs) * 100).toFixed(0)}% of it)` : "";
    // A coarse window has no worst block to report and says so, rather
    // than printing a zero that reads like a measurement.
    const worst = w.coarse ? "worst block not measurable" : `${w.maxMs.toFixed(2)} ms worst`;
    const over = w.coarse ? `at least ${w.over} over budget` : `${w.over} over budget`;
    parts.push(
      `crone ${mean.toFixed(2)} ms mean, ${worst} ` +
        `of ${w.budgetMs.toFixed(2)} ms a block${share}, ` +
        `${w.blocks} block(s), ${over}`,
    );
  }
  parts.push(
    w.scReads === 0
      ? "scsynth has not answered /status"
      : `scsynth ${w.scAvgMax.toFixed(0)}% avg, ${w.scPeakMax.toFixed(0)}% peak`,
  );
  return parts.join(" · ");
}
