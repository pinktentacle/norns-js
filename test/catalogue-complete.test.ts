// E9-133 — every script in the catalogue is reachable.
//
// Reported from a Pixel (user, 2026-11-19) as a list that stops scrolling:
// the `available` tab ended at `splicer` and nothing below it could be
// reached. It was not a scroll bug. `maiden-project.ts` drew
// `found.slice(0, 300)` of 355 entries, so the last 55 — `splicer` to
// `zxcvbn` — were never in the DOM, while the summary above them said
// "355 of 355".
//
// A browser proved the fix once: 355 rows, the container scrolled to its
// end, `zxcvbn` last. This is what keeps it. The render loop needs a DOM
// and `maiden-project.ts` needs a page, so what runs here is the text of
// the module — the same tactic as `rail-panels.test.ts`, and for the same
// reason.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { search } from "../src/community/catalog.js";
import type { CatalogEntry } from "../src/community/catalog.js";

const ROOT = path.resolve(__dirname, "..");
const project = fs.readFileSync(path.join(ROOT, "src", "ui", "maiden-project.ts"), "utf8");

/**
 * Comments out, code in.
 *
 * Without this the first run failed on the comment that EXPLAINS the cap,
 * which quotes `found.slice(0, 300)` to say what was removed. A test that
 * cannot tell code from the note beside it would make the fix harder to
 * document than to undo. Whole-line comments only, so a `//` inside a
 * string stays where it is.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}

/** The body of `draw`'s catalogue branch: from the search call to the summary. */
function catalogueBranch(): string {
  const from = project.indexOf("const found = search(catalog.entries, query.value);");
  expect(from, "the catalogue branch has moved").toBeGreaterThan(-1);
  // To the end of `draw` itself, so the summary line is inside the window.
  const to = project.indexOf("\n  };", from);
  expect(to, "the end of draw() has moved").toBeGreaterThan(from);
  return code(project.slice(from, to));
}

describe("the available list shows the whole catalogue", () => {
  it("iterates every match, with no limit on the way to the DOM", () => {
    const body = catalogueBranch();
    // The exact shape that caused it, and anything else that would cut the
    // list down between the search and the rows.
    expect(body, "the 300-row cap is back").not.toMatch(/found\s*\.\s*slice\s*\(/);
    expect(body, "the matches are sliced before they are drawn").not.toMatch(
      /for\s*\(\s*const\s+\w+\s+of\s+found\s*\.\s*\w+\s*\(/,
    );
    expect(body).toMatch(/for\s*\(\s*const\s+entry\s+of\s+found\s*\)/);
  });

  // THE PART THAT MADE IT SURVIVE. A cap is a decision; a cap nobody can
  // see is a bug. The summary counted the search result, so it agreed with
  // itself and disagreed with the screen.
  it("counts what it drew, not what it found", () => {
    const body = catalogueBranch();
    expect(body).toMatch(/shown\+\+/);
    expect(body, "the summary is back to counting the search result").not.toMatch(
      /say\(`\$\{found\.length\} of/,
    );
    expect(body).toMatch(/say\(`\$\{shown\} of \$\{catalog\.entries\.length\}/);
  });

  it("empties to the whole catalogue rather than to nothing", () => {
    // The other half: clearing the search box has to give everything back.
    const entries = ["zxcvbn", "awake", "splicer", "takt"].map(
      (name): CatalogEntry => ({
        name,
        author: "someone",
        description: "",
        tags: [],
        url: `https://github.com/someone/${name}`,
        documentation: null,
        discussion: null,
      }),
    );
    expect(search(entries, "")).toHaveLength(entries.length);
    expect(search(entries, "   ")).toHaveLength(entries.length);
    // And it is a copy, so a caller sorting or splicing it cannot reach
    // back into the catalogue the panel keeps.
    expect(search(entries, "")).not.toBe(entries);
  });
});
