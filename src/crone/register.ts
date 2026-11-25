// E4-07 / E4-08 / E4-09 — bind crone to the `_norns` boundary.
//
// 62 of the 178, and the count is not mine: `src/crone/lua-surface.json` is
// derived from weaver.cc, oracle.cc and crone.h by
// `tools/extract-crone-lua.mjs`, and it comes to 62 on its own. p1-api-plan
// §0.3 said 62 from a different direction, which is the kind of agreement
// worth noticing.
//
// WHY THE MAPPING IS DERIVED AND NOT TYPED OUT. The chain is three files
// deep and the names do not line up at the end of it:
//
//   _norns.level_cut_rev  ->  o_set_level_cut_rev
//                         ->  crone_set_level_cut_rev
//                         ->  Commands::Id::SET_LEVEL_CUT_AUX
//
// The Lua name says "rev", the command says "AUX". Written by hand that is
// either a command that does not exist — a loud failure, fine — or
// `SET_LEVEL_CUT`, which does exist, takes different arguments, and would
// quietly set a voice's output level instead. Fifty-odd chances at that.
//
// So the mechanical ones are a loop over the manifest. The six that are not
// mechanical are written out, with upstream's own body quoted, because
// `monitor_mix_mono` is four calls with literal arguments and no table can
// say that.

import type { NornsRegistry } from "../norns/registry.js";
import type { Callbacks } from "../norns/callbacks.js";
import type { Crone, CroneEvents, WrittenFile } from "./crone.js";
import type { Vfs } from "../fs/vfs.js";
import { encodeWav, bitsFromFormat, interleave } from "./wav.js";
import surface from "./lua-surface.json" with { type: "json" };

interface PostSpec {
  readonly fn: string;
  readonly queue: "mixer" | "softcut";
  readonly id: string;
  readonly argc: number;
  readonly arity: string;
}
interface SurfaceEntry {
  readonly name: string;
  readonly args: number;
  readonly crone: readonly string[];
  readonly via:
    | { readonly kind: "post"; readonly posts: readonly PostSpec[] }
    | { readonly kind: "dispatch"; readonly family: string }
    | { readonly kind: "direct" };
}
const ENTRIES = surface.functions as unknown as readonly SurfaceEntry[];

/**
 * Nothing is deferred any more. E4-11 bound the last twenty-four.
 *
 * Kept as an empty table rather than deleted, because test/crone-lua.test.ts
 * holds the implemented set to "the manifest minus this", and a test that
 * reads an empty exclusion list is the clearest statement that there is one.
 */
export const CRONE_DEFERRED: Readonly<Record<string, string>> = {};

/**
 * The sixteen that need `files`.
 *
 * Twelve of them open something. The other four — `tape_play_loop`,
 * `tape_loop`, `tape_pause`, `tape_resume` — are pure transport and would
 * work without a filesystem, but they are gated with the rest because a tape
 * that cannot open a file has nothing to pause.
 *
 * Without `files` they stay stubs rather than failing per call: a page that
 * wires crone without a filesystem is a legitimate thing to build — both
 * spike pages do exactly that — and `softcut.lua` calls
 * `_norns.cut_buffer_clear()` while a script loads, where a throw takes the
 * script down rather than the one feature.
 */
export const CRONE_NEEDS_FILES: readonly string[] = [
  "cut_buffer_read_mono",
  "cut_buffer_read_stereo",
  "cut_buffer_write_mono",
  "cut_buffer_write_stereo",
  "tape_record_open",
  "tape_record_start",
  "tape_record_pause",
  "tape_record_stop",
  "tape_play_open",
  "tape_play_start",
  "tape_play_pause",
  "tape_play_stop",
  "tape_play_loop",
  "tape_loop",
  "tape_pause",
  "tape_resume",
];

/**
 * Where the tape's two paths live, shared between the registration and the
 * writer that encodes what comes back.
 *
 * `_norns.tape_rec_file` fires on OPEN, carrying the path: `o_tape_rec_open`
 * posts that event next to the crone call, so it is matron's, not crone's.
 * The CLOSE comes from crone's own poll and carries no path at all —
 * `o_poll_callback_tape_file` sets it to NULL with a comment saying the
 * engine does not propagate it. So the path is remembered here, and the
 * close reaches Lua as nil.
 */
export interface CroneTapePaths {
  play: string | null;
  rec: string | null;
}
export function createTapePaths(): CroneTapePaths {
  return { play: null, rec: null };
}

