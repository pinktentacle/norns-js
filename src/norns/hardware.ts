// E5-24 — the seven that are about the machine norns is running on.
//
// `platform`, `platform_factory`, `platform_shield`, `adc_rev`, `gain_hp`,
// `audio_get_cpu_load`, `audio_get_xrun_count`. None of them is a capability
// we lacked; each is a DECISION about what to answer, and answering nothing
// was not neutral — two of them are called from a menu page that then does
// arithmetic on the answer.
//
// WHAT WE SAY WE ARE. `norns.lua:208-219` turns these three into
// `norns.platform`, `norns.is_norns` and `norns.is_shield`, and scripts
// branch on them (`wrms/lib/globals.lua:1`). A browser is none of the five
// platforms upstream knows, so the honest value is `PLATFORM_OTHER`, which
// upstream itself defines for "a Pi that is not one of ours". That makes
// `platform_factory()` false, and `platform_shield()` false with it.
//
// Shield was the answer here for a long time, on the reasoning that a
// shield is a norns somebody assembled on other hardware. The reasoning
// held and the consequence did not: `norns.is_shield` is read in exactly
// one place, the wording of the sleep screen (sleep.lua:23), where it says
// "when the not-red light stops blinking, disconnect power" — advice about
// an LED and a power supply, given to somebody looking at a web page. False
// on both is the honest pair, and it is what `src/api/stubs.ts` documented
// all along.
//
// WHY `adc_rev` IS 0, AND IT MATTERS. `norns.lua:140` reads it to pick an
// encoder handler: `_norns.adc_rev()==1` gives `process`, anything else gives
// `process_with_accel`. On a shield `i2c_init` returns early without ever
// setting a revision, so `adc_rev()` is 0 and a shield has acceleration.
// Returning 0 keeps the behaviour the page already had — and now says so on
// purpose rather than by the accident of a stub returning nil.

import type { NornsRegistry } from "./registry.js";

/** `platform.h:9-17`. The browser is OTHER, for the reasons in the header. */
export const PLATFORM = {
  UNKNOWN: 0,
  OTHER: 1,
  CM3: 2,
  PI3: 3,
  PI4: 4,
  CM4: 5,
  CM4S: 6,
} as const;

export interface HardwareOptions {
  /**
   * The audio thread's cost over the last window, if anything is measuring
   * it. `audio_get_cpu_load` is a PERCENT on hardware (jack's), so the mean
   * block time is scaled by the block budget.
   */
  readonly load?: () => { meanMs: number; budgetMs: number } | null;
  readonly log?: (line: string) => void;
}

export interface Hardware {
  /**
   * Record dropouts the audio thread reported since the last window.
   *
   * They ACCUMULATE here and are cleared by a read, because that is what
   * `jack_client_get_xrun_count` does: `atomic_exchange(&xrun_count, 0)` —
   * the count since you last asked, not the count ever. `menu/home.lua`
   * depends on the difference: it shows "!!!" for four frames whenever the
   * answer is above zero, which only stops blinking because the counter
   * resets.
   */
  noteXruns(n: number): void;
}

export function registerHardware(registry: NornsRegistry, opts: HardwareOptions = {}): Hardware {
  const log = opts.log ?? ((): void => {});
  let xruns = 0;

  registry.implement("platform", () => [PLATFORM.OTHER]);
  registry.implement("platform_factory", () => [false]);
  /**
   * Not a shield either, and that is a correction.
   *
   * This answered true, which made `norns.is_shield` true, which is read in
   * exactly one place: the wording of the sleep screen (sleep.lua:23). So
   * pressing SLEEP in a browser tab said "when the not-red light stops
   * blinking, disconnect power" — advice about an LED and a power supply
   * that are not there, given to somebody looking at a web page. False is
   * the honest answer to "is this a DIY norns on a Raspberry Pi", and it
   * also matches what `src/api/stubs.ts` has documented all along.
   */
  registry.implement("platform_shield", () => [false]);
  registry.implement("adc_rev", () => [0]);

  /**
   * The headphone amplifier's gain.
   *
   * On a factory norns this is an i2c write to the TPA6130 and the value is
   * 0-63; `audio.lua:141` passes whatever the `headphone gain` param holds.
   * There is no amplifier here, and no browser API that moves the output
   * device's volume — that is the user's control, not ours, and a page that
   * could turn the system volume up would be a page nobody should run. So
   * the value is KEPT and reported, which is what makes the param behave
   * (it reads back, it saves into a PSET, the menu shows it) without
   * pretending to an effect it does not have.
   */
  let hpGain = 0;
  registry.implement("gain_hp", (level) => {
    const v = Math.max(0, Math.min(63, Math.round(Number(level ?? 0))));
    if (v !== hpGain) {
      hpGain = v;
      // Once per change, not per call: `params:bang()` sets every param on
      // every script load and the line would be noise.
      log(`audio: headphone gain ${v} (no amplifier here — the system volume is yours)`);
    }
  });

  /**
   * CPU load and xruns, from the audio thread rather than from jack.
   *
   * `menu/home.lua:55` does `math.floor(_norns.audio_get_cpu_load())` and
   * line 57 compares the xrun count to zero — so a stub that pushed nothing
   * made that page raise "bad argument #1 to 'floor' (number expected, got
   * no value)" the moment it was opened. That is the bug this closes; the
   * numbers being real is the bonus.
   *
   * crone already measures what jack reports: the mean time a block took
   * against the budget it had, and the count of blocks that missed it. A
   * missed block IS an xrun — the same dropout, named by whoever noticed.
   */
  registry.implement("audio_get_cpu_load", () => {
    const l = opts.load?.();
    if (!l || l.budgetMs <= 0) return [0];
    return [Math.max(0, Math.min(100, (l.meanMs / l.budgetMs) * 100))];
  });
  registry.implement("audio_get_xrun_count", () => {
    const n = xruns;
    xruns = 0;
    return [n];
  });

  return {
    noteXruns(n: number): void {
      if (n > 0) xruns += n;
    },
  };
}
