// E6-09 — `system_action` and `usleep`, as honest stubs.
//
// Both are places where the browser cannot do what the C does, and both were
// the kind of stub that is worse than nothing: `norns.lua:244` DISCARDS the
// return value of `system_action`, so a stub that answered `false` answered
// nobody. The menu set `confirmed`, drew "restarting.", cleared the script,
// muted the DAC, saved the state — and stopped there, on a dead screen.
//
// So the contract under test is not "returns false". It is: the one action
// that HAS a meaning here does it, the two that do not say why out loud, and
// the unknown one is refused by name.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHost, type Host } from "../src/lua/host.js";
import { loadNornsLua } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";
import { registerClock } from "../src/clock/register.js";
import { Vfs } from "../src/fs/vfs.js";
import { bootedHost } from "./support/script-harness.js";
import { restartInto } from "../src/ui/restart-into.js";

function harness() {
  const vfs = new Vfs();
  const host: Host = createHost({ sources: loadNornsLua(), vfs });
  const actions: Array<[string, string]> = [];
  const stubs: Array<[string, string]> = [];
  let reloaded = 0;
  registerFs(host.registry, vfs, {
    onSystemAction: (a, why) => actions.push([a, why]),
    reload: () => void reloaded++,
  });
  return {
    host,
    vfs,
    actions,
    stubs,
    reloads: () => reloaded,
    call: (name: string, ...args: unknown[]): unknown => {
      const raw = host.registry.rawImplementationFor(name);
      const impl = host.registry.implementationFor(name);
      if (raw) {
        // A raw implementation works the Lua stack; drive it through Lua.
        const err = host.run(
          `rawset(_G, "_R", _norns.${name}(${args.map((a) => JSON.stringify(a)).join(", ")}))`,
        );
        if (err) throw new Error(err);
        const before = host.output.length;
        host.run(`print(tostring(_R))`);
        return host.output.slice(before).join("").trim();
      }
      if (!impl) throw new Error(`${name} is not implemented`);
      const out = impl(...(args as never[]));
      return Array.isArray(out) ? out[0] : out;
    },
  };
}