/** The six polls, by the name their `Poll` was constructed with. */
const POLL_NAMES: Readonly<Record<string, { poll: string; on: boolean }>> = {
  poll_start_vu: { poll: "vu", on: true },
  poll_stop_vu: { poll: "vu", on: false },
  poll_start_tape: { poll: "tape", on: true },
  poll_stop_tape: { poll: "tape", on: false },
  poll_start_cut_phase: { poll: "softcut/phase", on: true },
  poll_stop_cut_phase: { poll: "softcut/phase", on: false },
};

export interface CroneRegisterOptions {
  readonly onStub?: (name: string, why: string) => void;
  readonly log?: (line: string) => void;
  /**
   * Called when a script opens the audio input into a softcut voice.
   *
   * E9-173 — the caller knows whether there IS an input; this file only
   * knows that something just asked for one.
   */
  readonly onWantsInput?: () => void;
  /**
   * What the sixteen file-touching functions need.
   *
   * `decode` is separate from an AudioContext on purpose: in a browser it is
   * `decodeAudioData`, and in a test it is anything that returns channels —
   * which is what makes the twelve testable without a browser.
   */
  readonly files?: {
    readonly vfs: Vfs;
    readonly decode: (bytes: Uint8Array) => Promise<{
      numberOfChannels: number;
      length: number;
      sampleRate: number;
      getChannelData(ch: number): Float32Array;
    }>;
    readonly paths?: CroneTapePaths;
    /** For `_norns.tape_rec_file` on open, which matron posts, not crone. */
    readonly callbacks?: Callbacks;
  };
}

/**
 * E9-233 — WHERE MATRON SUBTRACTS ONE, and which argument.
 *
 * Lua counts softcut's voices 1..6 and its buffers 1..2; crone counts them
 * from 0. matron is the only translator between the two: `weaver.cc` takes
 * one off each voice and buffer index as it reads it (`luaL_checkinteger(l,
 * 2) - 1`), and crone's events come back 0-based for it to add the one again
 * (`w_handle_poll_softcut_phase` pushes `idx + 1`, as callbacks.ts does here).
 *
 * This port added the one on the way back and never took it off on the way
 * in. So Lua's voice 1 drove crone's SECOND voice and reported itself as
 * voice 2; voice 6 fell off the end onto voice 5; buffers 1 and 2 were the
 * same buffer. Most scripts sounded right, because a consistent shift is
 * invisible — until one tracked its voice positions (piwip never saw voice 1
 * move and stayed silent), recorded left and right into the two buffers, or
 * used all six voices.
 *
 * Copied from weaver.cc, function by function: the 0-based position of each
 * argument matron takes one off (note `cut_param_ii`, which treats its value
 * as an index too: `softcut.buffer(voice, buffer)`).
 */
export const ONE_BASED: Readonly<Record<string, readonly number[]>> = {
  cut_enable: [0],
  level_cut: [0],
  level_cut_cut: [0, 1],
  pan_cut: [0],
  level_input_cut: [0, 1],
  cut_param: [1],
  cut_param_ii: [1, 2],
  cut_param_iif: [1, 2],
  cut_buffer_clear_channel: [0],
  cut_buffer_clear_region_channel: [0],
  cut_buffer_copy_mono: [0, 1],
  cut_buffer_read_mono: [4, 5],
  cut_buffer_write_mono: [3],
  cut_buffer_render: [0],
  cut_query_position: [0],
};

