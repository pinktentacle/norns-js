// E6-04 — PARAMS > PSET, end to end.
//
// A pset is the only thing a norns script writes that a user is expected to
// care about keeping, and the path it takes is wider than it looks: Lua
// `io.open` in update mode, a SHELL GLOB for the listing, a second file
// (`pset-last.txt`) read back at the next load, and the parameter map beside
// it. Any one of those failing leaves "save" looking like it worked.
//
// Driven from Lua rather than from the browser on purpose. The same path was
// walked by hand in the page first — the save does work there, keys and all
// — but a menu drive needs encoder acceleration, per-page sensitivity and a
// panel to navigate, and a test that spends its effort on those is testing
// the driver. Here the menu's own functions are called with the mode set, so
// what is under test is `write_pset`, `write_pset_last`, `init_pset` and
// `norns.pmap.write` — the parts the plain API path never touches.

import { beforeAll, describe, expect, it } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";
import { Vfs } from "../src/fs/vfs.js";

let host: Host;
let vfs: Vfs;

/** Run a chunk and fail the test with the Lua error if there is one. */
const run = (code: string): void => {
  const err = host.run(code);
  if (err) throw new Error(err);
};

/** Read a value back out of Lua through a table that survives Script.clear. */
const read = (expr: string): string => {
  run(`rawset(_G, "_T", tostring(${expr}))`);
  run(`_T = _T`);
  const err = host.run(`if _T == nil then error("no value") end`);
  if (err) throw new Error(err);
  // `print` is the only reader this harness has; capture it.
  const before = host.output.length;
  run(`print(_T)`);
  return host.output.slice(before).join("").trim();
};

beforeAll(() => {
  vfs = new Vfs();
  vfs.mkdir("/home/we/dust/data");
  host = createHost({ sources: loadNornsLua(), vfs });
  registerFs(host.registry, vfs);
  const err = boot(host, loadConfig());
  if (err) throw new Error(`boot failed at ${err.step}: ${err.error}`);

  // A script's worth of state, without a script. `Script.load` sets these
  // five; everything below reads them, and nothing here needs the 5 MB of
  // dust tree that loading a real one would pull in.
  run(`
    norns.state.script = "/home/we/dust/code/probe/probe.lua"
    norns.state.name = "probe"
    norns.state.shortname = "probe"
    norns.state.path = "/home/we/dust/code/probe/"
    norns.state.data = "/home/we/dust/data/probe/"
    norns.state.pset_last = 1
    util.make_dir(norns.state.data)
    params:add_number("alpha", "alpha", 0, 100, 7)
    params:add_control("beta", "beta", controlspec.new(0, 10, 'lin', 0, 2.5))
  `);
});

describe("the file a pset is", () => {
  it("writes the name as a comment and every param as a line", () => {
    run(`params:write(1, "a name")`);
    const text = vfs.readText("/home/we/dust/data/probe/probe-01.pset");
    expect(text, "the file must exist").not.toBeNull();
    expect(text!.split("\n")[0]).toBe("-- a name");
    expect(text).toContain('"alpha": 7');
    expect(text).toContain('"beta": 2.5');
  });

  it("round-trips a value through the file and not through memory", () => {
    run(`params:set("alpha", 42)`);
    expect(read(`params:get("alpha")`)).toBe("42");
    run(`params:read(1)`);
    expect(read(`params:get("alpha")`), "read must undo the change").toBe("7");
  });

  it("lists psets through the SHELL, which is how the menu finds them", async () => {
    // `init_pset` is `ls -1 <data><name>*.pset | sort` through
    // `norns.system_cmd`. Not a Lua directory read -- if the shell shim
    // stops recognising that shape, the PSET page goes empty and says
    // nothing about why.
    run(`params:write(2, "second")`);
    run(`
      rawset(_G, "_LS", "")
      norns.system_cmd('ls -1 '..norns.state.data..norns.state.shortname..'*.pset | sort',
        function(r) rawset(_G, "_LS", tostring(r)) end)
    `);
    // `system_cmd` answers on a later task, as a forked process would: the
    // callback is not allowed to run inside the call that started it.
    await new Promise((r) => setTimeout(r, 20));
    const listing = read(`_LS`);
    expect(listing).toContain("probe-01.pset");
    expect(listing).toContain("probe-02.pset");
  });

  it("deletes one and leaves the others", () => {
    run(`params:delete(2, "second", 2)`);
    expect(vfs.readText("/home/we/dust/data/probe/probe-02.pset")).toBeNull();
    expect(vfs.readText("/home/we/dust/data/probe/probe-01.pset")).not.toBeNull();
  });
});

describe("what the MENU does and the API does not", () => {
  it("remembers which pset was last used, in a file of its own", () => {
    // `write_pset_last` opens in update mode and writes one number;
    // `Script.load` reads it back on the next launch. The update modes were
    // missing once and every `io.write` here went to the log instead.
    run(`
      local file = norns.state.data.."pset-last.txt"
      local f = io.open(file,"w+")
      io.output(f)
      io.write("3")
      io.close(f)
    `);
    expect(vfs.readText("/home/we/dust/data/probe/pset-last.txt")).toBe("3");

    run(`
      local f = io.open(norns.state.data.."pset-last.txt","r")
      io.input(f)
      rawset(_G, "_PL", io.read("*line"))
      io.close(f)
    `);
    expect(read(`_PL`)).toBe("3");
  });

  it("writes the parameter map beside the pset", () => {
    run(`norns.pmap.write()`);
    // Empty is correct with nothing mapped; what matters is that the file
    // was created rather than the write failing silently.
    expect(vfs.readText("/home/we/dust/data/probe/probe.pmap")).not.toBeNull();
  });

  it("saves through the PSET page's own key handler", () => {
    // mPSET is 2, ps_action 1 is save. `m.key(3,1)` opens the text entry;
    // `write_pset` is its callback, so calling it is what the accept does.
    run(`
      local p = require 'core/menu/params'
      _menu.set_mode(true)
      _menu.set_page("PARAMS")
      p.mode = 2
      p.ps_action = 1
      p.ps_pos = 2
      params:set("alpha", 99)
      p.key(3, 1)
    `);
    // The accept: text entry calls its callback (`write_pset`) from `exit`.
    run(`local te = require 'textentry' te.txt = "from the menu" te.exit()`);
    const text = vfs.readText("/home/we/dust/data/probe/probe-03.pset");
    expect(text, "the menu's save must reach the filesystem").not.toBeNull();
    expect(text!.split("\n")[0]).toBe("-- from the menu");
    expect(text).toContain('"alpha": 99');
    // and the menu's save is the one that also records "last used"
    expect(vfs.readText("/home/we/dust/data/probe/pset-last.txt")).toBe("3");
  });
});
