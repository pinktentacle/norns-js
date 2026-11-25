// Enough of a RIFF/WAVE header to answer `_norns.sound_file_inspect`.
//
// Shared with tools/build-dust.mjs, which runs it at BUILD time over every
// sound file a script ships and records the answer in the manifest. That is
// what lets `audio.file_info` work on a file whose bytes have not been
// fetched yet: the three numbers a caller wants are in the header, and the
// header can be read once, here, instead of 1.2 MB being pulled over the
// network to find them.
//
// One parser, two callers, because two would drift — and a drift here is a
// sample that reports the wrong length and plays at the wrong speed.

export interface WavInfo {
  channels: number;
  frames: number;
  sampleRate: number;
}

/** Enough of a RIFF/WAVE header for `sound_file_inspect`'s three numbers. */
export function parseWavHeader(data: Uint8Array): WavInfo | null {
  if (data.length < 44) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (o: number): string => String.fromCharCode(...data.subarray(o, o + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  let at = 12;
  while (at + 8 <= data.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
      bitsPerSample = view.getUint16(at + 22, true);
    } else if (id === "data") {
      dataBytes = size;
    }
    at += 8 + size + (size % 2); // chunks are word aligned
  }
  if (!channels || !bitsPerSample) return null;
  return { channels, sampleRate, frames: Math.floor(dataBytes / (channels * (bitsPerSample / 8))) };
}

/**
 * E9-235 — the same three numbers from a FLAC or an AIFF header too.
 *
 * libsndfile, which answers `audio.file_info` on a norns, reads all three
 * formats, and the catalogue uses them: amenbreak's 425 breaks are .flac.
 * Here only WAV was read, so every one of them reported 0 frames and the
 * script printed "ERROR PROCESSING FILE" and loaded nothing. Both headers
 * are fixed and at the front, so the answer stays synchronous.
 */
export function parseSoundHeader(data: Uint8Array): WavInfo | null {
  return parseWavHeader(data) ?? parseFlacHeader(data) ?? parseAiffHeader(data);
}

/** FLAC's STREAMINFO: rate (20 bits), channels-1 (3), bits-1 (5), total samples (36). */
export function parseFlacHeader(data: Uint8Array): WavInfo | null {
  let at = 0;
  // An ID3v2 tag may come first: "ID3", version, flags, then a syncsafe size.
  if (data.length >= 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    at = 10 + ((data[6]! & 0x7f) << 21) + ((data[7]! & 0x7f) << 14) + ((data[8]! & 0x7f) << 7) + (data[9]! & 0x7f);
  }
  if (data.length < at + 26) return null;
  if (String.fromCharCode(...data.subarray(at, at + 4)) !== "fLaC") return null;
  if ((data[at + 4]! & 0x7f) !== 0) return null; // the first block must be STREAMINFO
  const s = at + 8 + 10;
  const sampleRate = (data[s]! << 12) | (data[s + 1]! << 4) | (data[s + 2]! >> 4);
  const channels = ((data[s + 2]! >> 1) & 0x07) + 1;
  const frames = (data[s + 3]! & 0x0f) * 2 ** 32 + ((data[s + 4]! << 24) >>> 0) + (data[s + 5]! << 16) + (data[s + 6]! << 8) + data[s + 7]!;
  if (sampleRate === 0) return null;
  return { channels, sampleRate, frames };
}

/** AIFF/AIFC's COMM chunk, big-endian, with the rate as an 80-bit extended float. */
export function parseAiffHeader(data: Uint8Array): WavInfo | null {
  if (data.length < 12) return null;
  const tag = (o: number): string => String.fromCharCode(...data.subarray(o, o + 4));
  if (tag(0) !== "FORM" || (tag(8) !== "AIFF" && tag(8) !== "AIFC")) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 12;
  while (at + 8 <= data.length) {
    const size = view.getUint32(at + 4, false);
    if (tag(at) === "COMM" && at + 8 + 18 <= data.length) {
      const channels = view.getUint16(at + 8, false);
      const frames = view.getUint32(at + 10, false);
      const e = ((view.getUint8(at + 16) & 0x7f) << 8) | view.getUint8(at + 17);
      const mantissa = view.getUint32(at + 18, false) * 2 ** 32 + view.getUint32(at + 22, false);
      const sampleRate = Math.round(mantissa * 2 ** (e - 16383 - 63));
      return channels > 0 && sampleRate > 0 ? { channels, frames, sampleRate } : null;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}
