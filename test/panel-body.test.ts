// E9-108 — two norns bodies, and a grid a thumb can hit.
//
// Reported from a Pixel 9 Pro (user, 2026-11-18): the official norns is a
// bad shape for a phone. It is a wide box with its screen in the lower left
// and its controls up the right-hand side, so a phone — which gives a
// device its WIDTH and has height to spare — spends most of that width on
// anodised aluminium. The SHIELD is the same instrument in a nearly square
// case with the screen across the middle, and at one width it is simply
// bigger everywhere that matters.
//
// The numbers below are the reason the shield is the default, so they are
// asserted rather than written in a comment: a later tidy-up of the
// stylesheet that quietly shrank the shield's screen would otherwise leave
// the setting in place and take away what it was for.
//
// Arithmetic on the stylesheet, like `rail-panels.test.ts`, and for the
// same reason: `main.ts` wants an AudioWorklet and a cross-origin-isolated
// origin, and Node has neither.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createSettings, type StorageLike } from "../src/ui/settings.js";

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "src", "main.ts"), "utf8");

/** A percentage declared inside the rule for `selector`. */
function pct(selector: string, prop: string): number {
  const at = html.indexOf(selector + " {");
  expect(at, `${selector} is not in index.html`).toBeGreaterThan(-1);
  const block = html.slice(at, html.indexOf("}", at));
  const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*([\\d.]+)%`).exec(block);
  expect(m, `${selector} has no ${prop} in %`).not.toBeNull();
  return Number(m![1]);
}

/** `aspect-ratio: a / b`, as a number. */
function ratio(selector: string): number {
  const at = html.indexOf(selector + " {");
  expect(at, `${selector} is not in index.html`).toBeGreaterThan(-1);
  const block = html.slice(at, html.indexOf("}", at));
  const m = /aspect-ratio:\s*([\d.]+)\s*\/\s*([\d.]+)/.exec(block);
  expect(m, `${selector} has no aspect-ratio`).not.toBeNull();
  return Number(m![1]) / Number(m![2]);
}

const BODIES = ["norns", "shield"] as const;
const CONTROLS = ["k1", "k2", "k3", "e1", "e2", "e3"] as const;

describe("the two norns bodies", () => {
  it("places every control on both of them", () => {
    // The whole hazard of two layouts in one stylesheet: a control that
    // only one of them positions is drawn at 0,0 with no size on the other,
    // which is a norns with a knob in its corner and nothing says so.
    for (const body of BODIES) {
      for (const id of CONTROLS) {
        const sel = `.norns[data-panel="${body}"] #${id}`;
        expect(html, `${sel} is missing`).toContain(sel + " {");
        expect(pct(sel, "--d"), `${sel} has no diameter`).toBeGreaterThan(0);
        expect(pct(sel, "left")).toBeGreaterThan(0);
        expect(pct(sel, "top")).toBeGreaterThan(0);
      }
      expect(ratio(`.norns[data-panel="${body}"]`)).toBeGreaterThan(1);
      expect(pct(`.norns[data-panel="${body}"] .screen-well`, "width")).toBeGreaterThan(0);
    }
  });

  it("gives the three encoders one size and the three keys another, on each", () => {
    // True of the hardware and NOT of a photograph of it: the shield's far
    // encoders measured 15.0% and 16.3% against the near one's 18.4%, which
    // is parallax. Three different diameters here would be three different
    // knobs, which no norns has.
    for (const body of BODIES) {
      const d = (id: string): number => pct(`.norns[data-panel="${body}"] #${id}`, "--d");
      expect(new Set([d("e1"), d("e2"), d("e3")]).size, `${body}: encoders differ`).toBe(1);
      expect(new Set([d("k1"), d("k2"), d("k3")]).size, `${body}: keys differ`).toBe(1);
      expect(d("e1"), `${body}: the keys are not smaller than the encoders`).toBeGreaterThan(d("k1"));
    }
  });

  it("is why the shield is the default: bigger screen, bigger knobs", () => {
    // At ONE device width — which is what a phone gives you — these are the
    // ratios the gear panel quotes. They are asserted here so the sentence
    // on screen cannot quietly stop being true.
    const screen = (b: string): number => pct(`.norns[data-panel="${b}"] .screen-well`, "width");
    const enc = (b: string): number => pct(`.norns[data-panel="${b}"] #e1`, "--d");
    const key = (b: string): number => pct(`.norns[data-panel="${b}"] #k1`, "--d");
    expect(screen("shield") / screen("norns")).toBeGreaterThan(1.5);
    expect(enc("shield") / enc("norns")).toBeGreaterThan(1.6);
    expect(key("shield") / key("norns")).toBeGreaterThan(1.3);
    // And the cost, stated: a squarer body is a taller one at that width.
    expect(ratio('.norns[data-panel="shield"]')).toBeLessThan(ratio('.norns[data-panel="norns"]'));
  });

  it("has no inline position left on a control", () => {
    // An inline `style` beats every rule in the stylesheet, so one left
    // behind would pin that control to the official body on both.
    for (const id of CONTROLS) {
      const at = html.indexOf(`id="${id}"`);
      expect(at, `#${id} is not in the markup`).toBeGreaterThan(-1);
      const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
      expect(tag, `#${id} still carries an inline style`).not.toContain("style=");
    }
  });

  it("ships the shield in the markup, so the first paint is the default", () => {
    expect(html).toContain('<div class="norns" id="norns" data-panel="shield">');
  });
});

