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
   * The most synths and unit generators scsynth held at once (E9-200).
   * A load with no count beside it cannot be divided: 30% for two voices
   * and 30% for thirty are different problems.
   */
  scSynthsMax: number;
  scUgensMax: number;
  /**
   * Blocks that measured 0, 1, 2, 3 and 4+ whole milliseconds, summed.
   * E9-197 — the shape the mean hides, and the only thing a 1 ms clock
   * can report without a verdict attached.
   */
  hist: number[];
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
    scSynthsMax: 0,
    scUgensMax: 0,
    coarse: false,
    hist: [0, 0, 0, 0, 0],
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
  readonly hist?: readonly number[];
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
  if (r.hist !== undefined) {
    for (let i = 0; i < into.hist.length; i++) {
      into.hist[i] = (into.hist[i] ?? 0) + Number(r.hist[i] ?? 0);
    }
  }
  into.reports++;
  return true;
}

/** Fold one `/status.reply` from scsynth. */
export function foldScsynth(
  into: AudioLoadWindow,
  avgCpu: number,
  peakCpu: number,
  synths = 0,
  ugens = 0,
): boolean {
  if (!Number.isFinite(avgCpu) || !Number.isFinite(peakCpu)) return false;
  into.scAvgMax = Math.max(into.scAvgMax, avgCpu);
  into.scPeakMax = Math.max(into.scPeakMax, peakCpu);
  if (Number.isFinite(synths)) into.scSynthsMax = Math.max(into.scSynthsMax, synths);
  if (Number.isFinite(ugens)) into.scUgensMax = Math.max(into.scUgensMax, ugens);
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
    // NOT "at least", which is what this said and which is false. A 1 ms
    // clock turns a true 2.1 ms block into a measured 3 about a tenth of
    // the time, and a true 2.8 into a measured 2 about a fifth of it, so
    // the count both invents and misses. It is a signal that there are
    // long blocks, never a count of dropouts.
    const over = w.coarse
      ? `${w.over} over budget by a 1 ms clock, which misses some and invents others`
      : `${w.over} over budget`;
    // E9-197 — and the shape, which is the honest half of all this. The
    // zero bucket is left out of the printed list when it holds nearly
    // everything, because "2998 blocks under a millisecond" is the
    // uninteresting part of every healthy reading; what wants reading is
    // the tail beside it.
    const h = w.hist;
    const counted = h.reduce((a, b) => a + b, 0);
    // WHERE THERE IS A HISTOGRAM, IT REPLACES THE VERDICT. `over` is a
    // judgement this clock cannot reach; the buckets are the same data
    // with nothing claimed about it, and printing both made a line
    // nobody would read to the end.
    const shape =
      counted === 0
        ? over
        : `blocks at 0/1/2/3/4+ ms: ${h.join("/")}` +
          (h.slice(1).reduce((a, b) => a + b, 0) === 0 ? " — all under a millisecond" : "");
    parts.push(
      `crone ${mean.toFixed(2)} ms mean, ${worst} ` +
        `of ${w.budgetMs.toFixed(2)} ms a block${share}, ` +
        `${w.blocks} block(s), ${shape}`,
    );
  }
  parts.push(
    w.scReads === 0
      ? "scsynth has not answered /status"
      : `scsynth ${w.scAvgMax.toFixed(0)}% avg, ${w.scPeakMax.toFixed(0)}% peak` +
          (w.scSynthsMax > 0 || w.scUgensMax > 0
            ? `, up to ${w.scSynthsMax} synth(s) and ${w.scUgensMax} ugen(s)`
            : ""),
  );
  return parts.join(" · ");
}
