// E9-130 — the console's timestamp column.
//
// The DOM half of `src/ui/log.ts` is two calls and needs a browser; it is
// verified in the page. Everything that decides what a line LOOKS like is
// here, because a timestamp that is subtly wrong is worse than none: it is
// read as a measurement.

import { describe, expect, it } from "vitest";
import { stamp } from "../src/ui/log.js";

describe("the console's timestamp", () => {
  it("is seconds since the time origin, to three places", () => {
    expect(stamp("booting", 1234)).toBe("  1.234 booting\n");
  });

  it("keeps the text in a column", () => {
    const lines = [stamp("a", 0), stamp("b", 9_999), stamp("c", 123_456)];
    const cols = lines.map((l) => l.indexOf(" ", l.search(/\S/)) + 1);
    expect(new Set(cols).size).toBe(1);
    expect(lines[0]).toBe("  0.000 a\n");
    expect(lines[1]).toBe("  9.999 b\n");
    expect(lines[2]).toBe("123.456 c\n");
  });

  it("pushes rather than truncating once a session runs long", () => {
    // Four figures of seconds is 2.7 hours in. The column gives way; the
    // number does not, because a clipped timestamp is a wrong one.
    expect(stamp("still here", 12_345_678)).toBe("12345.678 still here\n");
  });

  // THE ONE THAT MATTERS. sclang's backtraces arrive as one chunk of forty
  // lines; forty stamps would be forty moments invented out of one.
  it("stamps a multi-line chunk once and indents the rest", () => {
    expect(stamp("ERROR: nil\n  at foo\n  at bar", 2_000)).toBe(
      "  2.000 ERROR: nil\n" + //
        "          at foo\n" +
        "          at bar\n",
    );
  });

  it("leaves a chunk's blank lines blank, and keeps its line count", () => {
    const chunk = "one\n\nthree";
    const out = stamp(chunk, 1_000);
    expect(out.split("\n")).toHaveLength(chunk.split("\n").length + 1);
    expect(out.split("\n")[1]).toBe("        ");
  });

  it("does not swallow a trailing newline into nothing", () => {
    // `log("a\n")` used to append "a\n\n" — one line and a blank. It still
    // does, because changing that would change what sclang's output looks
    // like for a reason that has nothing to do with sclang.
    expect(stamp("a\n", 0)).toBe("  0.000 a\n        \n");
  });

  it("is subtractable, which is the whole reason for it", () => {
    const a = Number(stamp("x", 1_500).slice(0, 7));
    const b = Number(stamp("y", 4_250).slice(0, 7));
    expect(b - a).toBeCloseTo(2.75, 3);
  });
});
