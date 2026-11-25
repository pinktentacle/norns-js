// E9-222 — a script that listens to an input that is off is said on the page.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { engineReadsInput } from "../src/engine/input-use.js";
import { Vfs } from "../src/fs/vfs.js";

const code = (files: Record<string, string>): Vfs => {
  const vfs = new Vfs();
  for (const [p, text] of Object.entries(files)) vfs.write(`/home/we/dust/code/${p}`, text);
  return vfs;
};

describe("does an engine hear the input", () => {
  it("leslie does: an effect reads context.in_b", () => {
    const vfs = code({
      "leslie/lib/Engine_Leslie.sc": `Engine_Leslie : CroneEngine {
  alloc { SynthDef(\\leslie, { var in = In.ar(context.in_b, 2); Out.ar(context.out_b, in) }).add } }`,
    });
    expect(engineReadsInput(vfs, "Leslie")).toBe(true);
  });

  it("so does one that uses SoundIn, in a second class of the same script", () => {
    const vfs = code({
      "caster/engine/Engine_Caster.sc": "Engine_Caster : CroneEngine { alloc { k = Kernel.new } }",
      "caster/engine/Kernel.sc": "Kernel { *new { ^{ Out.ar(0, SoundIn.ar([0, 1])) }.play } }",
    });
    expect(engineReadsInput(vfs, "Caster")).toBe(true);
  });

  it("a synth that never touches the input does not", () => {
    const vfs = code({
      "perc/lib/Engine_Perc.sc": "Engine_Perc : CroneEngine { alloc { SynthDef(\\p, { Out.ar(context.out_b, SinOsc.ar) }).add } }",
    });
    expect(engineReadsInput(vfs, "Perc")).toBe(false);
  });

  it("nor does one whose only SoundIn is commented out", () => {
    const vfs = code({
      "quiet/lib/Engine_Quiet.sc": `Engine_Quiet : CroneEngine {
  // var in = SoundIn.ar(0);
  /* context.in_b */
  alloc { } }`,
    });
    expect(engineReadsInput(vfs, "Quiet")).toBe(false);
  });

  it("does not look at another script's classes", () => {
    const vfs = code({
      "perc/lib/Engine_Perc.sc": "Engine_Perc : CroneEngine { alloc { } }",
      "leslie/lib/Engine_Leslie.sc": "Engine_Leslie : CroneEngine { alloc { In.ar(context.in_b, 2) } }",
    });
    expect(engineReadsInput(vfs, "Perc")).toBe(false);
  });

  it("answers no for an engine it cannot find, and for None", () => {
    expect(engineReadsInput(code({}), "Nowhere")).toBe(false);
    expect(engineReadsInput(code({}), "None")).toBe(false);
  });
});

describe("the page", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");

  it("says it when a silent script's engine hears the input", () => {
    expect(main).toMatch(/verdict\?\.kind === "nothing-arrives" && engineHearsInput/);
    expect(main).toMatch(/onLoadEngine: \(name\) => void \(engineHearsInput = engineReadsInput\(vfs, name\)\)/);
  });

  it("shows the looper's warning on the page too, not only in the log", () => {
    expect(main).toMatch(/onWantsInput: \(\) => inputHint\(/);
    expect(main).toMatch(/showInputNotice\(/);
  });

  it("forgets it with the script", () => {
    const clear = main.slice(main.indexOf('line.startsWith("# script clear")'), main.indexOf("rawLog(line);"));
    expect(clear).toMatch(/engineHearsInput = false/);
    expect(clear).toMatch(/getElementById\("input-notice"\)\?\.remove\(\)/);
  });
});

// E9-222 — the input reaches the engine. On a norns crone hands the ADC to
// SuperCollider over JACK (`crone:output_5` -> `SuperCollider:in_1`); here
// nothing stood in for it, so `SoundIn` was silent with the microphone on.
describe("the audio input, into the engine", () => {
  const read = (p: string): string => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  it("is rendered by crone's mixer and exported", () => {
    const cpp = read("src/crone/worklet.cpp");
    // E9-240 — through the cable matrix: the Ext sink is the default cable.
    expect(cpp).toMatch(/mixer->setSink\(MixerClient::SinkExt, extSinkL, extSinkR\)/);
    expect(cpp).toMatch(/float route\[4\]\[2\] = \{\{1\.f, 0\.f\}, \{0\.f, 1\.f\}, \{0\.f, 0\.f\}, \{0\.f, 0\.f\}\};/);
    expect(cpp).toMatch(/auxL\[i\] = route\[0\]\[0\] \* s0 \+ route\[1\]\[0\] \* s1 \+ route\[2\]\[0\] \* s2 \+ route\[3\]\[0\] \* s3;/);
    expect(cpp).toMatch(/crone_aux_left\(\) \{ return auxL; \}/);
    expect(cpp).toMatch(/crone_aux_right\(\) \{ return auxR; \}/);
  });

  it("leaves the worklet on a second output", () => {
    expect(read("src/crone/crone.ts")).toMatch(/numberOfOutputs: 2,\s*outputChannelCount: \[2, 2\]/);
    const proc = read("src/crone/processor.js");
    expect(proc).toMatch(/const toEngine = outputs\[1\];/);
    expect(proc).toMatch(/toEngine\[0\]\.set\(b\.auxL\.subarray\(0, n\)\)/);
  });

  it("goes into scsynth through one quantum of delay, because the graph is a cycle", () => {
    const main = read("src/main.ts");
    expect(main).toMatch(/new DelayNode\(ctx, \{ maxDelayTime: 0\.05, delayTime: 128 \/ ctx\.sampleRate \}\)/);
    expect(main).toMatch(/crone\.node\.connect\(toEngine, 1\)/);
    expect(main).toMatch(/toEngine\.connect\(node, 0, 0\)/);
  });
});
