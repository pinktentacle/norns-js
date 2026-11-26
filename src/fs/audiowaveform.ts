// E9-267 — audiowaveform (BBC), the parts the catalogue uses.
//
// amenbreak, zxcvbn and paracosms draw their sample views with it, and
// makebreakbeat its onset pictures. None ships with norns: each script
// apt-gets or downloads an aarch64 build, which a browser cannot run, so
// every view stayed blank. The calls are few and fixed:
//
//   audiowaveform --help                       is it installed? ("Options")
//   audiowaveform -q -i X -o Y.dat -z 2 -b 8   peaks of a sound file
//   audiowaveform -q -i Y.dat -o Z.png -s A -e B -w W -h H
//       --background-color 000000 --waveform-color 757575
//       --no-axis-labels --compression 9       a view of those peaks
//   audiowaveform -i X -o Z.png --pixels-per-second N -w -h ...
//
// REWRITTEN FROM ITS SOURCE, not approximated: the numbers below are the
// program's own. WaveformGenerator mixes to mono with an integer mean and
// keeps min/max per `samples_per_pixel` frames, the last partial pixel
// included; WaveformBuffer stores 8-bit as value/256 truncated, reads it
// back as value*256, and writes a version 1 header for one channel;
// WaveformRescaler merges pixels at `x * samples_per_pixel` boundaries;
// GdImageRenderer maps [-32768, 32767] to rows with `high * height /
// 65536` and draws one vertical line per pixel; DurationScaleFactor is
// `(end - start) * rate / width` in integers. Colours default to its
// "audacity" scheme, and an RGBA colour is stored the way gd stores it.
//
// What it does NOT do is said, rather than drawn differently: axis labels
// (every caller turns them off), bars, split channels, and json/txt
// output each refuse by name.

import { encodePng } from "../screen/png-encode.js";

export const VERSION = "AudioWaveform v1.10.1 (norns-js)";

export const HELP = `${VERSION}

Usage:
  audiowaveform [options]

Options:
  --help                        show help message
  -v [ --version ]              show version information
  -q [ --quiet ]                disable status messages
  -i [ --input-filename ] arg   input file name (.wav, .flac, .mp3, .ogg, .aiff, .dat)
  -o [ --output-filename ] arg  output file name (.dat, .png)
  -z [ --zoom ] arg (=256)      zoom level (samples per pixel)
  --pixels-per-second arg (=100) zoom level (pixels per second)
  -b [ --bits ] arg (=16)       bits (8 or 16)
  -s [ --start ] arg (=0)       start time (seconds)
  -e [ --end ] arg (=0)         end time (seconds)
  -w [ --width ] arg (=800)     image width (pixels)
  -h [ --height ] arg (=250)    image height (pixels)
  --background-color arg        background color (rrggbb[aa])
  --waveform-color arg          wave color (rrggbb[aa])
  --border-color arg            border color (rrggbb[aa])
  --axis-label-color arg        axis label color (rrggbb[aa])
  --no-axis-labels              render waveform image without axis labels
  --amplitude-scale arg (=1.0)  amplitude scale, or "auto"
  --compression arg (=-1)       PNG compression level

norns-js: axis labels, bars, --split-channels and json/txt output are not
available here and are refused.
`;

// --- sound in --------------------------------------------------------------

/** Interleaved 16-bit samples, as libsndfile hands audiowaveform a file. */
export interface Pcm16 {
  readonly sampleRate: number;
  readonly channels: number;
  readonly data: Int16Array;
}

const clamp16 = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/**
 * A WAV file to 16-bit, the way `sf_readf_short` converts it: 8-bit
 * unsigned is shifted up, 24 and 32 bits are shifted down, float is scaled
 * by 32767 and clipped. Null for anything that is not a WAV this reads.
 */
