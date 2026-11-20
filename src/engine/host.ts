// E4-01 / E4-03 — sclang and scsynth, wired the way norns wires them.
//
// Three decisions here are architectural and each cost a day of E0 to find.
// They are ADR-04c, ADR-04d and the `numInputBusChannels` trap.

import { installCapture, captured, uncapturedAudioContext } from "./capture.js";
import { timed } from "../norns/call-cost.js";
import { decode, encodeMessage } from "./osc.js";
import { loadClassLibrary } from "./classlib-loader.js";

/** What an OSC argument can be: int32, float32 or string, plus blobs. */
export type OscArg = number | string | Uint8Array;

installCapture(); // before any wasm import; see capture.ts

/* eslint-disable @typescript-eslint/no-explicit-any */
type ScModule = any;

export interface EngineHostOptions {
  /** Human-readable progress. */
  readonly log?: (line: string) => void;
  /** OSC that sclang addressed to matron rather than to the server. */
  readonly onMatron?: (msg: { address: string; args: OscArg[] }) => void;
  /**
   * The browser is holding the audio engine until somebody touches the page.
   *
   * Called with `true` when the wait starts and `false` when it ends, so the
   * page can SAY so instead of looking like it has stalled — which is what a
   * line in a console the user has not opened amounts to.
   */
  readonly onNeedsGesture?: (waiting: boolean) => void;
  /** Where the wasm lives. Defaults match tools/build-audio-assets.mjs. */
  readonly sclangUrl?: string;
  readonly scsynthUrl?: string;
  /** Where the norns class library and the overrides are fetched from. */
  readonly nornsScUrl?: string;
  /** Where `sclang-lib.tar.gz` lives. Defaults to `/pack`. */
  readonly classLibUrl?: string;
  /**
   * A script's own SuperCollider classes, keyed by a path relative to the
   * dust tree — `amen/lib/Engine_Amen.sc`.
   *
   * norns puts `~/dust/code` on sclang's class path, so an engine a script
   * ships is compiled at startup and appears in `engine.names`. Without
   * these, `engine.name = "Amen"` asks for something sclang never heard of.
   */
  readonly extraClasses?: ReadonlyMap<string, string | Uint8Array>;
  /**
   * What every bundled sound file is, for `SoundFile.openRead`.
   *
   * sclang's `SoundFile` is a libsndfile primitive and this build has none,
   * so an engine asking a file how long it is gets nil -- which is why
   * timber and takt load and then make no sound. The answer has to be
   * synchronous, so it cannot be a round trip to the host; the host writes
   * what it already knows into sclang's filesystem instead. See
   * NornsJsSoundFileOverride.sc.
   */
  readonly soundFiles?: ReadonlyMap<string, { frames: number; channels: number; sampleRate: number }>;
}

export interface EngineHost {
  /** What the `/d_recv` barrier cost. See E5-20. */
  readonly transport: {
    acks: number;
    ackTotalMs: number;
    ackMaxMs: number;
    timeouts: number;
    timedOutDefs: number;
    dead: boolean;
  };
  /**
   * What the SERVER says its own load is, from `/status.reply`. E9-112.
   *
   * `avgCpu` and `peakCpu` are percentages of the block period scsynth's
   * DSP took, which is the audio thread's load and not the page's. `at` is
   * when the last reply arrived, so a caller can tell a quiet server from
   * one that has stopped answering.
   */
  readonly status: {
    avgCpu: number;
    peakCpu: number;
    ugens: number;
    synths: number;
    at: number;
  };
  /** Ask for it. The reply lands in `status` a round trip later. */
  pollStatus(): void;
  readonly sclang: ScModule;
  readonly scsynth: ScModule;
  /** Everything sclang has printed, for waiting on and for reporting. */
  readonly scLog: string[];
  sawLine(s: string): boolean;
  until(pred: () => boolean, ms: number, what: string): Promise<boolean>;
  injectNorns(): Promise<number>;
  bootSclang(): Promise<boolean>;
  bootServerFromSclang(): Promise<{ ready: boolean; ctx: AudioContext | null }>;
  sendToServer(address: string, args?: readonly OscArg[]): void;
  /**
   * Wait until the server has processed everything sent before this.
   *
   * E9-171 — BECAUSE NOTHING ELSE DOES. `sendToServer` queues a packet
   * and returns; it says the message was SENT, never that it was acted
   * on. For most commands that is fine — the queue is FIFO and the next
   * command lands behind this one. It is not fine when something
   * OUTSIDE that queue is told the work is finished, which is exactly
   * what pushing a buffer does: fifty-two `/b_setn` messages go out and
   * sclang is then told the buffer is ready, over a different channel
   * that does not wait behind them.
   *
   * `/sync` is SuperCollider's answer to this and the server already
   * exempts it from the `/d_recv` barrier (see below) precisely so it
   * can answer from behind the queue. Resolves false on timeout rather
   * than hanging: a buffer that loaded slowly is better than a script
   * that never starts.
   */
  syncServer(timeoutMs?: number): Promise<boolean>;
  /**
   * Read samples back OUT of a server buffer.
   *
   * E9-171 — THE ONLY WAY TO KNOW THE SAMPLES ARRIVED. Everything else
   * in this file reports what was SENT. `/b_alloc` and fifty-two
   * `/b_setn` are queued and the loader logs a line saying how many
   * frames went; nothing anywhere confirms that any of them landed, and
   * a buffer that is allocated but empty plays as silence with no error
   * after the first block.
   *
   * `/b_getn` answers with `/b_setn`, which is the server's own copy of
   * what it holds. Null on timeout or on a server that does not answer.
   */
  peekBuffer(bufnum: number, index: number, count: number, timeoutMs?: number): Promise<number[] | null>;
  /**
   * Send OSC INTO sclang, as if it had arrived on a socket.
   *
   * The same channel scsynth's replies come back on. It is how a
   * SystemOverwrite that asked matron a question hears the answer —
   * `NornsJsBufferOverride.sc` waits on `/norns-js/buffer/done` this way.
   */
  sendToLang(address: string, args?: readonly OscArg[]): void;
  runCode(code: string): void;
  readonly context: AudioContext | null;
}

/** The 15 norns classes, written flat into one MEMFS directory. */
const NORNS_CLASSES = [
  "Crone.sc", "CroneAudioContext.sc", "CroneDefs.sc", "CroneEffects.sc",
  "CroneEngine.sc", "CronePoll.sc", "CroneTester.sc",
  "AudioTaper.sc", "BufUtil.sc", "CroneGenEngine.sc",
  "Engine_PolyPerc.sc", "Engine_PolySub.sc", "Engine_SimplePassThru.sc",
  "Engine_TestSine.sc", "PatchMatrix.sc",
];

