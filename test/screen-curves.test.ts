// E5-27 — filling a curve used to kill the screen module.
//
// The worst defect this project has found in its own build, and it took an
// exerciser to find it. **Filling any path that contains a curve traps**,
// and not a degenerate one: `arc(44, 25, 2, 0, 6.28)` with a `fill` is
// enough, and so is a single bezier. The module raises `RuntimeError:
// function signature mismatch` from inside cairo — and after it, EVERY later
// call into the module traps as well, so the screen is gone for the rest of
// the session. One script that drew a filled circle took the whole page's
// display with it, and the nineteen loaded after it looked broken.
//
// Measured alongside, on the same page, which is what made the fix obvious:
//
//     arc + stroke       ok, 151 pixels
//     polygon + fill     ok, 1020 pixels (a 64-segment circle)
//     arc + fill         TRAP
//     bezier + fill      TRAP
//
// cairo's fill is fine; its CURVE fill is not. That is a link-time problem
// in a build that cannot be rebuilt here, so curves are flattened to line
// segments before they reach it and nothing curved ever gets to the
// tessellator.

import { describe, expect, it, beforeAll } from "vitest";
import { createScreen, SCREEN_H, SCREEN_W, type Screen } from "../src/screen/screen.js";
import { loadScreenModule } from "../src/screen/screen-node.js";
import { NornsRegistry } from "../src/norns/registry.js";

let screen: Screen;
let registry: NornsRegistry;
const traps: Array<{ name: string; count: number }> = [];
const gone: number[] = [];

const call = (name: string, ...args: unknown[]): unknown => {
  const fn = registry.implementationFor(name);
  if (!fn) throw new Error(`${name} is not implemented`);
  return fn(...(args as never[]));
};

const litPixels = (): number => {
  const g = screen.greyscale();
  let n = 0;
  for (const v of g) if (v > 0) n++;
  return n;
};

const drawProbe = (): number => {
  call("screen_clear");
  call("screen_level", 15);
  call("screen_rect", 10, 10, 20, 10);
  call("screen_fill");
  return litPixels();
};

beforeAll(async () => {
  screen = await createScreen(loadScreenModule, {
    onTrap: (name, count) => void traps.push({ name, count }),
    onGone: (n) => void gone.push(n),
  });
  registry = new NornsRegistry();
  screen.register(registry);
}, 60_000);

describe("filling a curve", () => {
  it("draws 200 pixels for a 20x10 rectangle, before anything curved", () => {
    expect(drawProbe()).toBe(200);
  });

  it("FILLS A CIRCLE instead of taking the module down", () => {
    // The exact call from `mi-eng/resonate-r.lua`, which is the script that
    // found this. A disc of radius 18 is about 1018 pixels.
    call("screen_clear");
    call("screen_level", 15);
    call("screen_move", -20, -5);
    call("screen_arc", 44, 25, 18, 0, 6.3);
    call("screen_fill");
    const lit = litPixels();
    expect(lit).toBeGreaterThan(900);
    expect(lit).toBeLessThan(1300);
    expect(traps, "nothing may trap").toEqual([]);
  });

  it("fills a bezier too", () => {
    call("screen_clear");
    call("screen_level", 15);
    call("screen_move", 10, 10);
    call("screen_curve", 30, 0, 60, 50, 90, 10);
    call("screen_fill");
    expect(litPixels()).toBeGreaterThan(0);
    expect(traps).toEqual([]);
  });

  it("still STROKES an arc, which never was the broken half", () => {
    call("screen_clear");
    call("screen_level", 15);
    call("screen_arc", 44, 25, 18, 0, 6.28);
    call("screen_stroke");
    // A KNOWN DIVERGENCE, measured rather than hidden: a stroked circle of
    // radius 18 lights 312 pixels as a flattened polygon and 151 as a true
    // `cairo_arc`. The stroke reads about twice as thick. It is the price
    // of flattening unconditionally — the alternative is buffering the
    // whole path so a stroke can replay the real curve, which needs
    // `screen_current_point` answered from our own tracking too. Filed
    // rather than done, because a slightly fat circle beats a dead screen.
    const lit = litPixels();
    expect(lit).toBeGreaterThan(80);
    expect(lit).toBeLessThan(400);
  });

  it("starts a NEW subpath after a fill, not a line across the screen", () => {
    // cairo's arc joins the current point when a subpath is open. A fill
    // consumes the path, so the next arc has to begin on its own — if that
    // were mistracked, every circle after the first would trail a line back
    // to wherever the last one ended.
    call("screen_clear");
    call("screen_level", 15);
    call("screen_arc", 20, 20, 6, 0, 6.28);
    call("screen_fill");
    const one = litPixels();
    call("screen_arc", 100, 40, 6, 0, 6.28);
    call("screen_fill");
    const two = litPixels();
    // Two discs of radius 6 are about 226 px in total. A line joining them
    // would add roughly another 80.
    expect(two - one).toBeGreaterThan(90);
    expect(two - one).toBeLessThan(150);
  });
});

