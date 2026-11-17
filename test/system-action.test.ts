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
import { createHost, type Host } from "../src/lua/host.js";
import { loadNornsLua } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";
import { registerClock } from "../src/clock/register.js";
import { Vfs } from "../src/fs/vfs.js";

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
    // clock, so a reload restarts all four — and the state was saved
    // immediately before, so it comes back into the same script.
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
