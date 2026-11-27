import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// E9-272 — an engine's NaN and infinities are zeroed at crone's input, so
// they cannot reach the reverb's and the compressor's state.

const src = fs.readFileSync(path.join(__dirname, "..", "src", "crone", "processor.js"), "utf8");

/** The two copy functions out of the worklet, run as they are written. */
function load(): (input: Float32Array[] | undefined, l: Float32Array, r: Float32Array, n: number) => number {
  const pick = (name: string): string => {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}`);
  };
  return new Function(`${pick("copyIn")}\n${pick("copyInFinite")}\nreturn copyInFinite;`)();
}

describe("crone's engine input", () => {
  const copyInFinite = load();

  it("passes finite samples through untouched", () => {
    const l = new Float32Array(4);
    const r = new Float32Array(4);
    const bad = copyInFinite([Float32Array.of(0.5, -1, 8e5, 0), Float32Array.of(0, 0.25, -0.25, 1)], l, r, 4);
    expect(bad).toBe(0);
    expect([...l]).toEqual([0.5, -1, 8e5, 0]);
    expect([...r]).toEqual([0, 0.25, -0.25, 1]);
  });

  it("zeroes NaN and both infinities, and counts them", () => {
    const l = new Float32Array(4);
    const r = new Float32Array(4);
    const bad = copyInFinite(
      [Float32Array.of(NaN, 0.5, Infinity, 0.1), Float32Array.of(-Infinity, NaN, 0.2, 0.3)],
      l,
      r,
      4,
    );
    expect(bad).toBe(4);
    expect([...l]).toEqual([0, 0.5, 0, Float32Array.of(0.1)[0]]);
    expect([...r]).toEqual([0, 0, Float32Array.of(0.2)[0], Float32Array.of(0.3)[0]]);
  });

  it("is what the engine's input goes through, and the ADC's is not", () => {
    expect(src).toMatch(/const bad = copyInFinite\(inputs\[0\], b\.extL, b\.extR, n\);/);
    expect(src).toMatch(/copyIn\(inputs\[1\], b\.adcL, b\.adcR, n\);/);
  });
});