describe("system_action", () => {
  it("RESTARTS, because reloading the page is exactly what reset means here", async () => {
    // On hardware `reset` relaunches matron and sclang as one detached
    // command. In a browser the page IS matron, sclang, crone and the
    // clock, so a reload restarts all four.
    //
    // This comment used to end "so it comes back into the same script",
    // which was wrong about hardware and wrong here. See the restart
    // describe below: `_norns.restart` clears the script BEFORE it saves.
    const h = harness();
    expect(h.call("system_action", "reset")).toBe("true");
    expect(h.actions[0]?.[0]).toBe("reset");
    // On a task, not inline: the menu has just drawn "restarting." and that
    // frame has to reach the canvas before the document goes away. Both
    // halves are asserted — deferred, and then actually done, because a
    // reload that is only deferred is the bug this replaced.
    expect(h.reloads()).toBe(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(h.reloads()).toBe(1);
  });

  it("refuses shutdown and update, and says why rather than just failing", () => {
    const h = harness();
    expect(h.call("system_action", "shutdown")).toBe("false");
    expect(h.call("system_action", "update")).toBe("false");
    expect(h.actions.map(([a]) => a)).toEqual(["shutdown", "update"]);
    expect(h.actions[0]![1]).toContain("cannot close itself");
    expect(h.actions[1]![1]).toContain("deploy");
  });

  it("names an action it has never heard of", () => {
    const h = harness();
    expect(h.call("system_action", "levitate")).toBe("false");
    expect(h.actions[0]![1]).toContain("levitate");
  });
});

describe("usleep", () => {
  it("does NOT sleep, and is recorded as not having slept", () => {
    // A blocking sleep in C. Blocking here would freeze the thread that
    // pumps the audio graph's messages — a 100 ms `usleep` would be 100 ms
    // of silence and a stalled screen.
    const vfs = new Vfs();
    const host = createHost({ sources: loadNornsLua(), vfs });
    const stubs: Array<[string, string]> = [];
    registerClock(host.registry, null as never, { onStub: (n, w) => stubs.push([n, w]) });
    const t0 = Date.now();
    host.registry.implementationFor("usleep")!(500_000 as never);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(stubs[0]?.[0]).toBe("usleep");
    expect(stubs[0]?.[1]).toContain("freeze");
  });
});

// E9-135 — WHAT A RESTART COMES BACK TO.
//
// Reported from a Pixel (user, 2026-11-19): load a script, press RESTART,
// and the script is still there afterwards. It should not be. `norns.lua`
// clears the script BEFORE saving the state:
//
//     _norns.restart = function()
//       norns.script.clear()          -- norns.state.script = ''
//       norns.state.clean_shutdown = true
//       norns.state.save()
//
// so `state.resume` finds an empty script on the way back up and takes its
// `else` branch. SLEEP is the one that resumes, because `norns.shutdown`
// saves without clearing — and a tab has no sleep.
//
// The port of that logic was always right. What was wrong is what the page
// did with the file afterwards: the OPFS mirror is debounced by 150 ms and
// the reload fired at 50, so the save never landed and the boot read the
// previous `system.state`, which still named the script.
describe("restart", () => {
  it("clears the script before it saves, so the state names nothing", () => {
    const h = bootedHost();
    // `state.save_state` writes `clock.midi_out[1..16]`, and this harness
    // has no clock params to fill them -- the page does. Fixture, not
    // fix: without it `save` dies concatenating a nil and the test would
    // be measuring the harness.
    h.host.run(`for i = 1, 16 do norns.state.clock.midi_out[i] = 0 end`);
    expect(h.host.run(`norns.state.script = '/home/we/dust/code/awake/awake.lua'`)).toBeFalsy();
    h.host.run(`norns.state.save()`);
    expect(h.vfs.readText("/home/we/dust/data/system.state")).toContain(
      "norns.state.script = '/home/we/dust/code/awake/awake.lua'",
    );

    const err = h.host.run(`_norns.restart()`);
    expect(err, `restart failed: ${err}`).toBeFalsy();

    const saved = h.vfs.readText("/home/we/dust/data/system.state") ?? "";
    expect(saved).toContain("norns.state.script = ''");
    expect(saved).toContain("norns.state.clean_shutdown = true");
    expect(saved).not.toContain("awake.lua");
  });

  // The other half of the same statement: a state that names nothing
  // resumes nothing, however clean the shutdown was.
  it("resumes nothing from a state that names nothing", () => {
    const h = bootedHost();
    h.host.run(`
      norns.state.clean_shutdown = true
      norns.state.script = ''
      norns.state.save()
    `);
    const before = h.host.output.length;
    const err = h.host.run(`norns.state.resume()`);
    expect(err, `resume failed: ${err}`).toBeFalsy();
    const said = h.host.output.slice(before).join("");
    expect(said).toContain("# script clear");
    expect(said).not.toContain("last file loaded");
  });
});

// `main.ts` wants a DOM, an AudioWorklet and a cross-origin-isolated
// origin, so the wiring is checked the way `rail-panels.test.ts` checks
// the rail: by reading it. The ORDER is the whole fix — a reload that
// starts before the flush settles is the bug, not a style.
describe("the page's reload flushes before it goes", () => {
  it("awaits the mirror, then reloads", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");
    const at = main.indexOf("registerFs(host.registry, vfs, {");
    expect(at, "registerFs has moved").toBeGreaterThan(-1);
    const opts = main.slice(at, main.indexOf("\n  });", at));
    const reload = /reload:\s*\(\)\s*=>\s*\{([\s\S]*?)\n    \}/.exec(opts);
    expect(reload, "registerFs is called without a reload of its own").not.toBeNull();
    const body = reload![1]!;
    expect(body, "the mirror is not flushed").toMatch(/mirror\.flush\(\)/);
    expect(body, "the reload does not wait for the flush").toMatch(
      /mirror\.flush\(\)\s*\.\s*(finally|then)\s*\(/,
    );
    expect(body.indexOf("mirror.flush()")).toBeLessThan(body.indexOf("location?.reload()"));
  });
});

// E9-254 — THE STORE'S RESTART, FROM A SCRIPT THAT BROUGHT AN ENGINE.
//
// Pressed to play that script, so it comes back into it — through norns'
// own resume, with the file put back after `_norns.restart` clears it.
describe("restart back into a script", () => {
  const FILE = "/home/we/dust/code/backagain/backagain.lua";
  const booted = () => {
    const h = bootedHost();
    h.host.run(`for i = 1, 16 do norns.state.clock.midi_out[i] = 0 end`);
    h.vfs.write("/home/we/dust/code/backagain/lib/helper.lua", `print("BACKAGAIN-HELPER") return {}`);
    h.vfs.write(FILE, `local helper = include("lib/helper")
function init() print("BACKAGAIN-INIT") end`);
    return h;
  };

  it("saves a clean shutdown that names the script", () => {
    const h = booted();
    const err = h.host.run(restartInto(FILE));
    expect(err, `restart failed: ${err}`).toBeFalsy();
    const saved = h.vfs.readText("/home/we/dust/data/system.state") ?? "";
    expect(saved).toContain(`norns.state.script = '${FILE}'`);
    expect(saved).toContain("norns.state.clean_shutdown = true");
  });

  it("and the boot that follows loads it", () => {
    const h = booted();
    h.host.run(restartInto(FILE));
    const before = h.host.output.length;
    const err = h.host.run(`dofile("/home/we/dust/data/system.state"); norns.state.resume()`);
    expect(err, `resume failed: ${err}`).toBeFalsy();
    const said = h.host.output.slice(before).join("");
    expect(said).toContain(`last file loaded: ${FILE}`);
    expect(said).toContain(`# script load: ${FILE}`);
    // Its own folder, as when it is loaded by hand: `include("lib/…")`.
    expect(said).toContain("BACKAGAIN-HELPER");
    expect(said).not.toContain("MISSING INCLUDE");
    // `Script.load()` appends a "/" to the saved path, as after a sleep on a norns.
    expect(
      h.host.run(`assert(norns.state.name == "backagain" and norns.state.path:find("/home/we/dust/code/backagain/", 1, true) == 1)`),
    ).toBeFalsy();
  });

  it("is the plain restart without a script", () => {
    const h = booted();
    h.host.run(`norns.state.script = '${FILE}'`);
    expect(h.host.run(restartInto(null))).toBeFalsy();
    expect(h.vfs.readText("/home/we/dust/data/system.state") ?? "").toContain("norns.state.script = ''");
  });
});
