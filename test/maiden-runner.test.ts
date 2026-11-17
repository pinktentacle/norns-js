// The play button's judgement: what it refuses, and how it reads an outcome.
//
// It reads what norns already prints rather than hooking anything, which
// means the parsing IS the feature. A run that fails and reports success
// sends somebody looking at the wrong half of their script.

import { describe, expect, it } from "vitest";
import { createRunner } from "../src/editor/runner.js";
import type { Host } from "../src/lua/host.js";

/**
 * A host that prints what a script load would print.
 *
 * `lines` is what lands in the output when `norns.script.load` is run;
 * everything else (the two `_menu.set_mode` calls) is accepted silently,
 * as the real one does.
 */
function fakeHost(lines: string[], raises: string | null = null): Host & { ran: string[] } {
  const output: string[] = [];
  const ran: string[] = [];
  return {
    output,
    ran,
    L: null as never,
    registry: null as never,
    run(code: string) {
      ran.push(code);
      if (!code.includes("norns.script.load")) return null;
      if (raises !== null) return raises;
      output.push(...lines);
      return null;
    },
  };
}

const AWAKE = "/home/we/dust/code/awake/awake.lua";
const quick = { initTimeoutMs: 800, settleMs: 20 };

describe("what the play button refuses", () => {
  it("runs a script under code/", () => {
    expect(createRunner(fakeHost([]), quick).refuse(AWAKE)).toBeNull();
  });

  it("refuses lib, data and audio, which is maiden's own rule", () => {
    const r = createRunner(fakeHost([]), quick);
    expect(r.refuse("/home/we/dust/code/awake/lib/halfsecond.lua")).toContain("lib/");
    expect(r.refuse("/home/we/dust/code/x/data/thing.lua")).toContain("data/");
    expect(r.refuse("/home/we/dust/code/x/audio/thing.lua")).toContain("audio/");
  });

  it("refuses what is not a script at all", () => {
    const r = createRunner(fakeHost([]), quick);
    expect(r.refuse("/home/we/dust/audio/amen/break.wav")).toContain("code/");
    expect(r.refuse("/home/we/dust/code/awake/README.md")).toContain("lua");
  });

  it("does not touch the host for a file it refuses", async () => {
    const host = fakeHost([]);
    const out = await createRunner(host, quick).run("/home/we/dust/code/x/lib/y.lua");
    expect(out.ok).toBe(false);
    expect(host.ran, "it never went near the menu").toEqual([]);
  });
});

describe("reading the outcome out of what norns printed", () => {
  it("is a success when init arrives and nothing follows it", async () => {
    const host = fakeHost([`# script load: ${AWAKE}`, "# script run", "# script init"]);
    const out = await createRunner(host, quick).run(AWAKE);
    expect(out).toEqual({ ok: true, message: null, at: null });
  });

  it("goes through the MENU, both ways", async () => {
    // Not a detail: `Script.init` ends in an unconditional `screen_save()`
    // and the matching restore only happens when the menu is showing, so
    // loading from play mode pushes a cairo gstate per load and never pops
    // it. Twenty of those and the module traps (E5-27).
    const host = fakeHost([`# script load: ${AWAKE}`, "# script init"]);
    await createRunner(host, quick).run(AWAKE);
    const modes = host.ran.filter((c) => c.includes("set_mode"));
    expect(modes).toHaveLength(2);
    expect(modes[0]).toContain("true");
    expect(modes[1]).toContain("false");
  });

  it("is a failure when the error banner arrives, and keeps what followed it", async () => {
    const host = fakeHost([
      `# script load: ${AWAKE}`,
      "# script init",
      "### SCRIPT ERROR: init",
      `${AWAKE}:217: attempt to call a nil value (field 'amenbpm')`,
      "stack traceback:",
    ]);
    const out = await createRunner(host, quick).run(AWAKE);
    expect(out.ok).toBe(false);
    // The banner alone says "init" and nothing else; the line that matters
    // is the one after it.
    expect(out.message).toContain("attempt to call a nil value");
    expect(out.at).toEqual({ path: AWAKE, line: 217 });
  });

  it("finds the site of the error, not the site of the handler", async () => {
    // The traceback carries the same `path:line:` shape, and `core/norns.lua`
    // is always in it. The FIRST match is where it was raised.
    const host = fakeHost([
      "### SCRIPT ERROR: init",
      `${AWAKE}:3: attempt to index a nil value`,
      "stack traceback:",
      "\tcore/norns.lua:154: in field 'x'",
      "\t/home/we/dust/code/awake/lib/halfsecond.lua:9: in function 'y'",
    ]);
    const out = await createRunner(host, quick).run(AWAKE);
    expect(out.at).toEqual({ path: AWAKE, line: 3 });
  });

  it("is a failure when the file was not found", async () => {
    const host = fakeHost([`# script load failed, file not found: ${AWAKE}`]);
    const out = await createRunner(host, quick).run(AWAKE);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("not found");
  });

  it("reports a chunk that raised before it printed anything", async () => {
    const host = fakeHost([], "(norns-js):1: something went wrong");
    const out = await createRunner(host, quick).run(AWAKE);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("something went wrong");
  });

  it("gives up rather than hanging when init never comes", async () => {
    const host = fakeHost([`# script load: ${AWAKE}`]);
    const out = await createRunner(host, quick).run(AWAKE);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("never reached init");
    // And it still leaves the menu as it found it.
    expect(host.ran.filter((c) => c.includes("set_mode"))).toHaveLength(2);
  });
});