/**
 * Two overrides written as string literals because they are two lines each.
 *
 * `bootOnInit` — `Crone.initClass` registers a StartUp block that boots the
 * server while the interpreter starts. It has to wait for the user's gesture
 * instead, or the AudioContext is created before the browser will allow it.
 *
 * `runShellCommand` — `Crone.finishBoot` shells out to `jack_connect` four
 * times through `Pipe` → `sc_popen` → `fork`, which wasm does not have. There
 * is no JACK in a browser and nothing to connect. It goes in
 * `SystemOverwrites/`, which is how SuperCollider wants a deliberate override
 * declared rather than a patched file.
 *
 * `Pipe` — E9-66, the same missing `fork` reached from the other side, and
 * it cost two scripts. A `Pipe` IS a subprocess, so in a browser it can
 * only ever fail, and it fails in the worst way: `getLine` calls
 * `_FileReadLine`, the primitive fails, and the error is raised wherever
 * the caller happened to be.
 *
 * Where it happened to be, twice:
 *
 *   `pirate-radio` ships the MP3 quark, whose `*initClass` runs
 *   `("which" + execname).unixCmdGetStdOut` to find `lame`. That is inside
 *   `Class.initClassTree(Object)`, so the class tree never finished, sclang
 *   never said it was ready, and the boot waited out its ninety seconds.
 *   Not pirate-radio's audio: EVERY engine on the machine.
 *
 *   `Engine_Tapedeck.alloc` runs `Pipe.new("lscpu | grep BogoMIPS | awk
 *   ...", "r")` to size its buffers. The engine failed to allocate and
 *   registered NOT ONE command, so `tapedeck` drew its whole interface and
 *   then died on `engine.set` being nil.
 *
 * So the override is on `Pipe` and not on `String:unixCmdGetStdOut`, which
 * is only one of its callers: a dead pipe reads as a command that produced
 * no output, which is the truth here and a shape every caller already
 * handles.
 *
 * WHAT A DEAD PIPE READS AS, which is the one judgement call in here.
 * `Engine_Tapedeck` is `mips = piped.getLine.asFloat` — no nil check — so
 * an end-of-stream `getLine` moved its death one line down, from
 * `_FileReadLine` to "Nil does not understand asFloat", and the engine
 * still registered nothing. The pipe therefore reads as ONE EMPTY LINE and
 * then ends:
 *
 *   • bounded at one line, so every `while (line.notNil)` loop —
 *     `unixCmdGetStdOut`, `Pipe.callSync` — still terminates;
 *   • "" is already what `String:unixCmdGetStdOut` returns for a command
 *     that printed nothing, so the two levels agree rather than disagree;
 *   • `"".asFloat` is 0, which is exactly the default Engine_Tapedeck set
 *     two lines above, and `mips` is used for one thing: whether to
 *     oversample three times instead of two.
 *
 * Teaching `Nil` to answer `asFloat` would fix the same line and is the
 * wrong fix: SuperCollider leaves those off `Nil` ON PURPOSE, and adding
 * them would turn every nil-arithmetic mistake in every script into a
 * silent zero.
 *
 * Said plainly, because it is the one place this build is not literal: a
 * real pipe over an empty stream returns nil on the FIRST read. This one
 * returns an empty line first. That difference is the whole of the
 * fiction, and `pid` — which only `close` ever used, and `close` is
 * overridden — is what remembers it.
 */
const INLINE_OVERRIDES: Record<string, string> = {
  "NornsJsBootHook.sc": `NornsJsBootHook { *initClass { Crone.bootOnInit = false; } }\n`,
  "SystemOverwrites/NornsJsShellOverride.sc":
    `+ Crone {\n` +
    `    *runShellCommand { arg str; ("[norns-js] shell skipped: " ++ str).postln; }\n` +
    `}\n`,
  "SystemOverwrites/NornsJsSubprocessOverride.sc":
    `+ Pipe {\n` +
    `    *new { arg commandLine, mode;\n` +
    `        ("[norns-js] no subprocess here, so '" ++ commandLine ++ "' ran nothing").postln;\n` +
    `        ^super.new;\n` +
    `    }\n` +
    `    *argv { arg args, mode;\n` +
    `        ("[norns-js] no subprocess here, so '" ++ args ++ "' ran nothing").postln;\n` +
    `        ^super.new;\n` +
    `    }\n` +
    `    getLine { arg maxSize = 1024;\n` +
    `        if (pid.isNil) { pid = 0; ^"" };\n` +
    `        ^nil;\n` +
    `    }\n` +
    `    close { ^0 }\n` +
    `}\n`,
};

/**
 * The two that are long enough to deserve a file and a reviewer.
 *
 * `NornsJsPollOverride` rebuilds norns' poll transport on `/c_get`, because
 * `Bus:getSynchronous` needs scsynth's shared memory and there is none between
 * two separate wasm modules with two separate heaps (E0-34).
 *
 * `NornsJsShmOverride` leaves `serverInterface` nil rather than an Integer, so
 * `hasShmInterface` stops answering a false `true` (E0-33).
 */