describe("which body, as a setting", () => {
  const fakeStorage = (): StorageLike => {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
    };
  };

  it("defaults to the shield, with nothing stored", () => {
    expect(createSettings(null).panel).toBe("shield");
    expect(createSettings(fakeStorage()).panel).toBe("shield");
  });

  it("comes back after a reload, which is the whole point of storing it", () => {
    const store = fakeStorage();
    createSettings(store).setPanel("norns");
    expect(createSettings(store).panel).toBe("norns");
  });

  it("reads anything else as the shield rather than as nothing", () => {
    const store = fakeStorage();
    store.setItem("norns-js/settings/v1", JSON.stringify({ panel: "banana" }));
    expect(createSettings(store).panel).toBe("shield");
  });

  it("brings the forced machine back too, which it never did", () => {
    // Not a new feature — a defect found beside this one. `write` is
    // `JSON.stringify(state)` and the field is `machine`, so the stored
    // blob has always said `machine`; the reader asked for `device`. A
    // machine forced in the gear therefore lasted until the next reload.
    const store = fakeStorage();
    createSettings(store).setMachine("steamdeck");
    expect(JSON.parse(store.getItem("norns-js/settings/v1")!).machine).toBe("steamdeck");
    expect(createSettings(store).machine).toBe("steamdeck");
  });

  it("still reads the old `device` key, for anyone who has one", () => {
    const store = fakeStorage();
    store.setItem("norns-js/settings/v1", JSON.stringify({ device: "phone" }));
    expect(createSettings(store).machine).toBe("phone");
  });
});

describe("the grid a phone gets", () => {
  // 128 keys across a phone's width is about 21 CSS pixels a key, well under
  // any touch target anybody recommends, and the key you hit is the one next
  // to the key you wanted. 64 is 8 across, so each is twice as wide — and
  // 8x8 is a real monome, not a cropped 128.
  it("is 64, and every other machine still gets 128", () => {
    expect(main).toContain("const GRID_ON_PHONE = 64;");
    expect(main).toContain("const GRID_DEFAULT = 128;");
    expect(main).toContain('kindNow() === "phone" ? GRID_ON_PHONE : GRID_DEFAULT');
    // And the device that is attached has to agree with the number that
    // lights the button, or SETTINGS shows 64 beside a 16x8 grid.
    expect(main).toContain("attachGrid(gridSize === 64 ? 8 : 16, 8);");
  });

  it("knows which machine it is before it attaches one", () => {
    // The detection used to live seven hundred lines BELOW the grid. This
    // is the ordering that the default depends on, and nothing else in the
    // file would fail if it moved back.
    const detect = main.indexOf("let detected = detect(readSignals());");
    const attach = main.indexOf("attachGrid(gridSize === 64 ? 8 : 16, 8);");
    expect(detect).toBeGreaterThan(-1);
    expect(attach).toBeGreaterThan(-1);
    expect(detect, "the machine is detected after the grid is attached").toBeLessThan(attach);
  });
});
