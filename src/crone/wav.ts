// WAV, written. The browser decodes every format worth having and encodes
// none of them, so this is the half that has to exist.
//
// `decodeAudioData` handles WAV, AIFF, FLAC, mp3, ogg and m4a on the way in,
// which is more than libsndfile would have given us. On the way out there is
// no browser API at all, so sound files crone writes — `buffer_write_mono`,
// `buffer_write_stereo` and the tape — are encoded here.
//
// WHY 24-BIT. Not a preference: crone asks for it. `BufDiskWorker.cpp:449`
// is `SF_FORMAT_WAV | SF_FORMAT_PCM_24`, and norns' tape is 24-bit too.
// Writing 16 would quietly halve the dynamic range of every recording a
// script makes, and nothing downstream would say so — the file would open
// and sound almost the same.

/** libsndfile's format word, enough of it to read back what crone asked. */
export const SF_FORMAT_SUBMASK = 0x0000ffff;
export const SF_FORMAT_PCM_16 = 0x0002;
export const SF_FORMAT_PCM_24 = 0x0003;
export const SF_FORMAT_PCM_32 = 0x0004;
export const SF_FORMAT_FLOAT = 0x0006;

/** Bit depth from a libsndfile format word, defaulting to crone's 24. */
export function bitsFromFormat(format: number): 16 | 24 | 32 {
  switch (format & SF_FORMAT_SUBMASK) {
    case SF_FORMAT_PCM_16:
      return 16;
    case SF_FORMAT_PCM_32:
    case SF_FORMAT_FLOAT:
      return 32;
    default:
      return 24;
  }
}

export interface WavOptions {
  readonly channels: number;
  readonly sampleRate: number;
  /** Interleaved, `channels` per frame, nominally -1..1. */
  readonly samples: Float32Array;
  readonly bits?: 16 | 24 | 32;
}

/**
 * Encode interleaved float samples as a RIFF/WAVE file.
 *
 * Clipping is applied, because crone asked for it: `writeBufferMono` sets
 * `SFC_SET_CLIPPING`, which is libsndfile's "clamp rather than wrap". A
 * sample over 1.0 written without clamping wraps to the opposite extreme,
 * and one frame of that is a click, not a loud note.
 */
export function encodeWav(opts: WavOptions): Uint8Array {
  const bits = opts.bits ?? 24;
  const bytesPerSample = bits / 8;
  const n = opts.samples.length;
  const dataBytes = n * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  // 1 is integer PCM, 3 is IEEE float. A 32-bit file written with tag 1
  // opens as silence-or-noise in half the editors that read it.
  view.setUint16(20, bits === 32 ? 3 : 1, true);
  view.setUint16(22, opts.channels, true);
  view.setUint32(24, opts.sampleRate, true);
  view.setUint32(28, opts.sampleRate * opts.channels * bytesPerSample, true);
  view.setUint16(32, opts.channels * bytesPerSample, true);
  view.setUint16(34, bits, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  let at = 44;
  if (bits === 32) {
    for (let i = 0; i < n; i++, at += 4) view.setFloat32(at, opts.samples[i]!, true);
  } else if (bits === 16) {
    for (let i = 0; i < n; i++, at += 2) {
      view.setInt16(at, Math.round(clamp(opts.samples[i]!) * 32767), true);
    }
  } else {
    for (let i = 0; i < n; i++, at += 3) {
      const v = Math.round(clamp(opts.samples[i]!) * 8388607);
      // Little-endian 24-bit: three bytes, low first. There is no
      // setInt24, and getting the order wrong produces a file that plays
      // as loud noise rather than as nothing.
      view.setUint8(at, v & 0xff);
      view.setUint8(at + 1, (v >> 8) & 0xff);
      view.setUint8(at + 2, (v >> 16) & 0xff);
    }
  }
  return new Uint8Array(buf);
}

function clamp(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

/**
 * Interleave an `AudioBuffer`'s channels, optionally a window of it.
 *
 * `decodeAudioData` gives planar channels; crone's registry is interleaved,
 * because that is what libsndfile's `readf` hands back and what upstream's
 * `readBufferMono` expects.
 */
export function interleave(
  buffer: { numberOfChannels: number; length: number; getChannelData(ch: number): Float32Array },
  firstFrame = 0,
  frames = buffer.length - firstFrame,
): Float32Array {
  const ch = buffer.numberOfChannels;
  const n = Math.max(0, Math.min(frames, buffer.length - firstFrame));
  const out = new Float32Array(n * ch);
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i * ch + c] = data[firstFrame + i]!;
  }
  return out;
}
