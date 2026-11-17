// E9-66 — the two source defects that took sclang down, and the scanner
// that has to tell them from code that merely looks like them.
//
// Every case below is either a file that was measured in the browser or a
// shape that would make a naive `/\/\*/g` count answer wrongly. The regex
// version passes the first two and fails the rest, which is why there is a
// scanner.

import { describe, expect, it } from "vitest";
import { blockCommentDepth, repairScSource } from "../src/engine/sc-source.js";

const BOM = "﻿";

describe("the block comment that crashes the compiler", () => {
  it("sees lissadron's: opened at the bottom of the file, never closed", () => {
    // Engine_Lissadron.sc verbatim in shape — the real file ends here.
    const src = [
      "Engine_Lissadron : CroneGenEngine {",
      "\t*generators { ^Dictionary.new; }",
      "}",
      "",
      "/*",
      "",
      "Engine_Lissadron.generateLuaEngineModuleSpecsSection",
      "",
    ].join("\n");
    expect(blockCommentDepth(src)).toBe(1);

    const fixed = repairScSource("lissadron/lib/Engine_Lissadron.sc", src);
    expect(blockCommentDepth(fixed.text)).toBe(0);
    expect(fixed.text.startsWith(src)).toBe(true);
    expect(fixed.repairs).toHaveLength(1);
    expect(fixed.repairs[0]).toContain("Engine_Lissadron.sc");
    expect(fixed.repairs[0]).toContain("1 block comment");
  });

  it("leaves a balanced file exactly as it found it", () => {
    const src = "/* a note */\nSomeClass {\n\t// and a line comment\n}\n";
    const out = repairScSource("fine.sc", src);
    expect(out.text).toBe(src);
    expect(out.repairs).toEqual([]);
  });

  it("counts NESTED comments, which SuperCollider has and C does not", () => {
    expect(blockCommentDepth("/* outer /* inner */ still outer")).toBe(1);
    expect(blockCommentDepth("/* outer /* inner */ back */ out")).toBe(0);
    expect(blockCommentDepth("/* a /* b")).toBe(2);
    // Two closes are needed, and both are written.
    const out = repairScSource("two.sc", "/* a /* b");
    expect(blockCommentDepth(out.text)).toBe(0);
    expect(out.repairs[0]).toContain("2 block comments");
  });

  it("does not take a comment opener inside a string for a comment", () => {
    expect(blockCommentDepth('var s = "/*";')).toBe(0);
    expect(blockCommentDepth("var s = '/*';")).toBe(0);
    expect(blockCommentDepth('"a \\" /* still a string";')).toBe(0);
  });

  it("ignores an opener inside a line comment, as the lexer does", () => {
    expect(blockCommentDepth("// /* not an open\n")).toBe(0);
    expect(blockCommentDepth("A { } // /*\n")).toBe(0);
  });

  it("lets a close inside a line comment count, because sclang does", () => {
    // Not a guess: `langutils/sc_lexer/include/lexer.hpp` scans a block
    // comment for the two delimiters ONLY, so `//` has no meaning once
    // you are inside one. This closes. A scanner that suppressed it
    // would report an unclosed comment in a file that compiles, and
    // "repair" it by appending a stray close.
    expect(blockCommentDepth("/* open\n// */ out again\n")).toBe(0);
    expect(repairScSource("ok.sc", "/* a\n// */\n").repairs).toEqual([]);
  });

  it("reads `$\"` as a character, which is what Mp3.sc writes", () => {
    // ("MP3." ++ varname + "=" + $" ++ poss ++ $").interpret
    // A scanner that takes that `$"` for a string runs off the end of the
    // file and every count after it is wrong.
    const src = '("MP3." ++ v + "=" + $" ++ p ++ $").interpret;\n/* open\n';
    expect(blockCommentDepth(src)).toBe(1);
    expect(blockCommentDepth('$" + "a string" + $"')).toBe(0);
    expect(blockCommentDepth("$\\t /* open")).toBe(1);
  });
});

describe("the byte-order mark that crashes the compiler", () => {
  it("removes sway's, which sits in the middle of a line", () => {
    // Norns_Sway.sc line 21: a tab, a U+FEFF, then SynthDef.
    const src = `\t\t\t${BOM}SynthDef(\freeze, {\n\t\t\t|in = 0|\n`;
    const out = repairScSource("sway/lib/Norns_Sway.sc", src);
    expect(out.text).toBe("\t\t\tSynthDef(\freeze, {\n\t\t\t|in = 0|\n");
    expect(out.text).not.toContain(BOM);
    expect(out.repairs).toHaveLength(1);
    expect(out.repairs[0]).toContain("Norns_Sway.sc");
    expect(out.repairs[0]).toContain("U+FEFF");
  });

  it("removes a LEADING one too, and counts them", () => {
    const out = repairScSource("x.sc", `${BOM}A { }\n${BOM}B { }\n`);
    expect(out.text).toBe("A { }\nB { }\n");
    expect(out.repairs[0]).toContain("2 stray byte-order marks");
  });

  it("reports both repairs when a file needs both", () => {
    const out = repairScSource("x.sc", `${BOM}A { }\n/*\n`);
    expect(out.repairs).toHaveLength(2);
    expect(blockCommentDepth(out.text)).toBe(0);
    expect(out.text).not.toContain(BOM);
  });
});

describe("the one line that is a correction and not a repair", () => {
  // E9-68 — splnkr. `Tartini.kr` is control rate and `Clip.ar` refuses a
  // first input that is not audio rate, so the SynthDef never built, the
  // engine registered none of its thirty commands, and the script died in
  // init on `engine.set_numSegs`. The other two uses of `freq` in the file
  // are `Tartini.kr` and `SendReply.kr`.
  const LINE = "      freq = Clip.ar(freq, 0.midicps, 127.midicps);";

  it("changes Clip.ar to Clip.kr, and says so with the file name", () => {
    const src = `# freq, hasFreq = Tartini.kr(wet);\n${LINE}\n`;
    const out = repairScSource("splnkr/lib/Engine_Splnkr.sc", src);
    expect(out.text).toContain("Clip.kr(freq, 0.midicps, 127.midicps)");
    expect(out.text).not.toContain("Clip.ar(freq");
    expect(out.repairs).toHaveLength(1);
    expect(out.repairs[0]).toContain("Engine_Splnkr.sc");
    expect(out.repairs[0]).toContain("control-rate");
    // Nothing else moved.
    expect(out.text.split("\n")[0]).toBe("# freq, hasFreq = Tartini.kr(wet);");
  });

  it("stops firing the day the repository fixes it", () => {
    // The text is matched, not the file alone, so an upstream fix is not
    // overwritten and nothing is claimed in the log.
    const fixed = LINE.replace("Clip.ar", "Clip.kr");
    const out = repairScSource("splnkr/lib/Engine_Splnkr.sc", fixed);
    expect(out.text).toBe(fixed);
    expect(out.repairs).toEqual([]);
  });

  it("does not touch the same line in somebody else's file", () => {
    const out = repairScSource("other/lib/Engine_Other.sc", LINE);
    expect(out.text).toBe(LINE);
    expect(out.repairs).toEqual([]);
  });

  it("leaves a file that needs neither kind of change alone", () => {
    const src = "Engine_Thing : CroneEngine {\n\talloc { }\n}\n";
    const out = repairScSource("thing/lib/Engine_Thing.sc", src);
    expect(out.text).toBe(src);
    expect(out.repairs).toEqual([]);
  });
});
