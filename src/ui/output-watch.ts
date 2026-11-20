/**
 * E9-166 — WHERE THE SOUND STOPS, FROM INSIDE THE AUDIO THREAD.
 *
 * Three rounds of "there is no sound" were spent narrowing by hand what
 * this file answers in one line, and the measurement it uses had been
 * arriving every 50 ms the whole time with nobody reading it.
 *
 * `MixerClient.cpp:21` polls twelve peaks and `crone.poll("vu", true)`
 * has been asking for them since E4-14. They are taken INSIDE the audio
 * worklet, at the points that matter:
 *
 *     0,1   in        the ADC
 *     2,3   out       what leaves the mixer for the speakers
 *     4,5   engine    scsynth, as crone receives it
 *     6,7   monitor
 *     8,9   softcut
 *     10,11 tape
 *
 * `engine` against `out` is the whole of the question that took three
 * rounds. An engine that is producing while the output is flat is the
 * mixer eating it; an engine at zero while a script says it is playing
 * is scsynth never reaching crone — the re-route in `main.ts` walks a
 * snapshot, and a node that was not in it is connected to nothing.
 * Neither could be told from the other, from a log, by anybody.
 *
 * IT ONLY SPEAKS WHEN THE NUMBERS CONTRADICT EACH OTHER. A quiet script
 * is not a fault and there is no way to know from here what a script
 * MEANT to do, so silence alone is never reported as a problem. What is
 * reported is a stage that is producing into a stage that is not — which
 * cannot be anything but broken — and, separately and in plain words,
 * the fact that nothing has left the mixer for a long time while a
 * script is loaded. That second one is an observation, worded as one.
 */

/** Twelve peaks, 0..64, as `o_poll_callback_vu` sends them. */
export interface VuWindow {
  inMax: number;
  outMax: number;
  engMax: number;
  monMax: number;
  cutMax: number;
  tapeMax: number;
  /** How many polls went into this window. */
  polls: number;
}

export function emptyVu(): VuWindow {
  return { inMax: 0, outMax: 0, engMax: 0, monMax: 0, cutMax: 0, tapeMax: 0, polls: 0 };
}

const pairMax = (l: readonly number[], a: number, b: number): number =>
  Math.max(Number(l[a]) || 0, Number(l[b]) || 0);

/**
 * Fold one poll into a running window.
 *
 * A reading that is not twelve numbers is DROPPED rather than guessed
 * at: the order is the whole meaning here, and a short array would
 * silently shift `engine` into `monitor` and report the opposite of the
 * truth.
 */
export function foldVu(into: VuWindow, levels: readonly number[]): boolean {
  if (levels.length !== 12) return false;
  into.inMax = Math.max(into.inMax, pairMax(levels, 0, 1));
  into.outMax = Math.max(into.outMax, pairMax(levels, 2, 3));
  into.engMax = Math.max(into.engMax, pairMax(levels, 4, 5));
  into.monMax = Math.max(into.monMax, pairMax(levels, 6, 7));
  into.cutMax = Math.max(into.cutMax, pairMax(levels, 8, 9));
  into.tapeMax = Math.max(into.tapeMax, pairMax(levels, 10, 11));
  into.polls++;
  return true;
}

/** The twelve peaks as one readable clause, for the diagnosis block. */
export function describeVu(w: VuWindow): string {
  return (
    `in ${w.inMax}, engine ${w.engMax}, softcut ${w.cutMax}, ` +
    `tape ${w.tapeMax}, monitor ${w.monMax} → out ${w.outMax} (of 64)`
  );
}

/**
 * What a window says went wrong, or null when it says nothing.
 *
 * `scriptLoaded` gates the quiet case only. The contradictions below are
 * faults whether or not a script is running — a mixer that eats its own
 * input is broken at idle too.
 */
export interface Verdict {
  /**
   * What KIND of trouble this is, for rate limiting.
   *
   * E9-172 — SEPARATE FROM THE SENTENCE, because the sentence carries
   * an elapsed time and so is never equal to the last one. The caller
   * compared whole strings and its thirty-second quiet period
   * therefore never once applied: a log from a silent `amen` carries
   * fifty copies of the same finding, three seconds apart, and one
   * from `mlr` — which is a live looper and legitimately silent until
   * something is fed to it — carries a dozen.
   */
  readonly kind: "stopped" | "mixer-eats-it" | "nothing-arrives";
  readonly line: string;
}

export function judgeVu(w: VuWindow, scriptLoaded: boolean, quietForMs: number): Verdict | null {
  if (w.polls === 0) {
    return {
      kind: "stopped",
      line: "audio: crone has stopped reporting its levels — the audio thread may be gone",
    };
  }
  // A stage producing into an output that is flat. There is no reading of
  // this that is not a fault.
  if (w.outMax === 0) {
    const sources: string[] = [];
    if (w.engMax > 0) sources.push(`engine ${w.engMax}`);
    if (w.cutMax > 0) sources.push(`softcut ${w.cutMax}`);
    if (w.tapeMax > 0) sources.push(`tape ${w.tapeMax}`);
    if (sources.length > 0) {
      return {
        kind: "mixer-eats-it",
        line:
          `audio: ${sources.join(", ")} of 64 reaching the mixer and NOTHING leaving it — ` +
          `the mixer is not passing it through (level_ext, level_dac, or the output stage)`,
      };
    }
    if (scriptLoaded && quietForMs >= 15000) {
      return {
        kind: "nothing-arrives",
        line:
          `audio: nothing has reached the mixer for ${(quietForMs / 1000).toFixed(0)} s ` +
          `with a script loaded — engine, softcut and tape are all flat. A script that ` +
          `plays nothing until you feed it, like a live looper, looks exactly like this.`,
      };
    }
  }
  return null;
}
