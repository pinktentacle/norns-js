// E4-07/08/09 — crone on the main thread: load it, wire it, hear it.
//
// The worklet is in src/crone/processor.js and the DSP is upstream's. This is
// the side that has a DOM: it fetches the wasm (a worklet cannot), loads the
// classic bundle, builds the node with crone's own topology, and turns the
// records that come back up the ring into the callbacks `_norns` expects.
//
// THE GRAPH, which is norns' and not a simplification:
//
//     scsynth ──► input 0 (ext) ┐
//                               ├─► crone ──► destination
//     microphone ─► input 1 (adc)┘
//
// scsynth does NOT reach the speakers directly. Everything the engine makes
// goes through crone's mixer, because that is where `level_ext`, the monitor,
// the sends to softcut, the reverb and the compressor live. A build that
// connected scsynth to the destination as well would sound almost right and
// ignore every one of those controls.

import { CommandId, CutParamFamily } from "./commands.js";
import { decodeBatch, SLOTS } from "./events.js";

export interface CroneEvents {
  /** Twelve levels, in matron's order. `_norns.vu` takes them separately. */
  vu?(levels: number[]): void;
  tapeStatus?(s: {
    playState: number;
    playPos: number;
    playLen: number;
    recState: number;
    recPos: number;
    loop: number;
  }): void;
  /** 0 = play_close, 1 = rec_close. crone never had the filename. */
  tapeFile?(kind: number): void;
  /** `voice` is 0-based here; the +1 for Lua happens in callbacks.ts. */
  softcutPhase?(voice: number, value: number): void;
  softcutPosition?(voice: number, value: number): void;
  softcutRender?(r: {
    channel: number;
    secPerSample: number;
    start: number;
    count: number;
    samples: Float32Array;
  }): void;
}

/** A sound file crone has finished writing, as PCM for the encoder. */
export interface WrittenFile {
  readonly path: string;
  /** Interleaved, `channels` per frame. */
  readonly pcm: Float32Array;
  readonly channels: number;
  readonly rate: number;
  /** libsndfile's format word, so the encoder matches what crone asked. */
  readonly format: number;
}

/** One second of audio-thread cost, from inside the worklet. */
export interface CroneLoad {
  /** Blocks measured in the window. */
  readonly blocks: number;
  readonly meanMs: number;
  readonly maxMs: number;
  /**
   * Blocks that took longer than one quantum. Each one is a dropout.
   *
   * NEITHER A FLOOR NOR A CEILING when `coarse` is set. A 1 ms clock
   * reports a true 2.1 ms block as 3 about a tenth of the time and a
   * true 2.8 ms block as 2 about a fifth of it, so the count invents
   * some and misses others. Read it as "there are long blocks here",
   * never as a count of dropouts.
   */
  readonly over: number;
  /** One quantum of real time: the deadline every block has. */
  readonly budgetMs: number;
  /**
   * The audio thread had no `performance.now()` and fell back to `Date`
   * (E9-183). `meanMs` is still sound — the truncation is unbiased over a
   * second of blocks — and `maxMs` is 0, because a 1 ms clock cannot
   * resolve one 2.67 ms block.
   */
  readonly coarse?: boolean;
  /**
   * How many blocks measured 0, 1, 2, 3 and 4+ whole milliseconds.
   * E9-197 — the raw counts, with no verdict attached. A mean hides its
   * tail and `over` is a judgement this clock cannot reach; this is what
   * it can actually say, and the distribution reads straight off it.
   */
  readonly hist?: readonly number[];
}

export interface CroneOptions {
  readonly context: AudioContext;
  /** Defaults to the files tools/build-crone-worklet.mjs writes. */
  readonly workletUrl?: string;
  readonly wasmUrl?: string;
  readonly events?: CroneEvents;
  /** `buffer_write_*` finished; encode it and put it in the VFS. */
  readonly onFileWritten?: (f: WrittenFile) => void;
  /** One block's worth of tape recording, interleaved stereo. */
  readonly onTapeData?: (pcm: Float32Array) => void;
  /** The recording stopped. `dropped` is frames the ring could not hold. */
  readonly onTapeFinished?: (dropped: number) => void;
  /**
   * Audio-thread cost, once a second. Absent if the worklet has no
   * `performance.now()` — a measurement that did not happen must not be
   * reported as a zero.
   */
  readonly onLoad?: (load: CroneLoad) => void;
  readonly log?: (line: string) => void;
}