export function decodeWav16(bytes: Uint8Array): Pcm16 | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number): string => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let dataAt = -1;
  let dataLen = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 24 <= bytes.length) {
      format = view.getUint16(at + 8, true);
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
      // WAVE_FORMAT_EXTENSIBLE: the real code is the subformat GUID's first two bytes.
      if (format === 0xfffe && size >= 26 && at + 34 <= bytes.length) format = view.getUint16(at + 32, true);
    } else if (id === "data") {
      dataAt = at + 8;
      dataLen = Math.min(size, bytes.length - dataAt);
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (dataAt < 0 || channels < 1 || rate < 1) return null;
  const bytesPer = bits / 8;
  if (!Number.isInteger(bytesPer) || bytesPer < 1) return null;
  const n = Math.floor(dataLen / bytesPer);
  const out = new Int16Array(n - (n % channels));
  for (let i = 0; i < out.length; i++) {
    const o = dataAt + i * bytesPer;
    let s: number;
    if (format === 1) {
      if (bits === 8) s = (view.getUint8(o) - 128) << 8;
      else if (bits === 16) s = view.getInt16(o, true);
      else if (bits === 24) s = ((view.getUint8(o + 2) << 24) | (view.getUint8(o + 1) << 16) | (view.getUint8(o) << 8)) >> 16;
      else if (bits === 32) s = view.getInt32(o, true) >> 16;
      else return null;
    } else if (format === 3) {
      const f = bits === 32 ? view.getFloat32(o, true) : bits === 64 ? view.getFloat64(o, true) : NaN;
      if (Number.isNaN(f)) return null;
      s = clamp16(Math.round(f * 32767));
    } else {
      return null;
    }
    out[i] = s;
  }
  return { sampleRate: rate, channels, data: out };
}

/** Float channels (a browser's decode) to interleaved 16-bit. */
export function floatToPcm16(sampleRate: number, chans: readonly Float32Array[]): Pcm16 {
  const channels = chans.length;
  const frames = channels > 0 ? chans[0]!.length : 0;
  const data = new Int16Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) data[f * channels + c] = clamp16(Math.round(chans[c]![f]! * 32768));
  }
  return { sampleRate, channels, data };
}

// --- peaks -------------------------------------------------------------------

/** A WaveformBuffer: min/max pairs, `channels` per point, in 16-bit units. */
export interface Peaks {
  readonly sampleRate: number;
  readonly samplesPerPixel: number;
  readonly channels: number;
  /** min, max, min, max… for point 0 channel 0, point 0 channel 1, … */
  readonly data: Int16Array;
}

export const peakCount = (p: Peaks): number => p.data.length / (2 * p.channels);

/** WaveformGenerator, mono: the mean of the channels, min and max per pixel. */
export function generatePeaks(pcm: Pcm16, samplesPerPixel: number): Peaks {
  if (samplesPerPixel < 2) throw new Error("Invalid zoom: minimum 2");
  const { channels, data } = pcm;
  const frames = Math.floor(data.length / channels);
  const out: number[] = [];
  let min = 32767;
  let max = -32768;
  let count = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data[f * channels + c]!;
    const s = clamp16(Math.trunc(sum / channels));
    if (s < min) min = s;
    if (s > max) max = s;
    if (++count === samplesPerPixel) {
      out.push(min, max);
      min = 32767;
      max = -32768;
      count = 0;
    }
  }
  if (count > 0) out.push(min, max);
  return { sampleRate: pcm.sampleRate, samplesPerPixel, channels: 1, data: Int16Array.from(out) };
}

// --- .dat ----------------------------------------------------------------------

export function encodeDat(p: Peaks, bits: 8 | 16): Uint8Array {
  const n = peakCount(p);
  const version = p.channels === 1 ? 1 : 2;
  const head = version === 1 ? 20 : 24;
  const out = new Uint8Array(head + p.data.length * (bits / 8));
  const v = new DataView(out.buffer);
  v.setInt32(0, version, true);
  v.setUint32(4, bits === 8 ? 1 : 0, true);
  v.setInt32(8, p.sampleRate, true);
  v.setInt32(12, p.samplesPerPixel, true);
  v.setUint32(16, n, true);
  if (version === 2) v.setInt32(20, p.channels, true);
  for (let i = 0; i < p.data.length; i++) {
    if (bits === 8) v.setInt8(head + i, Math.trunc(p.data[i]! / 256));
    else v.setInt16(head + i * 2, p.data[i]!, true);
  }
  return out;
}

export function decodeDat(bytes: Uint8Array): Peaks {
  if (bytes.length < 20) throw new Error("not a waveform data file");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = v.getInt32(0, true);
  if (version !== 1 && version !== 2) throw new Error(`Cannot load data file version: ${version}`);
  const eight = (v.getUint32(4, true) & 1) !== 0;
  const sampleRate = v.getInt32(8, true);
  const samplesPerPixel = v.getInt32(12, true);
  const size = v.getUint32(16, true);
  const channels = version === 2 ? v.getInt32(20, true) : 1;
  if (sampleRate < 1) throw new Error(`Invalid sample rate: ${sampleRate} Hz, minimum 1 Hz`);
  if (samplesPerPixel < 2) throw new Error(`Invalid samples per pixel: ${samplesPerPixel}, minimum 2`);
  if (channels < 1 || channels > 24) throw new Error(`Cannot load data file with ${channels} channels`);
  const head = version === 2 ? 24 : 20;
  const width = eight ? 1 : 2;
  // As many as are there: the program reads to the end and only notes a short file.
  const values = Math.min(size * channels * 2, Math.floor((bytes.length - head) / width));
  const data = new Int16Array(values - (values % (2 * channels)));
  for (let i = 0; i < data.length; i++) {
    data[i] = eight ? v.getInt8(head + i) * 256 : v.getInt16(head + i * 2, true);
  }
  return { sampleRate, samplesPerPixel, channels, data };
}

