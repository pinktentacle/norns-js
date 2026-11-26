// E4-16 — sound files into scsynth's buffers, decoded by the browser.
//
// scsynth is built `-DNO_LIBSNDFILE`, so `/b_allocRead` answers "scsynth
// compiled without libsndfile" and every `PlayBuf` on the result reports
// "Buffer UGen: no buffer data". Two things make building libsndfile for
// wasm the wrong answer rather than merely a large one:
//
//   1. `decodeAudioData` is already in the page and reads WAV, AIFF, FLAC,
//      mp3, ogg and m4a — MORE than libsndfile would give us — and it
//      resamples to the context's rate on the way in, which is exactly what
//      a buffer played at rate 1.0 needs.
//   2. scsynth is a separate wasm module with its own MEMFS. A script's
//      sound files are in the VFS on this thread. Even a scsynth that could
//      decode would have nothing to open.
//
// So the bytes go the other way: decoded here, pushed in with `/b_alloc` and
// `/b_setn`. `src/engine/sc-overrides/SystemOverwrites/NornsJsBufferOverride.sc`
// is the sclang half.

import type { Vfs } from "../fs/vfs.js";
import { stagedToDust } from "./dust-path.js";
import type { RawBufferRead } from "./raw-buffer-read.js";

export interface BufferLoaderOptions {
  readonly vfs: Vfs;
  /** For `decodeAudioData`, and for the rate the samples end up at. */
  readonly context: BaseAudioContext;
  readonly sendToServer: (address: string, args: readonly (number | string)[]) => void;
  /**
   * Wait for the server to have processed what was just sent. E9-171.
   *
   * Optional so a test can leave it out; absent means the old behaviour,
   * which is to assume.
   */
  readonly syncServer?: (timeoutMs?: number) => Promise<boolean>;
  /** Read samples back out of a server buffer, to check they arrived. E9-171. */
  readonly peekBuffer?: (
    bufnum: number,
    index: number,
    count: number,
    timeoutMs?: number,
  ) => Promise<number[] | null>;
  readonly sendToLang: (address: string, args: readonly (number | string)[]) => void;
  readonly log?: (line: string) => void;
}

/**
 * Samples per `/b_setn`.
 *
 * An OSC message carries its payload as 4 bytes a float plus a type tag a
 * byte, so 8192 samples is about 41 kB on the wire. The ceiling that matters
 * is not the protocol's — this never touches a datagram — but scsynth's
 * reply buffer and the cost of one big array in the audio thread's command
 * queue. A minute of stereo at 48 kHz is 5.76 M samples, so 700 messages:
 * worth keeping each one small.
 */
const CHUNK = 8192;