export interface Crone {
  readonly node: AudioWorkletNode;
  readonly sampleRate: number;
  readonly voices: number;
  /** crone's wasm heap, as the worklet reports it. */
  readonly heapBytes: number;
  /** A mixer or softcut command, by the name upstream's enum uses. */
  command(name: keyof typeof CommandId, ...args: number[]): void;
  /** A named parameter: softcut voice, reverb or compressor. */
  param(name: string, ...args: number[]): void;
  /**
   * Start or stop one of crone's polls: `vu`, `tape`, `softcut/phase`.
   *
   * Resolves to false for a name no poll has. Upstream this is
   * `/poll/start/vu` at the OSC interface, and upstream's polls each own a
   * thread started from there — which is why nothing polls at all until
   * something calls this. See shim/CronePoll.h.
   */
  poll(name: string, on: boolean): Promise<boolean>;
  /**
   * Call one of the worklet's `cronejs_*` entry points by name.
   *
   * This is how everything that is not a command or a named parameter gets
   * across — the buffer operations, the tape transport, the position query.
   * `types` is emscripten's ccall spelling: "string" or "number".
   */
  call(entry: string, types: readonly string[], args: readonly unknown[]): void;
  /**
   * Put decoded frames where crone can read them, under `path`.
   *
   * Resolves false when the window is larger than the worklet will hold —
   * the heap is fixed at 320 MB and softcut has 134 of it, so a read of
   * softcut's whole 349 seconds cannot also be staged as PCM.
   */
  preloadFile(spec: {
    path: string;
    pcm: Float32Array;
    channels: number;
    rate: number;
    totalFrames: number;
    firstFrame: number;
    frames: number;
  }): Promise<boolean>;
  dropFile(path: string): void;
  /** Queue frames for tape playback; the worklet meters them into the ring. */
  feedTape(pcm: Float32Array): void;
  /** Throw away anything queued for playback — a stop, or a seek. */
  resetTape(): void;
  /** How many poll records the audio thread had to throw away. */
  readonly dropped: number;
  stop(): void;
}

/** The ccall shape of each parameter family, from crone_param_dispatch.cpp. */
const PARAM_ENTRY: Record<string, { entry: string; types: string[]; arity: number }> = {
  f: { entry: "crone_cut_param", types: ["string", "number", "number"], arity: 2 },
  ii: { entry: "crone_cut_param_ii", types: ["string", "number", "number"], arity: 2 },
  iif: { entry: "crone_cut_param_iif", types: ["string", "number", "number", "number"], arity: 3 },
  reverb: { entry: "crone_reverb_param", types: ["string", "number"], arity: 1 },
  compressor: { entry: "crone_compressor_param", types: ["string", "number"], arity: 1 },
};