/** WaveformRescaler: to a coarser zoom, merging at `x * spp` sample boundaries. */
export function rescalePeaks(input: Peaks, samplesPerPixel: number): Peaks {
  const inSpp = input.samplesPerPixel;
  const ch = input.channels;
  const size = peakCount(input);
  const minAt = (c: number, i: number): number => input.data[(i * ch + c) * 2]!;
  const maxAt = (c: number, i: number): number => input.data[(i * ch + c) * 2 + 1]!;
  const at = (x: number): number => x * samplesPerPixel;
  const out: number[] = [];
  const min = new Array<number>(ch).fill(0);
  const max = new Array<number>(ch).fill(0);
  if (size > 0) {
    for (let c = 0; c < ch; c++) {
      min[c] = minAt(c, 0);
      max[c] = maxAt(c, 0);
    }
  }
  let inIndex = 0;
  let outIndex = 0;
  let lastIn = 0;
  while (inIndex < size) {
    while (Math.trunc(at(outIndex) / inSpp) === inIndex) {
      if (outIndex > 0) for (let c = 0; c < ch; c++) out.push(min[c]!, max[c]!);
      lastIn = inIndex;
      outIndex++;
      if (at(outIndex) !== at(outIndex - 1)) {
        min.fill(32767);
        max.fill(-32768);
      }
    }
    const stop = Math.min(Math.trunc(at(outIndex) / inSpp), size);
    while (inIndex < stop) {
      for (let c = 0; c < ch; c++) {
        if (minAt(c, inIndex) < min[c]!) min[c] = minAt(c, inIndex);
        if (maxAt(c, inIndex) > max[c]!) max[c] = maxAt(c, inIndex);
      }
      inIndex++;
    }
  }
  if (inIndex !== lastIn) for (let c = 0; c < ch; c++) out.push(min[c]!, max[c]!);
  return { sampleRate: input.sampleRate, samplesPerPixel, channels: ch, data: Int16Array.from(out) };
}

// --- .png -------------------------------------------------------------------

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Absent when the colour was given without one: opaque, and no alpha channel. */
  readonly a?: number;
}

export function parseColor(s: string): Rgba | null {
  const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(s.trim());
  if (!m) return null;
  const h = (x: string): number => parseInt(x, 16);
  return m[4] === undefined ? { r: h(m[1]!), g: h(m[2]!), b: h(m[3]!) } : { r: h(m[1]!), g: h(m[2]!), b: h(m[3]!), a: h(m[4]!) };
}

/** The "audacity" scheme, the program's default. */
export const DEFAULT_BACKGROUND: Rgba = { r: 214, g: 214, b: 214 };
export const DEFAULT_WAVEFORM: Rgba = { r: 63, g: 77, b: 155 };

export interface RenderOptions {
  readonly width: number;
  readonly height: number;
  readonly startTime: number;
  readonly background: Rgba;
  readonly waveform: Rgba;
  /** 1.0, or "auto" to fill the height with the loudest point in view. */
  readonly amplitudeScale: number | "auto";
}

/**
 * GdImageRenderer, without axis labels: background, then one vertical line
 * per pixel from the min to the max of each point, rows split by channel.
 */
