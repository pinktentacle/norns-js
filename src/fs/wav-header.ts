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
