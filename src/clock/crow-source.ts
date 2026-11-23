// E9-206 — crow as the clock source.
//
// `clock/clock_crow.c`, transcribed. norns asks crow to say `^^change(1,1)`
// on every rising edge at its first input (`norns.crow.clock_enable`), and
// matron — not Lua — watches the lines for it: each one is a pulse, the
// time between two is a fraction of a beat, and the clock is told where the
// beat is and how long one lasts.
//
// THE SAME SHAPE AS `midi-source.ts`, which is `clock_midi.c`: a short
// running mean of beat durations, and a reference of beat and duration
// handed on. What differs is what the file differs in — four durations
// rather than twenty-four, a division that can be set (`crow_in_div`,
// pulses to a beat, four until told otherwise), and no start or stop: a
// pulse train has no transport.
//
// A GAP OF MORE THAN FOUR SECONDS A BEAT IS A CLOCK THAT STOPPED, exactly
// as there: the pulse is taken as a new first one and no tempo is drawn
// from the silence.

import type { ClockReference } from "./midi-source.js";

const DURATION_BUFFER_LENGTH = 4;
const STOPPED_BEAT_DURATION = 4;

/** What matron looks for in a line from crow. */
export const CROW_PULSE = "^^change(1,1)";

export class CrowClockSource {
  private counter = 0;
  private lastTime = 0;
  private lastTimeSet = false;
  private readonly durations = new Float64Array(DURATION_BUFFER_LENGTH);
  private pos = 0;
  private len = 0;
  private meanScale = 1;
  private meanSum = 0;
  private div = 4;

  constructor(private readonly onReference: (ref: ClockReference) => void = () => {}) {}

  /** `clock_crow_in_div` — pulses to a beat. */
  setDiv(div: number): void {
    if (div > 0) this.div = div;
  }

  /** A line from crow: is it a pulse? `now` in seconds. */
  line(text: string, now: number): boolean {
    if (!text.includes(CROW_PULSE)) return false;
    this.pulse(now);
    return true;
  }

  /** `clock_crow_handle_clock`. */
  pulse(now: number): void {
    if (!this.lastTimeSet) {
      this.lastTimeSet = true;
      this.lastTime = now;
      return;
    }
    const beatDuration = (now - this.lastTime) * this.div;
    if (beatDuration > STOPPED_BEAT_DURATION) {
      this.lastTime = now;
      return;
    }
    if (this.len < DURATION_BUFFER_LENGTH) {
      this.len++;
      this.meanScale = 1 / this.len;
    }
    const a = beatDuration * this.meanScale;
    this.meanSum = this.meanSum + a - this.durations[this.pos]!;
    this.durations[this.pos] = a;
    this.pos = (this.pos + 1) % DURATION_BUFFER_LENGTH;
    this.counter++;
    this.lastTime = now;
    if (this.meanSum > 0) {
      this.onReference({ beat: this.counter / this.div, beatDuration: this.meanSum });
    }
  }

  get tempo(): number {
    return this.meanSum > 0 ? 60 / this.meanSum : 0;
  }

  get beat(): number {
    return this.counter / this.div;
  }
}
