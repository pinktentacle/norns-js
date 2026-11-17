// E3-09 — MIDI clock as a source. A port of `clocks/clock_midi.cc`.
//
// A MIDI clock is 24 pulses per quarter note and nothing else: no tempo
// number is ever transmitted, only ticks, so the tempo has to be MEASURED
// from the gaps between them. That measurement is the whole of this file,
// and the awkward parts of it are upstream's, kept because the feel of
// following an external clock is exactly the feel of how it is smoothed.
//
// THE ROLLING MEAN IS 24 TICKS — one beat. Shorter and the tempo wobbles
// with every jittery tick; longer and it lags behind a real tempo change.
// `clock_midi.cc` keeps an incremental mean rather than re-summing: each
// tick's contribution is added and the one 24 ticks ago is subtracted. That
// is reproduced here including its quirk — the scale factor is recomputed
// only while the buffer is still filling, so the first 24 ticks are a mean
// over however many have arrived.
//
// A GAP LONGER THAN FOUR SECONDS IS NOT A TEMPO. `beat_duration > 4` means
// the sending device stopped without saying so, and upstream re-anchors the
// time and discards the interval instead of concluding that the tempo is
// 15 bpm. Without that, unplugging a drum machine mid-bar leaves norns
// crawling until the next tick arrives.
//
// THE COUNTER STARTS AT -1 ON 0xFA. `clock_midi_handle_start` sets it so
// that the FIRST tick after a start increments it to 0, and the check
// `counter == 0` then fires `clock_start_from_source` — the transport
// starts on the first tick, not on the start byte, which is what keeps it
// aligned with the sender's first beat.

/** The reference a tick produces: where the beat is, and how long one takes. */
export interface ClockReference {
  readonly beat: number;
  readonly beatDuration: number;
}

export interface MidiClockSourceEvents {
  /** Every tick, once there is enough history to say anything. */
  onReference?(ref: ClockReference): void;
  /** The first tick after a start byte. `clock_start_from_source`. */
  onStart?(): void;
  /** A stop byte. `clock_stop_from_source`. */
  onStop?(): void;
}

const DURATION_BUFFER_LENGTH = 24;

/** Longer than this between ticks and the sender is assumed to have stopped. */
const STOPPED_BEAT_DURATION = 4;

export class MidiClockSource {
  private counter = 0;
  private lastTickTime = 0;
  private lastTickTimeSet = false;
  private readonly durations = new Float64Array(DURATION_BUFFER_LENGTH);
  private pos = 0;
  private len = 0;
  private meanScale = 1;
  private meanSum = 0;

  constructor(private readonly events: MidiClockSourceEvents = {}) {}

  /** `clock_midi_handle_message`. `now` is seconds, monotonic. */
  handle(byte: number, now: number): void {
    switch (byte) {
      case 0xfa:
        // Start. Note what it does NOT do: it does not reset the duration
        // history, so a restart keeps the tempo it had learned.
        this.counter = -1;
        break;
      case 0xf8:
        this.tick(now);
        break;
      case 0xfc:
        this.events.onStop?.();
        break;
      default:
        break;
    }
  }

  private tick(now: number): void {
    if (!this.lastTickTimeSet) {
      // The first tick only establishes a time. There is no interval yet,
      // and inventing one would put a wrong tempo on the first beat.
      this.lastTickTimeSet = true;
      this.lastTickTime = now;
      return;
    }

    const beatDuration = (now - this.lastTickTime) * 24;
    if (beatDuration > STOPPED_BEAT_DURATION) {
      this.lastTickTime = now;
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
    this.lastTickTime = now;

    const referenceBeat = this.counter / 24;
    if (this.meanSum > 0) {
      this.events.onReference?.({ beat: referenceBeat, beatDuration: this.meanSum });
    }
    // AFTER the reference, as upstream does: the transport starts on a clock
    // that already knows where it is.
    if (this.counter === 0) this.events.onStart?.();
  }

  /** The tempo it has measured, or 0 before it has measured one. */
  get tempo(): number {
    return this.meanSum > 0 ? 60 / this.meanSum : 0;
  }

  get beat(): number {
    return this.counter / 24;
  }
}
