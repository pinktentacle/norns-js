// E9-164 — the await that could never finish.
//
// `startAudio()` yields for one frame before a long unbroken run of
// synchronous work, so the menu reaches the canvas instead of the page
// sitting black. The frame is the right instrument for that and the
// wrong one to DEPEND on: a tab that is occluded or backgrounded is
// painted no frames at all while still reporting itself visible, and
// the await then never resolves. Observed in the Claude desktop app's
// browser pane on 2026-11-20 — `document.hidden` false,
// `visibilityState` "visible", no frame in two seconds — and the whole
// audio engine was simply never loaded, silently, because the line that
// would have said so is on the other side of the wait.

import { describe, expect, it, vi } from "vitest";
import { afterPaint } from "../src/ui/first-paint.js";

describe("yielding for a frame", () => {
  it("goes on as soon as a frame is painted", async () => {
    let timerMs = -1;
    await afterPaint({
      frame: (fn) => fn(),
      timer: (_fn, ms) => void (timerMs = ms),
      timeoutMs: 250,
    });
    // The timer was armed, and it is the frame that won.
    expect(timerMs).toBe(250);
  });

  // The case the whole file exists for.
  it("goes on anyway when no frame is ever painted", async () => {
    let fired = false;
    await afterPaint({
      frame: () => {}, // asked for, never called: an occluded tab
      timer: (fn) => {
        fired = true;
        fn();
      },
    });
    expect(fired, "the timer is what let the boot continue").toBe(true);
  });

  it("resolves once, whichever arrives second", async () => {
    const resolved = vi.fn();
    let frameFn: (() => void) | null = null;
    let timerFn: (() => void) | null = null;
    const p = afterPaint({
      frame: (fn) => void (frameFn = fn),
      timer: (fn) => void (timerFn = fn),
    }).then(resolved);
    frameFn!();
    timerFn!(); // the loser, arriving late
    await p;
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("does not wait at all where there is no rAF", async () => {
    // Node has none. A boot that hung there would hang every test that
    // ever drives this path.
    let timerArmed = false;
    // The key is OMITTED rather than set to undefined: node has no
    // `requestAnimationFrame`, so the default is exactly the case under
    // test, and `exactOptionalPropertyTypes` refuses the explicit one.
    await afterPaint({ timer: () => void (timerArmed = true) });
    expect(timerArmed, "nothing to wait for, so nothing was armed").toBe(false);
  });

  it("really does resolve against the live clock", async () => {
    // No injection: the real `setTimeout`, with no frame to be had.
    await expect(afterPaint({ frame: () => {}, timeoutMs: 5 })).resolves.toBeUndefined();
  });
});
