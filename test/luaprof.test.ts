// E9-200 — the two instruments on the Lua side of the bridge: the sampler
// inside the interpreter, and the timing of what Lua calls on the page.
//
// Both are checked against a real Lua state, because what is under test is
// what the interpreter does: whether a hook follows a script into a
// coroutine, and whether a script can tell that anything was added.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";

const luaprof = readFileSync(fileURLToPath(new URL("../src/lua/norns-js/luaprof.lua", import.meta.url)), "utf8");

let host: Host;
const marks: string[] = [];

/** What Lua has printed since `from`. */
const printed = (from: number): string => host.output.slice(from).join("\n");

/**
 * Run Lua and fail loudly, with the interpreter's own message.
 *
 * `chunk` is what the interpreter calls the code, and so what the sampler
 * prints as its file: a test names its own so that "line 2" means one
 * function and not whichever chunk happened to have a line 2.
 */
function run(code: string, chunk?: string): void {
  const err = chunk === undefined ? host.run(code) : host.run(code, `=(${chunk})`);
  expect(err, `lua: ${err}`).toBeNull();
}

beforeAll(() => {
  host = createHost({ sources: loadNornsLua() });
  boot(host, loadConfig());
  host.registry.implement("profile_mark", (label) => {
    marks.push(String(label));
    return [];
  });
  const err = host.run(luaprof, "=(norns-js luaprof)");
  expect(err, `luaprof did not load: ${err}`).toBeNull();
});

describe("the Lua heap, which a profile may ask about and a script may not", () => {
  it("is a real number of kilobytes", () => {
    run(`_T = _norns_js_heap_kb()`);
    const from = host.output.length;
    run(`print(type(_T), _T > 100)`);
    expect(printed(from)).toContain("number");
    expect(printed(from)).toContain("true");
  });

  it("leaves `collectgarbage` answering scripts exactly as it did", () => {
    // The stand-in is a recorded difference from hardware. Making the
    // heap readable must not quietly become changing what a script sees.
    const from = host.output.length;
    run(`print(collectgarbage("count"), collectgarbage("step"), collectgarbage())`);
    expect(printed(from)).toMatch(/^0\.0\s+true\s+0$/m);
  });
});

describe("the sampler, off", () => {
  it("is off until something starts it", () => {
    const from = host.output.length;
    run(`print(_njs_prof.on)`);
    expect(printed(from)).toContain("false");
  });

  it("says it is not sampling, and how to make it, and still gives the heap", () => {
    const from = host.output.length;
    run(`_njs_prof.report()`);
    const said = printed(from);
    expect(said).toContain("not sampled");
    expect(said).toContain("&lua");
    expect(said).toMatch(/lua heap \d+ KB/);
  });

  it("sets no hook, so an unprofiled script runs on the interpreter's fast path", () => {
    const from = host.output.length;
    run(`print(debug.gethook() == nil)`);
    expect(printed(from)).toContain("true");
  });
});