export function registerCrone(
  registry: NornsRegistry,
  crone: Crone,
  opts: CroneRegisterOptions = {},
): void {
  const log = opts.log ?? (() => {});

  // --- the mechanical ones --------------------------------------------
  //
  // One command, fixed arity, arguments straight through. The id, the queue
  // and the arity all come from the manifest; the only thing decided here is
  // that a Lua number becomes a number.
  for (const entry of ENTRIES) {
    if (entry.via.kind !== "post") continue;
    if (entry.args === 0) continue; // the literal-argument six, below
    if (entry.via.posts.length !== 1) continue;
    const post = entry.via.posts[0]!;
    if (post.argc !== entry.args) {
      // Upstream's C takes a different number of arguments than Lua hands
      // it. That is not something to paper over at run time.
      throw new Error(
        `crone: ${entry.name} takes ${entry.args} from Lua but ${post.fn} takes ${post.argc}`,
      );
    }
    registry.implement(entry.name, (...args) => {
      /**
       * E9-173 — A LOOPER WITH NOTHING TO LOOP SAYS NOTHING ON ITS OWN.
       *
       * `level_input_cut(channel, voice, amp)` is how a script opens the
       * audio INPUT into a softcut voice, and it is the whole basis of
       * `mlr` and `oooooo`: neither has an engine worth the name, and
       * everything they play they first record from what is coming in.
       *
       * On a norns there is always an input. In a browser tab it is OFF
       * until somebody turns it on and grants a microphone, so these
       * load, draw, answer every key, and stay silent for ever. Both
       * were reported as "no sound, but maybe I don't know how to use
       * it" — and the person asking was right, which is the worst way
       * to find out something is missing.
       */
      if (entry.name === "level_input_cut" && Number(args[2]) > 0) opts.onWantsInput?.();
      crone.command(post.id as never, ...args.map(Number));
    });
  }

  // --- the named parameters --------------------------------------------
  //
  // `cut_param("rate", voice, value)` and its two siblings, plus the reverb
  // and compressor. The NAME is checked against the generated table before
  // it crosses: crone resolves it with `std::map::at` inside a `try`, and
  // this build has exceptions off, so an unknown name aborts the module
  // rather than printing a line (research/crone-port.md §3).
  const param = (name: string, args: readonly unknown[]) => {
    try {
      crone.param(String(name), ...args.map(Number));
    } catch (err) {
      // A script asking for a parameter this crone does not have is a script
      // bug, not a reason to take the audio engine down.
      // The message already names crone; prefixing again reads as
      // `crone: crone: no parameter "x"`.
      log((err as Error).message);
    }
  };
  registry.implement("cut_param", (name, voice, value) => param(String(name), [voice, value]));
  registry.implement("cut_param_ii", (name, voice, value) => param(String(name), [voice, value]));
  registry.implement("cut_param_iif", (name, a, b, value) => param(String(name), [a, b, value]));
  registry.implement("rev_param", (name, value) => param(String(name), [value]));
  registry.implement("comp_param", (name, value) => param(String(name), [value]));

  // --- the six with literal arguments ----------------------------------
  //
  // oracle.cc, quoted, because the literals are the whole content:
  //
  //   void o_set_rev_on()  { crone_set_enabled_reverb(1); }
  //   void o_set_rev_off() { crone_set_enabled_reverb(0); }
  //   void o_set_comp_on()  { crone_set_enabled_compressor(1); }
  //   void o_set_comp_off() { crone_set_enabled_compressor(0); }
  //
  // `SET_ENABLED_REVERB` takes a FLOAT, not a bool — `MixerClient` reads
  // `p->value > 0.f`. Sending an int through the (int, float) entry point
  // would fill the wrong union member.
  registry.implement("rev_on", () => crone.command("SET_ENABLED_REVERB", 1));
  registry.implement("rev_off", () => crone.command("SET_ENABLED_REVERB", 0));
  registry.implement("comp_on", () => crone.command("SET_ENABLED_COMPRESSOR", 1));
  registry.implement("comp_off", () => crone.command("SET_ENABLED_COMPRESSOR", 0));

  //   void o_set_monitor_mix_mono() {
  //       crone_set_level_monitor_mix(0, 0.5);  ... (1, 0.5) (2, 0.5) (3, 0.5)
  //   }
  //   void o_set_monitor_mix_stereo() {
  //       crone_set_level_monitor_mix(0, 1.0);  (1, 0.0) (2, 0.0) (3, 1.0)
  //   }
  //
  // Four entries because the monitor matrix is 2x2: in-left to out-left,
  // in-left to out-right, in-right to out-left, in-right to out-right. Mono
  // is both inputs at half into both outputs; stereo is the diagonal.
  registry.implement("monitor_mix_mono", () => {
    for (let i = 0; i < 4; i++) crone.command("SET_LEVEL_MONITOR_MIX", i, 0.5);
  });
  registry.implement("monitor_mix_stereo", () => {
    const diag = [1.0, 0.0, 0.0, 1.0];
    for (let i = 0; i < 4; i++) crone.command("SET_LEVEL_MONITOR_MIX", i, diag[i]!);
  });

  // --- the polls --------------------------------------------------------
  //
  // Upstream has six entry points, `crone_poll_start_vu` and friends. Here
  // one takes the name, because the shim that replaced `std::thread` already
  // keys on it — and it answers whether the name was known, which upstream's
  // six cannot get wrong but a string can.
  for (const [name, { poll, on }] of Object.entries(POLL_NAMES)) {
    registry.implement(name, () => {
      void crone.poll(poll, on).then((ok) => {
        if (!ok) log(`crone: no poll named ${poll}`);
      });
    });
  }

  // --- the one that answers through the ring ----------------------------
  //
  // `cut_query_position` returns NOTHING. The answer arrives later as
  // `_norns.softcut_position`, through the same ring as the meters, which is
  // upstream's shape — `crone_cut_query_position` calls
  // `o_poll_callback_softcut_position` rather than returning.
  registry.implement("cut_query_position", (voice) => {
    crone.node.port.postMessage({
      op: "param",
      entry: "cronejs_cut_query_position",
      types: ["number"],
      args: [Number(voice)],
    });
  });

  // --- the buffer operations that need no file --------------------------
  //
  // Eight of the twelve never open anything: they clear, copy, reset or
  // render inside softcut's own buffers. They queue a job and return, and
  // the pump in the render callback runs a slice of it per block.
  const N = "number";
  const S = "string";
  const call = (entry: string, types: readonly string[], args: readonly unknown[]) =>
    crone.call(entry, types, args);

  registry.implement("cut_buffer_clear", () => call("cronejs_cut_buffer_clear", [], []));
  registry.implement("cut_buffer_clear_channel", (ch) =>
    call("cronejs_cut_buffer_clear_channel", [N], [Number(ch)]),
  );
  registry.implement("cut_buffer_clear_region", (start, dur, fade, preserve) =>
    call("cronejs_cut_buffer_clear_region", [N, N, N, N], [start, dur, fade, preserve].map(Number)),
  );
  registry.implement("cut_buffer_clear_region_channel", (ch, start, dur, fade, preserve) =>
    call(
      "cronejs_cut_buffer_clear_region_channel",
      [N, N, N, N, N],
      [ch, start, dur, fade, preserve].map(Number),
    ),
  );
  registry.implement(
    "cut_buffer_copy_mono",
    (srcCh, dstCh, srcStart, dstStart, dur, fade, preserve, reverse) =>
      call(
        "cronejs_cut_buffer_copy_mono",
        [N, N, N, N, N, N, N, N],
        [srcCh, dstCh, srcStart, dstStart, dur, fade, preserve, reverse].map(Number),
      ),
  );
  registry.implement("cut_buffer_copy_stereo", (srcStart, dstStart, dur, fade, preserve, reverse) =>
    call(
      "cronejs_cut_buffer_copy_stereo",
      [N, N, N, N, N, N],
      [srcStart, dstStart, dur, fade, preserve, reverse].map(Number),
    ),
  );
  registry.implement("cut_buffer_render", (ch, start, dur, samples) =>
    call("cronejs_cut_buffer_render", [N, N, N, N], [ch, start, dur, samples].map(Number)),
  );
  registry.implement("cut_reset", () => call("cronejs_cut_reset", [], []));

  // --- the sixteen that need a filesystem -------------------------------
  const files = opts.files;
  if (files === undefined) {
    for (const name of CRONE_NEEDS_FILES) {
      opts.onStub?.(name, "needs a filesystem; pass `files` to registerCrone");
    }
    return;
  }

  const paths = files.paths ?? createTapePaths();

  /** Decode a file out of the VFS, or say why not. */
  async function decodeFromVfs(path: string) {
    let bytes = files!.vfs.read(path);
    if (bytes === null) {
      // NOT RESIDENT IS NOT ABSENT. A sound file a script ships is declared
      // in the manifest and fetched the first time something reads it, and
      // this reader used to stop at the declaration: softcut reported "no
      // such file" for a file the tree could list. `beets` copies its demo
      // loops into ~/dust/audio on the first run -- correctly, as lazy
      // declarations -- and then could not play one of them.
      //
      // `src/engine/buffers.ts` has always fetched. Two readers over one
      // tree, one of them blind to half of it.
      // A host may hand us a simpler filesystem than the page's: the two
      // lazy-loading methods are optional, and their absence means every
      // file is resident or absent.
      const lazy = files!.vfs as Partial<Pick<Vfs, "remoteAt" | "fetchRemote">>;
      if (lazy.remoteAt?.(path) == null || !lazy.fetchRemote) {
        log(`crone: no such file ${path}`);
        return null;
      }
      bytes = await lazy.fetchRemote(path);
      if (bytes === null) {
        log(`crone: ${path} could not be fetched`);
        return null;
      }
    }
    try {
      return await files!.decode(bytes);
    } catch (err) {
      // A file the browser will not decode is a real answer, not a crash.
      // norns reads whatever libsndfile reads; a browser reads a different
      // set, and the difference should name itself rather than appear as a
      // buffer that stayed silent.
      log(`crone: cannot decode ${path}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Stage the window a read is going to touch.
   *
   * `startSrc` and `dur` are SECONDS AT THE FILE'S RATE, which is not
   * necessarily the context's. Staging from frame 0 would spend the size cap
   * on audio nothing will read; staging the wrong number of frames has
   * `readBufferMono` seek outside the window and give up half way through a
   * sample, which sounds like a truncated file rather than a bug here.
   */
  async function stage(path: string, startSrc: number, dur: number): Promise<boolean> {
    const decoded = await decodeFromVfs(path);
    if (decoded === null) return false;
    const rate = decoded.sampleRate;
    // CLAMPED TO THE LAST FRAME, because `readBufferMono` clamps too:
    // `clamp(frSrc, file.frames() - 1)`. Staging from past the end would
    // leave an empty window, upstream would then seek to the clamped frame,
    // find it outside that window, and abandon the read — "error seeking to
    // frame; aborting read" for a file that is simply shorter than the
    // script thought.
    const first = Math.max(0, Math.min(Math.floor(startSrc * rate), Math.max(0, decoded.length - 1)));
    const wanted = dur < 0 ? decoded.length - first : Math.ceil(dur * rate) + 1;
    const frames = Math.max(0, Math.min(wanted, decoded.length - first));
    const pcm = interleave(decoded, first, frames);
    const ok = await crone.preloadFile({
      path,
      pcm,
      channels: decoded.numberOfChannels,
      rate,
      totalFrames: decoded.length,
      firstFrame: first,
      frames,
    });
    if (!ok) log(`crone: ${path} is too long to stage (${frames} frames)`);
    return ok;
  }

  // EVERY READ IS ASYNCHRONOUS AND THAT IS UPSTREAM'S SHAPE, not a
  // compromise. `Tape::Reader::open` stores a `pendingPath` and returns; the
  // disk thread opens it later. A script that calls `tape_play_open` and
  // then immediately `tape_play_start` works on hardware for the same reason
  // it works here: starting a transport with no file yet is a no-op, and the
  // file arrives. Lua gets its return before any of this has happened.
  registry.implement(
    "cut_buffer_read_mono",
    (path, startSrc, startDst, dur, chSrc, chDst, preserve, mix) => {
      const p = String(path);
      void stage(p, Number(startSrc), Number(dur)).then((ok) => {
        if (!ok) return;
        crone.call(
          "cronejs_cut_buffer_read_mono",
          [S, N, N, N, N, N, N, N],
          [
            p,
            Number(startSrc),
            Number(startDst),
            Number(dur),
            Number(chSrc),
            Number(chDst),
            Number(preserve),
            Number(mix),
          ],
        );
      });
    },
  );

  registry.implement("cut_buffer_read_stereo", (path, startSrc, startDst, dur, preserve, mix) => {
    const p = String(path);
    void stage(p, Number(startSrc), Number(dur)).then((ok) => {
      if (!ok) return;
      crone.call(
        "cronejs_cut_buffer_read_stereo",
        [S, N, N, N, N, N],
        [p, Number(startSrc), Number(startDst), Number(dur), Number(preserve), Number(mix)],
      );
    });
  });

  registry.implement("cut_buffer_write_mono", (path, start, dur, ch) =>
    crone.call(
      "cronejs_cut_buffer_write_mono",
      [S, N, N, N],
      [String(path), Number(start), Number(dur), Number(ch)],
    ),
  );
  registry.implement("cut_buffer_write_stereo", (path, start, dur) =>
    crone.call("cronejs_cut_buffer_write_stereo", [S, N, N], [String(path), Number(start), Number(dur)]),
  );

  // --- the tape ---------------------------------------------------------
  registry.implement("tape_record_open", (path) => {
    paths.rec = String(path);
    crone.call("cronejs_tape_rec_open", [S], [paths.rec]);
    // Upstream posts this next to the crone call, on OPEN — it is matron's
    // event, not crone's, and `core/tape.lua` uses it to show the filename
    // before anything has been recorded.
    files.callbacks?.tapeRecFile(paths.rec);
  });
  registry.implement("tape_record_start", () => crone.call("cronejs_tape_rec_start", [], []));
  registry.implement("tape_record_pause", (p) =>
    crone.call("cronejs_tape_rec_pause", [N], [Number(p)]),
  );
  registry.implement("tape_record_stop", () => crone.call("cronejs_tape_rec_stop", [], []));

  registry.implement("tape_play_open", (path) => {
    const p = String(path);
    void decodeFromVfs(p).then((decoded) => {
      if (decoded === null) return;
      paths.play = p;
      crone.resetTape();
      crone.call("cronejs_tape_play_prepare", [N, N], [decoded.length, decoded.sampleRate]);
      crone.call("cronejs_tape_play_open", [S], [p]);
      // The whole file, queued in one transfer. "Queued" is not "resident on
      // the audio thread": the worklet meters it into a four-second ring as
      // room appears.
      crone.feedTape(interleave(decoded));
      files.callbacks?.tapePlayFile(p);
    });
  });
  registry.implement("tape_play_start", () => crone.call("cronejs_tape_play_start", [], []));
  registry.implement("tape_play_pause", (p) =>
    crone.call("cronejs_tape_play_pause", [N], [Number(p)]),
  );
  registry.implement("tape_play_stop", () => {
    crone.call("cronejs_tape_play_stop", [], []);
    crone.resetTape();
    paths.play = null;
  });
  registry.implement("tape_play_loop", (l) =>
    crone.call("cronejs_tape_play_loop", [N], [Number(l)]),
  );
  registry.implement("tape_loop", (l) => crone.call("cronejs_tape_play_loop", [N], [Number(l)]));
  registry.implement("tape_pause", () => crone.call("cronejs_tape_pause", [], []));
  registry.implement("tape_resume", () => crone.call("cronejs_tape_resume", [], []));

  // E9-233 — last, so it wraps whatever each name was given above.
  for (const [name, positions] of Object.entries(ONE_BASED)) {
    const fn = registry.implementationFor(name);
    if (fn === undefined) continue;
    registry.implement(name, (...args) => fn(...args.map((a, i) => (positions.includes(i) ? Number(a) - 1 : a))));
  }
}

/**
 * Encode what crone wrote and put it in the VFS.
 *
 * Pass as `onFileWritten` to `startCrone`. The bit depth comes from the
 * format word crone asked for — `BufDiskWorker.cpp:449` asks for 24-bit, and
 * writing 16 would halve the dynamic range of every recording a script makes
 * with nothing anywhere to say so.
 */
export function croneFileWriter(vfs: Vfs, log: (line: string) => void = () => {}) {
  return (f: WrittenFile): void => {
    if (f.pcm.length === 0) {
      log(`crone: ${f.path} came back empty; nothing written`);
      return;
    }
    const wav = encodeWav({
      channels: f.channels,
      sampleRate: f.rate,
      samples: f.pcm,
      bits: bitsFromFormat(f.format),
    });
    vfs.write(f.path, wav);
    log(`crone: wrote ${f.path}, ${(wav.length / 1024).toFixed(0)} KB`);
  };
}

/**
 * Collect the tape as it records, and write it when it stops.
 *
 * The chunks arrive one render block at a time, so a long recording is a
 * list of small arrays rather than one that is reallocated as it grows.
 *
 * Upstream streams straight to disk and never holds the recording at all.
 * Here it is held until the stop, because an OPFS write is asynchronous and
 * a tape that paused for one would not be a tape. The cost is memory: an
 * hour of stereo at 48 kHz is 1.3 GB, which this will not survive. That is a
 * real limit and it is in research/crone-port.md rather than discovered.
 */
export function croneTapeWriter(
  vfs: Vfs,
  paths: CroneTapePaths,
  /**
   * REQUIRED, and before the optional arguments on purpose.
   *
   * It is the AudioContext's rate, not 48000. A default here would be the
   * same mistake upstream makes in `BufDiskWorker::writeBufferMono`, where
   * `const int sr = 48000;` is right on hardware and silently wrong in a
   * browser whose context is 44100 — the file then plays 8.8% fast and
   * nothing says so. Making it impossible to forget is cheaper than
   * measuring it again.
   */
  sampleRate: number,
  cb?: Callbacks,
  log: (line: string) => void = () => {},
) {
  let chunks: Float32Array[] = [];
  let frames = 0;
  return {
    onTapeData(pcm: Float32Array): void {
      chunks.push(pcm);
      frames += pcm.length / 2;
    },
    onTapeFinished(dropped: number): void {
      const path = paths.rec;
      const all = new Float32Array(frames * 2);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      chunks = [];
      frames = 0;
      if (path === null || all.length === 0) return;
      if (dropped > 0) {
        // Said once, with the number. A recording with a hole in it is
        // still worth keeping; one that pretends to be whole is not.
        log(`crone: tape dropped ${dropped} frames — the page could not keep up`);
      }
      vfs.write(path, encodeWav({ channels: 2, sampleRate, samples: all, bits: 24 }));
      log(`crone: tape wrote ${path}, ${(all.length / 2 / sampleRate).toFixed(1)} s`);
      paths.rec = null;
      // The CLOSE carries no path, as upstream's does not.
      cb?.tapeRecFile(null);
    },
  };
}

/**
 * The other direction: crone's polls into `_norns`.
 *
 * Pass the result as `events` to `startCrone`. It is separate from
 * `registerCrone` because the two are wired at different moments — the
 * events have to be in place when the node is built, and the registry only
 * exists once Lua does.
 *
 * Every index conversion lives in `makeCallbacks`, not here. Doing the +1 in
 * both places gives a voice that exists and is the wrong one.
 */
export function croneEvents(cb: Callbacks, log: (line: string) => void = () => {}): CroneEvents {
  /** The last tape reading handed to Lua, and when. E9-174. */
  let lastTape: {
    playState: number;
    playPos: number;
    playLen: number;
    recState: number;
    recPos: number;
    loop: number;
  } | null = null;
  let lastTapeAt = 0;
  return {
    vu: (levels) => {
      const err = cb.vu(levels);
      if (err) log(`_norns.vu: ${err.message}`);
    },
    softcutPhase: (voice, value) => {
      cb.softcutPhase(voice, value);
    },
    softcutPosition: (voice, value) => {
      cb.softcutPosition(voice, value);
    },
    softcutRender: (r) => {
      // `_norns.softcut_render(i, start, sec_per_sample, samples)` — the
      // order is NOT the order the record carries them in, and the C is the
      // authority: `w_handle_softcut_render` pushes start before
      // secPerSample. A swap here is a waveform drawn at the wrong scale,
      // which looks like a rendering bug rather than an argument order.
      cb.softcutRender(r.channel, r.start, r.secPerSample, Array.from(r.samples));
    },
    /**
     * E9-174 — TWENTY A SECOND, FOR A TAPE THAT IS NOT RUNNING.
     *
     * `MixerClient.cpp:62` sets the tape poll to 50 ms and crone sends
     * it whether or not anything is playing or recording. Every one of
     * them crossed into Lua, which is a `lua_pcall` and six pushes.
     *
     * Measured on a Pixel 9 Pro running `molly_the_poly`, which has no
     * tape in it at all:
     *
     *     105 ms over 1559 calls   tape_status
     *     110 ms over  595 calls   draw:grid
     *
     * — the same cost as rendering the whole grid, spent reporting six
     * numbers that never changed.
     *
     * So an identical reading is dropped. A HEARTBEAT KEEPS IT HONEST:
     * at least one call every two seconds whatever happens, because a
     * consumer that has reset its own state and is waiting to be told
     * where the tape is would otherwise wait for ever — and this file
     * cannot know whether there is one.
     */
    tapeStatus: (s) => {
      const now = Date.now();
      const same =
        lastTape !== null &&
        lastTape.playState === s.playState &&
        lastTape.playPos === s.playPos &&
        lastTape.playLen === s.playLen &&
        lastTape.recState === s.recState &&
        lastTape.recPos === s.recPos &&
        lastTape.loop === s.loop;
      if (same && now - lastTapeAt < 2000) return;
      lastTape = { ...s };
      lastTapeAt = now;
      cb.tapeStatus(s.playState, s.playPos, s.playLen, s.recState, s.recPos, s.loop);
    },
    tapeFile: (kind) => {
      // crone sends a TYPE, not a name: 0 = play_close, 1 = rec_close. The
      // path upstream passes is the one matron remembered when it opened the
      // file, and nothing here has opened one yet — E4-11.
      if (kind === 0) cb.tapePlayFile("");
      else cb.tapeRecFile("");
    },
  };
}
