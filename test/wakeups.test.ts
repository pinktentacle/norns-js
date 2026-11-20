// E9-182 — the decision to stop the sound, which must not be able to misfire.
//
// This path cannot be exercised from a browser pane: nothing there can make
// `document.hidden` true, and the one consequence of getting it wrong is an
// instrument that goes silent in the middle of a performance. So it is a
// function with a clock passed to it rather than a closure over a timer.

import { describe, expect, it } from "vitest";
import { createWakeupWatch } from "../src/ui/wakeups.js";

describe("deciding whether a page can still keep time", () => {
  it("does nothing at all while the page is in front", () => {
    const w = createWakeupWatch(600);
    expect(w.watching).toBe(false);
    // A tick with no spell of being away behind it is not a 0 ms gap, it
    // is not a reading.
    expect(w.tick(1_000_000)).toBeNull();
    expect(w.stopped).toBe(false);
    expect(w.back()).toBe(false);
  });

  it("leaves a punctual page alone, however long it is away", () => {
    // Measured in this app's own pane: a tab behind another gets no
    // animation frames and a perfectly unthrottled 16 ms timer, and
    // delivers 160 metro callbacks in 8.02 s. Stopping THAT would be a
    // fault rather than a kindness.
    const w = createWakeupWatch(600);
    w.away(0);
    for (let at = 200; at <= 60_000; at += 200) {
      expect(w.tick(at), `tick at ${at} ms`).toBeNull();
    }
    expect(w.stopped).toBe(false);
    expect(w.back()).toBe(false);
  });

  it("decides once a spell, not once a tick", () => {
    // A throttled page produces a slow tick every time it is let back in.
    // Suspending an already-suspended context on each of them would be a
    // log line a second saying the same thing.
    const w = createWakeupWatch(600);
    w.away(0);
    expect(w.tick(1000)).toBe(1000);
    expect(w.stopped).toBe(true);
    expect(w.watching).toBe(false);
    expect(w.tick(2000)).toBeNull();
    expect(w.tick(3000)).toBeNull();
  });

  it("reports the gap that proved it, so the log can say how seldom", () => {
    const w = createWakeupWatch(600);
    w.away(500);
    expect(w.tick(700)).toBeNull(); // 200 ms — fine
    expect(w.tick(900)).toBeNull(); // 200 ms — fine
    expect(w.tick(2400)).toBe(1500); // 1.5 s — throttled
  });

  it("asks for the sound back exactly once", () => {
    const w = createWakeupWatch(600);
    w.away(0);
    expect(w.tick(1000)).toBe(1000);
    expect(w.back()).toBe(true);
    // A second `visibilitychange` to visible must not resume a context
    // nobody suspended.
    expect(w.back()).toBe(false);
    expect(w.stopped).toBe(false);
  });

  it("does not ask for the sound back when it was never stopped", () => {
    const w = createWakeupWatch(600);
    w.away(0);
    w.tick(200);
    expect(w.back()).toBe(false);
  });

  it("re-arming while already stopped cannot stop it twice", () => {
    // Two `visibilitychange` events to hidden with no visible in between
    // is not a shape to rely on never happening.
    const w = createWakeupWatch(600);
    w.away(0);
    expect(w.tick(1000)).toBe(1000);
    w.away(1000);
    expect(w.tick(3000)).toBeNull();
    expect(w.stopped).toBe(true);
    // And one `back` still puts it right.
    expect(w.back()).toBe(true);
    expect(w.stopped).toBe(false);
  });

  it("works again after a full round trip", () => {
    const w = createWakeupWatch(600);
    w.away(0);
    expect(w.tick(1000)).toBe(1000);
    expect(w.back()).toBe(true);
    w.away(5000);
    expect(w.tick(5200)).toBeNull();
    expect(w.tick(7000)).toBe(1800);
    expect(w.back()).toBe(true);
  });

  it("takes the threshold it is given", () => {
    const strict = createWakeupWatch(100);
    strict.away(0);
    expect(strict.tick(150)).toBe(150);
    const loose = createWakeupWatch(5000);
    loose.away(0);
    expect(loose.tick(1500)).toBeNull();
  });
});
