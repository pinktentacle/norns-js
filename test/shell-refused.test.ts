// E9-12 — a refused shell command has to be REPORTED, not only refused.
//
// There are two doors into the shell recogniser and only one of them talked.
// `_norns.execute` — what norns core calls — has always reported through
// `registerFs`'s `onRefused`. `_vfs_shell` — what a SCRIPT's own
// `os.execute` and `io.popen` come through — did not, and the comment above
// it claimed "a refusal it can see". The only thing a script could see was a
// false return value.
//
// WHAT THAT COST, which is why this is tested through Lua rather than
// against `runShell`: `amenbreak` checks for a native SuperCollider
// extension with `test -n "$(find …)"`, cannot find it because a wasm
// scsynth has no `.so` plugins, "installs" it with `wget … && sudo rsync …`,
// and asks for a restart. All three refusals were invisible, so the script
// sat on "please restart norns." for ever and the page had nothing to say
// about why. It read as a broken SYSTEM > RESTART.
//
// Through Lua, because the bug was in the WIRING and not in the recogniser:
// a test against `runShell` would have passed on the day this was broken.

import { beforeAll, describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import { createHost, type Host } from "../src/lua/host.js";
import { loadNornsLua } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";

/** Every command the host refused, as the page would log it. */
let refusals: Array<{ cmd: string; why: string }>;
let host: Host;
let vfs: Vfs;

beforeAll(() => {
  refusals = [];
  vfs = new Vfs();
  host = createHost({
    sources: loadNornsLua(),
    vfs,
    onShellRefused: (cmd, why) => refusals.push({ cmd, why }),
  });
});

describe("a script's own os.execute", () => {
  it("reports the command it would not run, and the reason", () => {
    // E9-228: this used to be amenbreak's `test -n "$(find …)"`, which the
    // shell now answers (test/tar-shell.test.ts), and then its
    // `pkill -f oscnotify`, which E9-267 answers from the page's own
    // process table (test/programs.test.ts). paracosms' sudo it cannot.
    const cmd = "sudo apt-get install -y sox";
    refusals.length = 0;
    host.run(`_EXEC_OK = os.execute(${JSON.stringify(cmd)})`);

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.cmd).toBe(cmd);
    expect(refusals[0]?.why).toContain("sudo");
  });

  it("reports an install that shells out to the network", () => {
    const cmd =
      "cd /tmp && wget https://github.com/schollz/tapedeck/releases/download/PortedPlugins/PortedPlugins.tar.gz && tar -xvzf PortedPlugins.tar.gz";
    refusals.length = 0;
    host.run(`os.execute(${JSON.stringify(cmd)})`);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.cmd, "the whole command, not the verb").toBe(cmd);
  });

  it("says nothing about a command it can actually run", () => {
    // `mkdir -p` IS recognised, and amenbreak's data directories really are
    // created. A refusal logged here would be noise, and noise is what makes
    // the three lines above unreadable.
    refusals.length = 0;
    host.run('os.execute("mkdir -p /home/we/dust/data/amenbreak/dats/")');
    expect(refusals).toEqual([]);
    expect(vfs.isDir("/home/we/dust/data/amenbreak/dats")).toBe(true);
  });

  it("reports what io.popen was refused too, through the same door", () => {
    refusals.length = 0;
    host.run('_POPEN = io.popen("nmcli --terse --fields name connection show"):read("a")');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.why).toContain("nmcli");
  });
});


// E9-69 — and the SAME two doors, for a download.
//
// `runShell` recognises `git clone`, `wget -O` and `curl -o`, says no for
// this run and hands the work up. `_vfs_shell` has started it since E9-37.
// `_norns.execute` and `_norns.system_cmd` — the ones norns' OWN Lua uses,
// and `util.os_capture` is `_norns.execute` — dropped it, so the log said
// "it will be in place next run" and no request was ever made.
//
// Found on `folio`, whose download button is
// `run_cmdline('git clone '..s['project_url']..' '..script_dir)`.
describe("a download handed up through each door", () => {
  const clone = "git clone https://github.com/monome/awake /home/we/dust/code/awake";

  it("is started when a SCRIPT shells out", () => {
    const fetches: Array<{ kind: string; url: string; dest: string }> = [];
    const v = new Vfs();
    const h = createHost({
      sources: loadNornsLua(),
      vfs: v,
      onShellFetch: (f) => fetches.push(f),
    });
    h.run(`os.execute(${JSON.stringify(clone)})`);
    expect(fetches).toEqual([
      { kind: "repo", url: "https://github.com/monome/awake", dest: "/home/we/dust/code/awake" },
    ]);
  });

  it("is started when NORNS shells out, which is what util.os_capture does", () => {
    const fetches: Array<{ kind: string; url: string; dest: string }> = [];
    const v = new Vfs();
    const h = createHost({ sources: loadNornsLua(), vfs: v });
    registerFs(h.registry, v, { onFetch: (f) => fetches.push(f) });
    const e = h.run(`local util = require('util') _CAPTURED = util.os_capture(${JSON.stringify(clone)})`);
    expect(e, "util.os_capture has to actually run").toBeNull();
    expect(fetches, "dropped on the floor before E9-69").toEqual([
      { kind: "repo", url: "https://github.com/monome/awake", dest: "/home/we/dust/code/awake" },
    ]);
  });

  it("still tells this run that the files are not there yet", () => {
    // The contract E9-37 set: `ok` is false on purpose, because a script
    // told otherwise would read the files and find nothing.
    const refused: string[] = [];
    const v = new Vfs();
    const h = createHost({ sources: loadNornsLua(), vfs: v });
    registerFs(h.registry, v, { onRefused: (_c, why) => refused.push(why), onFetch: () => {} });
    const e = h.run(`local util = require('util') _CAPTURED = util.os_capture(${JSON.stringify(clone)})`);
    expect(e, "util.os_capture has to actually run").toBeNull();
    expect(refused.join(" ")).toContain("next run");
    expect(v.isDir("/home/we/dust/code/awake")).toBe(false);
  });
});