export function renderPeaks(p: Peaks, o: RenderOptions): Uint8Array {
  const { width, height } = o;
  if (width < 1) throw new Error("Invalid image width: minimum 1");
  if (height < 1) throw new Error("Invalid image height: minimum 1");
  const size = peakCount(p);
  if (size < 1) throw new Error("Empty waveform buffer");
  const alpha = o.background.a !== undefined || o.waveform.a !== undefined;
  const bpp = alpha ? 4 : 3;
  // gd keeps 7 bits of alpha (127 - a/2) and writes it back out as PNG alpha.
  const pngAlpha = (c: Rgba): number => {
    if (c.a === undefined) return 255;
    const g = 127 - (c.a >> 1);
    return 255 - ((g << 1) + (g >> 6));
  };
  const px = new Uint8Array(width * height * bpp);
  const put = (x: number, y: number, c: Rgba): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * bpp;
    px[i] = c.r;
    px[i + 1] = c.g;
    px[i + 2] = c.b;
    if (alpha) px[i + 3] = pngAlpha(c);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, o.background);
  const start = Math.trunc((o.startTime * p.sampleRate) / p.samplesPerPixel);
  let scale: number;
  if (o.amplitudeScale === "auto") {
    let peak = 0;
    for (let i = start; i < Math.min(start + width, size); i++) {
      for (let c = 0; c < p.channels; c++) {
        peak = Math.max(peak, Math.abs(p.data[(i * p.channels + c) * 2]!), Math.abs(p.data[(i * p.channels + c) * 2 + 1]!));
      }
    }
    scale = peak > 0 ? 32767 / peak : 1;
  } else {
    scale = o.amplitudeScale;
  }
  const scaled = (v: number): number => clamp16(Math.trunc(v * scale));
  let available = height;
  const rowHeight = Math.trunc(available / p.channels);
  let top = 0;
  for (let c = 0; c < p.channels; c++) {
    const bottom = c === p.channels - 1 ? top + available - 1 : top + rowHeight;
    const h = bottom - top + 1;
    for (let i = start, x = 0; x < width && i < size; i++, x++) {
      const low = scaled(p.data[(i * p.channels + c) * 2]!) + 32768;
      const high = scaled(p.data[(i * p.channels + c) * 2 + 1]!) + 32768;
      const yHigh = top + h - 1 - Math.floor((high * h) / 65536);
      const yLow = top + h - 1 - Math.floor((low * h) / 65536);
      for (let y = Math.min(yHigh, yLow); y <= Math.max(yHigh, yLow); y++) put(x, y, o.waveform);
    }
    available -= rowHeight + 1;
    top += rowHeight + 1;
  }
  return encodePng(width, height, px, alpha);
}

// --- the command line ---------------------------------------------------------

export interface AwfArgs {
  readonly help: boolean;
  readonly version: boolean;
  readonly quiet: boolean;
  readonly input?: string | undefined;
  readonly output?: string | undefined;
  readonly zoom?: number | undefined;
  readonly pixelsPerSecond?: number | undefined;
  readonly bits?: number | undefined;
  readonly start: number;
  readonly end?: number | undefined;
  readonly width: number;
  readonly height: number;
  readonly background: Rgba;
  readonly waveform: Rgba;
  readonly axisLabels: boolean;
  readonly amplitudeScale: number | "auto";
}

const BOOL = new Set(["help", "version", "quiet", "no-axis-labels", "with-axis-labels", "split-channels"]);
const SHORT: Record<string, string> = { i: "input-filename", o: "output-filename", z: "zoom", b: "bits", s: "start", e: "end", w: "width", h: "height", q: "quiet", v: "version" };
const VALUED = new Set([
  "input-filename", "output-filename", "zoom", "bits", "start", "end", "width", "height",
  "pixels-per-second", "background-color", "waveform-color", "border-color", "axis-label-color",
  "amplitude-scale", "compression", "input-format", "output-format", "colors", "waveform-style",
  "bar-width", "bar-gap", "bar-style", "end-time", "start-time",
]);

