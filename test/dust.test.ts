// E6 — the dust tree, and norns finding the community scripts in it.
//
// The question this answers is the one the user asked: are the scripts
// installed? Not "is there a filesystem" but "does SELECT list them", which
// goes through `system_cmd`, a held Lua callback, a `find` emulation and a
// VFS, and fails at any of the four.

import { beforeAll, describe, expect, it } from "vitest";
import { Vfs, normalise, seedDust } from "../src/fs/vfs.js";
import { runShell } from "../src/fs/shell.js";
import { registerFs } from "../src/fs/register.js";
import { loadDustNode } from "../src/fs/dust-node.js";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { HAS_CORPUS, corpusLine, corpusScripts } from "./support/corpus.js";

// FIVE OF THESE ASK ABOUT THE COMMUNITY CORPUS, which a `--no-scripts`
// build does not have. Skipped there rather than failed: see
// `support/corpus.ts`. The other five in the same block are about the
// filesystem itself and run either way.
const itCorpus = HAS_CORPUS ? it : it.skip;

describe("paths", () => {
  it("expands ~, collapses // and .., and drops a trailing slash", () => {
    // All three turn up in real norns commands: `find ~/dust/code/` has two.
    expect(normalise("~/dust/code/")).toBe("/home/we/dust/code");
    expect(normalise("~//dust///code")).toBe("/home/we/dust/code");
    expect(normalise("/home/we/dust/code/../data")).toBe("/home/we/dust/data");
    expect(normalise("dust/code")).toBe("/dust/code");
  });
});

describe("the filesystem", () => {
  it("reads what was mounted and what was written, with writes winning", () => {
    const vfs = new Vfs();
    vfs.mount("/a.txt", () => "base");
    expect(vfs.readText("/a.txt")).toBe("base");
    vfs.write("/a.txt", "overlay");
    expect(vfs.readText("/a.txt")).toBe("overlay");
  });

  it("remembers a deletion of a read-only file, instead of letting it return", () => {
    // Without a tombstone the base file reappears on the next read, and a
    // deleted PSET comes back from the dead.
    const vfs = new Vfs();
    vfs.mount("/p.pset", () => "x");
    expect(vfs.remove("/p.pset")).toBe(true);
    expect(vfs.exists("/p.pset")).toBe(false);
    expect(vfs.read("/p.pset")).toBeNull();
  });

  it("supplies a file's contents at most once, and not before it is read", () => {
    let calls = 0;
    const vfs = new Vfs();
    vfs.mount("/lazy.lua", () => {
      calls++;
      return "-- hi";
    });
    expect(calls).toBe(0);
    vfs.readText("/lazy.lua");
    expect(calls).toBe(1);
  });

  it("lists directories and files, and knows which is which", () => {
    const vfs = new Vfs();
    vfs.mount("/d/sub/one.lua", () => "");
    vfs.mount("/d/two.lua", () => "");
    expect(vfs.list("/d")).toEqual([
      { name: "sub", isDir: true },
      { name: "two.lua", isDir: false },
    ]);
    expect(vfs.isDir("/d/sub")).toBe(true);
    expect(vfs.isDir("/d/two.lua")).toBe(false);
  });

  it("mkdir makes an empty directory that exists but holds nothing", () => {
    const vfs = new Vfs();
    seedDust(vfs);
    expect(vfs.isDir("/home/we/dust/data")).toBe(true);
    expect(vfs.list("/home/we/dust/data")).toEqual([]);
  });

  it("and LISTS it as a directory, which it did not", () => {
    // `isDir` said directory and `list` said file about the same path: the
    // empty-directory keys ARE the directory, and they were going through
    // the branch that means "a leaf" for every other source. A script's own
    // `util.make_dir` on first run is how such a folder appears, and
    // `util.scandir` is `ls -pL` — the trailing slash that tells a script a
    // name is a folder comes from this flag.
    const vfs = new Vfs();
    vfs.mkdir("/home/we/dust/audio/amen");
    expect(vfs.isDir("/home/we/dust/audio/amen")).toBe(true);
    expect(vfs.list("/home/we/dust/audio")).toEqual([{ name: "amen", isDir: true }]);
  });

  it("deletes an empty directory, placeholder and all", () => {
    // A folder made by `mkdir` and still empty exists only as a name in a
    // set, so `remove` used to do nothing at all to it: the folder stayed
    // in every listing with no way to be rid of it.
    const vfs = new Vfs();
    vfs.mkdir("/home/we/dust/audio/scratch");
    vfs.mkdir("/home/we/dust/audio/scratch/deeper");
    expect(vfs.isDir("/home/we/dust/audio/scratch")).toBe(true);
    expect(vfs.remove("/home/we/dust/audio/scratch")).toBe(true);
    expect(vfs.isDir("/home/we/dust/audio/scratch"), "and the one under it").toBe(false);
    expect(vfs.list("/home/we/dust/audio")).toEqual([]);
  });

  it("reverts an edited bundled file to what the build supplies", () => {
    // Editing a bundled script writes a copy that wins for ever, and
    // `remove` is not the way back: it leaves a tombstone, because a
    // deleted file that reappeared on the next load would be a deletion
    // that did not happen.
    const vfs = new Vfs();
    vfs.mount("/home/we/dust/code/awake/awake.lua", () => "-- bundled");
    vfs.write("/home/we/dust/code/awake/awake.lua", "-- mine");
    expect(vfs.readText("/home/we/dust/code/awake/awake.lua")).toBe("-- mine");
    expect(vfs.hasOverlay("/home/we/dust/code/awake/awake.lua")).toBe(true);

    expect(vfs.revert("/home/we/dust/code/awake/awake.lua")).toBe(true);
    expect(vfs.readText("/home/we/dust/code/awake/awake.lua")).toBe("-- bundled");
    expect(vfs.hasOverlay("/home/we/dust/code/awake/awake.lua")).toBe(false);
  });

  it("brings a deleted bundled file back, too", () => {
    const vfs = new Vfs();
    vfs.mount("/home/we/dust/code/awake/awake.lua", () => "-- bundled");
    vfs.remove("/home/we/dust/code/awake/awake.lua");
    expect(vfs.exists("/home/we/dust/code/awake/awake.lua")).toBe(false);
    expect(vfs.revert("/home/we/dust/code/awake/awake.lua")).toBe(true);
    expect(vfs.readText("/home/we/dust/code/awake/awake.lua")).toBe("-- bundled");
  });

  it("refuses to revert a file the build never had", () => {
    // Reverting a file you wrote yourself would be deleting it, and that
    // is a different word.
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/mine/mine.lua", "-- mine");
    expect(vfs.revert("/home/we/dust/code/mine/mine.lua")).toBe(false);
    expect(vfs.readText("/home/we/dust/code/mine/mine.lua")).toBe("-- mine");
  });

  it("does not demote a directory that also has files in it", () => {
    const vfs = new Vfs();
    vfs.mount("/home/we/dust/audio/amen/break.wav", () => "x");
    vfs.mkdir("/home/we/dust/audio/amen");
    expect(vfs.list("/home/we/dust/audio")).toEqual([{ name: "amen", isDir: true }]);
  });
});

