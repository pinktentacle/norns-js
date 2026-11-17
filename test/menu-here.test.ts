// The menu pages that cannot do what they offer, and what they say instead.
//
// Three of norns' SYSTEM pages are dead ends in a browser, and each was dead
// in a way that looked like a freeze rather than a refusal: UPDATE waiting
// for a `curl` that is refused, WIFI offering five `nmcli` actions, SLEEP
// muting the audio for a shutdown a tab cannot perform. What is tested here
// is that the replacements are in place and that the pages that DO work were
// not caught in the net.

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Vfs } from "../src/fs/vfs.js";
import { registerFs } from "../src/fs/register.js";
import { registerHardware } from "../src/norns/hardware.js";
import { loadDustNode } from "../src/fs/dust-node.js";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";

const OVERLAY = join(import.meta.dirname, "..", "src", "lua", "norns-js", "menu-here.lua");

describe("the menu pages that cannot work here", () => {
  let host: Host;
  let vfs: Vfs;
  const refused: string[] = [];

  /**
   * Read one Lua expression back as a string.
   *
   * Through `print` and the output buffer rather than through a global:
   * `Script.clear` puts a metatable on `_G` that diverts new globals into
   * the running script's own table, and a probe written that way reads back
   * nil as soon as anything has been loaded.
   */
  const probe = (expr: string): string => {
    const before = host.output.length;
    expect(host.run(`print(tostring(${expr}))`)).toBeNull();
    return host.output.slice(before).join("").trim();
  };

  beforeAll(async () => {
    vfs = loadDustNode();
    host = createHost({ sources: loadNornsLua(), vfs });
    registerFs(host.registry, vfs, { onRefused: (c) => refused.push(c) });
    // The REAL hardware answers, not the stub table: platform_shield is
    // what this suite is asking about, and the stub has said false all
    // along while the implementation said true.
    registerHardware(host.registry);
    const err = boot(host, loadConfig());
    expect(err, err ? `${err.step}: ${err.error}` : "").toBeNull();
    expect(host.run(readFileSync(OVERLAY, "utf8"), "=(norns-js menu)")).toBeNull();
  }, 60_000);

  it("opens UPDATE without asking for a command that cannot run", () => {
    // Upstream's `m.init` fires `ping github.com` and then `curl`, and both
    // are refused — so the page sat on "checking for update." for ever,
    // because a refused `system_cmd` never calls its callback.
    refused.length = 0;
    expect(host.run(`pcall(_menu.set_page, "UPDATE")`)).toBeNull();
    expect(refused.filter((c) => /curl|ping|systemctl/.test(c))).toEqual([]);
  });

  it("opens WIFI without running nmcli", () => {
    refused.length = 0;
    expect(host.run(`pcall(_menu.set_page, "WIFI")`)).toBeNull();
    expect(refused.filter((c) => c.startsWith("nmcli"))).toEqual([]);
  });

  it("SLEEP saves the state and does NOT mute the output", () => {
    // The half that means something, without the half that does not:
    // `norns.shutdown` muted the DAC and the headphone gain in preparation
    // for a power-off that never comes, leaving the page silent with no way
    // back but a reload.
    expect(host.run(`
      rawset(_G, "_MUTED", false)
      local real = audio.level_dac
      audio.level_dac = function(v)
        if v == 0 then rawset(_G, "_MUTED", true) end
        return real(v)
      end
      norns.state.clean_shutdown = false
      pcall(_menu.set_page, "SLEEP")
      pcall(_menu.m.SLEEP.key, 3, 1)
    `)).toBeNull();
    expect(probe("_MUTED")).toBe("false");
    expect(probe("norns.state.clean_shutdown")).toBe("true");
    expect(probe("_menu.m.SLEEP.njs_slept")).toBe("true");
  });

  it("SETTINGS no longer offers a password nothing can receive", () => {
    // It used to open a text entry, run `sudo chpasswd` and `sudo smbpasswd`
    // — both refused in silence — and then print "hotspot password changed",
    // because writing that one file DID succeed.
    expect(probe("_menu.m.SETTINGS.list[2]")).toBe("PASSWORD");
    refused.length = 0;
    expect(host.run(`
      pcall(_menu.set_page, "SETTINGS")
      _menu.m.SETTINGS.pos = 2
      pcall(_menu.m.SETTINGS.key, 3, 1)
    `)).toBeNull();
    expect(refused.filter((c) => /chpasswd|smbpasswd/.test(c))).toEqual([]);
    expect(probe("_menu.m.SETTINGS.njs_note")).toContain("ssh");
  });

  it("leaves the pages that DO work alone", () => {
    // RESET really does clear the state files and reload, and DISPLAY really
    // does open — the wrapper on SETTINGS must not have swallowed either.
    expect(host.run(`
      pcall(_menu.set_page, "SETTINGS")
      _menu.m.SETTINGS.pos = 1
      pcall(_menu.m.SETTINGS.key, 3, 1)
    `)).toBeNull();
    expect(probe("_menu.page")).toBe("RESET");
    expect(host.run(`
      pcall(_menu.set_page, "SETTINGS")
      _menu.m.SETTINGS.pos = 3
      pcall(_menu.m.SETTINGS.key, 3, 1)
    `)).toBeNull();
    expect(probe("_menu.page")).toBe("DISPLAY");
  });

  it("marks the two stats that cannot be read, and keeps the two that can", () => {
    // K2 on HOME showed `cpu 0. 0. 0. 0.` and `0c`, and a zero there does
    // not read as "unknown" — it reads as an idle machine running cold.
    // The free space beside them is real (`navigator.storage.estimate()`),
    // and so is the audio percent (crone's own block time).
    expect(host.run(`_norns.stat(1234, 41, 7, 8, 9, 10, 11)`)).toBeNull();
    expect(probe("norns.disk")).toBe("1234");
    expect(probe("norns.cpu[1]")).toBe("-");
    expect(probe("norns.cpu[4]")).toBe("-");
    expect(probe("norns.temp")).toBe("-");
  });

  it("notices that a battery reported, without swallowing the reading", () => {
    // SETTINGS > BATTERY WARNING really does swap `screen.update` for the
    // low-battery overlay, and whether it can ever fire depends on the
    // machine rather than on the page — so the menu says so where the
    // cursor is, and this is the flag it reads.
    expect(probe(`rawget(_G, "_NJS_BATTERY")`)).toBe("nil");
    expect(host.run(`_norns.battery(42, -1)`)).toBeNull();
    expect(probe(`rawget(_G, "_NJS_BATTERY")`)).toBe("true");
    expect(probe("norns.battery_percent")).toBe("42");
    expect(probe("norns.battery_current")).toBe("-1");
  });

  it("is not a shield, so SLEEP stops talking about a power cable", () => {
    // `norns.is_shield` is read in exactly one place — the wording of the
    // sleep screen — and it used to say "when the not-red light stops
    // blinking, disconnect power" to somebody looking at a web page.
    expect(probe("norns.is_shield")).toBe("false");
  });
});
