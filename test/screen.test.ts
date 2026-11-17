// E2-01 / E2-02 / E2-07 — the screen, from cairo through to what the panel
// would receive, and then norns' own menu drawn through it.

import { beforeAll, describe, expect, it } from "vitest";
import { createScreen, UNIMPLEMENTED, SCREEN_W, SCREEN_H, type Screen } from "../src/screen/screen.js";
import { loadScreenModule } from "../src/screen/screen-node.js";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import surface from "../src/api/surface.json" with { type: "json" };

const SCREEN_NAMES = surface.functions
  .map((f: { name: string }) => f.name)
  .filter((n: string) => n.startsWith("screen_"));

let screen: Screen;
let host: Host;
let updates = 0;

beforeAll(async () => {
  screen = await createScreen(loadScreenModule, { onUpdate: () => void updates++ });
  host = createHost({ sources: loadNornsLua() });
  screen.register(host.registry);
  boot(host, loadConfig());
}, 60_000);

describe("the wasm screen", () => {
  it("loads the two fonts the build ships and knows about all 69", () => {
    // 14 MB of fonts is not shipped; index 0 and 1 are. See screen_install_font.
    expect(screen.fontAvailable(0)).toBe(true);
    expect(screen.fontName(0)).toBe("norns.ttf");
    expect(screen.fontName(1)).toBe("liquid.ttf");
    expect(screen.fontName(68)).toBe("norns.ttf"); // upstream lists it twice
    expect(screen.fontAvailable(4)).toBe(false); // Roboto-Regular, not shipped
  });

  it("gives a 128x64 ARGB buffer", () => {
    expect(screen.pixels().length).toBe(SCREEN_W * SCREEN_H * 4);
  });

  it("draws: a filled rect changes the pixels under it and nothing else", () => {
    host.run(`_norns.screen_clear()`);
    const before = screen.greyscale();
    expect(before.every((v) => v === 0)).toBe(true);

    host.run(`
      _norns.screen_level(15)
      _norns.screen_rect(10, 10, 4, 4)
      _norns.screen_fill()
    `);
    const after = screen.greyscale();
    const lit = [...after].filter((v) => v > 0).length;
    expect(lit).toBe(16); // 4x4, hard edges at integer coordinates
    expect(after[10 * SCREEN_W + 10]).toBe(15);
    expect(after[9 * SCREEN_W + 10]).toBe(0);
  });

  it("screen_level maps 0-15 onto the panel's 0-15, exactly", () => {
    // E0-17 measured this on the fingerprint: level z lands on nibble z.
    for (const z of [0, 1, 7, 14, 15]) {
      host.run(`_norns.screen_clear() _norns.screen_level(${z}) _norns.screen_rect(0,0,2,2) _norns.screen_fill()`);
      expect(screen.greyscale()[0], `level ${z}`).toBe(z);
    }
  });

  it("screen_aa(0) gives hard edges and aa(1) gives partial coverage", () => {
    const countLevels = () => new Set(screen.greyscale()).size;
    host.run(`_norns.screen_clear() _norns.screen_aa(0) _norns.screen_level(15)
              _norns.screen_move(0,0) _norns.screen_line(40,20) _norns.screen_stroke()`);
    const hard = countLevels();
    host.run(`_norns.screen_clear() _norns.screen_aa(1) _norns.screen_level(15)
              _norns.screen_move(0,0) _norns.screen_line(40,20) _norns.screen_stroke()`);
    const soft = countLevels();
    expect(soft).toBeGreaterThan(hard);
    host.run(`_norns.screen_aa(1)`);
  });

  it("screen_text_extents returns two values and they are not zero", () => {
    host.run(`_W, _H = _norns.screen_text_extents("hello")`);
    expect(host.run(`assert(_W > 0, 'width') assert(_H > 0, 'height')`)).toBeNull();
  });

  it("peek and poke round-trip the same bytes", () => {
    host.run(`_norns.screen_clear() _norns.screen_level(11) _norns.screen_rect(0,0,4,2) _norns.screen_fill()`);
    host.run(`_BUF = _norns.screen_peek(0, 0, 4, 2)`);
    expect(host.run(`assert(#_BUF == 8, 'got ' .. #_BUF)`)).toBeNull();
    host.run(`_norns.screen_clear() _norns.screen_poke(0, 0, 4, 2, _BUF)`);
    expect(screen.greyscale()[0]).toBe(11);
  });

  it("panel state is stored without the SSD1322's +16 offset", () => {
    host.run(`_norns.screen_brightness(9) _norns.screen_contrast(200) _norns.screen_invert(1)`);
    const p = screen.panel();
    expect(p.brightness).toBe(9); // upstream adds 16 before writing the hardware register
    expect(p.contrast).toBe(200);
    expect(p.inverted).toBe(true);
    host.run(`_norns.screen_invert(0)`);
  });
});

describe("coverage of the screen surface", () => {
  it("every one of the 45 screen functions is either implemented or explained", () => {
    expect(SCREEN_NAMES).toHaveLength(45);
    const unaccounted = SCREEN_NAMES.filter(
      (n: string) => !host.registry.isImplemented(n) && !(n in UNIMPLEMENTED),
    );
    expect(unaccounted).toEqual([]);
  });

  it("nothing is claimed twice", () => {
    const both = Object.keys(UNIMPLEMENTED).filter((n) => host.registry.isImplemented(n));
    // screen_update is listed in UNIMPLEMENTED with an explanation AND
    // implemented as a host callback, which is the one honest overlap.
    expect(both).toEqual(["screen_update"]);
  });
});

describe("norns' own menu, drawn", () => {
  it("boots and puts something on the screen", () => {
    updates = 0;
    host.run(`_norns.stat(50, 40, 10, 10, 10, 10, 10)`);
    host.run(`_norns.battery(100, 0)`);
    host.run(`norns.menu.toggle(true)`);
    expect(host.run(`_menu.redraw()`)).toBeNull();

    expect(updates).toBeGreaterThan(0);
    const g = screen.greyscale();
    const lit = [...g].filter((v) => v > 0).length;
    // A menu page with text on it. The exact count belongs to E2-09's pixel
    // diff; here the question is only whether anything was drawn at all.
    expect(lit).toBeGreaterThan(50);
    expect(lit).toBeLessThan(SCREEN_W * SCREEN_H); // not simply filled
  });

  it("draws with more than one grey level, so text is antialiased", () => {
    const levels = new Set(screen.greyscale());
    expect(levels.size).toBeGreaterThan(2);
  });
});
