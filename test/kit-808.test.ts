// E9-41 — the stock drum kit, which is generated rather than vendored.
//
// `bakeneko` dies in `init` on an empty `~/dust/audio/common/808`: it lists
// the directory with `io.popen('ls -a …')` and then calls
// `math.random(1, #t)`, which raises "interval is empty" when the listing
// is empty. The kit exists to make that listing non-empty, so the two
// things worth testing are that the files ARE a listing a script can use —
// the names it asks for, readable as WAV — and that two builds produce the
// same bytes, because the manifest records a size and a URL per file.

import { describe, expect, it } from "vitest";
// @ts-expect-error -- a build tool, plain JS, with no types of its own.
import { kit808, KIT_README, KIT_README_PATH } from "../tools/kit-808.mjs";
import { parseWavHeader } from "../src/fs/wav-header.js";

const kit = (): Map<string, Buffer> => kit808() as Map<string, Buffer>;

describe("the synthesised 808 kit", () => {
  it("carries the names the catalogue actually asks for", () => {
    // Read off the 354 scripts, not invented: `bakeneko` names 808-BD.wav
    // outright and picks the rest at random from the listing.
    const names = [...kit().keys()];
    for (const n of ["808-BD", "808-SD", "808-CH", "808-OH", "808-CP", "808-CY", "808-RS"]) {
      expect(names, n).toContain(`${n}.wav`);
    }
    expect(names.filter((n) => n.endsWith(".wav"))).toHaveLength(17);
  });

  it("says beside the folder that it is not the Roland samples", () => {
    // The one claim that must survive somebody opening the directory.
    expect(KIT_README).toContain("NOT the Roland");
    expect(KIT_README_PATH).toBe("/home/we/dust/audio/common/.808-README.txt");
  });

  // E9-130, then E9-230. Undotted, `bakeneko` drew the note from the
  // folder it picks at random, handed a text file to `decodeAudioData`,
  // and its engine compared the resulting nil against a number. Dotted,
  // it STILL drew it: it lists with `ls -a`. A norns' 808 folder holds
  // the sounds and nothing else, so here it does too.
  it("holds the sounds and nothing else", () => {
    const names = [...kit().keys()];
    expect(names.filter((n) => !n.endsWith(".wav"))).toEqual([]);
  });

  it("writes WAVs the same parser the manifest uses can read", () => {
    // A file whose header does not parse reaches `audio.file_info` as
    // nothing, and a script computing a duration from it gets NaN all the
    // way down — the failure E5-35 traced through `amen`.
    for (const [name, data] of kit()) {
      if (!name.endsWith(".wav")) continue;
      const info = parseWavHeader(data);
      expect(info, name).not.toBeNull();
      expect(info!.channels).toBe(1);
      expect(info!.sampleRate).toBe(48000);
      expect(info!.frames).toBeGreaterThan(1000);
    }
  });

  it("is a drum and not a click or a silence", () => {
    // Peak-normalised to 0.9, and long enough to be heard.
    for (const [name, data] of kit()) {
      if (!name.endsWith(".wav")) continue;
      let peak = 0;
      for (let i = 44; i + 1 < data.length; i += 2) {
        peak = Math.max(peak, Math.abs(data.readInt16LE(i)) / 32768);
      }
      expect(peak, name).toBeGreaterThan(0.85);
      expect(parseWavHeader(data)!.frames / 48000, name).toBeGreaterThan(0.03);
    }
  });

  it("gives the same bytes twice, because the manifest records sizes", () => {
    // Math.random here would churn dust-assets.json on every build and make
    // two builds impossible to compare.
    const a = kit();
    const b = kit();
    for (const [name, data] of a) expect(b.get(name)!.equals(data), name).toBe(true);
  });

  it("is low where a kick is low and high where a hat is high", () => {
    // Rough but real: zero crossings per second separate the voices, and a
    // kit where the kick was brighter than the hat would be a bug nobody
    // would catch from a header.
    const zcr = (name: string): number => {
      const d = kit().get(name)!;
      const n = (d.length - 44) / 2;
      let crossings = 0;
      let prev = 0;
      for (let i = 0; i < n; i++) {
        const v = d.readInt16LE(44 + i * 2);
        if (i > 0 && v < 0 !== prev < 0) crossings++;
        prev = v;
      }
      return crossings / (n / 48000);
    };
    expect(zcr("808-BD.wav")).toBeLessThan(400);
    expect(zcr("808-LT.wav")).toBeLessThan(zcr("808-HT.wav"));
    expect(zcr("808-CH.wav")).toBeGreaterThan(2000);
    expect(zcr("808-CY.wav")).toBeGreaterThan(zcr("808-CH.wav"));
  });
});
