// Which machine the page thinks it is on.
//
// The rules are guesses of different quality, so what is tested is mostly
// that a guess is REPORTED as one: a page that quietly decides it is a Steam
// Deck and rearranges itself is worse than one that asks.

import { describe, expect, it } from "vitest";
import {
  detect,
  effectiveKind,
  type MachineSignals,
} from "../src/ui/machine.js";

const base: MachineSignals = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0",
  screenW: 2560,
  screenH: 1440,
  maxTouchPoints: 0,
  coarsePointer: false,
  gamepadIds: [],
};
const sig = (over: Partial<MachineSignals>): MachineSignals => ({ ...base, ...over });

describe("a Steam Deck", () => {
  it("is certain when Steam's own browser says so", () => {
    // Game Mode. The only unambiguous signal there is.
    const d = detect(
      sig({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64; Valve Steam Client/Steam Deck [Steam Deck Stable]/default/0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.183 Safari/537.36",
        screenW: 1280,
        screenH: 800,
        maxTouchPoints: 10,
      }),
    );
    expect(d.kind).toBe("steamdeck");
    expect(d.confident).toBe(true);
  });

  it("is certain when a gamepad names itself", () => {
    const d = detect(sig({ gamepadIds: ["Valve Software Steam Deck Controller (STANDARD GAMEPAD)"] }));
    expect(d.kind).toBe("steamdeck");
    expect(d.confident).toBe(true);
    expect(d.why).toContain("Valve Software");
  });

  it("is a GUESS from the panel shape, and says so", () => {
    // Desktop mode sends an ordinary Linux Chrome string with no marker, so
    // all that is left is Linux + the Deck's panel + a touchscreen.
    const d = detect(
      sig({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        screenW: 1280,
        screenH: 800,
        maxTouchPoints: 10,
        coarsePointer: true,
      }),
    );
    expect(d.kind).toBe("steamdeck");
    expect(d.confident, "a shape is not a statement").toBe(false);
  });

  it("is not guessed from the panel alone", () => {
    // A 1280x800 Linux machine with no touchscreen is a small laptop.
    expect(
      detect(sig({ userAgent: "X11; Linux x86_64", screenW: 1280, screenH: 800 })).kind,
    ).toBe("normal");
    // And 1280x800 on Windows is not a Deck whatever else is true.
    expect(detect(sig({ screenW: 1280, screenH: 800, maxTouchPoints: 10 })).kind).toBe("normal");
  });
});

describe("a phone", () => {
  it("is certain from the user agent", () => {
    const d = detect(sig({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari", screenW: 390, screenH: 844 }));
    expect(d.kind).toBe("phone");
    expect(d.confident).toBe(true);
  });

  it("is a guess from a small touchscreen", () => {
    const d = detect(sig({ screenW: 412, screenH: 915, maxTouchPoints: 5, coarsePointer: true, userAgent: "unknown" }));
    expect(d.kind).toBe("phone");
    expect(d.confident).toBe(false);
  });

  it("does not catch a tablet or a touchscreen laptop", () => {
    expect(detect(sig({ screenW: 1024, screenH: 1366, maxTouchPoints: 5, coarsePointer: true, userAgent: "iPad" })).kind).toBe("normal");
    expect(detect(sig({ maxTouchPoints: 10 })).kind).toBe("normal");
  });

  it("loses to a Steam Deck, which is also a touchscreen", () => {
    const d = detect(
      sig({
        userAgent: "X11; Linux x86_64",
        screenW: 1280,
        screenH: 800,
        maxTouchPoints: 10,
        coarsePointer: true,
      }),
    );
    expect(d.kind).toBe("steamdeck");
  });
});

describe("the stored preference", () => {
  it("wins over any detection, which is the point of having it", () => {
    const guessed = detect(sig({}));
    expect(effectiveKind("auto", guessed)).toBe("normal");
    expect(effectiveKind("steamdeck", guessed)).toBe("steamdeck");
    expect(effectiveKind("phone", guessed)).toBe("phone");
    expect(effectiveKind("normal", { kind: "phone", why: "", confident: true })).toBe("normal");
  });
});
