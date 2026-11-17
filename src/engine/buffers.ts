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

export interface BufferLoaderOptions {
  readonly vfs: Vfs;
  /** For `decodeAudioData`, and for the rate the samples end up at. */
  readonly context: BaseAudioContext;
  readonly sendToServer: (address: string, args: readonly (number | string)[]) => void;
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
    path: string,
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
  ): Promise<void> {
    const fail = (why: string): void => {
      log(`buffer ${bufnum}: ${path}: ${why}`);
      opts.sendToLang("/norns-js/buffer/done", [bufnum, 0, 0, 0]);
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
    try {
      // `slice()` because `decodeAudioData` DETACHES the ArrayBuffer it is
      // given, and the VFS is still holding this one — a second read of the
      // same path would find an empty file.
      decoded = await opts.context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    } catch (err) {
      return fail(`the browser cannot decode it (${(err as Error).message})`);
    }

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

    opts.sendToServer("/b_alloc", [bufnum, frames, out]);
    for (let at = 0; at < interleaved.length; at += CHUNK) {
      const slice = interleaved.subarray(at, Math.min(at + CHUNK, interleaved.length));
      opts.sendToServer("/b_setn", [bufnum, at, slice.length, ...slice]);
    }

    // `decoded.sampleRate` is the CONTEXT's rate, not the file's:
    // `decodeAudioData` resamples. That is the right number to report —
    // `PlayBuf` at rate 1.0 should play it at the speed it was decoded to,
    // and a script that computes `buf.numFrames / buf.sampleRate` wants the
    // duration, which survives the resample.
    opts.sendToLang("/norns-js/buffer/done", [bufnum, frames, out, decoded.sampleRate]);
    log(
      `buffer ${bufnum}: ${path} — ${frames} frames, ${out} ch at ` +
        `${decoded.sampleRate} Hz` +
        (out !== channels ? ` (channel ${take.join(",")} of ${channels})` : ""),
    );
  }

  return { read };
}