describe("the shell", () => {
  const vfs = new Vfs();
  vfs.mount("/home/we/dust/code/awake/awake.lua", () => "-- awake");
  vfs.mount("/home/we/dust/code/awake/lib/helper.lua", () => "-- helper");
  vfs.mount("/home/we/dust/code/awake/.git/config", () => "x");
  // A dot FILE as well as a dot directory: an installed script arrives with
  // both, and until E9-130 every listing handed them to the caller.
  vfs.mount("/home/we/dust/code/awake/.gitignore", () => "data/\n");
  vfs.mount("/home/we/dust/code/cranes/cranes.lua", () => "-- cranes");
  vfs.mount("/home/we/dust/data/awake-01.pset", () => "p");
  vfs.mount("/home/we/dust/data/awake-02.pset", () => "p");

  it("runs SELECT's find, excluding lib/ and .git as the real one does", () => {
    const r = runShell(
      vfs,
      'find ~/dust/code/ -mindepth 2 -name .git -prune -o -type f -name "*.lua" ' +
        '-printf "%P\\n" | grep -Ev "/(lib|data|crow|test|docs)/" | sort',
    );
    expect(r.ok).toBe(true);
    expect(r.out.trim().split("\n")).toEqual(["awake/awake.lua", "cranes/cranes.lua"]);
  });

  it("runs the PSET listing", () => {
    const r = runShell(vfs, "ls -1 /home/we/dust/data/awake*.pset | sort");
    expect(r.out.trim().split("\n")).toEqual([
      "/home/we/dust/data/awake-01.pset",
      "/home/we/dust/data/awake-02.pset",
    ]);
  });

  it("marks directories with a trailing slash, which util.scandir relies on", () => {
    const r = runShell(vfs, 'ls -pL --group-directories-first "/home/we/dust/code/awake"');
    expect(r.out.trim().split("\n")).toEqual(["lib/", "awake.lua"]);
  });

  // E9-130. THIS TEST USED TO EXPECT `.git/` IN THE LINE ABOVE, which is
  // how long the shim had been handing a script's repository to
  // `util.scandir` as though it were content. The same gap gave `bakeneko`
  // the 808 README to play.
  it("hides a leading dot, the way ls does", () => {
    const r = runShell(vfs, 'ls -pL --group-directories-first "/home/we/dust/code/awake"');
    expect(r.out).not.toContain(".git");
  });

  // Also the test that caught `-apL` missing this branch altogether: `-p`
  // was matched as a substring, so one extra flag letter sent
  // `util.scandir`'s own command to the plain listing at the bottom.
  it("shows them again for -a, because that is what -a is", () => {
    const r = runShell(vfs, 'ls -apL --group-directories-first "/home/we/dust/code/awake"');
    expect(r.out.trim().split("\n")).toEqual([".git/", "lib/", ".gitignore", "awake.lua"]);
  });

  // `--group-directories-first` has an `a` in it and is not `-a`.
  it("does not read a long option as a flag letter", () => {
    const r = runShell(vfs, 'ls -pL --group-directories-first "/home/we/dust/code/awake"');
    expect(r.out).not.toContain(".git");
  });

  it("keeps a dotfile out of a glob, and lets a dotted pattern have it", () => {
    const plain = runShell(vfs, 'ls "/home/we/dust/code/awake"/*');
    expect(plain.out).toContain("awake.lua");
    expect(plain.out).not.toContain(".gitignore");
    const asked = runShell(vfs, 'ls "/home/we/dust/code/awake"/.*');
    expect(asked.out).toContain(".gitignore");
  });

  it("refuses what it cannot do, instead of returning an empty success", () => {
    // A shell that answered "" for nmcli would have norns believe wifi was
    // configured.
    for (const cmd of ["nmcli radio wifi on", "sudo systemctl stop norns-sclang.service", "curl -s http://x"]) {
      const r = runShell(vfs, cmd);
      expect(r.ok, cmd).toBe(false);
      expect(r.refused).toBeTruthy();
    }
  });
});

