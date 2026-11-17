// E3-02 — the clock, on the audio thread.
//
// This file is the tail of the built worklet script: `tools/build-clock-worklet.mjs`
// concatenates scheduler.js, ring.js and core.js in front of it and strips
// their `export` keywords, because `audioWorklet.addModule()` loads a CLASSIC
// script and an `import` there is a syntax error.
//
// The node is `{numberOfInputs: 1, numberOfOutputs: 0}` and attached to
// nothing. That shape is measured, not guessed (E0-39a):
//
//   * `{inputs: 0, outputs: 0}` THROWS — a node cannot have zero of both.
//   * a node WITH an output is not pulled at all unless its output reaches
//     the destination: 0 calls in 20,678 quanta for `1 out -> gain 0 ->
//     nothing`.
//   * a zero-output node attached to nothing is pulled every single quantum,
//     206,719 of 206,719 over ten minutes, with no `currentFrame` gap.
//
// So the zero-gain keep-alive that clock-timing.md §4.2 called for is both
// impossible for this node and unnecessary.

class NornsClockProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.core = new ClockCore(sampleRate);
    this.metros = new MetroTable();
    this.sched = new ClockScheduler();
    this.ring = opts.sab ? ringViews(opts.sab, opts.records || 1024) : null;
    this.fired = [];
    this.lastFrame = currentFrame;
    this.quantum = 128;
    this.wakeSent = false;

    this.port.onmessage = (e) => this.command(e.data);
    // The port must be started explicitly when a handler is assigned through
    // addEventListener; `onmessage` starts it implicitly. Noted because the
    // other spelling cost a debugging cycle in E0-24.
  }

  command(m) {
    switch (m.t) {
      case "metro_start":
        this.metros.start(m.idx, m.seconds, m.count, m.stage, this.core.time);
        break;
      case "metro_stop":
        this.metros.stop(m.idx);
        break;
      case "metro_set_time":
        this.metros.setTime(m.idx, m.seconds);
        break;
      case "tempo":
        this.core.setTempo(m.bpm, this.core.frames);
        break;
      case "source_ref":
        // An external clock tick. The beat and the rate arrive together;
        // see ClockCore.setSourceReference.
        this.core.setSourceReference(m.beat, m.beatDuration, this.core.frames);
        this.sched.rescheduleSyncEvents(this.core.beat);
        break;
      case "transport_start":
        this.core.start();
        this.sched.resetSyncEvents();
        break;
      case "transport_stop":
        this.core.stop();
        break;
      case "sync":
        this.sched.scheduleSync(m.id, this.core.beat, m.beat, m.offset || 0);
        break;
      case "sleep":
        this.sched.scheduleSleep(m.id, this.core.time, m.seconds);
        break;
      case "cancel":
        this.sched.clear(m.id);
        break;
      case "reschedule":
        this.sched.rescheduleSyncEvents(this.core.beat);
        break;
      default:
        break;
    }
    // Answer state queries straight away: `clock_get_tempo` and
    // `clock_get_time_beats` are synchronous in Lua, so the main thread keeps
    // a mirror and this is what refreshes it.
    if (m.t === "tempo" || m.t === "transport_start" || m.t === "transport_stop") {
      this.port.postMessage({ t: "state", beat: this.core.beat, tempo: this.core.tempo });
    }
  }

  emit(type, a, b, c) {
    if (this.ring && ringPush(this.ring, type, a, b, c)) {
      // Wake the main thread.
      //
      // The ring is drained per animation frame, and `requestAnimationFrame`
      // DOES NOT RUN in a hidden or unfocused tab — measured: a tab that is
      // not fronted produced zero frames in 500 ms. The audio thread keeps
      // counting there (E0-39a: 6m33s hidden at 0.999990x real time), so
      // without this every metro and every clock resume would queue up
      // silently until the tab came back, which is the exact failure the
      // whole frame-counting design exists to avoid.
      //
      // A message is a task, not a frame, so it is delivered either way. One
      // per burst: `wakeSent` is cleared whenever the ring is seen empty.
      if (!this.wakeSent) {
        this.wakeSent = true;
        this.port.postMessage({ t: "wake" });
      }
      return;
    }
    // No ring (no SharedArrayBuffer, so no cross-origin isolation) or the ring
    // is full. postMessage allocates, which is why it is not the first choice,
    // but dropping a metro silently would be worse than a garbage object.
    this.port.postMessage({ t: "event", type, a, b, c });
  }

  process() {
    // `currentFrame` is the only reliable clock in here. The gap between
    // calls is normally exactly one quantum; anything else is a stall, and
    // measuring it rather than assuming 128 is what let E0-39a prove there
    // were none.
    // An empty ring means the main thread has caught up, so the next event
    // may wake it again.
    if (this.ring && Atomics.load(this.ring.idx, 0) === Atomics.load(this.ring.idx, 1)) {
      this.wakeSent = false;
    }

    const delta = currentFrame - this.lastFrame;
    this.lastFrame = currentFrame;
    if (delta > 0 && delta < 4096) this.quantum = delta;

    const gap = this.core.advance(delta > 0 ? delta : this.quantum, Date.now());
    if (gap > 0) this.emit(EV_STALL, gap, this.core.frames, 0);

    this.fired.length = 0;
    this.metros.tick(this.core.time, this.fired);
    for (let i = 0; i < this.fired.length; i += 2) {
      this.emit(EV_METRO, this.fired[i], this.fired[i + 1], 0);
    }

    this.fired.length = 0;
    this.sched.tick(this.core.beat, this.core.time, this.fired);
    for (let i = 0; i < this.fired.length; i++) {
      this.emit(EV_CLOCK, this.fired[i], this.core.beat, 0);
    }

    // Returning true keeps the node alive. It has no outputs, so there is
    // nothing to write and nothing that could make it appear silent.
    return true;
  }
}

registerProcessor("norns-clock", NornsClockProcessor);
