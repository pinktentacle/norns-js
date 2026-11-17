// E9-103 — is the community corpus in this build, or is it not?
//
// There are TWO dust builds and both are correct. The development one packs
// `community patches/` — thirty-five scripts — because the exerciser and
// these tests need something to exercise. The published one is
// `tools/build-dust.mjs --no-scripts`, which ships an EMPTY script folder on
// purpose: norns.community is read live, so nothing of anybody else's is
// served by us at all.
//
// Five tests in `dust.test.ts` and the whole of `community.test.ts` ask
// questions about the corpus, and on the published build there is no corpus
// to ask about. They used to fail there — five reds and `No test found in
// suite` — on a machine where nothing was wrong. That is the worst kind of
// red: it is in the five checks the publishing runbook says must pass, so
// the only way past it is to stop believing the checks.
//
// A SKIP IS NOT A PASS, so this is not silent. `announce()` prints which of
// the two builds is under test, and the tests that need the corpus are named
// as needing it. A reader of the output can tell the difference between "the
// corpus is fine" and "there is no corpus here".

import fs from "node:fs";

const DUST = "public/dust.json";

/** Top-level `.lua` in each script directory, which is what SELECT lists. */
export function corpusScripts(): string[] {
  if (!fs.existsSync(DUST)) return [];
  const tree = JSON.parse(fs.readFileSync(DUST, "utf8")) as Record<string, string>;
  return Object.keys(tree)
    .filter((k) => /^\/home\/we\/dust\/code\/[^/]+\/[^/]+\.lua$/.test(k))
    .sort();
}

/** True when this build packs the community scripts. */
export const HAS_CORPUS = corpusScripts().length > 0;

/**
 * The sentence the test output carries, so a skip is never read as a pass.
 *
 * Returned rather than printed, and written to STDERR by the caller.
 * Measured: vitest's default reporter prints neither the name of a passing
 * test nor the name of a skipped one, and swallowed a `console.log` from
 * both a `describe` body and a test body. A bare `process.stderr.write`
 * from a test that always runs comes out. `dust.test.ts` has it.
 */
export function corpusLine(): string {
  const n = corpusScripts().length;
  return n === 0
    ? `${DUST} packs no community scripts: a \`--no-scripts\` build, which is what ` +
        "is published. The tests that ask about the corpus are SKIPPED, not passed."
    : `${DUST} packs ${n} community scripts.`;
}