describe("the sampler, on", () => {
  it("ranks the function that did the work, by name and by line", () => {
    // NOT `return _hot(n)`: a tail call replaces the caller's frame, and
    // Lua then has no name for the callee and no caller to show. That is
    // the interpreter being correct, and the first version of this test
    // asserted otherwise.
    run(
      `
      function _hot(n)
        local acc = 0
        for i = 1, n do acc = acc + i * 0.5 end
        return acc
      end
      function _entry()
        local r = _hot(400000)
        return r
      end
      _njs_prof.start()
      _entry()
    `,
      "hot-test",
    );
    const from = host.output.length;
    run(`_njs_prof.report()`);
    const said = printed(from);
    expect(said).toMatch(/lua: \d+ samples, one every 1000 instructions/);
    expect(said).toContain("lua functions, self% / with callees%:");
    // The loop is where the instructions are, so it is first and nearly all.
    const first = said.split("\n").find((l) => /^\s+\d+\.\d\s+\d+\.\d\s+\S/.test(l))!;
    expect(first).toContain("_hot");
    expect(first).toContain("(hot-test):2");
    expect(Number(first.trim().split(/\s+/)[0])).toBeGreaterThan(90);
    // The line inside the loop, not the line the function starts on.
    expect(said).toMatch(/lua lines: \(hot-test\):4 /);
    // And the caller that did nothing itself is on the stack for all of it.
    expect(said).toMatch(/most often on the stack:.*_entry \(hot-test\):7/);
    // The report does not rank the code that printed it.
    expect(said).not.toContain("luaprof");
  });

  it("starts each report from nothing", () => {
    const from = host.output.length;
    run(`_njs_prof.report()`);
    expect(printed(from)).toMatch(/no samples|lua: \d+ samples/);
    expect(printed(from)).not.toContain("_hot");
  });

  it("follows a script into a coroutine made after it started", () => {
    // A hook belongs to one coroutine. Without the wrap on
    // `coroutine.create` everything a `clock.run` does would be invisible,
    // and that is where a sequencer does its work.
    run(
      `
      function _in_coro()
        local acc = 0
        for i = 1, 300000 do acc = acc + i end
        return acc
      end
      local co = coroutine.create(_in_coro)
      coroutine.resume(co)
    `,
      "coro-test",
    );
    const from = host.output.length;
    run(`_njs_prof.report()`);
    // By where it is, not by name: the body of a coroutine was not called
    // by any instruction, so Lua has no name to give it. The file and the
    // line are what a reader goes to anyway.
    expect(printed(from)).toMatch(/\d+\.\d\s+\d+\.\d\s+\?\s+\(coro-test\):2/);
    expect(printed(from)).toMatch(/lua lines: \(coro-test\):4 /);
  });

  it("and into one that already existed when it started", () => {
    run(
      `
      _njs_prof.stop()
      function _early()
        coroutine.yield()
        local acc = 0
        for i = 1, 300000 do acc = acc + i end
      end
      _CO = coroutine.create(_early)
      coroutine.resume(_CO)
      _njs_prof.start()
      coroutine.resume(_CO)
    `,
      "early-test",
    );
    const from = host.output.length;
    run(`_njs_prof.report()`);
    expect(printed(from)).toMatch(/\d+\.\d\s+\d+\.\d\s+\?\s+\(early-test\):3/);
  });

  it("gives back what `coroutine.create` gives", () => {
    const from = host.output.length;
    run(`
      local co = coroutine.create(function(a, b) local c = coroutine.yield(a + b); return c * 2 end)
      local ok1, v1 = coroutine.resume(co, 2, 3)
      local ok2, v2 = coroutine.resume(co, 10)
      print(type(co), ok1, v1, ok2, v2, coroutine.status(co))
    `);
    expect(printed(from)).toMatch(/thread\s+true\s+5\s+true\s+20\s+dead/);
  });

  it("stops, and takes its hooks with it", () => {
    const from = host.output.length;
    run(`
      _njs_prof.stop()
      print(_njs_prof.on, debug.gethook() == nil, debug.gethook(_CO) == nil)
    `);
    expect(printed(from)).toMatch(/false\s+true\s+true/);
  });
});

describe("a mark made from Lua", () => {
  it("reaches the page first and is finished by Lua", () => {
    marks.length = 0;
    const from = host.output.length;
    run(`_norns.profile_mark("a phase")`);
    expect(marks).toEqual(["a phase"]);
    // Lua's own half, printed on the way out.
    expect(printed(from)).toContain("lua:");
  });
});

describe("timing what Lua calls on the page", () => {
  it("counts nothing while nobody is profiling", () => {
    const slot = host.registry.slotFor("screen_level");
    slot.calls = 0;
    slot.timed = 0;
    slot.ms = 0;
    slot.max = 0;
    expect(host.registry.timing).toBe(false);
    run(`for i = 1, 64 do _norns.screen_level(5) end`);
    expect(slot).toEqual({ calls: 0, timed: 0, ms: 0, max: 0 });
  });

  it("counts every call and times one in eight when somebody is", () => {
    const slot = host.registry.slotFor("screen_level");
    host.registry.timing = true;
    try {
      run(`for i = 1, 64 do _norns.screen_level(5) end`);
    } finally {
      host.registry.timing = false;
    }
    expect(slot.calls).toBe(64);
    expect(slot.timed).toBe(8);
    expect(slot.ms).toBeGreaterThanOrEqual(0);
  });

  it("returns what the function returns, timed or not", () => {
    // The eighth call takes the other branch of the dispatcher. It has to
    // come back with the same thing as the seven before it.
    host.registry.implement("screen_text_extents", () => [11, 7]);
    host.registry.timing = true;
    const from = host.output.length;
    try {
      run(`
        local seen = {}
        for i = 1, 16 do
          local w, h = _norns.screen_text_extents("x")
          seen[w .. "," .. h] = (seen[w .. "," .. h] or 0) + 1
        end
        for k, v in pairs(seen) do print(k, v) end
      `);
    } finally {
      host.registry.timing = false;
    }
    expect(printed(from)).toMatch(/^11,7\s+16$/m);
  });

  it("still raises a Lua error from a call that was being timed", () => {
    host.registry.implement("screen_peek", () => {
      throw new Error("deliberate");
    });
    host.registry.timing = true;
    const from = host.output.length;
    try {
      run(`
        local failed = 0
        for i = 1, 16 do
          if not pcall(_norns.screen_peek, 0, 0, 1, 1) then failed = failed + 1 end
        end
        print("failed", failed)
      `);
    } finally {
      host.registry.timing = false;
    }
    expect(printed(from)).toMatch(/failed\s+16/);
    // And the timed ones were still accounted for on the way out.
    expect(host.registry.slotFor("screen_peek").timed).toBe(2);
  });
});