describe("norns finds the installed scripts", () => {
  let host: Host;
  let vfs: Vfs;
  const refused: string[] = [];

  beforeAll(async () => {
    vfs = loadDustNode();
    host = createHost({ sources: loadNornsLua(), vfs });
    registerFs(host.registry, vfs, { onRefused: (c) => refused.push(c) });
    const err = boot(host, loadConfig());
    expect(err, err ? `${err.step}: ${err.error}` : "").toBeNull();
  }, 60_000);

  // ALWAYS RUNS, and it is the only line in the output that distinguishes
  // "the corpus is fine" from "there is no corpus here". Six skipped tests
  // with no reason beside them are not better than six red ones.
  //
  // It checks as well as says: a dust tree is either the development one,
  // which packs every script in `community patches/`, or the published one,
  // which packs none. A handful would be a build that went half way.
  it("says which of the two dust builds this is", () => {
    const n = corpusScripts().length;
    process.stderr.write(corpusLine() + "\n");
    expect(n === 0 || n >= 30, `${n} scripts is neither none nor a corpus`).toBe(true);
  });

  itCorpus("mounted the community scripts into ~/dust/code", () => {
    const scripts = vfs.list("/home/we/dust/code").filter((e) => e.isDir);
    expect(scripts.length).toBeGreaterThanOrEqual(30);
    for (const name of ["awake", "cranes", "mlr", "orca", "molly_the_poly"]) {
      expect(
        scripts.map((s) => s.name),
        `${name} should be installed`,
      ).toContain(name);
    }
  });

  itCorpus("gives Lua a working io.open over the tree", () => {
    expect(host.run(`
      local f = assert(io.open('/home/we/dust/code/awake/awake.lua', 'r'))
      _READ = f:read('a')
      f:close()
    `)).toBeNull();
    expect(host.run(`assert(#_READ > 100, 'got ' .. #_READ)`)).toBeNull();
  });

  it("opens a file whose bytes have not arrived, because it is THERE", () => {
    // E5-38. `util.file_exists` is nothing but an `io.open`, and a sound
    // file a script ships is fetched the first time something plays it —
    // so between the manifest and the first note it existed without being
    // openable, and a script guarding its own work with `file_exists` did
    // nothing, in silence.
    vfs.mountRemote("/home/we/dust/audio/demo/0.wav", {
      url: "/dust-bin/demo/0.wav",
      size: 1234,
    });
    expect(host.run(`_EX = util.file_exists('/home/we/dust/audio/demo/0.wav')`)).toBeNull();
    expect(host.run(`assert(_EX == true, 'file_exists said ' .. tostring(_EX))`)).toBeNull();
  });

  it("and the READ fails, rather than handing back an empty file", () => {
    // The open succeeding and the read failing is the honest pair. Empty
    // data would give a reader silence and call it the contents — the same
    // reasoning as the directory case just above.
    vfs.mountRemote("/home/we/dust/audio/demo/1.wav", {
      url: "/dust-bin/demo/1.wav",
      size: 1234,
    });
    expect(
      host.run(`
      local f, err = io.open('/home/we/dust/audio/demo/1.wav', 'r')
      assert(f ~= nil, 'open failed: ' .. tostring(err))
      local d, e = f:read('a')
      assert(d == nil, 'read returned data')
      assert(e ~= nil and e:find('not fetched'), 'no reason given: ' .. tostring(e))
    `),
    ).toBeNull();
  });

  it("round-trips a write, which is what PSET and favourites need", () => {
    expect(host.run(`
      local f = assert(io.open('/home/we/dust/data/probe.txt', 'w'))
      f:write('one\\n')
      f:write('two\\n')
      f:close()
      local g = assert(io.open('/home/we/dust/data/probe.txt', 'r'))
      _L1 = g:read('l')
      _L2 = g:read('l')
      _L3 = g:read('l')
      g:close()
    `)).toBeNull();
    expect(host.run(`assert(_L1 == 'one' and _L2 == 'two' and _L3 == nil, _L1 .. '/' .. _L2)`)).toBeNull();
  });

  it("loadfile reports a missing file instead of raising with just its name", () => {
    // The failure that broke boot in the browser: fengari's loadfile threw an
    // fs error of the wrong shape and the Lua message was a bare path.
    expect(host.run(`
      local chunk, err = loadfile('/home/we/dust/data/nope.lua')
      assert(chunk == nil, 'should not load')
      assert(err and err:find('cannot open'), 'bad error: ' .. tostring(err))
    `)).toBeNull();
  });

  itCorpus("SELECT lists them: system_cmd holds its callback and answers later", async () => {
    expect(host.run(`
      _SELECT_OUT = nil
      _SELECT_OK = _norns.system_cmd(
        'find ~/dust/code/ -mindepth 2 -name .git -prune -o -type f -name "*.lua" ' ..
        '-printf "%P\\n" | grep -Ev "/(lib|data|crow|test|docs)/" | sort',
        function(out) _SELECT_OUT = out end)
    `)).toBeNull();

    // True means "an event will fire", and it must not have fired yet.
    expect(host.run(`assert(_SELECT_OK == true, 'system_cmd returned ' .. tostring(_SELECT_OK))`)).toBeNull();
    expect(host.run(`assert(_SELECT_OUT == nil, 'callback was synchronous')`)).toBeNull();

    await new Promise((r) => setTimeout(r, 20));

    expect(host.run(`
      assert(_SELECT_OUT ~= nil, 'callback never ran')
      _COUNT = 0
      for _ in _SELECT_OUT:gmatch('[^\\n]+') do _COUNT = _COUNT + 1 end
    `)).toBeNull();
    expect(host.run(`assert(_COUNT >= 30, 'only ' .. _COUNT .. ' scripts listed')`)).toBeNull();
  });

  it("a refused command returns false, so no callback is left waiting", () => {
    expect(host.run(`_BAD = _norns.system_cmd('nmcli radio wifi on', function() _NEVER = true end)`)).toBeNull();
    expect(host.run(`assert(_BAD == false, 'got ' .. tostring(_BAD))`)).toBeNull();
    expect(refused.some((c) => c.startsWith("nmcli"))).toBe(true);
  });

  itCorpus("system_glob returns a table, or (nil, 3) for no match", () => {
    expect(host.run(`
      _G1 = { _norns.system_glob('/home/we/dust/code/awake/*.lua') }
      _G2 = { _norns.system_glob('/home/we/dust/code/awake/*.nope') }
    `)).toBeNull();
    expect(host.run(`assert(type(_G1[1]) == 'table' and #_G1[1] >= 1, 'glob found nothing')`)).toBeNull();
    // GLOB_NOMATCH is a failure status, not an empty table.
    expect(host.run(`assert(_G2[1] == nil and _G2[2] == 3, 'got ' .. tostring(_G2[1]))`)).toBeNull();
  });

  itCorpus("globs across path COMPONENTS, which is how norns finds mods", () => {
    // `core/mods.lua:13` searches for a star in the MIDDLE of the path.
    // Matching only the basename asked for a `mod.lua` inside a directory
    // literally called `*`, found nothing, and SYSTEM > MODS was empty for
    // ever — this tree ships `passthrough` and `midigrid`, and norns could
    // see neither. `passthrough`'s own example scripts then drew a blank
    // screen, because their `init` is wrapped in `if mod_running`.
    expect(host.run(`_GM = { _norns.system_glob('/home/we/dust/code/*/lib/mod.lua') }`)).toBeNull();
    expect(
      host.run(`assert(type(_GM[1]) == 'table' and #_GM[1] >= 1, 'no mods found')`),
    ).toBeNull();
    expect(host.run(`assert(_GM[1][1]:match('/lib/mod%.lua$'), 'got ' .. tostring(_GM[1][1]))`)).toBeNull();
  });
});

