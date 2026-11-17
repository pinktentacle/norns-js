// The UGen names inside a `/d_recv` payload.
//
// WHY THIS EXISTS. scsynth throws when a SynthDef names a UGen it does not
// have, and this build has exceptions off, so the throw aborts the thread
// that handles `/d_recv` — and that thread never comes back. One bad def
// kills the audio server for the rest of the session: nothing loads, no poll
// reports, nothing sounds, while the audio thread keeps running and
// `/status` keeps answering so it all looks fine from the outside.
//
// A script only has to ship its own SuperCollider class for a UGen that is
// not in this build. `pedalboard/lib/fx/third_party/SmoothFold.sc` declares
// `SmoothFoldS`, sclang resolves it, and the server dies on the def.
// Compiling SmoothFold would fix that script and not the next one, so the
// page reads the def and refuses it instead.
//
// THE FORMAT is SuperCollider's own, documented in
// `HelpSource/Reference/Synth-Definition-File-Format.schelp`. Only what is
// needed to reach the UGen names is parsed, and every length is checked
// against the buffer — this runs on bytes sclang produced, but it also runs
// on bytes a script produced, and a malformed def must come back as "I could
// not read this" rather than as an exception in the OSC path.
//
//     "SCgf" int32 version   version 1 and 2 differ in the WIDTH of
//     int16 numDefs          several fields, which is the only reason
//     per def:               this is not twenty lines
//       pstring name
//       int32 numConstants, float32 * n
//       int32 numParams,    float32 * n
//       int32 numParamNames, (pstring, int32) * n
//       int32 numUGens
//       per ugen: pstring className, int8 rate, int32 numInputs,
//                 int32 numOutputs, int16 specialIndex,
//                 (int32 ugenIndex, int32 outputIndex) * numInputs,
//                 int8 rate * numOutputs

export interface SynthDefInfo {
  /** One entry per def in the payload. */
  readonly defs: Array<{ name: string; ugens: string[] }>;
}

class Reader {
  private at = 0;
  constructor(private readonly v: DataView) {}

  private need(n: number): void {
    if (this.at + n > this.v.byteLength) throw new Error("truncated SynthDef");
  }
  u8(): number {
    this.need(1);
    return this.v.getUint8(this.at++);
  }
  i16(): number {
    this.need(2);
    const n = this.v.getInt16(this.at);
    this.at += 2;
    return n;
  }
  i32(): number {
    this.need(4);
    const n = this.v.getInt32(this.at);
    this.at += 4;
    return n;
  }
  skip(n: number): void {
    if (n < 0) throw new Error("negative length in SynthDef");
    this.need(n);
    this.at += n;
  }
  /** A pascal string: one length byte, then that many bytes. */
  pstring(): string {
    const n = this.u8();
    this.need(n);
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.v.getUint8(this.at + i));
    this.at += n;
    return s;
  }
  tag(): string {
    this.need(4);
    let s = "";
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.v.getUint8(this.at + i));
    this.at += 4;
    return s;
  }
  get offset(): number {
    return this.at;
  }
}

/**
 * Read the def. Returns null when the bytes are not a SynthDef at all.
 *
 * Null is "I cannot tell", and the caller must treat it as permission to
 * send: refusing everything unreadable would turn a parser bug into a
 * silent audio outage, which is worse than the problem being solved.
 */
export function readSynthDefs(bytes: Uint8Array): SynthDefInfo | null {
  try {
    const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (r.tag() !== "SCgf") return null;
    const version = r.i32();
    if (version !== 1 && version !== 2) return null;
    // Version 2 widened these three counts from int16 to int32. Everything
    // else about the walk is the same.
    const count = (): number => (version === 1 ? r.i16() : r.i32());

    const numDefs = r.i16();
    if (numDefs < 0 || numDefs > 4096) return null;
    const defs: Array<{ name: string; ugens: string[] }> = [];

    for (let d = 0; d < numDefs; d++) {
      const name = r.pstring();
      const numConstants = count();
      r.skip(numConstants * 4);
      const numParams = count();
      r.skip(numParams * 4);
      const numParamNames = count();
      for (let i = 0; i < numParamNames; i++) {
        r.pstring();
        if (version === 1) r.i16();
        else r.i32();
      }
      const numUGens = count();
      const ugens: string[] = [];
      for (let u = 0; u < numUGens; u++) {
        const className = r.pstring();
        ugens.push(className);
        r.u8(); // rate
        const numInputs = count();
        const numOutputs = count();
        r.i16(); // special index
        // Each input is a pair; in version 1 both are int16, in 2 int32.
        r.skip(numInputs * (version === 1 ? 4 : 8));
        r.skip(numOutputs); // one rate byte each
      }
      defs.push({ name, ugens });
      // A variant section follows in version 2; it is not walked, because
      // the next def's name is not reached from here. Multi-def payloads
      // with variants are not something sclang sends for an engine.
      if (version === 2 && d + 1 < numDefs) {
        const numVariants = r.i16();
        for (let i = 0; i < numVariants; i++) {
          r.pstring();
          r.skip(numParams * 4);
        }
      }
    }
    return { defs };
  } catch {
    return null;
  }
}

/**
 * The UGens in this payload that the server does not have.
 *
 * `known` empty means the list was never loaded, and then nothing is
 * refused: a missing list must not become a reason to refuse every def.
 */
export function unknownUGens(bytes: Uint8Array, known: ReadonlySet<string>): string[] {
  if (known.size === 0) return [];
  const info = readSynthDefs(bytes);
  if (info === null) return [];
  const missing = new Set<string>();
  for (const def of info.defs) {
    for (const u of def.ugens) {
      // `BinaryOpUGen`, `UnaryOpUGen` and `Control` are real registered
      // UGens and appear in the list; nothing is special-cased here.
      if (!known.has(u)) missing.add(u);
    }
  }
  return [...missing];
}