export function createBufferLoader(opts: BufferLoaderOptions) {
  const log = opts.log ?? (() => {});
  /** When a buffer was last read back, so a burst is checked once. E9-175. */
  let lastReadAt = -Infinity;
  /** The last file decoded, for reads of one file in pieces. E9-260. */
  let lastDecode: { path: string; size: number; decoded: AudioBuffer; at: number } | null = null;

  /**
   * Load `path` into buffer `bufnum`, then tell sclang what arrived.
   *
   * ALWAYS replies, including on failure. The sclang side runs the caller's
   * action either way, because a script that waits for a buffer that never
   * reports hangs — and a hang is harder to read than an empty buffer and a
   * line in the log.
   */
  async function read(
    bufnum: number,
    asked: string,
    startFrame: number,
    numFrames: number,
    /**
     * Which channels to keep, from `Buffer.readChannel`.
     *
     * Empty or absent means all of them, which is `Buffer.read`. It matters
     * more than it looks: Timber loads one channel of a stereo file per
     * sample slot, and handing it both doubles the frame stride — the
     * sample then plays at HALF SPEED, with no error anywhere.
     */
    pick?: readonly number[],
    /**
     * E9-260 — a `/b_read*` sent to the server by hand (raw-buffer-read.ts).
     * `alloc` false writes into the buffer as it is, from frame `bufStart`,
     * as scsynth's `/b_read` does; neither form answers with
     * `/norns-js/buffer/done`, which only the sclang override waits for.
     */
    raw?: { readonly bufStart: number; readonly alloc: boolean },
  ): Promise<boolean> {
    // E9-220 — a sample beside a script's class, asked for by the path of
    // the staged copy the class was compiled from. See `dust-path.ts`.
    const path = stagedToDust(asked);
    const fail = (why: string): boolean => {
      log(`buffer ${bufnum}: ${path}: ${why}`);
      if (raw === undefined) opts.sendToLang("/norns-js/buffer/done", [bufnum, 0, 0, 0]);
      return false;
    };

    let bytes: Uint8Array | null = opts.vfs.read(path);
    if (bytes === null) {
      // Not resident. A sound file a script ships is declared in the
      // manifest and fetched the first time something wants it — which is
      // here, and nowhere else.
      if (opts.vfs.remoteAt(path) === null) return fail("no such file");
      bytes = await opts.vfs.fetchRemote(path);
      if (bytes === null) return fail("could not be fetched");
    }

    let decoded: AudioBuffer;
    // E9-260 — twins reads one file a megaframe and a channel at a time:
    // the same decode, again and again, unless the last one is kept.
    if (lastDecode !== null && lastDecode.path === path && lastDecode.size === bytes.length && Date.now() - lastDecode.at < 30000) {
      decoded = lastDecode.decoded;
    } else {
      try {
        // `slice()` because `decodeAudioData` DETACHES the ArrayBuffer it is
        // given, and the VFS is still holding this one — a second read of the
        // same path would find an empty file.
        decoded = await opts.context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
      } catch (err) {
        return fail(`the browser cannot decode it (${(err as Error).message})`);
      }
    }
    lastDecode = { path, size: bytes.length, decoded, at: Date.now() };

    const channels = decoded.numberOfChannels;
    const first = Math.max(0, Math.min(Math.floor(startFrame), decoded.length));
    // -1 is libsndfile's "to the end", and it is what `Buffer.read`'s
    // default sends.
    // NOT FINITE IS "TO THE END", and it is said out loud. `amen` asks for
    // `nan` samples on a cold start — it computes the count from metadata a
    // previous load was supposed to have filled in, and on the first run
    // there is none. Letting NaN through gives a buffer of NaN frames,
    // which allocates nothing and plays as silence with no complaint.
    let want: number;
    if (!Number.isFinite(numFrames)) {
      log(`buffer ${bufnum}: asked for ${numFrames} frames; reading to the end`);
      want = decoded.length - first;
    } else {
      want = numFrames < 0 ? decoded.length - first : Math.floor(numFrames);
    }
    const frames = Math.max(0, Math.min(want, decoded.length - first));
    if (frames === 0) return fail("nothing to read at that offset");

    // An out-of-range index is dropped rather than refused: asking for
    // channel 1 of a mono file is a script making an assumption about a
    // file the user supplied, and a mono buffer is a better answer than an
    // error it has no handler for.
    const wanted = (pick ?? [])
      .map((n) => Math.floor(n))
      .filter((n) => n >= 0 && n < channels);
    const take = wanted.length > 0 ? wanted : Array.from({ length: channels }, (_, i) => i);
    if (pick !== undefined && pick.length > 0 && wanted.length !== pick.length) {
      log(`buffer ${bufnum}: channel ${pick.join(",")} of a ${channels}-channel file`);
    }
    const out = take.length;

    // Interleaved, because that is what `/b_setn` writes: scsynth's buffers
    // are one array of frames * channels.
    const interleaved = new Float32Array(frames * out);
    for (let c = 0; c < out; c++) {
      const data = decoded.getChannelData(take[c]!);
      for (let i = 0; i < frames; i++) interleaved[i * out + c] = data[first + i]!;
    }

    // E9-260 — `/b_read*` writes where it is told, into the buffer as it is.
    const allocate = raw === undefined || raw.alloc;
    const base = allocate ? 0 : Math.max(0, Math.floor(raw.bufStart)) * out;
    if (allocate) opts.sendToServer("/b_alloc", [bufnum, frames, out]);

    /**
     * E9-171 — AND WAIT FOR THE ALLOCATION BEFORE WRITING INTO IT.
     *
     * This is the same race `host.ts` documents for `/d_recv`, in the
     * same server, and it was here the whole time. `/b_alloc` is handled
     * on scsynth's NON-REAL-TIME thread, because it allocates memory;
     * `/b_setn` is handled on the real-time thread, at once. A `/b_setn`
     * that is dequeued before the allocation has finished has no buffer
     * to write into, and is DISCARDED WITHOUT A WORD.
     *
     * Measured in a running page, which is the only reason this is a
     * finding and not a theory:
     *
     *     alloc, setn, sync, read back   ->  [0, 0, 0, 0]
     *     alloc, sync, setn, sync, read  ->  [0.5, 0.25, 0.125, 0.0625]
     *
     * What it costs is a buffer that exists, reports its full frame
     * count, and holds silence. Every voice reading it plays nothing,
     * scsynth burns its CPU computing that nothing — `10% avg, 13
     * synths, 690 ugens` with `crone vu: engine 0 -> out 0` — and no
     * error is printed after the first block, because by then the
     * buffer is allocated and `bufData` is no longer null.
     *
     * IT IS A RACE, SO IT IS INTERMITTENT, and that is the whole shape
     * of the report it came from: `amen` needing "four restarts before
     * there was sound", the same build sounding on one machine and not
     * on another, and every log identical line for line. A machine that
     * dequeues the allocation before the first chunk wins; one that is
     * slower, busier, or has a larger audio buffer loses.
     *
     * ONE SYNC, NOT TWO. A second one after the chunks looked like it
     * was needed to make `/norns-js/buffer/done` mean the server HAS
     * the samples. It is not: everything that reads the buffer —
     * sclang's `/s_new`, a `/b_getn` — goes into the SAME server queue,
     * behind the chunks, and `host.ts` holds that order through its
     * `/d_recv` barrier too. Measured four times out of four: chunks
     * sent, read-back sent immediately after with no sync between, and
     * the samples are there.
     *
     * That matters because a sync is not free. Measured at 10-20 ms a
     * round trip, quantised by the audio block — and `kolor` loads
     * twenty-four buffers in its `init`, so the second sync was half a
     * second of script load spent proving something the queue already
     * guarantees.
     */
    if (opts.syncServer && allocate) {
      const allocated = await opts.syncServer();
      if (!allocated) {
        log(`buffer ${bufnum}: the server did not confirm the allocation within 4 s`);
      }
    }

    for (let at = 0; at < interleaved.length; at += CHUNK) {
      const slice = interleaved.subarray(at, Math.min(at + CHUNK, interleaved.length));
      opts.sendToServer("/b_setn", [bufnum, base + at, slice.length, ...slice]);
    }

    /**
     * E9-171 — AND WAIT UNTIL THE SERVER HAS THEM.
     *
     * Everything above is QUEUED, not done. `sendToServer` hands a
     * packet to scsynth and returns; the fifty-two `/b_setn` messages
     * are still in the server's queue when this function reaches the
     * next line. Telling sclang the buffer is ready at that point is
     * telling it over a DIFFERENT channel, one that does not wait
     * behind them — so the script's action runs, its synths are
     * created, and they read a buffer that is not there yet.
     *
     * What that looks like from the outside:
     *
     *     s| Buffer UGen: no buffer data      (x8, one per voice)
     *     scsynth: 10% avg, 13 synths, 690 ugens
     *     crone vu: ... engine 0 ... -> out 0
     *
     * — a server working hard at computing silence, reported from a
     * desktop where the same script and the same sample sound on
     * another machine. It is a race, so it is intermittent, which is
     * why `amen` has needed "four restarts before there was sound"
     * since the beginning.
     *
     * `/sync` is what SuperCollider has for this. The server answers it
     * from BEHIND its own queue, so the reply means the samples are in.
     * A timeout reports and carries on: a buffer that loaded slowly is
     * better than a script that never starts.
     */
    /**
     * E9-171 — AND NOW ASK THE SERVER WHAT IT ACTUALLY HAS.
     *
     * Every other line this file logs reports what was SENT. A buffer
     * that was allocated and never filled plays as silence, with one
     * error on the first block and nothing after it — which is exactly
     * the shape of a report that took five rounds to narrow: `scsynth:
     * 10% avg, 13 synths, 690 ugens` and `crone vu: engine 0 -> out 0`,
     * a server working hard at computing nothing.
     *
     * So four samples are read back from where the file is LOUDEST, and
     * compared to what was pushed. The loudest point is the one place a
     * zero cannot be the file's own silence.
     *
     * CHECKED, NOT ASSUMED, and cheap: one message and one reply per
     * buffer load, against the fifty-two that carried the samples.
     */
    /**
     * ONCE PER BURST, not once per buffer. E9-175 — the read-back is a
     * round trip too, at the same 10-20 ms, and `kolor` loads
     * twenty-four buffers in one `init`. What it is looking for is
     * SYSTEMIC: if the allocation race bites it bites every load, so
     * the first of a burst answers for all of them. A load that stands
     * alone — a script reading one sample later, from a menu — is more
     * than two seconds after the last and is checked on its own.
     */
    const burstGap = Date.now() - lastReadAt > 2000;
    lastReadAt = Date.now();
    if (opts.peekBuffer && frames > 16 && burstGap) {
      let at = 0;
      let loudest = 0;
      for (let i = 0; i < interleaved.length; i++) {
        const v = interleaved[i]!;
        const m = v < 0 ? -v : v;
        if (m > loudest) {
          loudest = m;
          at = i;
        }
      }
      if (loudest > 0.01) {
        const got = await opts.peekBuffer(bufnum, base + at, 4);
        if (got === null) {
          log(`buffer ${bufnum}: the server did not answer /b_getn — cannot say whether it has the samples`);
        } else {
          const back = got.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
          if (back <= 0.0001) {
            log(
              `buffer ${bufnum}: THE SERVER HAS NO SAMPLES — read back ${back.toFixed(4)} where the ` +
                `file is ${loudest.toFixed(3)}. Everything that plays this buffer will be silent.`,
            );
          }
        }
      }
    }

    // `decoded.sampleRate` is the CONTEXT's rate, not the file's:
    // `decodeAudioData` resamples. That is the right number to report —
    // `PlayBuf` at rate 1.0 should play it at the speed it was decoded to,
    // and a script that computes `buf.numFrames / buf.sampleRate` wants the
    // duration, which survives the resample.
    if (raw === undefined) opts.sendToLang("/norns-js/buffer/done", [bufnum, frames, out, decoded.sampleRate]);
    log(
      `buffer ${bufnum}: ${path} — ${frames} frames, ${out} ch at ` +
        `${decoded.sampleRate} Hz` +
        (out !== channels ? ` (channel ${take.join(",")} of ${channels})` : "") +
        (base > 0 ? ` from frame ${base / out}` : ""),
    );
    return true;
  }

  /** E9-260 — a `/b_read*` the server was sent by hand; see raw-buffer-read.ts. */
  const readRaw = (r: RawBufferRead): Promise<boolean> =>
    read(r.bufnum, r.path, r.fileStart, r.numFrames, r.channels, { bufStart: r.bufStart, alloc: r.alloc });

  return { read, readRaw };
}
