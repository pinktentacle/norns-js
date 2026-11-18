// E9-110 — what a phone does to a page built on a desk.
//
// Four screenshots from a Pixel 9 Pro (user, 2026-11-18), and four
// separate faults in them. Every one was measured in the page at 375 CSS
// px before it was fixed, and the numbers are here so the fixes cannot
// quietly come undone.
//
// Arithmetic on the stylesheet and on the sources, like
// `rail-panels.test.ts` and for the same reason: `main.ts` wants an
// AudioWorklet and a cross-origin-isolated origin, and Node has neither.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const stage = fs.readFileSync(path.join(ROOT, "src", "ui", "stage.ts"), "utf8");
const panel = fs.readFileSync(path.join(ROOT, "src", "ui", "maiden-panel.ts"), "utf8");
const project = fs.readFileSync(path.join(ROOT, "src", "ui", "maiden-project.ts"), "utf8");

/** The body of the rule for `selector`, the first one declared. */
function rule(selector: string): string {
  const at = html.indexOf(selector + " {");
  expect(at, `${selector} is not in index.html`).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("}", at));
}

/** A `prop: <n>px` inside that rule. */
function px(selector: string, prop: string): number {
  const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(-?[\\d.]+)px`).exec(rule(selector));
  expect(m, `${selector} has no ${prop} in px`).not.toBeNull();
  return Number(m![1]);
}

/**
 * EVERY `@media (max-width: <n>px)` block, joined.
 *
 * There is more than one, and which rule is in which is an accident of
 * where the rule it overrides happens to live. The cascade sees all of
 * them, so a test that read only the first would be testing the file's
 * order rather than the page's behaviour.
 */
function media(width: number): string {
  const head = `@media (max-width: ${width}px) {`;
  const blocks: string[] = [];
  for (let at = html.indexOf(head); at !== -1; at = html.indexOf(head, at + 1)) {
    // Brace matching, because these blocks hold rules of their own.
    let depth = 0;
    for (let i = at + head.length - 1; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}" && --depth === 0) {
        blocks.push(html.slice(at, i + 1));
        break;
      }
    }
  }
  expect(blocks.length, `there is no @media (max-width: ${width}px)`).toBeGreaterThan(0);
  return blocks.join("\n\n");
}

/** Where the block that holds `needle` starts, for an ordering check. */
function mediaAt(width: number, needle: string): number {
  const head = `@media (max-width: ${width}px) {`;
  for (let at = html.indexOf(head); at !== -1; at = html.indexOf(head, at + 1)) {
    let depth = 0;
    for (let i = at + head.length - 1; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}" && --depth === 0) {
        if (html.slice(at, i + 1).includes(needle)) return at;
        break;
      }
    }
  }
  return -1;
}

describe("the rail, which is fixed over everything", () => {
  it("has a gutter wide enough to keep the page out from under it", () => {
    // Measured at 375px before this: the norns ran to x=359 and the rail
    // starts at x=337 — twenty-two pixels of instrument under the buttons,
    // the edge where E1 and E3 sit on both bodies. The grid lost twelve.
    const right = px(".rail", "right");
    const width = px(".rail-b", "width");
    const gutter = Number(/padding-right:\s*(\d+)px/.exec(rule("body"))?.[1] ?? 0);
    expect(gutter, "the body's right padding is under the rail's own band").toBeGreaterThan(
      right + width,
    );
  });
});

describe("maiden, on a screen too narrow for three columns", () => {
  const narrow = () => media(720);

  it("gives the editor the width the tree used to take", () => {
    // Measured at 375px: rail 44, tree 229, EDITOR 101. The tree is a
    // fixed 230px column of a three-column grid, so on a narrow screen it
    // takes what the rail left and the thing you opened gets the rest.
    expect(html).toContain("grid-template-columns: 44px 230px 1fr;");
    expect(narrow()).toContain("grid-template-columns: 44px 1fr;");
    // And the tree comes back as an overlay rather than vanishing.
    expect(narrow()).toMatch(/\.mdn-side\s*\{[^}]*position:\s*absolute/);
  });

  it("gives the tree a button, because Ctrl-B is not a gesture", () => {
    expect(panel).toContain("filesButton");
    expect(narrow()).toMatch(/\.mdn-files\s*\{\s*display:\s*block/);
    // Hidden where the tree is a column: a button offering what is already
    // on screen is a button that lies.
    expect(rule(".mdn-files")).toContain("display: none");
  });

  it("closes the tree when a file is chosen, which is the point of an overlay", () => {
    expect(panel).toMatch(/if \(narrow\(\)\) showSide\(false\);/);
  });

  it("puts the catalogue row's controls on a line of their own", () => {
    // `flex: 1 1 100%` is a basis of a whole line that may still SHRINK,
    // and it did: `details` came up at the end of the description and
    // `code` alone underneath it. Measured on `_awed` and `3d`.
    expect(narrow()).toMatch(/\.mdn-proj-left\s*\{[^}]*flex:\s*0 0 100%/);
    expect(narrow()).toMatch(/\.mdn-proj-desc\s*\{[^}]*flex:\s*0 0 100%/);
    expect(narrow()).toMatch(/\.mdn-proj-row\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it("is declared after the rules it overrides, or it does nothing at all", () => {
    // Found by measuring rather than by reading: `flex-basis` stayed
    // `auto` at 375px because the block sat ABOVE `.mdn-proj-left`, and
    // between two rules of the same specificity the later one wins.
    const base = html.indexOf(".mdn-proj-left {");
    const override = mediaAt(720, ".mdn-proj-left");
    expect(base).toBeGreaterThan(-1);
    expect(override, "no narrow block carries .mdn-proj-left").toBeGreaterThan(-1);
    expect(override, "the narrow block is above the rules it overrides").toBeGreaterThan(base);
  });
});

describe("the catalogue summary, which was painted over the first row", () => {
  it("lets the scroller shrink, so the lines above it keep their height", () => {
    // A flex item will not shrink below its content by default, so the
    // scroller refused to give up height and the siblings — which have no
    // content to defend — were squeezed instead. On a phone the summary
    // wraps to four lines and one line's worth of box was all it got.
    expect(rule(".mdn-proj-list")).toContain("min-height: 0");
    expect(html).toMatch(
      /\.mdn-proj-tabs,\s*\.mdn-proj-bar,\s*\.mdn-proj-jobs,\s*\.mdn-proj-note,\s*\.mdn-proj-ask\s*\{\s*flex:\s*0 0 auto/,
    );
  });
});

describe("a handheld on its side", () => {
  it("lays out in two columns, like the deck it has become", () => {
    // 812x375 is wide and short, which is the shape the deck's two columns
    // exist for. Stacked at full width the norns alone came to 750 by 670
    // on a 375-tall screen. The page DID re-lay-out on the turn — `refresh`
    // is on the resize event — and laid it out to the wrong rule.
    expect(stage).toContain("const SIDEWAYS = SHARE.steamdeck;");
    expect(stage).toMatch(/const sideways = \(\): boolean =>/);
    expect(stage).toContain("const twoColumns = sideways();");
    expect(stage).toContain("const deck = sideways();");
  });

  it("never asks the question on a desk, where scrolling is normal", () => {
    expect(stage).toMatch(/kindNow\(\) !== "normal" &&/);
  });
});

describe("the download strip, which used to move the list under the finger", () => {
  it("gives the scroller back exactly what the strip took", () => {
    // Press `install` three hundred rows down and the row you pressed
    // walked down the screen: the strip is pinned above the list, so the
    // scroller's box got shorter from the top and its content, keeping
    // `scrollTop`, slid down by as much. Measured at 349px for the first
    // press and 50 for the second; now -2, 0, 0 over three presses.
    expect(project).toContain("const resizing = willDraw !== jobRowsDrawn;");
    expect(project).toMatch(/list\.scrollTop = scrolled \+ delta;/);
  });

  it("only measures when a row comes or goes", () => {
    // `drawJobs` runs on every progress tick, several times a second, and
    // `offsetHeight` is a forced layout.
    expect(project).toMatch(/const was = resizing \? jobs\.offsetHeight : 0;/);
  });

  it("counts the lines it will DRAW, not the jobs", () => {
    // `pending` adds a line of its own under the job rows, and a count
    // that missed it would miss the resize it causes.
    expect(project).toContain("const willDraw = jobList.length + pending.size;");
  });
});