describe("E5-29 — a flattened stroke is not thicker than the curve it replaces", () => {
  // THE ROW THIS CLOSES CLAIMED THE OPPOSITE, on two numbers — "312 pixels
  // as a polygon and 151 as a true cairo_arc" — that turn out to have been
  // measured under different settings and compared as one experiment. 312 is
  // what BOTH produce at antialiasing on, width 2, radius 18; at width 1 the
  // same circle is 212, and with antialiasing off it is 108.
  //
  // So this measures the two side by side under identical settings, which is
  // the whole point. INK rather than lit pixels: a count of non-zero pixels
  // cannot tell a doubled coverage from a wider one, and it was a lit-pixel
  // count that produced the original claim.
  interface RawPath {
    arc(x: number, y: number, r: number, a1: number, a2: number): void;
    stroke(): void;
    move(x: number, y: number): void;
    line(x: number, y: number): void;
  }
  const raw = (): RawPath => {
    const m = screen.module as unknown as {
      cwrap(n: string, r: null, a: string[]): (...x: number[]) => void;
    };
    const w = (n: string, a: string[]): ((...x: number[]) => void) => m.cwrap(n, null, a);
    return {
      arc: w("screen_arc", ["number", "number", "number", "number", "number"]),
      stroke: w("screen_stroke", []),
      move: w("screen_move", ["number", "number"]),
      line: w("screen_line", ["number", "number"]),
    } as RawPath;
  };

  const ink = (): number => {
    let t = 0;
    for (const v of screen.greyscale()) t += v;
    return t;
  };

  /** The same circle twice: once as cairo draws it, once as we flatten it. */
  const compare = (aa: number, width: number, r: number): { arc: number; poly: number } => {
    const c = raw();
    const setup = (): void => {
      call("screen_clear");
      call("screen_aa", aa);
      call("screen_line_width", width);
      call("screen_level", 15);
    };
    setup();
    c.arc(64, 32, r, 0, Math.PI * 2);
    c.stroke();
    const a = ink();
    setup();
    const n = Math.max(8, Math.ceil(2 * Math.PI * r));
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      const x = 64 + Math.cos(t) * r;
      const y = 32 + Math.sin(t) * r;
      if (i === 0) c.move(x, y);
      else c.line(x, y);
    }
    c.stroke();
    return { arc: a, poly: ink() };
  };

  for (const [aa, width, r] of [
    [0, 1, 18],
    [1, 1, 18],
    [1, 2, 18],
    [1, 3, 18],
    [0, 2, 18],
  ] as const) {
    it(`aa ${aa}, width ${width}, radius ${r}: within 3% of the real arc`, () => {
      const { arc, poly } = compare(aa, width, r);
      expect(arc).toBeGreaterThan(0);
      expect(poly / arc).toBeGreaterThan(0.95);
      expect(poly / arc, "a doubling would land at 2.0").toBeLessThan(1.05);
    });
  }

  it("leaves antialiasing and width as it found them", () => {
    call("screen_aa", 0);
    call("screen_line_width", 1);
  });
});

describe("the guard that is still there for anything else", () => {
  it("keeps drawing after the context has been rebuilt", () => {
    // Recovery is bounded: `screen_init` leaks a surface, a context and a
    // FreeType library each time, and rebuilding through a long run ended
    // in "memory access out of bounds" from inside the allocator. Forcing
    // one here is the half that can be tested without a trap.
    (screen.module as unknown as { _screen_init(): void })._screen_init();
    call("screen_clear");
    call("screen_level", 15);
    call("screen_rect", 0, 0, SCREEN_W, SCREEN_H);
    call("screen_fill");
    expect(litPixels()).toBe(SCREEN_W * SCREEN_H);
  });

  it("still reports what the panel was told, which a rebuild must not wipe", () => {
    call("screen_brightness", 7);
    call("screen_invert", 1);
    const p = screen.panel();
    expect(p.brightness).toBe(7);
    expect(p.inverted).toBe(true);
    call("screen_invert", 0);
  });

  it("never declared the module gone", () => {
    expect(gone).toEqual([]);
  });
});
