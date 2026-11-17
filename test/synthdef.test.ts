// The UGen names inside a /d_recv payload.
//
// Not used by the page in the end — the check lives in sclang, where a
// SynthDef is still an object and `ugen.name` is the same string the def
// file carries. This parser stays because it is the only way to assert, from
// a test, that a given payload names a given UGen: it reads the bytes the
// server would read.

import { describe, expect, it } from "vitest";
import { readSynthDefs, unknownUGens } from "../src/engine/synthdef.js";

/** A minimal version-2 SynthDef with the UGens named. */
function makeDef(name: string, ugens: string[]): Uint8Array {
  const parts: number[] = [];
  const push32 = (n: number) => parts.push((n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  const push16 = (n: number) => parts.push((n >> 8) & 255, n & 255);
  const pstr = (s: string) => {
    parts.push(s.length);
    for (const c of s) parts.push(c.charCodeAt(0));
  };
  for (const c of "SCgf") parts.push(c.charCodeAt(0));
  push32(2); // version
  push16(1); // one def
  pstr(name);
  push32(0); // constants
  push32(0); // params
  push32(0); // param names
  push32(ugens.length);
  for (const u of ugens) {
    pstr(u);
    parts.push(0); // rate
    push32(0); // inputs
    push32(1); // outputs
    push16(0); // special index
    parts.push(0); // one output rate byte
  }
  return new Uint8Array(parts);
}

describe("reading a SynthDef", () => {
  it("finds the def's name and its UGens", () => {
    const info = readSynthDefs(makeDef("probe", ["SinOsc", "Out"]));
    expect(info?.defs).toEqual([{ name: "probe", ugens: ["SinOsc", "Out"] }]);
  });

  it("returns null for bytes that are not a SynthDef", () => {
    expect(readSynthDefs(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(readSynthDefs(new TextEncoder().encode("SCgfnope"))).toBeNull();
  });

  it("returns null rather than throwing on a truncated one", () => {
    const whole = makeDef("probe", ["SinOsc"]);
    expect(readSynthDefs(whole.subarray(0, whole.length - 3))).toBeNull();
  });
});

describe("the check", () => {
  it("names only the UGens that are missing", () => {
    const known = new Set(["SinOsc", "Out"]);
    expect(unknownUGens(makeDef("p", ["SinOsc", "Out"]), known)).toEqual([]);
    expect(unknownUGens(makeDef("p", ["SinOsc", "SmoothFoldS", "Out"]), known)).toEqual([
      "SmoothFoldS",
    ]);
  });

  it("REFUSES NOTHING when the list is empty", () => {
    // A missing list must not become a reason to refuse every def: that
    // would turn a build mistake into a silent audio outage.
    expect(unknownUGens(makeDef("p", ["Whatever"]), new Set())).toEqual([]);
  });

  it("refuses nothing when the bytes cannot be read", () => {
    expect(unknownUGens(new Uint8Array([9, 9, 9]), new Set(["SinOsc"]))).toEqual([]);
  });
});
