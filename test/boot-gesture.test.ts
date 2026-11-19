// E9-152 — the gesture is asked for before the boot, not during it.
//
// From a Pixel 9 Pro, with `?profile=90` running:
//
//     13.336 audio: the browser is holding the engine until you touch
//     19.032 | Requested notification messages from server 'localhost'  x6
//     19.113 scsynth died: map::at:  key not found
//     27.509 s| *** ERROR: SynthDef adc not found
//
// `waitForBoot` was sent while the AudioContext was still suspended, so
// sclang spent the wait retrying a `/notify` that a stopped worklet could
// not answer — and scsynth got all six the moment it started.
//
// `host.ts` wants wasm and a real AudioContext, so the ORDER is read out
// of the file the way `rail-panels.test.ts` reads the rail. The order is
// the whole fix: both calls were already there, on the wrong sides of a
// wait that can last minutes.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "engine", "host.ts"),
  "utf8",
);

/** The body of `bootServerFromSclang`, comments stripped. */
function body(): string {
  const at = src.indexOf("async function bootServerFromSclang(");
  expect(at, "bootServerFromSclang has gone").toBeGreaterThan(-1);
  const end = src.indexOf("\n  }", at);
  return src
    .slice(at, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}

describe("bringing the server up", () => {
  it("waits for the page to be allowed audio before telling sclang to boot", () => {
    const b = body();
    const gesture = b.indexOf("ensureRunning(probe)");
    const boot = b.indexOf("waitForBoot");
    expect(gesture, "nothing asks for the gesture first").toBeGreaterThan(-1);
    expect(boot, "the boot has gone").toBeGreaterThan(-1);
    expect(gesture, "sclang is told to boot into a suspended context").toBeLessThan(boot);
  });

  it("probes with a context of its own, because the real one does not exist yet", () => {
    // scsynth makes the real AudioContext, which is why the boot used to
    // come first. A throwaway answers the only question that matters.
    const b = body();
    expect(b).toMatch(/new Ctor\(\)/);
    expect(b, "the probe is left open").toMatch(/probe\.close\(\)/);
  });

  // THE PACKAGE SELF-CHECK FOUND THIS, and nothing else would have.
  // `installCapture` replaces `globalThis.AudioContext` with a subclass
  // that records every context built, and the boot wires crone, the
  // destination and the worklets to `captured.ctxs[0]`. A probe built
  // through the global takes that place and is then closed, so the graph
  // is assembled on a dead context: `the audio graph never arrived`, and
  // five of seven checks failing.
  it("builds the probe from the UNCAPTURED constructor", () => {
    const b = body();
    expect(b, "the probe would become captured.ctxs[0]").not.toMatch(
      /globalThis as \{ AudioContext\?/,
    );
    expect(b).toMatch(/uncapturedAudioContext\(\)/);
  });

  it("survives a browser that will not make one", () => {
    const b = body();
    expect(b).toMatch(/catch\s*\{/);
  });
});
