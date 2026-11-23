// crone, as an AudioWorkletProcessor.
//
// Plain JavaScript and no imports: `audioWorklet.addModule()` loads a CLASSIC
// script, where an `import` is a syntax error. tools/build-crone-worklet.mjs
// concatenates emscripten's classic glue, events.js and this file into one.
//
// WHERE THE WASM COMES FROM. Not from a fetch and not from base64: an
// AudioWorkletGlobalScope has neither `fetch` nor `atob`. The main thread
// fetches crone.wasm once and hands the bytes over in `processorOptions`,
// which is structured-cloned into this scope before the constructor runs.
// Emscripten takes them straight from `Module.wasmBinary`.
//
// THE NODE'S SHAPE, and why it is two inputs:
//
//   input 0  ext  — the engine (scsynth)
//   input 1  adc  — the hardware in (microphone)
//   output 0 dac  — stereo, to the speakers
//
// That is crone's own topology, not a convenience. `MixerClient` keeps adc
// and ext as separate source buses with separate levels, separate sends to
// softcut and a separate monitor path. Summing them into one input before
// they arrive would make `level_adc` and `level_ext` the same control.

/* global createCroneModule, AudioWorkletProcessor, registerProcessor, sampleRate, currentTime, SLOTS, decodeRecord */

class CroneProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.M = null;
    this.failed = null;
    this.pending = []; // commands that arrived before the module was ready
    this.tapeQueue = []; // {pcm, at} chunks waiting for room in the play ring

    // --- E4-14: what this costs -------------------------------------
    //
    // The only honest place to measure the audio thread is ON it. A
    // `process()` call has a deadline — one quantum of real time, 128
    // frames, 2.67 ms at 48 kHz — and the number that matters is what
    // fraction of that the work takes. Over budget means a dropout.
    //
    // `performance.now()` is not guaranteed in an AudioWorkletGlobalScope,
    // so whether it is there is reported rather than assumed: a measurement
    // that did not happen must not look like a zero.
    //
    // E9-183 — AND IT IS NOT THERE, IN CHROME, WHICH MEANT NO MEASUREMENT
    // AT ALL. Chrome's AudioWorkletGlobalScope exposes `currentFrame`,
    // `currentTime` and `sampleRate` and no clock finer than a quantum,
    // so this has been null since E4-14 and crone has never once reported
    // what it costs. The page said so at boot and nothing else ever
    // mentioned it again, which is how "crone dsp: nothing reported yet"
    // came to read like "not yet" for five releases.
    //
    // `Date` IS in every realm. It has 1 ms resolution against a 2.67 ms
    // budget, which is far too coarse for one block — but it is not
    // biased. `Date.now()` truncates, so a block that really takes 0.4 ms
    // measures 0 or 1 depending on where the millisecond boundary falls,
    // and the block period (2.667 ms) walks around that boundary rather
    // than sitting on it. Summed over a second of blocks the error
    // averages out: 375 samples puts the mean within about 0.03 ms.
    //
    // WHAT IT CANNOT DO is the worst block, which is the number that
    // matters most — a single 4 ms block is a click you can hear and a
    // 1 ms clock cannot resolve it. So `maxMs` is NOT sent when the clock
    // is coarse, rather than sent as a figure that looks like the fine
    // one.
    //
    // `over` SURVIVES AS A SIGNAL AND NOT AS A BOUND, and the first
    // version of this comment claimed otherwise. The arithmetic: a
    // measured delta is floor(t1) - floor(t0), which for a true
    // duration d is either floor(d) or floor(d)+1, the second with
    // probability frac(d). So a block measured at 3 ms may truly have
    // taken 2.1 — under the 2.67 ms budget — and a block that truly
    // took 2.8 may measure 2. The count misses some and invents
    // others; what it cannot do is be large without a real tail
    // reaching the budget. It is read as "there are long blocks here",
    // never as "there were exactly this many dropouts".
    const fine = typeof performance === "object" && typeof performance.now === "function";
    this.coarse = !fine;
    this.clock = fine ? () => performance.now() : () => Date.now();
    this.load = { blocks: 0, total: 0, max: 0, over: 0, since: 0, hist: [0, 0, 0, 0, 0] };
    this.port.onmessage = (e) => this.onMessage(e.data);

    const opts = (options && options.processorOptions) || {};
    const wasmBinary = opts.wasmBinary;
    if (!wasmBinary) {
      this.fail("no wasmBinary in processorOptions");
      return;
    }

    // `sampleRate` is a global in an AudioWorkletGlobalScope and is the
    // context's real rate. Passing it in from the main thread instead would
    // be one more thing that can disagree with the hardware.
    createCroneModule({ wasmBinary })
      .then((M) => this.ready(M, sampleRate))
      .catch((err) => this.fail(String((err && err.message) || err)));
  }

  fail(message) {
    this.failed = message;
    // An audio graph that is silent for a reason should say the reason once.
    // Throwing here would reach the node's `onprocessorerror` as
    // "undefined:undefined: undefined", which E0-37 established tells you
    // nothing at all.
    this.port.postMessage({ type: "error", message });
  }

  ready(M, sr) {
    M._crone_worklet_init(sr);

    const f32 = (ptr, n) => M.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + n);
    // 128 is the quantum. These views are taken ONCE and kept, which is only
    // safe because the build has ALLOW_MEMORY_GROWTH off (ADR-04e): a growth
    // would allocate a new ArrayBuffer and detach every one of them, and a
    // detached view reads as zeros rather than throwing.
    const N = 128;
    this.bufs = {
      adcL: f32(M._crone_adc_left(), N),
      adcR: f32(M._crone_adc_right(), N),
      extL: f32(M._crone_ext_left(), N),
      extR: f32(M._crone_ext_right(), N),
      dacL: f32(M._crone_dac_left(), N),
      dacR: f32(M._crone_dac_right(), N),
    };
    this.events = f32(M._crone_events_buffer(), M._crone_events_capacity() * SLOTS);
    // The tape's staging buffer, shared by both directions. Taken once for
    // the same reason as the audio buffers: the heap never moves.
    this.tapeStageFrames = M._cronejs_tape_stage_frames();
    this.tapeStage = f32(M._cronejs_tape_stage(), this.tapeStageFrames * 2);
    this.capacity = M._crone_events_capacity();
    this.M = M;

    for (const msg of this.pending) this.apply(msg);
    this.pending.length = 0;

    this.port.postMessage({
      type: "ready",
      sampleRate: M._crone_sample_rate(),
      voices: M._crone_num_voices(),
      // Whether the audio thread can time itself at all, and how well.
      // Said out loud so an absent or coarse measurement is never mistaken
      // for a cheap one.
      timed: this.clock !== null,
      coarse: this.coarse,
      // The wasm heap, exactly, rather than the INITIAL_MEMORY the build
      // asked for. E4-14 wants what the page is actually holding.
      heapBytes: M.HEAPU8.byteLength,
    });
  }

  onMessage(msg) {
    if (this.failed) return;
    // A command that arrives before the wasm has finished instantiating is
    // QUEUED, not dropped. norns sets every level during startup, and the
    // module takes a few milliseconds to come up — dropping those would
    // leave the mixer at its defaults with nothing to say so.
    if (!this.M) {
      this.pending.push(msg);
      return;
    }
    this.apply(msg);
  }

  apply(msg) {
    const M = this.M;
    switch (msg.op) {
      case "command": {
        // The entry point is chosen by ARITY and the queue by the generated
        // table on the other side; see src/crone/commands.ts for why neither
        // is decided by hand.
        const fn = `_crone_${msg.queue}_command_${msg.arity}`;
        if (typeof M[fn] !== "function") return this.fail(`no entry point ${fn}`);
        M[fn](msg.id, ...msg.args);
        return;
      }
      case "param": {
        // Names are checked against the generated table BEFORE they get here.
        // crone looks them up with `std::map::at` inside a `try`, and this
        // build has exceptions off, so a wrong name aborts the module rather
        // than printing a line. See research/crone-port.md §3.
        M.ccall(msg.entry, null, msg.types, msg.args);
        return;
      }
      case "filePreload": {
        // The main thread decoded it; this is where it lands in the wasm
        // heap. `cronejs_file_preload` returns 0 when the window is larger
        // than the cap, which is not a failure to report quietly: a script
        // asked for more audio than this build can hold.
        const ptr = M.ccall(
          "cronejs_file_preload",
          "number",
          ["string", "number", "number", "number", "number", "number"],
          [msg.path, msg.channels, msg.rate, msg.totalFrames, msg.firstFrame, msg.frames],
        );
        if (ptr === 0) {
          this.port.postMessage({ type: "filePreloaded", path: msg.path, ok: false });
          return;
        }
        M.HEAPF32.set(msg.pcm, ptr >> 2);
        this.port.postMessage({ type: "filePreloaded", path: msg.path, ok: true });
        return;
      }
      case "fileDrop":
        M.ccall("cronejs_file_drop", null, ["string"], [msg.path]);
        return;
      case "tapeFeed":
        // Queued, not pushed: the ring holds four seconds and a file is
        // longer than that. `topUpTape` moves it across as room appears.
        this.tapeQueue.push({ pcm: msg.pcm, at: 0 });
        return;
      case "tapeReset":
        this.tapeQueue.length = 0;
        return;
      case "poll": {
        // Replied to, unlike the other two. `crone_poll_set` returns 0 for a
        // name no poll has, and a misspelled poll that reports success is a
        // meter that never moves and a morning spent in the wrong file.
        const ok = M.ccall("crone_poll_set", "number", ["string", "number"], [msg.name, msg.on ? 1 : 0]);
        this.port.postMessage({ type: "poll", name: msg.name, on: !!msg.on, ok: ok === 1 });
        return;
      }
      default:
        return this.fail(`unknown op ${msg.op}`);
    }
  }

  /**
   * Drain the poll ring and post one batch.
   *
   * Once per quantum, and only when there is something: in the common
   * quantum this reads one integer and returns. The alternative — a message
   * per callback — allocates on the audio thread at poll rate.
   *
   * The copy is necessary and small: the ring is a view into the wasm heap,
   * which the next block overwrites. `postMessage` would structured-clone it
   * anyway, so the only question is whether the clone sees a consistent
   * snapshot, and copying under the read index is how it does.
   */
  /**
   * Move one block's worth of tape, both ways, and collect a finished write.
   *
   * Separate from `drain` because the poll ring is usually empty and the
   * tape usually is not: folding them into one early-return would stop the
   * tape whenever nothing was polling.
   */
  pump() {
    const M = this.M;

    // Record: out of the ring, into a message. One call is enough — the
    // ring gains 128 frames a block and the stage holds 4096.
    const recFrames = M._cronejs_tape_rec_drain();
    if (recFrames > 0) {
      const pcm = new Float32Array(this.tapeStage.subarray(0, recFrames * 2));
      this.port.postMessage({ type: "tapeData", pcm }, [pcm.buffer]);
    }
    if (M._cronejs_tape_rec_finished() === 1) {
      this.port.postMessage({
        type: "tapeFinished",
        dropped: M._cronejs_tape_rec_dropped(),
      });
    }

    // Play: into the ring, while there is room and anything queued.
    while (this.tapeQueue.length > 0) {
      const space = M._cronejs_tape_play_space();
      if (space <= 0) break;
      const head = this.tapeQueue[0];
      const left = (head.pcm.length - head.at) / 2;
      const n = Math.min(space, this.tapeStageFrames, left);
      if (n <= 0) {
        this.tapeQueue.shift();
        continue;
      }
      this.tapeStage.set(head.pcm.subarray(head.at, head.at + n * 2), 0);
      M._cronejs_tape_play_fill(n);
      head.at += n * 2;
      if (head.at >= head.pcm.length) this.tapeQueue.shift();
    }

    // A finished buffer write, handed back for encoding. At most one per
    // block, which is as fast as they can be produced.
    const written = M.ccall("cronejs_file_finished", "string", [], []);
    if (written !== "") {
      const frames = M.ccall("cronejs_file_frames", "number", ["string"], [written]);
      const channels = M.ccall("cronejs_file_channels", "number", ["string"], [written]);
      const rate = M.ccall("cronejs_file_rate", "number", ["string"], [written]);
      const format = M.ccall("cronejs_file_format", "number", ["string"], [written]);
      const ptr = M.ccall("cronejs_file_data", "number", ["string"], [written]);
      const n = frames * channels;
      const pcm = ptr === 0 ? new Float32Array(0) : new Float32Array(M.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + n));
      // Dropped here, not by the main thread: leaving it would offer the
      // same file again on the next block, for ever.
      M.ccall("cronejs_file_drop", null, ["string"], [written]);
      this.port.postMessage(
        { type: "fileWritten", path: written, pcm, channels, rate, format },
        [pcm.buffer],
      );
    }
  }

  drain() {
    const M = this.M;
    const count = M._crone_events_count();
    if (count === 0) return;
    const tail = M._crone_events_tail();
    const out = new Float32Array(count * SLOTS);
    for (let i = 0; i < count; i++) {
      const src = ((tail + i) % this.capacity) * SLOTS;
      out.set(this.events.subarray(src, src + SLOTS), i * SLOTS);
    }
    M._crone_events_clear();

    // A render carries its samples in a staging buffer of their own, because
    // a waveform preview does not fit in a 16-float record.
    let render = null;
    const rc = M._crone_render_count();
    if (rc > 0) {
      render = new Float32Array(M.HEAPF32.subarray(M._crone_render_buffer() >> 2, (M._crone_render_buffer() >> 2) + rc));
      M._crone_render_clear();
    }

    const msg = { type: "events", records: out, dropped: M._crone_events_dropped() };
    if (render) msg.render = render;
    // Transfer rather than clone: these are freshly allocated here and never
    // read again on this side.
    const transfer = render ? [out.buffer, render.buffer] : [out.buffer];
    this.port.postMessage(msg, transfer);
  }

  process(inputs, outputs) {
    if (!this.M) return true; // still instantiating; a silent block, not a dead node
    const t0 = this.clock === null ? 0 : this.clock();
    const b = this.bufs;
    const out = outputs[0];
    const n = (out && out[0] && out[0].length) || 128;

    // A DISCONNECTED INPUT IS AN EMPTY ARRAY, not an array of zeros. Leaving
    // the previous block's samples in place would make a disconnected engine
    // buzz on 128 frames for ever, which sounds like a stuck note rather
    // than like nothing being connected.
    copyIn(inputs[0], b.extL, b.extR, n);
    copyIn(inputs[1], b.adcL, b.adcR, n);

    this.M._crone_process(n);

    if (out) {
      out[0].set(b.dacL.subarray(0, n));
      if (out[1]) out[1].set(b.dacR.subarray(0, n));
    }

    this.drain();
    this.pump();

    if (this.clock !== null) {
      const ms = this.clock() - t0;
      const budget = (n / sampleRate) * 1000;
      const L = this.load;
      L.blocks++;
      L.total += ms;
      if (ms > L.max) L.max = ms;
      // Counted, not averaged away: one block over budget is one dropout,
      // and a mean of 12% hides a max of 140%.
      if (ms > budget) L.over++;
      // E9-197 — THE SHAPE, WHICH IS WHAT A 1 ms CLOCK CAN HONESTLY GIVE.
      //
      // A mean hides its tail and `over` is a verdict this clock cannot
      // reach: a block that truly took 2.1 ms measures 3 about a tenth of
      // the time and one that truly took 2.8 measures 2 about a fifth. A
      // HISTOGRAM of the measured millisecond is none of those things —
      // it is the raw counts, with no claim attached, and from it the
      // distribution can be read rather than guessed. Five buckets
      // because the budget is 2.67 ms, so 0-1 is comfortable, 2 is the
      // edge and 3+ is a block that was probably late.
      const b = ms < 1 ? 0 : ms < 2 ? 1 : ms < 3 ? 2 : ms < 4 ? 3 : 4;
      L.hist[b]++;
      // Once a second, so the message rate is nothing next to the work.
      if (L.blocks >= sampleRate / n) {
        this.port.postMessage({
          type: "load",
          blocks: L.blocks,
          meanMs: L.total / L.blocks,
          // Withheld rather than guessed at when the clock cannot resolve
          // one block. See the constructor.
          maxMs: this.coarse ? 0 : L.max,
          over: L.over,
          hist: L.hist.slice(),
          budgetMs: budget,
          coarse: this.coarse,
        });
        L.blocks = 0;
        L.total = 0;
        L.max = 0;
        L.over = 0;
        L.hist = [0, 0, 0, 0, 0];
      }
    }

    return true; // crone is always running: it is the mixer, not a voice
  }
}

/** Fill a stereo pair from one worklet input, zeroing what is not connected. */
function copyIn(input, left, right, n) {
  const l = input && input[0];
  const r = input && (input[1] || input[0]);
  if (l) left.set(l.subarray(0, n));
  else left.fill(0, 0, n);
  if (r) right.set(r.subarray(0, n));
  else right.fill(0, 0, n);
}

registerProcessor("crone", CroneProcessor);
