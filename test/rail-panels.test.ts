// E9-93 — the rail's panels, checked against the page rather than the code.
//
// Three defects in one report (user, 2026-11-17), and all three are the kind
// that come back silently because nothing fails when they do:
//
//   1. The settings panel sat at `right: 14px`. The rail is at `right: 10px`
//      and 28px wide, so the panel was UNDER it — and the rail has the higher
//      z-index, so the × that closes the panel could not be clicked.
//   2. Settings and the level could be open at once, overlapping. The four
//      popovers already closed each other; the gear was not among them.
//   3. The zoom panel's reset button was labelled `100%`, an inch from a
//      readout that also says `100%` whenever the zoom is at unity.
//
// A browser proved each fix once. These are what keep them: arithmetic on
// the stylesheet, and a count of what `main.ts` registers. Neither needs a
// DOM, which is why they can run here at all — `main.ts` wants an
// AudioWorklet and a cross-origin-isolated origin, and Node has neither.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "src", "main.ts"), "utf8");

/** The first `prop: <n>px` inside the block that starts at `selector`. */
function px(selector: string, prop: string): number {
  const at = html.indexOf(selector + " {");
  expect(at, `${selector} is not in index.html`).toBeGreaterThan(-1);
  const block = html.slice(at, html.indexOf("}", at));
  const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(-?[\\d.]+)px`).exec(block);
  expect(m, `${selector} has no ${prop} in px`).not.toBeNull();
  return Number(m![1]);
}

describe("the rail and the panels that hang off it", () => {
  // The rail is fixed to the right edge; a panel's `right` has to clear it,
  // or the panel is behind the buttons. 10 + 28 = 38 is the rail's inner
  // edge, and anything less than that overlaps.
  const railRight = px(".rail", "right");
  const railWidth = px(".rail-b", "width");

  it("the popovers open clear of the rail", () => {
    expect(px(".dv", "right")).toBeGreaterThanOrEqual(railRight + railWidth);
  });

  it("the settings panel opens clear of the rail, so its × can be clicked", () => {
    expect(px(".sp", "right")).toBeGreaterThanOrEqual(railRight + railWidth);
  });

  it("the settings panel leaves room for what it is offset by", () => {
    // `width: min(330px, calc(100vw - N))`. N has to cover the offset on the
    // right AND a matching gutter on the left, or a narrow window puts the
    // panel's left edge off screen.
    const at = html.indexOf(".sp {");
    const m = /width:\s*min\(\d+px,\s*calc\(100vw\s*-\s*(\d+)px\)\)/.exec(html.slice(at, html.indexOf("}", at)));
    expect(m, ".sp has no min()/calc() width").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2 * px(".sp", "right") - 36);
  });
});

describe("one panel at a time", () => {
  // Every panel that can be open has to be registered, or it is the one that
  // stays on screen under the next one. Counted rather than named: a seventh
  // panel added without a `railPanel(...)` beside it fails here.
  it("every rail panel is registered with the exclusion list", () => {
    const panels = [...html.matchAll(/<div class="dv" id="(\w+)" hidden>/g)].map((m) => m[1]);
    // The four popovers, plus the settings panel, which is built elsewhere.
    expect(panels.length).toBeGreaterThanOrEqual(4);
    const registered = [...main.matchAll(/railPanel\(/g)].length;
    expect(registered).toBe(panels.length + 1);
  });

  it("each registration opens by closing the others", () => {
    expect([...main.matchAll(/closeOtherPanels\(/g)].length).toBeGreaterThanOrEqual(
      [...main.matchAll(/railPanel\(/g)].length,
    );
  });
});

describe("a button says what it does, not what it is worth", () => {
  // Both of these were renamed after the same complaint, a day apart: a
  // button labelled with a value sits beside a readout showing that value,
  // and reads as a second copy of the readout that sometimes disagrees.
  for (const id of ["zoomreset", "volume0"]) {
    it(`#${id} is not labelled with a number`, () => {
      const m = new RegExp(`<button id="${id}"[^>]*>([^<]*)</button>`).exec(html);
      expect(m, `#${id} is not a button in index.html`).not.toBeNull();
      expect((m![1] ?? "").trim()).toBe("reset");
    });
  }
});
