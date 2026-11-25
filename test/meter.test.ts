// The page's peak meter reads each side, not their mono sum: a stereo
// widener (dimension-expander) puts the same signal on both sides with one
// flipped, and (L+R)/2 of that is 0 — it measured silent while it played.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");

describe("the peak meter", () => {
  it("takes the louder of the two sides, off a splitter", () => {
    expect(main).toMatch(/const meterSplit = ctx\.createChannelSplitter\(2\);/);
    expect(main).toMatch(/meter\.connect\(meterSplit\);/);
    expect(main).toMatch(/peak: \(\) => Math\.max\(peakOf\(meterSides\[0\]!\), peakOf\(meterSides\[1\]!\)\)/);
  });

  it("leaves the audio path as it was: meter, master, speakers", () => {
    expect(main).toMatch(/meter\.connect\(master\);\s*master\.connect\(ctx\.destination\);/);
    expect(main).not.toMatch(/meterSides\[\d\]!?\.connect\(/);
  });
});
