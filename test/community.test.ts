// E5-18 — every bundled community script, loaded.
//
// One row, one script, one question: does its Lua run to the end of
// `init()` on this host? A failure names a file and a line in a real
// script.
//
// E9-42 — AND IT HAS TO AGREE WITH THE BROWSER, or it is worse than
// nothing. Twenty-one of forty were red here while thirty-nine of forty
// ran clean in the page, because this host has no audio server and
// everything the SERVER reports was missing: engine commands, polls, and
// a menu page. Every one of those reds was a reason not to look at the
// list. They are stubbed in the harness now — see script-harness.ts for
// what each stub can and cannot hide.
//
// E9-74 — FORTY OF FORTY. The last red was `cheat_codes_2`, whose own
// `for i = 1, nil` crashes a norns with no MIDI attached just as surely.
// The harness attaches a virtual MIDI device now, the same judgement the
// virtual grid was given for the same reason, and the page agrees: with
// the MIDI keyboard attached there, cheat_codes_2 draws 430 pixels and
// lights 89 grid keys.

import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { bootedHost, runScript, type ScriptRun } from "./support/script-harness.js";
import { loadDustNode } from "../src/fs/dust-node.js";
import { HAS_CORPUS, corpusScripts } from "./support/corpus.js";

/** Top-level `.lua` in each script directory, which is what SELECT lists. */
const scripts = corpusScripts;

const results = new Map<string, ScriptRun>();

beforeAll(() => {
  for (const p of scripts()) {
    // A fresh state per script: a script that fails half way through its
    // chunk leaves globals behind, and the next one would be measured
    // against them.
    const { host } = bootedHost(loadDustNode());
    results.set(p, runScript(host, p));

  }
  const report = [...results.values()].map((r) => ({
    script: r.path.replace("/home/we/dust/code/", ""),
    ok: r.hostError === null && r.errors.length === 0 && r.initDone,
    engine: r.engine,
    errors: r.errors,
    hostError: r.hostError,
    initDone: r.initDone,
    log: r.log,
  }));
  fs.mkdirSync("docs/measurements", { recursive: true });
  fs.writeFileSync(
    path.join("docs/measurements", "community-sweep.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}, 300_000);

describe("the bundled community scripts", () => {

  // A `--no-scripts` build has none, and a `describe` with no `it` in it is
  // not an empty suite to vitest — it is `Error: No test found in suite`,
  // which reads as a broken test file rather than as a build that ships no
  // scripts on purpose. One skipped test says it instead.
  if (!HAS_CORPUS) {
    it.skip("none in this build: `build-dust.mjs --no-scripts` ships an empty script folder", () => {});
    return;
  }

  for (const p of scripts()) {
    const short = p.replace("/home/we/dust/code/", "");
    it(`${short} loads and inits`, () => {
      const r = results.get(p)!;
      expect(r.hostError, `host error: ${r.hostError}`).toBeNull();
      expect(r.errors.join(" | "), r.log.split("\n").slice(-8).join("\n")).toBe("");
      expect(r.initDone, `init never completed\n${r.log.split("\n").slice(-8).join("\n")}`).toBe(true);
    });
  }
});
