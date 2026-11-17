// E2-09 — pixel-level regression, in CI.
//
// E0-17 bounded screen fidelity by argument: the same cairo calls in the same
// order produce the same bytes. This is what keeps that true as the code
// moves. It renders through the whole stack — norns' Lua, the `_norns`
// boundary, the wasm screen, the 4-bit conversion — and compares every pixel
// against a checked-in picture.
//
// Fixtures are text, one character per pixel, so a failure is readable rather
// than a changed hash. Regenerate deliberately:
//
//   UPDATE_PIXELS=1 npx vitest run test/pixels.test.ts
//
// and then READ the diff. A fixture updated without looking is a fixture that
// records a bug.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createScreen, type Screen } from "../src/screen/screen.js";
import { loadScreenModule } from "../src/screen/screen-node.js";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { toAscii, describeFrame } from "./support/ascii.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const UPDATE = process.env["UPDATE_PIXELS"] === "1";

let screen: Screen;
let host: Host;

beforeAll(async () => {
  screen = await createScreen(loadScreenModule);
  host = createHost({ sources: loadNornsLua() });
  screen.register(host.registry);
  const err = boot(host, loadConfig());
  expect(err, err ? `${err.step}: ${err.error}` : "").toBeNull();
}, 60_000);

/** Compare the current frame against a fixture, or write it. */
function matchesFixture(name: string): void {
  const grey = screen.greyscale();
  const actual = toAscii(grey);
  const file = path.join(FIXTURES, `${name}.txt`);

  if (UPDATE || !fs.existsSync(file)) {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(file, actual);
    if (!UPDATE) {
      throw new Error(
        `no fixture for "${name}" — one has been written to ${path.relative(HERE, file)}. ` +
          `Read it, confirm it is what norns should draw, and commit it.`,
      );
    }
    return;
  }

  const expected = fs.readFileSync(file, "utf8");
  if (actual !== expected) {
    // Point at the first differing row, because 64 rows of diff is hard to
    // read and the first one is usually the whole story.
    const a = actual.split("\n");
    const b = expected.split("\n");
    const row = a.findIndex((line, i) => line !== b[i]);
    throw new Error(
      `${name} differs from its fixture, first at row ${row}.\n` +
        `  expected: ${JSON.stringify(b[row] ?? "")}\n` +
        `  actual:   ${JSON.stringify(a[row] ?? "")}\n` +
        `  frame:    ${describeFrame(grey)}\n` +
        `Regenerate with UPDATE_PIXELS=1 only after deciding the new output is correct.`,
    );
  }
  expect(actual).toBe(expected);
}

describe("what norns actually draws", () => {
  it("the home menu, pixel for pixel", () => {
    // The sequence matron performs: stat and battery arrive on a timer and
    // core/menu/home.lua indexes the cpu field they populate.
    host.run(`_norns.stat(50, 40, 10, 10, 10, 10, 10)`);
    host.run(`_norns.battery(100, 0)`);
    host.run(`norns.menu.toggle(true)`);
    expect(host.run(`_menu.redraw()`)).toBeNull();
    matchesFixture("menu-home");
  });

  it("the same page twice is the same pixels", () => {
    // Nothing in the draw path may depend on how many times it has run — a
    // cairo context left in a modified state would show up here and nowhere
    // else until a script looked wrong.
    const first = toAscii(screen.greyscale());
    host.run(`_menu.redraw()`);
    const second = toAscii(screen.greyscale());
    expect(second).toBe(first);
  });

  it("antialiased geometry, which is where a rasteriser change would show", () => {
    // E0-17's `geom` scene exists for this: strokes, arcs and curves are the
    // part of the output that FreeType and pixman differences could perturb,
    // and the part text cannot exercise because norns.ttf at 8 px renders
    // strictly binary coverage.
    //
    // THE ARC AND CURVE HERE ARE FLATTENED, and the fixture was regenerated
    // once, deliberately, when they started being. Filling a path with a
    // curve in it traps this cairo build and takes the screen module with
    // it (E5-27), so curves reach cairo as line segments now. Fourteen of
    // the sixty-four rows moved. If this fixture ever moves AGAIN, that is
    // the drift it was built to catch.
    expect(
      host.run(`
      _norns.screen_clear()
      _norns.screen_aa(1)
      _norns.screen_line_width(1)
      _norns.screen_level(15)
      _norns.screen_move(2, 2)
      _norns.screen_line(60, 30)
      _norns.screen_stroke()
      _norns.screen_level(8)
      _norns.screen_arc(90, 32, 20, 0, 3.14159)
      _norns.screen_stroke()
      _norns.screen_level(4)
      _norns.screen_move(10, 50)
      _norns.screen_curve(30, 10, 60, 60, 100, 50)
      _norns.screen_stroke()
    `),
    ).toBeNull();
    matchesFixture("scene-geom");
  });

  it("hard-edged geometry: aa(0) must produce two levels and nothing between", () => {
    host.run(`
      _norns.screen_clear()
      _norns.screen_aa(0)
      _norns.screen_level(15)
      _norns.screen_move(2, 2)
      _norns.screen_line(60, 30)
      _norns.screen_stroke()
    `);
    const levels = new Set(screen.greyscale());
    expect([...levels].sort((a, b) => a - b)).toEqual([0, 15]);
    matchesFixture("scene-hard");
    host.run(`_norns.screen_aa(1)`);
  });

  it("text at the default font and size", () => {
    // norns.ttf at 8 px is the one case E0-17 proved cannot differ between
    // FreeType versions. If this fixture ever moves, something in OUR code
    // moved, not in a dependency.
    host.run(`
      _norns.screen_clear()
      _norns.screen_font_face(0)
      _norns.screen_font_size(8)
      _norns.screen_level(15)
      _norns.screen_move(4, 12)
      _norns.screen_text("norns-js")
      _norns.screen_move(124, 24)
      _norns.screen_text_right("right")
      _norns.screen_move(64, 36)
      _norns.screen_text_center("center")
    `);
    matchesFixture("scene-text");
  });
});