const OVERRIDE_FILES = import.meta.glob("./sc-overrides/SystemOverwrites/*.sc", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * The SuperCollider CLASSES for the sc3-plugins UGens compiled into scsynth.
 *
 * Two halves of one thing, and both are needed. The UGen makes the sound;
 * the class is what `Decimator.ar` resolves to when sclang builds the
 * SynthDef. Ship the UGen without the class and sclang says
 * "Class 'Decimator' not found"; ship the class without the UGen and the
 * SynthDef builds and the server refuses it.
 *
 * Optional: a build without the sc3-plugins checkout has neither, and the
 * fetch failing here must not take the boot down — it means those UGens are
 * missing, which is a thing to say, not to crash over.
 */
const SC3_CLASSES = [
  "DistortionPlugins.sc", // Decimator, and the rest of DistortionUGens
  "TJUGens.sc", // DFM1
  "blackrain_ugens.sc", // SVF
  "MdaUGens.sc", // MdaPiano
  "JPverb.sc", // JPverb, over the JPverbRaw UGen
  "Greyhole.sc", // Greyhole, over the GreyholeRaw UGen
  "BatUGens.sc", // Coyote, the onset detector oooooo triggers on
  "SLUGens.sc", // EnvFollow, which Pedalboard uses
] as const;

/**
 * The mi-UGens classes, from a different pack and a different directory.
 *
 * Kept apart from SC3_CLASSES because they are a separate checkout with a
 * separate licence (GPL-3), and because a missing mi-UGens should report
 * itself as mi-UGens rather than as "sc3-plugins is short of two files".
 *
 * MiBraids is here only when the build has it. Its UGen resamples with
 * libsamplerate, which mi-UGens carries as a submodule of its own, so a
 * plain clone leaves it out of scsynth — and tools/build-audio-assets.mjs
 * then leaves the class out of public/ for the same reason. The fetch
 * below 404s and the count reports four of five, which is the honest
 * outcome: a class whose UGen is missing is the exact failure this list
 * exists to avoid, a SynthDef that builds and a server that refuses it.
 */
const MI_CLASSES = [
  "MiRings.sc",
  "MiClouds.sc",
  "MiElements.sc",
  "MiPlaits.sc",
  "MiBraids.sc",
] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function createEngineHost(opts: EngineHostOptions = {}): Promise<EngineHost> {
  const log = opts.log ?? (() => {});
  const sclangUrl = opts.sclangUrl ?? "/sclang";
  const scsynthUrl = opts.scsynthUrl ?? "/scsynth";
  const nornsScUrl = opts.nornsScUrl ?? "/norns-sc";

  log("loading scsynth.wasm and sclang.wasm …");

  // locateFile is required, not optional: emscripten resolves the .wasm
  // against the script URL but the --preload-file .data package against the
  // DOCUMENT, so sclang would fetch /sclang.data rather than /sclang/sclang.data.
  const { default: ScSynth } = await import(/* @vite-ignore */ `${scsynthUrl}/scsynth.js`);
  const { default: ScLang } = await import(/* @vite-ignore */ `${sclangUrl}/sclang.js`);
  // scsynth's heap is FIXED at link time and cannot be raised here: the
  // module declares its maximum, and handing it a larger Memory fails
  // validation with "memory import has a larger maximum size 2048 than the
  // module's declared maximum 256". The size is set by
  // `-DSC_WASM_INITIAL_MEMORY` in tools/sclang/build.sh — 128 MB, eight
  // times emscripten's default, because 16 MB has to hold the code, the
  // static data, `realTimeMemorySize`, 1024 buffers and every sample a
  // script loads. At 16 MB it aborted with OOM once sc3-plugins was
  // compiled in, and was already producing an intermittent
  // `Uncaught <address>` from the worklet thread before that.
  const scsynth: ScModule = await ScSynth({ locateFile: (p: string) => `${scsynthUrl}/${p}` });

  // E9-30 — STK's wavetables, into the SERVER's filesystem.
  //
  // `StkInst` and `StkUGens` are built from the STK vendored in
  // sc3-plugins, and Plucked, Mandolin, Shakers and Sitar read a `.raw`
  // wavetable at note-on. `Stk::setRawwavePath` decides where from, and a
  // script sets it through the `StkGlobals` UGen; unset, STK looks in
  // `rawwaves/` relative to the process's directory, which here is `/`.
  //
  // These go into SCSYNTH's filesystem, not sclang's. The two wasm modules
  // have one MEMFS each and the UGen runs in the server, so writing them
  // next to the class library — where every other file in this function
  // goes — would put them where nothing reads them.
  //
  // Optional, and quiet when absent: a build without the vendored stk has
  // no UGens to feed either.
  try {
    const res = await fetch("/stk-rawwaves/index.json");
    if (res.ok) {
      const names = (await res.json()) as string[];
      const FS = scsynth.FS;
      try {
        FS.mkdir("/rawwaves");
      } catch {
        /* already there */
      }
      let n = 0;
      await Promise.all(
        names.map(async (name) => {
          const r = await fetch(`/stk-rawwaves/${name}`);
          if (!r.ok) return;
          FS.writeFile(`/rawwaves/${name}`, new Uint8Array(await r.arrayBuffer()));
          n++;
        }),
      );
      if (n > 0) log(`stk: ${n} wavetables in /rawwaves`);
    }
  } catch {
    /* no rawwaves shipped; the Stk UGens are then missing them too */
  }

  // --- say what scsynth died of --------------------------------------
  //
  // When a thread in scsynth throws, the browser reports it as
  // `Uncaught 17681784` -- the address of the exception object and nothing
  // else. That number is why E5-20 and E5-21 both took a day: the server
  // stops answering and the only evidence is an integer.
  //
  // The integer is enough. A `std::runtime_error` is {vptr, char*}, so the
  // message is a NUL-terminated string at the pointer four bytes in, and
  // scsynth's module exposes both its heap and a UTF8 reader. Decoding it
  // turns "Uncaught 17681784" into
  //
  //     scsynth died: UGen 'VDiskIn' not installed.
  //
  // which names the cause in one line.
  //
  // Best effort by design: a trap rather than a throw, or a layout this
  // does not expect, produces no message and the raw number is reported.
  const decodeScsynthThrow = (text: string): string | null => {
    const m = /Uncaught (\d+)/.exec(text);
    if (m === null) return null;
    const ptr = Number(m[1]);
    try {
      const heap = scsynth.HEAPU8;
      const read = scsynth.UTF8ToString;
      if (heap === undefined || read === undefined) return null;
      const at = new DataView(heap.buffer as ArrayBuffer).getUint32(ptr + 4, true);
      if (at <= 0 || at >= heap.length) return null;
      const msg = read(at);
      return msg.length > 0 && msg.length < 400 ? msg : null;
    } catch {
      return null;
    }
  };
  globalThis.addEventListener?.("error", (e) => {
    const text = String((e as ErrorEvent).message ?? "");
    const msg = decodeScsynthThrow(text);
    if (msg !== null) log(`scsynth died: ${msg}`);
  });
  const sclang: ScModule = await ScLang({ locateFile: (p: string) => `${sclangUrl}/${p}` });

  // E4-02 — THE CLASS LIBRARY ARRIVES AS AN ARCHIVE, not baked into the
  // binary. sclang is built without `--preload-file`, so `/sc/SCClassLibrary`
  // is empty until this unpacks 373 files into it.
  //
  // Why it is worth the step: the preload puts a 2 MB `sclang.data` beside
  // the wasm and ties the two together, so every sclang rebuild invalidates
  // a class library that did not change. The archive is 529 KB gzipped, is
  // cached on its own, and can be replaced without touching the binary.
  //
  // BEFORE `injectNorns`, which writes into `/sc/SCClassLibrary/norns/` —
  // a directory that does not exist until the archive has been unpacked —
  // and long before `bootInterpreter`, which is when the compiler reads any
  // of it.
  //
  // A failure here is fatal and says so. With no preload there is no
  // fallback: an sclang whose class library never arrived compiles nothing
  // and reports it as a parse error in a file it cannot name.
  const lib = await loadClassLibrary(sclang, { url: `${opts.classLibUrl ?? "/pack"}/sclang-lib.tar.gz` });
  // `archiveBytes` is what ARRIVED, not what travelled: the dev server sends
  // the `.tar.gz` with `Content-Encoding: gzip`, so the browser inflates it
  // and the loader is handed a plain 2.3 MB tar — the path its own comment
  // calls "what you get when the server did the decompression". On the wire
  // it is the 529 KB file on disk. Reporting the number we measured rather
  // than the one we would like.
  log(
    `class library: ${lib.files} files, ${(lib.archiveBytes / 1048576).toFixed(1)} MB unpacked ` +
      `in ${lib.totalMs.toFixed(0)} ms`,
  );

  const scLog: string[] = [];
  const capture = (prefix: string) => (t: string) => {
    scLog.push(t);
    log(prefix + t);
  };
  sclang.printCallback = capture("  | ");
  sclang.printErrCallback = capture("  ! ");
  scsynth.onPrint = capture("  s| ");
  scsynth.onStdout = capture("  s| ");

  // --- the router (ADR-04c) --------------------------------------------
  //
  // sclang-wasm removed the concept of an address and a port, so EVERYTHING
  // sclang sends leaves through one callback: traffic for the server and
  // traffic for matron, interleaved. On real norns these are two UDP sockets.
  // Here they are one channel and we own the demultiplexer.
  //
  // The matron-bound set is small and CLOSED, which is what makes this safe:
  // anything else is the server's by definition, so a new norns message
  // cannot be silently swallowed — it would go to scsynth and be ignored
  // loudly rather than vanish.
  const toMatron = (addr: string): boolean =>
    addr.startsWith("/crone/") ||
    addr.startsWith("/report/") ||
    addr === "/poll/data" ||
    addr === "/poll/value" ||
    // Added by this port, not by norns: with the port gone, a script's own
    // OSC needs somewhere to say where it was going. See
    // sc-overrides/SystemOverwrites/NornsJsOscPortOverride.sc.
    addr.startsWith("/norns-js/");

  type Decoded = { address?: string; args?: OscArg[]; bundle?: Array<{ address: string }> };

  // --- ordering around asynchronous server commands --------------------
  //
  // `/d_recv` is handled on scsynth's NON-REAL-TIME thread and completes
  // some time later; `/s_new` is handled on the real-time thread, at once.
  // So this, which `Engine_Amen` does and many engines do, is a race:
  //
  //     (0..4).do { |i| SynthDef("playerAmen" ++ i, { ... }).add };
  //     playerAmen = Array.fill(4, { |i| Synth("playerAmen" ++ i, ...) });
  //
  // On hardware `/d_recv` lands in microseconds and the race is won. Here
  // it was lost the same way every run — the first two defs arrived and the
  // rest did not — and reported as
  //
  //     *** ERROR: SynthDef playerAmen2 not found
  //
  // which reads like a dropped message or a size limit and is neither.
  //
  // While a `/d_recv` is outstanding, what follows waits; `/done /d_recv`
  // releases it; a deadline releases it anyway if the acknowledgement never
  // comes. The queue is FIFO, so the order sclang sent in is the order the
  // server sees — all the UDP socket on hardware was ever giving us.
  //
  // `/sync` IS EXEMPT, and that exemption is the whole difficulty. Its
  // purpose is to answer from behind the server's queue, so holding it
  // means `server.sync` waits for a reply to a message that is waiting on
  // it: `Engine_MGlut` stopped dead at `context.server.sync` with both
  // deadlines expiring. Letting it past costs nothing — it is a question,
  // not a command, and the answer still comes after the work.
  //
  // IT IS A COUNT, NOT A FLAG, and that distinction is worth 108 seconds.
  //
  // A flag assumes at most one `/d_recv` can be in flight, which the barrier
  // itself normally guarantees -- except for the `/sync` exemption above. A
  // bundle carrying several defs AND a `/sync` (which is exactly what
  // `Server.sync` sends) goes straight through unheld, and scsynth answers
  // each def with its own `/done /d_recv`. The flag was cleared by the
  // first, so the rest arrived to a barrier that was already down and were
  // dropped -- and the NEXT def then waited the full two seconds for an
  // acknowledgement that had already been thrown away.
  //
  // Measured over the 40-script browser sweep: 54 such timeouts, two
  // seconds each, turning a 1.2 s script load into a 46 s one by the end of
  // the session. The server was idle throughout (0.15% average CPU), which
  // is what ruled out the obvious explanation.
  /**
   * What the barrier costs, so a slow session can be diagnosed rather than
   * guessed at. `/d_recv` is the one message the page waits on, and E5-20 is
   * about why it sometimes waits two seconds.
   */
  /**
   * E9-112 — WHAT THE SERVER SAYS ITS OWN LOAD IS.
   *
   * norns' home overlay draws `_norns.audio_get_cpu_load()`, which on
   * hardware is jack's figure for the audio thread. Here it was a stub
   * returning zero, so the one reading that would have said whether the
   * DSP was in trouble said nothing at all.
   *
   * scsynth has the number and gives it for the asking: `/status` is
   * answered with `/status.reply`, whose sixth and seventh arguments are
   * the average and peak share of the block period its own DSP took. That
   * is the right meaning — it is the audio thread's load, not the page's.
   *
   * Cached rather than asked for on demand, because `audio_get_cpu_load`
   * is called from Lua inside a redraw and the answer comes back over OSC.
   * `pollStatus` is driven once a second from `main.ts`, beside the disk
   * and battery polls it already has.
   */
  const status = {
    avgCpu: 0,
    peakCpu: 0,
    ugens: 0,
    synths: 0,
    /** When the last reply arrived, or 0. A stale number is worse than none. */
    at: 0,
  };

  const transport = {
    acks: 0,
    ackTotalMs: 0,
    ackMaxMs: 0,
    timeouts: 0,
    timedOutDefs: 0,
    /** Set once the server has stopped answering; see the timeout below. */
    dead: false,
  };
  /** Three in a row is a server that is gone, not one that is busy. */
  const DEAD_AFTER = 3;
  let consecutiveTimeouts = 0;
  let sentAt = 0;
  let outstanding = 0;
  const held: Array<{ bytes: Uint8Array; addr: string | undefined; defs: number }> = [];
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;

  const disarm = (): void => {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
  };

  const arm = (): void => {
    disarm();
    if (outstanding <= 0) return;
    releaseTimer = setTimeout(() => {
      transport.timeouts++;
      transport.timedOutDefs += outstanding;
      consecutiveTimeouts++;
      outstanding = 0;
      // A DEAD SERVER SHOULD SAY SO ONCE, not cost two seconds a SynthDef
      // for the rest of the session.
      //
      // scsynth throws on a SynthDef naming a UGen it does not have, and
      // this build has exceptions off, so the throw aborts the thread that
      // handles /d_recv. The audio thread keeps running and /status keeps
      // answering, so from the outside everything looks alive -- except
      // that no async command ever completes again. What that looked like
      // before this check was a session that got slower and slower: sixty
      // two-second waits spread over forty script loads, which reads like a
      // performance problem and is not one.
      if (consecutiveTimeouts === DEAD_AFTER) {
        transport.dead = true;
        log(
          "engine: the server has stopped completing /d_recv. SynthDefs will " +
            "not load, polls will not report and nothing will sound. This is " +
            "usually scsynth aborting on a SynthDef that names a UGen it does " +
            "not have. Reload the page to recover.",
        );
      } else if (!transport.dead) {
        log(`engine: ${transport.timedOutDefs} /d_recv not acknowledged; releasing what was held`);
      }
      pump();
    }, 2000);
  };

  const forward = (p: { bytes: Uint8Array; addr: string | undefined; defs: number }): void => {
    if (p.defs > 0 && !transport.dead) {
      // Once the server is known dead, nothing is held: waiting two seconds
      // for an answer that is never coming only slows down finding out.
      if (outstanding === 0) sentAt = performance.now();
      outstanding += p.defs;
      arm();
    }
    scsynth.sendOsc(p.bytes);
  };

  /**
   * Release what is waiting, RE-ARMING on each `/d_recv` as it goes.
   *
   * The first version drained straight to the server, so a held `/d_recv`
   * went through without raising the barrier again and everything behind it
   * raced past as before — four of amen's five defs instead of two, better
   * and still wrong.
   */
  const pump = (): void => {
    while (outstanding === 0 && held.length > 0) forward(held.shift()!);
  };

  /** A bundle counts as whatever its first message is. */
  const addressOf = (m: Decoded | null): string | undefined =>
    m?.address ?? m?.bundle?.[0]?.address;

  /**
   * How many `/d_recv` acknowledgements this packet will produce.
   *
   * Every `/d_recv` in a bundle gets its own `/done`, wherever it sits in
   * the bundle -- so this counts them all, not just the first message.
   */
  const defsIn = (m: Decoded | null): number => {
    if (m === null) return 0;
    if (m.address !== undefined) return m.address === "/d_recv" ? 1 : 0;
    return (m.bundle ?? []).filter((x) => x.address === "/d_recv").length;
  };

  /**
   * E9-160 — THE OSC PATHS ARE TIMED, in the same account as everything
   * else.
   *
   * The first busy span that reported where it went came to 7.9% of
   * itself: `draw:grid`, `metro` and `grid.key` adding up to 4.3 seconds
   * of a 53.8-second span at eighty per cent. Whatever the other forty
   * seconds were, nothing had a clock on it.
   *
   * OSC is the obvious candidate and the earlier profile agreed —
   * `sendToServer` carried 26.8% of the samples beneath it. Every engine
   * command, every poll reply and every bit of sclang's own chatter
   * passes through these four points, so they get the same treatment the
   * callbacks and the frame already have:
   *
   *     osc:to-server    encode and hand to scsynth
   *     osc:to-lang      the same, to sclang
   *     osc:from-lang    decode and dispatch what sclang says
   *     osc:from-server  the same, from scsynth
   *
   * Named apart because they are four different costs: a `kolorplay`
   * going out is not a `/status.reply` coming back.
   */
  sclang.onOsc = (bytes: Uint8Array) => timed("osc:from-lang", () => onLangOsc(bytes));

  const onLangOsc = (bytes: Uint8Array): void => {
    let msg: Decoded | null = null;
    try {
      msg = decode(bytes) as unknown as Decoded;
    } catch {
      /* not decodable here; the server will deal with it */
    }
    const addr = addressOf(msg);
    if (addr && toMatron(addr)) {
      opts.onMatron?.({ address: addr, args: msg?.args ?? [] });
      return;
    }
    // `/sync` is never held; see above. A bundle that CONTAINS a `/sync`
    // is not held either — `NetAddr.sync` sends the work and the `/sync`
    // together, so holding the bundle would hold the question with it.
    const hasSync =
      addr === "/sync" || (msg?.bundle?.some((m) => m.address === "/sync") ?? false);
    const defs = defsIn(msg);
    if (outstanding > 0 && !hasSync) {
      held.push({ bytes, addr, defs });
      return;
    }
    forward({ bytes, addr, defs });
  };

  scsynth.onOscReply = (bytes: Uint8Array) => timed("osc:from-server", () => onServerOsc(bytes));

  /**
   * E9-171 — `/sync` IDs OUTSTANDING, and who is waiting for each.
   *
   * The id matters: two loaders can be in flight at once — a script
   * that reads four samples in its `init` does exactly that — and a
   * flag would let the first `/synced` release all of them.
   */
  const syncWaiting = new Map<number, (ok: boolean) => void>();
  let nextSyncId = 1;
  /** `/b_getn` answers in flight, keyed by `bufnum:index`. E9-171. */
  const peekWaiting = new Map<string, (v: number[] | null) => void>();

  const onServerOsc = (bytes: Uint8Array): void => {
    // Read BEFORE the `/d_recv` bookkeeping below and outside its guard:
    // that branch only runs while a SynthDef is outstanding, and the
    // status poll has nothing to do with sending defs.
    try {
      const r = decode(bytes) as unknown as Decoded;
      if (r.address === "/status.reply") {
        const a = (r.args ?? []) as number[];
        // [1, ugens, synths, groups, defs, avgCPU, peakCPU, sr, actualSr]
        status.ugens = Number(a[1] ?? 0);
        status.synths = Number(a[2] ?? 0);
        status.avgCpu = Number(a[5] ?? 0);
        status.peakCpu = Number(a[6] ?? 0);
        status.at = performance.now();
      }
      // E9-171 — the server's own copy of what it holds.
      if (r.address === "/b_setn") {
        const a = (r.args ?? []) as number[];
        const key = `${Number(a[0] ?? -1)}:${Number(a[1] ?? -1)}`;
        const waiter = peekWaiting.get(key);
        if (waiter !== undefined) {
          peekWaiting.delete(key);
          waiter(a.slice(3).map(Number));
        }
      }
      // E9-171 — the answer from behind the server's queue.
      if (r.address === "/synced") {
        const id = Number((r.args ?? [])[0] ?? -1);
        const waiter = syncWaiting.get(id);
        if (waiter !== undefined) {
          syncWaiting.delete(id);
          waiter(true);
        }
      }
    } catch {
      /* a reply we cannot read is not a status */
    }
    if (outstanding > 0) {
      try {
        const r = decode(bytes) as unknown as Decoded;
        // `/done /d_recv` is the acknowledgement. `/fail` for the same
        // command counts too: a def that was refused still unblocks the
        // queue, and the refusal is already on its way to sclang.
        if (r.address === "/done" || r.address === "/fail") {
          if (String(r.args?.[0] ?? "") === "/d_recv") {
            const dt = performance.now() - sentAt;
            consecutiveTimeouts = 0;
            transport.acks++;
            transport.ackTotalMs += dt;
            if (dt > transport.ackMaxMs) transport.ackMaxMs = dt;
            outstanding -= 1;
            if (outstanding < 0) outstanding = 0;
            // Re-arm while any are still outstanding: the deadline is per
            // acknowledgement still owed, not per batch.
            arm();
            pump();
          }
        }
      } catch {
        /* a reply we cannot read cannot be the acknowledgement */
      }
    }
    sclang.sendOsc(bytes);
  };

  // --- the boot gate (ADR-04d) -----------------------------------------
  //
  // sclang boots the server by evaluating JavaScript: SuperCollider's own
  // `overwrites.sc` replaces `Server.bootServerApp` with
  // `JS.runCode("bootServer(<options json>)")`.
  //
  // We must NOT boot scsynth ourselves first. `Server:boot` pings the port,
  // and if anything answers within 250 ms it runs `{ this.quit; this.boot }`
  // to clear what it takes for a stale server — which under wasm never
  // terminates, because `/quit` kills no process. The result is an infinite
  // quit/boot loop.
  //
  // Options pass through unchanged. `numInputBusChannels: 0` would make
  // `SC_WebAudio.cpp` build the worklet node with `numberOfInputs: 0`, and it
  // then emits SILENCE while still loading SynthDefs and answering /status —
  // a failure that looks like everything working.
  let serverBooted = false;
  (globalThis as unknown as Record<string, unknown>)["bootServer"] = (options: unknown) => {
    if (serverBooted) {
      log("  (bootServer: already running)");
      return;
    }
    serverBooted = true;
    log(`  bootServer(${JSON.stringify(options)})`);
    scsynth.boot(options);
  };

  const sawLine = (s: string): boolean => scLog.some((l) => l.includes(s));

  async function until(pred: () => boolean, ms: number, what: string): Promise<boolean> {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (pred()) return true;
      await sleep(50);
    }
    log(`    …timed out after ${ms} ms waiting for ${what}`);
    return false;
  }

  /**
   * E9-106 — THE CLASS FILES ARRIVE AT ONCE, NOT ONE AFTER THE OTHER.
   *
   * Every injector below used to `await fetch` inside its own loop, and
   * between them that is 184 round trips taken strictly in turn. Measured on
   * the DEPLOYED page, from `performance.getEntriesByType("resource")`, with
   * peak concurrency ONE for every one of them:
   *
   *     norns-sc/sc3      110 files   4076 ms
   *     norns-sc/ported    39 files    439 ms
   *     norns-sc/mi        14 files    320 ms
   *     norns-sc/extra      5 files     78 ms
   *     norns-sc (root)    16 files      —   (interleaved with the above)
   *
   * — about 4.9 s of a 12 s boot spent waiting for 67 KB. The proof that it
   * is latency and not bytes was already in the same boot: the STK
   * wavetables above fetch 42 files through `Promise.all` and take 62 ms.
   *
   * TWELVE, AND TWELVE IS MEASURED. The same 110 sc3 files against the
   * deployed origin with the cache defeated, three runs each, median: 1 at a
   * time 1860 ms, 6 -> 297, 8 -> 232, 12 -> 179, 16 -> 146, 24 -> 234 and
   * wildly unstable (2682 / 110 / 234). Sixteen is marginally faster and
   * twenty-four is where the connection starts fighting itself, so the pool
   * sits below the knee rather than on it.
   *
   * The results come back IN ORDER and the MEMFS writes stay on one thread,
   * so what lands on disk does not depend on which response won: only the
   * waiting is overlapped.
   *
   * A file that fails comes back as a null BODY AND A REASON rather than as
   * an exception. Most of these classes are optional and their callers
   * already count what arrived and say so when the count is short — but
   * `injectNorns`'s own twenty are not optional, and `fetch
   * Engine_PolyPerc.sc: 404` is the line that says which build is broken.
   * Throwing from inside the pool would lose the eleven answers in flight
   * and report whichever happened to fail first.
   */
  const FETCH_POOL = 12;

  interface Fetched {
    readonly body: Uint8Array | null;
    /** Why it is missing, when it is. */
    readonly why: string | null;
  }

  async function fetchAll(urls: readonly string[]): Promise<Fetched[]> {
    const out: Fetched[] = new Array<Fetched>(urls.length).fill({ body: null, why: "not tried" });
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= urls.length) return;
        try {
          const res = await fetch(urls[i]!);
          out[i] = res.ok
            ? { body: new Uint8Array(await res.arrayBuffer()), why: null }
            : { body: null, why: String(res.status) };
        } catch (e) {
          out[i] = { body: null, why: (e as Error).message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_POOL, urls.length) }, worker));
    return out;
  }

  /**
   * Write a script's own SuperCollider classes into MEMFS.
   *
   * THIS IS WHY A COMMUNITY SCRIPT WITH ITS OWN ENGINE DID NOT WORK. norns
   * puts `~/dust/code` on sclang's class path, so every `Engine_*.sc` any
   * script ships is compiled into the class library at startup and appears
   * in `engine.names`. Here only the 20 norns classes were injected, so
   * `amen` — which does `engine.name = "Amen"` — asked for an engine sclang
   * had never heard of. The script loads, draws its splash, and has no
   * engine; nothing says why, because from Lua's side the name is simply
   * not in the list.
   *
   * The directory structure is kept rather than flattened: two scripts can
   * ship a file with the same NAME, and only one of them can win in a flat
   * directory. (Two scripts shipping the same CLASS name is a different
   * problem, and it breaks the class library on norns too.)
   *
   * A `.sc` file that does not compile takes the WHOLE class library with
   * it — on hardware as well. That is why the count is logged: 20 classes
   * injected and sclang refusing to compile is a different situation from
   * 20 and a working library.
   */
  async function injectSc3Classes(FS: NonNullable<typeof sclang.FS>): Promise<number> {
    let n = 0;
    // E9-28 — the list comes from the build, not from here.
    //
    // `SC3_CLASSES` below was eight names and is now the FALLBACK: a
    // `public/` built before this change has no manifest, and the eight it
    // does have should still be injected rather than none. The build writes
    // `sc3/index.json` beside the files it copied, so adding a UGen set
    // cannot leave the page fetching a list that no longer matches what is
    // on disk.
    let names: readonly string[] = SC3_CLASSES;
    try {
      const res = await fetch(`${nornsScUrl}/sc3/index.json`);
      if (res.ok) {
        const body: unknown = await res.json();
        if (Array.isArray(body) && body.every((x) => typeof x === "string")) {
          names = body as string[];
        }
      }
    } catch {
      /* no manifest: the eight below are what this build had */
    }
    const bodies = await fetchAll(names.map((name) => `${nornsScUrl}/sc3/${name}`));
    for (const [i, got] of bodies.entries()) {
      // A null is a file this checkout does not have; the UGens are missing
      // too, and that is said elsewhere.
      if (got.body === null) continue;
      FS.writeFile(`/sc/SCClassLibrary/norns/${names[i]!}`, got.body);
      n++;
    }
    if (n > 0 && n < names.length) {
      // Half a set is worse than none: a script would find some of the
      // names and not others, and the error would name the second one.
      log(`sc3-plugins: only ${n} of ${names.length} classes injected`);
    }
    return n;
  }

  /**
   * Tell sclang which UGens this server has.
   *
   * `NornsJsSynthDefOverride.sc` refuses a def naming anything else, because
   * scsynth throws on an unknown UGen and a throw with exceptions off aborts
   * the thread that handles `/d_recv` -- killing every later SynthDef, poll
   * and sound in the session.
   *
   * It goes in as a MEMFS file rather than as evaluated source: the list is
   * 394 names and `runCode` of a 6 KB literal is a parse at boot, where a
   * file is read once by the class that wants it. One name per line rather
   * than JSON, because sclang has no JSON parser and `split` is the whole
   * reader. A missing file means no checking, which is the safe direction.
   */
  async function loadUGenList(): Promise<number> {
    const FS = sclang.FS;
    if (!FS) return 0;
    try {
      const res = await fetch(`${nornsScUrl}/ugens.json`);
      if (!res.ok) {
        log(
          "ugens.json is missing; SynthDefs will not be checked before sending " +
            "— one unknown UGen will take the audio server down for the session. " +
            "Run: npm run ugens",
        );
        return 0;
      }
      const list = (await res.json()) as string[];
      FS.writeFile("/sc/ugens.txt", list.join("\n"));
      return list.length;
    } catch (e) {
      log(
        `ugens.json: ${(e as Error).message} — SynthDefs will not be checked, ` +
          "and one unknown UGen will take the audio server down for the session.",
      );
      return 0;
    }
  }

  /**
   * The sound-file manifest, as `path \t frames \t channels \t rate`.
   *
   * Tab-separated rather than JSON for the same reason as the UGen list:
   * sclang has no JSON parser and `split` is the whole reader.
   */
  function writeSoundFileTable(): number {
    const FS = sclang.FS;
    const files = opts.soundFiles;
    if (!FS || files === undefined || files.size === 0) return 0;
    const lines: string[] = [];
    for (const [path, info] of files) {
      lines.push(`${path}\t${info.frames}\t${info.channels}\t${info.sampleRate}`);
    }
    try {
      FS.writeFile("/sc/soundfiles.txt", lines.join("\n"));
      log(`sound files: ${lines.length} described for SoundFile.openRead`);
      return lines.length;
    } catch (e) {
      log(`soundfiles.txt: ${(e as Error).message}`);
      return 0;
    }
  }

  /**
   * The same, for PortedPlugins. E9-35.
   *
   * Read from `ported/index.json`, which the build writes beside the files
   * it copied — 38 of them, which is well past the point where a list kept
   * here would drift from the one on disk.
   */
  async function injectPortedClasses(FS: NonNullable<typeof sclang.FS>): Promise<number> {
    let names: string[];
    try {
      const res = await fetch(`${nornsScUrl}/ported/index.json`);
      if (!res.ok) return 0;
      const body: unknown = await res.json();
      names = Array.isArray(body) ? body.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return 0; // no checkout; the UGens are missing too
    }
    let n = 0;
    const bodies = await fetchAll(names.map((name) => `${nornsScUrl}/ported/${name}`));
    for (const [i, got] of bodies.entries()) {
      if (got.body === null) continue; // one file; the count below says so
      FS.writeFile(`/sc/SCClassLibrary/norns/${names[i]!}`, got.body);
      n++;
    }
    if (n > 0 && n < names.length) {
      log(`PortedPlugins: only ${n} of ${names.length} classes injected`);
    }
    return n;
  }

  /**
   * The same, for mi-UGens and for the PTR oscillators.
   *
   * E9-36: the lists come from the build's own manifests now. `MI_CLASSES`
   * below is the fallback for a `public/` built before they existed.
   */
  async function injectFromIndex(
    FS: NonNullable<typeof sclang.FS>,
    dir: string,
    fallback: readonly string[] = [],
  ): Promise<number> {
    let names: readonly string[] = fallback;
    try {
      const res = await fetch(`${nornsScUrl}/${dir}/index.json`);
      if (res.ok) {
        const body: unknown = await res.json();
        if (Array.isArray(body) && body.every((x) => typeof x === "string")) names = body;
      }
    } catch {
      /* no manifest: the fallback is what this build had */
    }
    let n = 0;
    const bodies = await fetchAll(names.map((name) => `${nornsScUrl}/${dir}/${name}`));
    for (const [i, got] of bodies.entries()) {
      if (got.body === null) continue; // no checkout; the UGens are missing too
      FS.writeFile(`/sc/SCClassLibrary/norns/${names[i]!}`, got.body);
      n++;
    }
    if (n > 0 && n < names.length) {
      log(`${dir}: only ${n} of ${names.length} classes injected`);
    }
    return n;
  }

  async function injectExtraClasses(FS: NonNullable<typeof sclang.FS>): Promise<number> {
    const extra = opts.extraClasses;
    if (extra === undefined || extra.size === 0) return 0;
    const made = new Set<string>();
    const mkdirp = (dir: string) => {
      const parts = dir.split("/").filter((x) => x !== "");
      let at = "";
      for (const part of parts) {
        at += "/" + part;
        if (made.has(at)) continue;
        made.add(at);
        try {
          FS.mkdir(at);
        } catch {
          /* already there */
        }
      }
    };
    let n = 0;
    for (const [name, body] of extra) {
      const path = `/sc/SCClassLibrary/dust/${name}`;
      mkdirp(path.slice(0, path.lastIndexOf("/")));
      FS.writeFile(path, body);
      n++;
    }
    return n;
  }

  /** Write the norns class library into MEMFS. MUST precede bootInterpreter. */
  async function injectNorns(): Promise<number> {
    const FS = sclang.FS;
    if (!FS) {
      throw new Error("Module.FS is not exported — rebuild with -sEXPORTED_RUNTIME_METHODS=FS");
    }
    // Idempotent. With the preload gone these directories may already be
    // there — the archive is unpacked first, and emscripten raises EEXIST
    // (errno 20, not 17) rather than returning. A bare `mkdir` here threw
    // an `ErrnoError` with no message and took the whole boot with it.
    const mkdir = (p: string): void => {
      try {
        FS.mkdir(p);
      } catch (err) {
        if ((err as { errno?: number }).errno !== 20) throw err;
      }
    };
    mkdir("/sc/SCClassLibrary/norns");
    mkdir("/sc/SCClassLibrary/norns/SystemOverwrites");

    let n = 0;
    // STILL FATAL, and still names the file. These twenty are norns itself:
    // without them sclang comes up as plain SuperCollider and every engine in
    // the catalogue is missing, so a 404 here is a broken build rather than a
    // missing option.
    const core = await fetchAll(NORNS_CLASSES.map((name) => `${nornsScUrl}/${name}`));
    for (const [i, got] of core.entries()) {
      if (got.body === null) throw new Error(`fetch ${NORNS_CLASSES[i]!}: ${got.why}`);
      FS.writeFile(`/sc/SCClassLibrary/norns/${NORNS_CLASSES[i]!}`, got.body);
      n++;
    }
    for (const [name, body] of Object.entries(INLINE_OVERRIDES)) {
      FS.writeFile(`/sc/SCClassLibrary/norns/${name}`, body);
      n++;
    }
    for (const [p, body] of Object.entries(OVERRIDE_FILES)) {
      const name = p.slice(p.indexOf("SystemOverwrites/"));
      FS.writeFile(`/sc/SCClassLibrary/norns/${name}`, body);
      n++;
    }
    n += await injectSc3Classes(FS);
    n += await injectFromIndex(FS, "mi", MI_CLASSES);
    n += await injectFromIndex(FS, "extra");
    n += await injectPortedClasses(FS);
    await loadUGenList();
    writeSoundFileTable();
    n += await injectExtraClasses(FS);
    return n;
  }

  async function bootSclang(): Promise<boolean> {
    sclang.bootInterpreter();
    if (!(await until(() => sawLine("Welcome to SuperCollider"), 90000, "the class library"))) {
      return false;
    }

    // THE BANNER IS NOT THE READY SIGNAL, and taking it for one is a race
    // this port lost about one boot in four.
    //
    // `wasmWorkerThreadFunction` is:
    //
    //     compileLibrary(false, false);     // prints the banner, among much else
    //     gInterpreterStatus = Running;     // only now will runCode do anything
    //     client.runMain();
    //
    // "*** Welcome to SuperCollider" is posted by `Process.startup`, from
    // INSIDE `compileLibrary`. So the line we wait for is printed just
    // before the status flips, and the next thing we do is `runCode` — which
    // checks that status, prints "sclang client not running!" and RETURNS.
    // Not an error, not an exception: the boot simply never happened, and
    // the page sat on a blank screen with a class library that had compiled
    // perfectly.
    //
    // So ask the interpreter instead of inferring. `runCode` before it is
    // Running costs one line of stdout and nothing else, which makes it safe
    // to repeat until it answers.
    // Not `until`, which logs a line every time it gives up — a hundred of
    // those would bury the one that matters.
    const probe = "NORNSJS-LANG-READY";
    for (let i = 0; i < 100; i++) {
      sclang.runCode(`"${probe}".postln;`);
      await sleep(50);
      if (sawLine(probe)) return true;
    }
    log("sclang compiled its class library but never started accepting code");
    return false;
  }

  /**
   * Make sure the AudioContext is actually running, asking the user if the
   * browser insists.
   *
   * A context created without a user gesture starts SUSPENDED, and a
   * suspended context does not run its worklets. Since that is where
   * scsynth lives, a suspended context is a server that cannot execute a
   * single sample — or answer anything.
   *
   * NOTHING HERE AWAITS `resume()`, and that is the entire lesson of this
   * function. Chrome does not reject a resume that is not allowed yet: it
   * logs "The AudioContext was not allowed to start" and leaves the promise
   * **pending for ever**, until a gesture happens. So `await ctx.resume()`
   * is not a check, it is a trap — it hangs before the code that would have
   * told the user to click, which is precisely the bug this replaced.
   * Reported twice from the same machine, the second time with the DevTools
   * line pointing straight at the await.
   *
   * So: ask, then watch the STATE, which is the only thing that tells the
   * truth about whether audio is running.
   */
  async function ensureRunning(ctx: AudioContext): Promise<boolean> {
    // Read through a call. `ctx.state` is a live getter that `resume()`
    // changes, and TypeScript narrows the property across an await as
    // though it could not.
    const state = (): string => ctx.state;
    // Fired and forgotten, never awaited. The catch is for browsers that
    // DO reject; the ones that hang are handled by not waiting on it.
    const ask = (): void => void Promise.resolve(ctx.resume()).catch(() => {});
    const settles = async (ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (state() === "running") return true;
        await sleep(25);
      }
      return state() === "running";
    };

    if (state() === "running") return true;
    ask();
    if (await settles(400)) return true;

    log("audio: the browser is holding the engine until you touch the page — click anywhere");
    opts.onNeedsGesture?.(true);
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    const go = (): void => ask();
    for (const e of events) globalThis.addEventListener(e, go, true);
    try {
      // No timeout: waiting for a click is not a failure, and giving up
      // would put us back to declaring a dead server that is merely
      // asleep. The rest of the page runs meanwhile.
      while (state() !== "running") await sleep(100);
    } finally {
      for (const e of events) globalThis.removeEventListener(e, go, true);
      opts.onNeedsGesture?.(false);
    }
    log(`  AudioContext resumed → ${state()}`);
    return true;
  }

  async function bootServerFromSclang(): Promise<{ ready: boolean; ctx: AudioContext | null }> {
    scLog.length = 0;

    /**
     * E9-152 — THE GESTURE IS ASKED FOR BEFORE THE BOOT, NOT DURING IT.
     *
     * The order below already fixed one version of this: resume the
     * context, THEN wait for the handshake. It left the boot itself on
     * the wrong side of the wait. `waitForBoot` was sent first, so
     * sclang was trying to bring a server up inside a suspended context
     * — and when its `/notify` went unanswered it retried, once a
     * second, for as long as the page waited for a finger.
     *
     * Then the finger arrived, scsynth started, and received all of them
     * at once. From a Pixel 9 Pro:
     *
     *     13.336 audio: the browser is holding the engine until you touch
     *     19.032 | Requested notification messages from server 'localhost'   x6
     *     19.113 scsynth died: map::at:  key not found
     *     25.150 engine: the server has stopped completing /d_recv …
     *     27.509 s| *** ERROR: SynthDef adc not found
     *
     * Ninety seconds of a session with no audio engine at all, and every
     * `SynthDef … not found` after it is that one line's consequence.
     *
     * A THROWAWAY CONTEXT IS THE PROBE. The real one does not exist until
     * scsynth makes it, which is the chicken and egg that put the boot
     * first in the first place; a context of our own answers the only
     * question that matters — will this page let audio start — and the
     * gesture that unlocks it unlocks the page, not that object. On a
     * page that is already allowed this costs one construction and one
     * close, and `state` is "running" immediately.
     */
    try {
      // THE UNCAPTURED ONE. `installCapture` replaces the global with a
      // subclass that records every context built, and the boot takes
      // `captured.ctxs[0]` as the one to wire everything to. A probe
      // built through the global takes that place, and the graph is then
      // assembled on a context this function has already closed.
      const Ctor = uncapturedAudioContext();
      if (Ctor !== undefined) {
        const probe = new Ctor();
        if (probe.state !== "running") await ensureRunning(probe);
        // NOT AWAITED, and the probe found that out: `close()` on a
        // context that is already running did not settle under Electron,
        // so the boot below never ran and the package self-check came
        // back with `the audio graph never arrived` and five failures.
        // Nothing here needs the close to finish -- the probe has already
        // answered, and letting it go is tidying, not a step.
        void probe.close().catch(() => {});
      }
    } catch {
      // A browser that will not make one is a browser that will not run
      // the server either; the boot below reports that in its own words.
    }

    sclang.runCode(`Server.local.waitForBoot { "NORNSJS-SERVER-READY".postln; };`);

    // THE CONTEXT IS RESUMED BEFORE THE HANDSHAKE IS WAITED FOR, and the
    // order is the whole of this function.
    //
    // It used to be the other way round: wait 45 s for the handshake, then
    // resume. scsynth runs in that context's worklet, so while it is
    // suspended the server cannot answer — the wait was guaranteed to
    // expire, every time, on any page the user had not clicked on first.
    // Chrome suspends by default, so "every time" meant every first visit.
    //
    // Reported from a clean Windows machine, and the log read exactly like
    // a dead server: `timed out after 45000 ms waiting for the server
    // handshake`, then `AudioContext resumed → running` AFTERWARDS — the
    // resume arriving when the user finally clicked something — then
    // `scsynth did not come up`, and a cascade of duplicate node IDs as
    // sclang kept retrying a boot the host had already given up on.
    await until(() => captured.ctxs.length > 0, 8000, "the AudioContext");
    const ctx = captured.ctxs[0] ?? null;
    if (ctx && !(await ensureRunning(ctx))) {
      log("audio: the AudioContext would not start, so the server cannot run");
      return { ready: false, ctx };
    }

    const ready = await until(() => sawLine("NORNSJS-SERVER-READY"), 45000, "the server handshake");
    await until(() => captured.toDestination.length > 0, 8000, "the server's output");
    return { ready, ctx };
  }

  return {
    sclang,
    scsynth,
    scLog,
    sawLine,
    until,
    injectNorns,
    bootSclang,
    bootServerFromSclang,
    transport,
    status,
    /** Ask the server what its load is. The answer lands in `status`. */
    pollStatus: (): void => scsynth.sendOsc(encodeMessage("/status", [])),
    sendToServer: (address, args = []) =>
      timed("osc:to-server", () => scsynth.sendOsc(encodeMessage(address, args))),
    syncServer: (timeoutMs = 4000): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const id = nextSyncId++;
        let settled = false;
        const done = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          syncWaiting.delete(id);
          resolve(ok);
        };
        syncWaiting.set(id, done);
        // A deadline, because a server that has stopped answering must
        // not take the page with it. Four seconds is far past the
        // hundreds of milliseconds a megabyte of samples takes and far
        // short of anything a person would wait through on purpose.
        setTimeout(() => done(false), timeoutMs);
        scsynth.sendOsc(encodeMessage("/sync", [id]));
      }),
    peekBuffer: (bufnum, index, count, timeoutMs = 2000): Promise<number[] | null> =>
      new Promise<number[] | null>((resolve) => {
        const key = `${bufnum}:${index}`;
        let settled = false;
        const done = (v: number[] | null): void => {
          if (settled) return;
          settled = true;
          peekWaiting.delete(key);
          resolve(v);
        };
        peekWaiting.set(key, done);
        setTimeout(() => done(null), timeoutMs);
        scsynth.sendOsc(encodeMessage("/b_getn", [bufnum, index, count]));
      }),
    sendToLang: (address, args = []) =>
      timed("osc:to-lang", () => sclang.sendOsc(encodeMessage(address, args))),
    runCode: (code: string) => sclang.runCode(code),
    get context() {
      return captured.ctxs[0] ?? null;
    },
  };
}

export { captured };
