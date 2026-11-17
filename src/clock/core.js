// E3-02 / E3-07 — the clock itself: frames in, beats out.
//
// Plain JavaScript, no imports (see scheduler.js).
//
// The design is E0-39's and it is not a browser workaround. norns' own beat
// clock is counted in audio sample frames: `matron/src/clock.cc` routes
// `clock_get_system_time()` through `jack_frame_time() / sample_rate`. Driving
// this from `currentFrame` is the faithful port; a timer would be the
// deviation.
//
// E0-39a measured what that buys. In a hidden tab a 100 ms `setTimeout` went
// to 294 ms effective with one gap of **18.9 seconds**, while the audio thread
// beside it rendered 6m33s at 0.999990x real time and missed no quantum.
//
// E3-07, the wall-clock witness: `currentFrame` STOPS across a
// `ctx.suspend()` and resumes contiguous, so a clock anchored on frames alone
// cannot tell a suspension from nothing happening. Measured in E0-39a stage 8:
// 0.54 s of audio across 3.52 s of wall time, and the frame sequence
// unbroken. So the core carries `Date.now()` beside the frame counter and
// reports the discrepancy rather than silently swallowing it.

export class ClockCore {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    /** Audio frames since the clock started. */
    this.frames = 0;
    /** Seconds of audio, which is `frames / sampleRate`. */
    this.time = 0;
    /** Beats since the transport started. */
    this.beat = 0;
    this.tempo = 120;
    this.running = true;

    /** The beat and frame the current tempo took effect at. */
    this.refFrame = 0;
    this.refBeat = 0;

    /** Wall clock, for noticing a suspension (E3-07). */
    this.wallStart = 0;
    this.lastWall = 0;
    /** Seconds of wall time unaccounted for by frames. */
    this.stalled = 0;
  }

  /** Seconds per beat, from the current tempo. */
  get beatDuration() {
    return 60 / this.tempo;
  }

  /**
   * Set the tempo without moving the current beat.
   *
   * Beats are derived from frames since a reference, so changing the tempo
   * means re-anchoring: keep the beat we are on, and count forward from here
   * at the new rate. Not re-anchoring would make every past frame count at
   * the new tempo and the beat would jump.
   */
  setTempo(bpm, now = this.frames) {
    if (!(bpm > 0)) return;
    this.refBeat = this.beatAt(now);
    this.refFrame = now;
    this.tempo = bpm;
  }

  /**
   * Put the clock ON an external beat, at an external rate.
   *
   * `clock_update_source_reference` in `matron/src/clock.cc:102`, expressed
   * in the terms this core already uses. matron computes a source's beat as
   *
   *     beat + (now - last_beat_time) / beat_duration
   *
   * and this computes `refBeat + (frame - refFrame) / (beatDuration * sr)`.
   * They are the same formula, so following an external clock is not a new
   * mechanism here -- it is setting all three anchors at once instead of
   * keeping the beat and changing only the rate, which is what `setTempo`
   * does.
   *
   * That difference is the whole point. An external clock says both WHERE
   * the beat is and how fast it is going, and a clock that took only the
   * tempo would run at the right speed next to the drum machine rather than
   * with it.
   */
  setSourceReference(beat, beatDuration, now = this.frames) {
    if (!(beatDuration > 0)) return;
    this.refBeat = beat;
    this.refFrame = now;
    this.tempo = 60 / beatDuration;
    this.beat = beat;
  }

  beatAt(frame) {
    if (!this.running) return this.refBeat;
    return this.refBeat + (frame - this.refFrame) / (this.beatDuration * this.sampleRate);
  }

  /** Transport start: beat 0, counting from here. */
  start() {
    this.refBeat = 0;
    this.refFrame = this.frames;
    this.beat = 0;
    this.running = true;
  }

  stop() {
    this.refBeat = this.beatAt(this.frames);
    this.running = false;
  }

  /**
   * Advance by one render quantum.
   *
   * `wall` is `Date.now()` read on the audio thread — the only wall clock an
   * AudioWorkletGlobalScope has, since `performance` is undefined there
   * (measured in E0-39a across two Chromium builds, and the cause of a false
   * pass in E0-07 before that).
   */
  advance(frames, wall) {
    this.frames += frames;
    this.time = this.frames / this.sampleRate;
    this.beat = this.beatAt(this.frames);

    if (this.wallStart === 0) {
      this.wallStart = wall;
      this.lastWall = wall;
      return 0;
    }

    // How much wall time passed versus how much audio we rendered. A
    // suspension shows up here as wall time with no frames behind it; a
    // quantum of jitter does not, because the comparison is cumulative rather
    // than per-tick.
    const wallElapsed = (wall - this.wallStart) / 1000;
    const drift = wallElapsed - this.time;
    this.lastWall = wall;

    // Half a second is far outside anything scheduling can explain and well
    // inside the 3 s suspension E0-39a used.
    if (drift - this.stalled > 0.5) {
      const gap = drift - this.stalled;
      this.stalled = drift;
      return gap;
    }
    return 0;
  }
}
