// E9-113 — the 60 Hz refresh interval, and where the 60 comes from.
//
// `docs/13-CPU.md` §8 proposed giving that number a reason, on the
// suspicion that it was ours and might be halved to save work. It is not
// ours. `matron/src/hardware/screen/ssd1322.cc` drives the display from a
// thread that sleeps 16666666 ns and posts `EVENT_SCREEN_REFRESH` every
// time round, and `w_handle_screen_refresh` calls the Lua global
// `refresh`. `main.ts` copies that loop.
//
// So the test is not an opinion about a good rate, it is a check that two
// files still say the same thing. A later reading of the CPU study might
// reach for this number again; this is what tells whoever does that they
// are changing matron's behaviour and not a setting of ours.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(ROOT, "src", "main.ts"), "utf8");

/**
 * matron's display thread, from the checkout `tools/fetch-third-party.ps1`
 * makes.
 *
 * Read with a message rather than left to throw ENOENT: this is the one
 * file this project reads from outside `lua/`, `sc/` and `resources/`, and
 * a stack trace about a path would send whoever meets it looking for a bug
 * in the test instead of running the fetch.
 */
const SSD = path.join(
  ROOT, "third_party", "norns", "matron", "src", "hardware", "screen", "ssd1322.cc",
);
if (!fs.existsSync(SSD)) {
  throw new Error(
    `${SSD} is missing. third_party/ is fetched by tools/fetch-third-party.ps1 ` +
      "(publishing runbook §0.6), which the wasm build needs too.",
  );
}
const ssd1322 = fs.readFileSync(SSD, "utf8");

describe("the screen refresh rate", () => {
  it("is the one matron's own display thread runs at", () => {
    const m = /\.tv_nsec = (\d+)/.exec(ssd1322);
    expect(m, "ssd1322.cc no longer declares a tv_nsec").not.toBeNull();
    const hardwareHz = 1e9 / Number(m![1]);
    expect(hardwareHz).toBeCloseTo(60, 3);

    const ours = /const REFRESH_MS = 1000 \/ (\d+);/.exec(main);
    expect(ours, "main.ts no longer declares REFRESH_MS as 1000 / n").not.toBeNull();
    expect(Number(ours![1]), "main.ts and ssd1322.cc disagree").toBeCloseTo(hardwareHz, 3);
  });

  it("is posted every time round that loop, not only when the screen changed", () => {
    // Which is why ours is an unconditional interval rather than something
    // hung off the dirty flag. The `event_post` is outside the `if`.
    const body = ssd1322.slice(ssd1322.indexOf("ssd1322_thread_run"));
    const loop = body.slice(body.indexOf("while"), body.indexOf("return NULL"));
    const post = loop.indexOf("event_post");
    const dirtyEnd = loop.indexOf("display_dirty = false;");
    expect(post).toBeGreaterThan(-1);
    expect(dirtyEnd).toBeGreaterThan(-1);
    expect(post, "the refresh event moved inside the dirty branch").toBeGreaterThan(dirtyEnd);
  });

  it("says in main.ts where the number came from", () => {
    // The measurement that mattered is in the comment, not here: halving
    // the rate buys ~4% of a phone's core on one script in twenty, out of
    // a frame rate that script's author chose. A reader reaching for this
    // number deserves to meet that before they change it.
    expect(main).toContain("SIXTY IS MATRON'S OWN NUMBER");
    expect(main).toContain("ssd1322.cc");
  });
});
