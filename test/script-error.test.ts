// E9-55 — one script must not be able to silence every error after it.
//
// `core/norns.lua:153` builds its message handler out of the GLOBAL `debug`:
//
//     local handler = function (err) return err .. "\n" .. debug.traceback() end
//
// `Script.clear` gives each script a clean slate by putting a metatable on
// `_G` whose `__newindex` diverts new globals into a private table — but
// `__newindex` only fires for a key `_G` does not already have, and `debug`
// is a standard library that is always there. A script that writes it
// writes into `_G` itself, and no later `Script.clear` takes it back.
//
// Two scripts in the catalogue do, both of them meaning a boolean flag:
//
//     pitfalls/lib/functions.lua:6        debug = bool
//     pirate-radio/pirate-radio.lua:24    debug=false
//
// After either one, the handler indexes a boolean, the handler itself
// raises, and Lua reports LUA_ERRERR — the string "error in error handling"
// — in place of every subsequent script error. Measured in the browser:
// eight scripts loaded after `pitfalls` reported exactly that, and all
// eight named a real error the moment the handler stopped reading the
// global.

import { beforeEach, describe, expect, it } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";
import { Vfs } from "../src/fs/vfs.js";

let host: Host;

const out = (code: string): string => {
  const before = host.output.length;
  const err = host.run(code);
  if (err) return `ERROR: ${err}`;
  return host.output.slice(before).join("\n");
};

beforeEach(() => {
  host = createHost({ sources: loadNornsLua(), vfs: new Vfs() });
  registerFs(host.registry, new Vfs());
  const err = boot(host, loadConfig());
  if (err) throw new Error(`boot failed at ${err.step}: ${err.error}`);
});

describe("norns.try, after a script has taken the name `debug`", () => {
  it("reports the message and a traceback as it always did", () => {
    const log = out(`norns.try(function() error("boom") end, "init")`);
    expect(log).toContain("init");
    expect(log).toContain("boom");
    expect(log).toContain("stack traceback");
  });

  it("still does, once a script has assigned to `debug`", () => {
    // Exactly what pitfalls/lib/functions.lua:6 does.
    expect(out("debug = false print(type(debug))")).toContain("boolean");
    const log = out(`norns.try(function() error("boom") end, "init")`);
    expect(log, "this is where 'error in error handling' came from").not.toContain(
      "error in error handling",
    );
    expect(log).toContain("boom");
    expect(log).toContain("stack traceback");
  });

  it("reports even while the global is still taken, mid-script", () => {
    // Inside one script's run there is no clear to put the library back,
    // so the handler has to be the thing that does not depend on it.
    out("debug = false");
    expect(out("print(type(debug))")).toContain("boolean");
    expect(out(`norns.try(function() error("boom") end, "init")`)).toContain("boom");
  });

  it("prints an error OBJECT, which upstream's concatenation cannot", () => {
    const log = out(`norns.try(function() error({ code = 1 }) end, "init")`);
    expect(log).not.toContain("error in error handling");
    expect(log).toContain("table:");
  });
});

describe("Script.clear and a library the last script took", () => {
  it("hands the next script its debug library back, and says so", () => {
    // pitter-patter/lib/nb/lib/nb.lua:1 is `debug.getinfo(1).source`, and
    // nb is carried by a long list of scripts. One `pitfalls` run used to
    // break every one of them until the page was reloaded.
    out("debug = false");
    const said = out("norns.script.clear()");
    expect(said).toContain("restored the debug library");
    expect(out("print(type(debug.getinfo))")).toContain("function");
  });

  it("says nothing when nothing was taken", () => {
    expect(out("norns.script.clear()")).not.toContain("restored the");
  });

  it("restores the libraries the reset itself is written in", () => {
    // `Script.clear` is `string`, `table` and `math` all the way down, so
    // the restore has to happen before the rest of it runs.
    out("string = false table = false math = false");
    const said = out("norns.script.clear()");
    expect(said).toContain("restored the string library");
    expect(said).toContain("restored the table library");
    expect(out(`print(string.upper("ok"))`)).toContain("OK");
  });
});
