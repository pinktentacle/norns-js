/**
 * E9-251 — a sound file's SAMPLES, for sclang.
 *
 * sclang reads a sound file with `SoundFile.openRead` / `seek` / `readData`,
 * which are libsndfile primitives, and this sclang has no libsndfile.
 * `openRead` is served from a manifest (NornsJsSoundFileOverride.sc); the
 * samples were not served at all, and grains, which reads them to draw a
 * file's waveform before it plays it, dropped every sample it loaded: its
 * `readData` failed, its `try` gave up the load, the voice never started.
 * twins reads them the same way, and timber for its waveform.
 *
 * So the page decodes the file and writes its samples into sclang's own
 * filesystem, interleaved little-endian float32 — what `File:readLE` reads
 * into a FloatArray at C speed — and sclang's `readData` reads from there.
 *
 * AT THE FILE'S OWN RATE. `readData` counts frames of the file, and
 * `numFrames` comes from its header; the page's AudioContext would resample
 * to 48 kHz. An OfflineAudioContext at the file's rate decodes it as it is.
 */

import type { Vfs } from "../fs/vfs.js";
import { parseSoundHeader } from "../fs/wav-header.js";

export interface SoundDataOptions {
  readonly vfs: Vfs;
  /** Write into sclang's filesystem. */
  readonly writeLangFile: (path: string, bytes: Uint8Array) => void;
  readonly removeLangFile: (path: string) => void;
  /** The answer, back into sclang: `/norns-js/soundfile/ready <raw> <samples>`. */
  readonly sendToLang: (address: string, args: Array<string | number>) => void;
  /** Decode at a given rate; supplied by tests, an OfflineAudioContext otherwise. */
  readonly decode?: (bytes: Uint8Array, sampleRate: number, channels: number) => Promise<Float32Array[]>;
  readonly log?: (line: string) => void;
}

async function decodeOffline(bytes: Uint8Array, sampleRate: number, channels: number): Promise<Float32Array[]> {
  const ctx = new OfflineAudioContext(Math.max(1, channels), 1, sampleRate);
  // `slice()`: decodeAudioData DETACHES the buffer it is given.
  const b = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
  return Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
}

/** Interleave channels into one array: frame 0 of every channel, then frame 1... */
export function interleave(chans: readonly Float32Array[], frames: number): Float32Array {
  const n = chans.length;
  const out = new Float32Array(frames * n);
  for (let c = 0; c < n; c++) {
    const src = chans[c]!;
    for (let f = 0; f < frames; f++) out[f * n + c] = src[f] ?? 0;
  }
  return out;
}

export function createSoundData(opts: SoundDataOptions) {
  const decode = opts.decode ?? decodeOffline;
  const say = opts.log ?? (() => {});

  /** Decode `path` into `raw` and say how many samples are there; 0 is a failure. */
  async function serve(path: string, raw: string): Promise<void> {
    let samples = 0;
    try {
      // Not resident: a sound file the build declares is fetched the first
      // time something wants it, as buffers.ts does for `Buffer.read`.
      let bytes = opts.vfs.read(path);
      if (bytes === null && opts.vfs.remoteAt(path) !== null) bytes = await opts.vfs.fetchRemote(path);
      if (bytes === null) throw new Error("no such file");
      const info = parseSoundHeader(bytes);
      if (info === null) throw new Error("not a sound file this page can read");
      const chans = await decode(bytes, info.sampleRate, info.channels);
      // The header's channel count is what sclang was told: keep to it.
      const use = chans.slice(0, info.channels);
      while (use.length < info.channels) use.push(new Float32Array(0));
      const frames = Math.min(info.frames, ...use.map((c) => c.length).filter((l) => l > 0));
      const data = interleave(use, Number.isFinite(frames) ? frames : 0);
      opts.writeLangFile(raw, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      samples = data.length;
    } catch (e) {
      say(`soundfile: ${path} could not be read for sclang (${(e as Error).message})`);
    }
    opts.sendToLang("/norns-js/soundfile/ready", [raw, samples]);
  }

  function release(raw: string): void {
    try {
      opts.removeLangFile(raw);
    } catch {
      /* already gone */
    }
  }

  return { serve, release };
}