/** boost::program_options, as audiowaveform declares them. Throws the program's own messages. */
export function parseAwfArgs(argv: readonly string[]): AwfArgs {
  const seen = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    let name: string;
    let value: string | undefined;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) value = a.slice(eq + 1);
    } else if (a.startsWith("-") && a.length >= 2) {
      const long = SHORT[a[1]!];
      if (long === undefined) throw new Error(`unrecognised option '${a}'`);
      name = long;
      if (a.length > 2) value = a.slice(2);
    } else {
      throw new Error(`unrecognised option '${a}'`);
    }
    if (BOOL.has(name)) {
      seen.set(name, "1");
      continue;
    }
    if (!VALUED.has(name)) throw new Error(`unrecognised option '--${name}'`);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new Error(`the required argument for option '--${name}' is missing`);
    }
    seen.set(name, value);
  }
  for (const no of ["split-channels"]) if (seen.has(no)) throw new Error(`--${no} is not available here`);
  const style = seen.get("waveform-style");
  if (style !== undefined && style !== "normal") throw new Error(`--waveform-style ${style} is not available here`);
  const num = (k: string): number | undefined => {
    const v = seen.get(k);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`the argument ('${v}') for option '--${k}' is invalid`);
    return n;
  };
  const color = (k: string, d: Rgba): Rgba => {
    const v = seen.get(k);
    if (v === undefined) return d;
    const c = parseColor(v);
    if (c === null) throw new Error(`Invalid color: ${v}`);
    return c;
  };
  const amp = seen.get("amplitude-scale");
  const zoomRaw = seen.get("zoom");
  const out: AwfArgs = {
    help: seen.has("help"),
    version: seen.has("version"),
    quiet: seen.has("quiet"),
    input: seen.get("input-filename"),
    output: seen.get("output-filename"),
    zoom: zoomRaw === undefined || zoomRaw === "auto" ? undefined : num("zoom"),
    pixelsPerSecond: num("pixels-per-second"),
    bits: num("bits"),
    start: num("start") ?? num("start-time") ?? 0,
    end: num("end") ?? num("end-time"),
    width: num("width") ?? 800,
    height: num("height") ?? 250,
    background: color("background-color", DEFAULT_BACKGROUND),
    waveform: color("waveform-color", DEFAULT_WAVEFORM),
    axisLabels: !seen.has("no-axis-labels"),
    amplitudeScale: amp === undefined ? 1 : amp === "auto" ? "auto" : (num("amplitude-scale") as number),
  };
  if (out.zoom !== undefined && out.end !== undefined) throw new Error("Specify either --end or --zoom but not both");
  if (out.pixelsPerSecond !== undefined && out.end !== undefined) throw new Error("Specify either --end or --pixels-per-second but not both");
  if (out.zoom !== undefined && out.pixelsPerSecond !== undefined) throw new Error("Specify either --zoom or --pixels-per-second but not both");
  return out;
}

/** ScaleFactor: the samples per pixel an image asks for. */
export function samplesPerPixelFor(a: AwfArgs, sampleRate: number): number {
  if (a.end !== undefined) {
    if (a.end < a.start) throw new Error(`Invalid end time, must be greater than ${a.start}`);
    return Math.trunc(Math.trunc((a.end - a.start) * sampleRate) / a.width);
  }
  if (a.pixelsPerSecond !== undefined) {
    if (a.pixelsPerSecond <= 0) throw new Error("Invalid pixels per second: must be greater than zero");
    return Math.trunc(sampleRate / a.pixelsPerSecond);
  }
  return a.zoom ?? 256;
}

export type FileKind = "dat" | "png" | "audio" | "other";

export function kindOf(path: string): FileKind {
  const ext = /\.([^./]+)$/.exec(path.toLowerCase())?.[1] ?? "";
  if (ext === "dat") return "dat";
  if (ext === "png") return "png";
  if (["wav", "flac", "mp3", "ogg", "oga", "opus", "aif", "aiff", "aifc", "m4a"].includes(ext)) return "audio";
  return "other";
}

/**
 * What one run produces, given its input already decoded: the bytes to
 * write to `output`. `pcm` for a sound file, `peaks` for a .dat.
 */
export function produce(a: AwfArgs, src: { pcm?: Pcm16; peaks?: Peaks }): Uint8Array {
  const out = a.output ?? "";
  const kind = kindOf(out);
  if (kind === "dat") {
    if (!src.pcm) throw new Error("Can't generate waveform data from waveform data");
    const bits = a.bits ?? 16;
    if (bits !== 8 && bits !== 16) throw new Error("Invalid bits: must be either 8 or 16");
    return encodeDat(generatePeaks(src.pcm, samplesPerPixelFor(a, src.pcm.sampleRate)), bits);
  }
  if (kind === "png") {
    if (a.axisLabels) throw new Error("axis labels are not drawn here: pass --no-axis-labels");
    let peaks: Peaks;
    let spp: number;
    if (src.peaks) {
      spp = samplesPerPixelFor(a, src.peaks.sampleRate);
      if (spp < src.peaks.samplesPerPixel) throw new Error(`Invalid zoom, minimum: ${src.peaks.samplesPerPixel}`);
      peaks = spp === src.peaks.samplesPerPixel ? src.peaks : rescalePeaks(src.peaks, spp);
    } else if (src.pcm) {
      spp = samplesPerPixelFor(a, src.pcm.sampleRate);
      peaks = generatePeaks(src.pcm, spp);
    } else {
      throw new Error("no input");
    }
    return renderPeaks(peaks, {
      width: a.width,
      height: a.height,
      startTime: a.start,
      background: a.background,
      waveform: a.waveform,
      amplitudeScale: a.amplitudeScale,
    });
  }
  throw new Error(`Unknown file type: ${out} (only .dat and .png are made here)`);
}