export async function startCrone(opts: CroneOptions): Promise<Crone> {
  const log = opts.log ?? (() => {});
  const workletUrl = opts.workletUrl ?? "/crone-worklet.js";
  const wasmUrl = opts.wasmUrl ?? "/crone.wasm";

  // The fetch happens HERE and not in the worklet, which has no fetch. The
  // bytes are structured-cloned into `processorOptions`, which is the only
  // channel that reaches a processor's constructor.
  const res = await fetch(wasmUrl);
  if (!res.ok) throw new Error(`crone: ${wasmUrl} returned ${res.status}`);
  const wasmBinary = await res.arrayBuffer();

  await opts.context.audioWorklet.addModule(workletUrl);

  const node = new AudioWorkletNode(opts.context, "crone", {
    // Two inputs because crone keeps adc and ext apart; see processor.js.
    numberOfInputs: 2,
    // Two outputs: the speakers, and (E9-222) the ADC going back to the
    // engine, which is upstream's `crone:output_5/6` -> SuperCollider.
    numberOfOutputs: 2,
    outputChannelCount: [2, 2],
    processorOptions: { wasmBinary },
  });

  let dropped = 0;
  const ev = opts.events ?? {};
  const pollWaiters = new Map<string, (ok: boolean) => void>();
  const preloadWaiters = new Map<string, (ok: boolean) => void>();

  const ready = new Promise<{ sampleRate: number; voices: number; heapBytes: number }>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as Record<string, unknown>;
      if (m["type"] === "ready") {
        if (m["timed"] !== true) {
          log("crone: the audio thread has no clock at all; its cost cannot be measured here");
        } else if (m["coarse"] === true) {
          // E9-183. Said once, because it qualifies every reading that
          // follows: the mean is sound and the worst block is absent.
          log(
            "crone: the audio thread has no performance.now(), so its cost is timed with Date " +
              "— the mean is good to about 0.03 ms, the worst block cannot be seen at all",
          );
        }
        resolve({
          sampleRate: m["sampleRate"] as number,
          voices: m["voices"] as number,
          heapBytes: (m["heapBytes"] as number) ?? 0,
        });
        return;
      }
      if (m["type"] === "error") {
        reject(new Error(`crone worklet: ${m["message"]}`));
        return;
      }
      if (m["type"] === "events") {
        handleEvents(m);
        return;
      }
      if (m["type"] === "poll") {
        const key = `${m["name"]}`;
        pollWaiters.get(key)?.(m["ok"] === true);
        pollWaiters.delete(key);
        return;
      }
      if (m["type"] === "filePreloaded") {
        const key = `${m["path"]}`;
        preloadWaiters.get(key)?.(m["ok"] === true);
        preloadWaiters.delete(key);
        return;
      }
      if (m["type"] === "fileWritten") {
        opts.onFileWritten?.({
          path: m["path"] as string,
          pcm: m["pcm"] as Float32Array,
          channels: m["channels"] as number,
          rate: m["rate"] as number,
          format: m["format"] as number,
        });
        return;
      }
      if (m["type"] === "tapeData") {
        opts.onTapeData?.(m["pcm"] as Float32Array);
        return;
      }
      if (m["type"] === "load") {
        opts.onLoad?.(m as unknown as CroneLoad);
        return;
      }
      if (m["type"] === "tapeFinished") {
        opts.onTapeFinished?.(m["dropped"] as number);
        return;
      }
      if (m["type"] === "nonFinite") {
        reportNonFinite(m["samples"] as number);
        return;
      }
    };
    node.port.onmessage = onMessage;
    // A node whose processor never reports is indistinguishable from one that
    // is merely slow, and the failure mode without this is a page that waits
    // for ever with no message. matron gives its own startup a deadline for
    // the same reason (E4-04).
    setTimeout(() => reject(new Error("crone worklet did not report ready within 10 s")), 10_000);
  });

  // E9-272 — the engine sent NaN or infinities and processor.js zeroed them.
  // The first time says what and why; after that at most every 10 s.
  let nonFiniteTotal = 0;
  let nonFiniteLogged = -Infinity;
  function reportNonFinite(samples: number): void {
    const first = nonFiniteTotal === 0;
    nonFiniteTotal += samples;
    const now = Date.now();
    if (first) {
      log(
        `crone: the engine sent ${samples} non-finite samples (NaN or infinity) — zeroed at crone's input, ` +
          "so the reverb and the compressor keep working. A norns has no such guard: there the output " +
          "would stay silent until a restart. The engine's own sound is not changed otherwise.",
      );
      nonFiniteLogged = now;
    } else if (now - nonFiniteLogged >= 10_000) {
      log(`crone: still zeroing non-finite samples from the engine (${nonFiniteTotal} so far)`);
      nonFiniteLogged = now;
    }
  }

  function handleEvents(m: Record<string, unknown>): void {
    const d = m["dropped"] as number;
    if (d > dropped) {
      // Saying it once per step up, not once per batch: a ring that is
      // overflowing would otherwise log faster than it drops.
      log(`crone: ${d - dropped} poll records dropped (${d} total)`);
      dropped = d;
    }
    const records = m["records"] as Float32Array;
    const render = m["render"] as Float32Array | undefined;
    for (const e of decodeBatch(records)) {
      switch (e.type) {
        case "vu":
          ev.vu?.(e.levels);
          break;
        case "tapeStatus":
          ev.tapeStatus?.(e);
          break;
        case "tapeFile":
          ev.tapeFile?.(e.kind);
          break;
        case "softcutPhase":
          ev.softcutPhase?.(e.voice, e.value);
          break;
        case "softcutPosition":
          ev.softcutPosition?.(e.voice, e.value);
          break;
        case "softcutRender":
          // The samples travel in their own buffer; a record is 16 floats and
          // a waveform preview is thousands. No buffer means the render was
          // dropped on the audio thread, and half an event is worse than
          // none.
          if (render) {
            ev.softcutRender?.({
              channel: e.channel,
              secPerSample: e.secPerSample,
              start: e.start,
              count: e.count,
              samples: render,
            });
          }
          break;
      }
    }
  }

  const info = await ready;
  log(`crone: ${info.voices} softcut voices at ${info.sampleRate} Hz`);

  return {
    node,
    sampleRate: info.sampleRate,
    voices: info.voices,
    heapBytes: info.heapBytes,
    get dropped() {
      return dropped;
    },

    command(name, ...args) {
      const c = CommandId[name];
      if (!c) throw new Error(`crone: no command ${String(name)}`);
      if (!c.queue) throw new Error(`crone: ${String(name)} has no handler in either client`);
      // Arity picks the entry point. `Commands::post` has four overloads and
      // filling the wrong union members is silent — the command arrives and
      // does something next to what was meant.
      const ARITY: Record<number, string> = { 1: "f", 2: "if", 3: "iif" };
      const arity = ARITY[args.length];
      if (!arity) throw new Error(`crone: ${String(name)} takes 1 to 3 arguments, got ${args.length}`);
      node.port.postMessage({ op: "command", queue: c.queue, id: c.id, arity, args });
    },

    param(name, ...args) {
      // CHECKED HERE ON PURPOSE. crone resolves the name with `std::map::at`
      // inside a `try`, and this build compiles without exceptions, so the
      // catch is gone: a real name in the wrong family aborts the module with
      // a bare number. research/crone-port.md §3.
      const family = (CutParamFamily as Record<string, string>)[name];
      if (!family) throw new Error(`crone: no parameter "${name}"`);
      const spec = PARAM_ENTRY[family];
      if (!spec) throw new Error(`crone: parameter "${name}" has family ${family}, which this build cannot send`);
      if (args.length !== spec.arity) {
        throw new Error(`crone: "${name}" takes ${spec.arity} argument(s), got ${args.length}`);
      }
      const coerced = family === "ii" ? args.map((v) => v | 0) : args;
      node.port.postMessage({ op: "param", entry: spec.entry, types: spec.types, args: [name, ...coerced] });
    },

    call(entry, types, args) {
      node.port.postMessage({ op: "param", entry, types, args });
    },

    preloadFile(spec) {
      return new Promise<boolean>((resolve) => {
        preloadWaiters.set(spec.path, resolve);
        // The PCM is TRANSFERRED, not cloned: it was decoded for this and
        // the main thread does not read it again. A clone of a minute of
        // stereo is 23 MB copied for nothing.
        node.port.postMessage(
          {
            op: "filePreload",
            path: spec.path,
            pcm: spec.pcm,
            channels: spec.channels,
            rate: spec.rate,
            totalFrames: spec.totalFrames,
            firstFrame: spec.firstFrame,
            frames: spec.frames,
          },
          [spec.pcm.buffer],
        );
        setTimeout(() => {
          if (preloadWaiters.delete(spec.path)) resolve(false);
        }, 5000);
      });
    },

    dropFile(path) {
      node.port.postMessage({ op: "fileDrop", path });
    },

    feedTape(pcm) {
      node.port.postMessage({ op: "tapeFeed", pcm }, [pcm.buffer]);
    },

    resetTape() {
      node.port.postMessage({ op: "tapeReset" });
    },

    poll(name, on) {
      return new Promise<boolean>((resolve) => {
        pollWaiters.set(name, resolve);
        node.port.postMessage({ op: "poll", name, on });
        // A reply that never comes would leave the caller awaiting for ever.
        setTimeout(() => {
          if (pollWaiters.delete(name)) resolve(false);
        }, 2000);
      });
    },

    stop() {
      node.port.onmessage = null;
      node.disconnect();
    },
  };
}

export { SLOTS };