// E9-148 — the three things `kolor`'s `list_files` asks for.
//
// All three were wrong, and together they are why twelve banks of samples
// never loaded on a phone even after `cp -r` was fixed. From its source:
//
//     local cmd = "ls -ad " .. d .. "*/ 2>/dev/null"
//     local cmd = "ls -p " .. d .. " | grep -v /"
//
// The second is the one that cost a release: the `util.scandir` branch
// takes `words(cmd).at(-1)` as the directory, and the last word of that
// line is the `/` belonging to `grep`. It listed the ROOT, answered
// `home/`, and kolor spent its init trying to load a sample called
// `/home/we/dust/audio/kolor/bank1/home/` — twelve times, once per bank,
// which is exactly what the log said.
describe("listing a folder the way a script actually asks", () => {
  const banked = (): Vfs => {
    const v = new Vfs();
    v.write("/home/we/dust/audio/kolor/bank1/01.wav", "a");
    v.write("/home/we/dust/audio/kolor/bank1/02.wav", "b");
    v.write("/home/we/dust/audio/kolor/bank1/sub/03.wav", "c");
    return v;
  };
  const D = "/home/we/dust/audio/kolor/bank1/";

  it("does not read the pipe's argument as the directory", () => {
    const r = runShell(banked(), `ls -p ${D} | grep -v /`);
    expect(r.ok).toBe(true);
    expect(r.out, "it listed the root and answered `home/`").not.toContain("home/");
    expect(r.out.trim().split("\n")).toEqual(["01.wav", "02.wav"]);
  });

  it("drops a stderr redirect rather than globbing it", () => {
    const withIt = runShell(banked(), `ls -ad ${D}*/ 2>/dev/null`);
    const without = runShell(banked(), `ls -ad ${D}*/`);
    expect(withIt.out).toBe(without.out);
    expect(withIt.out.trim()).not.toBe("");
  });

  it("answers a trailing-slash glob with directories, slash and all", () => {
    const r = runShell(banked(), `ls -ad ${D}*/`);
    expect(r.out.trim().split("\n")).toEqual(["/home/we/dust/audio/kolor/bank1/sub/"]);
  });

  it("still answers a plain glob with files", () => {
    const r = runShell(banked(), `ls ${D}*.wav`);
    expect(r.out.trim().split("\n")).toEqual([
      "/home/we/dust/audio/kolor/bank1/01.wav",
      "/home/we/dust/audio/kolor/bank1/02.wav",
    ]);
  });

  it("counts, now that `wc -l` is one of the pipes it can do", () => {
    expect(runShell(banked(), `ls -p ${D} | wc -l`).out).toBe("3\n");
  });

  it("refuses a pipe it cannot do, instead of answering wrongly", () => {
    const r = runShell(banked(), `ls -p ${D} | awk '{s+=$1} END {print s}'`);
    expect(r.ok).toBe(false);
    expect(r.refused).toContain("unsupported pipe");
  });
});
