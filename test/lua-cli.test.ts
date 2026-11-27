// E9-276 — `lua`, the command (src/fs/lua-cli.ts): a standalone Lua 5.3 as
// a process, in its own state, that makebreakbeat and sampswap start with
//
//   lua /home/we/dust/code/makebreakbeat/lib/dnb.lua … &
//   cd /home/we/dust/code/sampswap/lib/ && lua sampswap.lua … &

import { afterEach, describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import { runShell } from "../src/fs/shell.js";
import { runningPrograms, setProgramHost, stopAllPrograms } from "../src/fs/programs.js";
import { setLuaForegroundLimit } from "../src/fs/lua-cli.js";
import { luaHostFunctions } from "../src/lua/wasm53.js";
import { createHost } from "../src/lua/host.js";
import { loadNornsLua } from "../src/lua/host-node.js";

const log: string[] = [];
setProgramHost({ oscSend: () => false, log: (l) => log.push(l) });

afterEach(() => {
  stopAllPrograms();
  log.length = 0;
  setLuaForegroundLimit(null);
});

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const fresh = (files: Record<string, string> = {}): Vfs => {
  const vfs = new Vfs();
  vfs.mkdir("/home/we/dust/code");
  vfs.mkdir("/tmp");
  for (const [p, s] of Object.entries(files)) vfs.write(p, s);
  return vfs;
};

describe("lua in the foreground", () => {
  it("is on the PATH, as on a norns", () => {
    expect(runShell(fresh(), "command -v lua").out).toBe("/usr/bin/lua\n");
    expect(runShell(fresh(), "which lua5.3").out).toBe("/usr/bin/lua5.3\n");
  });

  it("prints its version, and runs -e", () => {
    expect(runShell(fresh(), "lua -v").out).toMatch(/^Lua 5\.3\.\d+ {2}Copyright \(C\) 1994-2020 Lua\.org, PUC-Rio\n$/);
    expect(runShell(fresh(), `lua -e "print(1+1, 'x')"`).out).toBe("2\tx\n");
  });

  it("builds arg as lua.c does and passes the arguments as ...", () => {
    const vfs = fresh({ "/home/we/t.lua": "print(#arg, arg[0], arg[-1], arg[1], arg[2], select('#', ...), ...)" });
    expect(runShell(vfs, "lua /home/we/t.lua a 'b c'").out).toBe("2\t/home/we/t.lua\tlua\ta\tb c\t2\ta\tb c\n");
    const e = runShell(vfs, "lua -e x=1 /home/we/t.lua");
    expect(e.out).toBe("0\t/home/we/t.lua\tx=1\tnil\tnil\t0\n");
  });

  it("skips a shebang and keeps the line numbers true in an error", () => {
    const vfs = fresh({ "/home/we/bad.lua": "#!/usr/bin/env lua\n\nerror('broken')\n" });
    const r = runShell(vfs, "lua /home/we/bad.lua");
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(true);
    expect(log[0]).toBe("lua: /home/we/bad.lua:3: broken");
    expect(log[1]).toBe("stack traceback:");
  });

  it("says it cannot open a script that is not there, and exits 1", () => {
    const r = runShell(fresh(), "lua /home/we/none.lua");
    expect(r.failed).toBe(true);
    expect(log).toEqual(["lua: cannot open /home/we/none.lua"]);
  });

  it("refuses -i, stdin, and an unknown option says so", () => {
    expect(runShell(fresh(), "lua -i").refused).toMatch(/terminal/);
    expect(runShell(fresh(), "lua").refused).toMatch(/stdin/);
    const r = runShell(fresh(), "lua -x");
    expect(r.failed).toBe(true);
    expect(log[0]).toBe("lua: unrecognized option '-x'");
  });

  it("os.exit sets the status", () => {
    expect(runShell(fresh(), `lua -e "print('a') os.exit(3) print('b')"`)).toMatchObject({ ok: false, failed: true, out: "a\n" });
    expect(runShell(fresh(), `lua -e "os.exit(true)"`).ok).toBe(true);
    expect(runShell(fresh(), `lua -e "os.exit()"`).ok).toBe(true);
  });

  it("runs commands: os.execute's output is its own, io.popen reads it", () => {
    const vfs = fresh({
      "/home/we/sh.lua": [
        "os.execute('echo hi')",
        "local f = assert(io.popen('echo there', 'r'))",
        "local s = f:read('*a') f:close()",
        "print('read:' .. s:gsub('%s+$', ''))",
        "print(os.execute('mkdir -p /tmp/made'))",
      ].join("\n"),
    });
    expect(runShell(vfs, "lua /home/we/sh.lua").out).toBe("hi\nread:there\ntrue\texit\t0\n");
    expect(vfs.isDir("/tmp/made")).toBe(true);
  });

  it("says once what it could not run, and os.execute gets sh's 127", () => {
    const vfs = fresh({
      "/home/we/x.lua": "for i = 1, 3 do print(os.execute('aubioonset -i a.wav')) end print(#io.popen('aubioonset -i a.wav'):read('*a'))",
    });
    const r = runShell(vfs, "lua /home/we/x.lua");
    expect(r.out).toBe("nil\texit\t127\n".repeat(3) + "0\n");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^lua x\.lua: aubioonset: /);
  });

  it("reads and writes the page's files byte for byte, io.write without a newline", () => {
    const vfs = fresh();
    const r = runShell(
      vfs,
      `lua -e "local f = io.open('/tmp/b.bin', 'wb') f:write(string.char(0, 200, 255)) f:close() io.write(#io.open('/tmp/b.bin', 'rb'):read('*a'), '!')"`,
    );
    expect(r.out).toBe("3!");
    expect([...vfs.read("/tmp/b.bin")!]).toEqual([0, 200, 255]);
  });

  it("works from the directory a leading cd gives it, and requires from there", () => {
    const vfs = fresh({
      "/home/we/dust/code/p/lib/main.lua": "local m = require('helper') m.go() print(os.getenv('PWD'), os.getenv('HOME'))",
      "/home/we/dust/code/p/lib/helper.lua": "return { go = function() local f = io.open('note.txt', 'w') f:write('here') f:close() os.execute('cp note.txt copy.txt') end }",
    });
    const r = runShell(vfs, "cd /home/we/dust/code/p/lib/ && lua main.lua");
    expect(r.out).toBe("/home/we/dust/code/p/lib\t/home/we\n");
    expect(vfs.readText("/home/we/dust/code/p/lib/note.txt")).toBe("here");
    expect(vfs.readText("/home/we/dust/code/p/lib/copy.txt")).toBe("here");
    // And nothing leaked into / once it was done.
    expect(vfs.exists("/note.txt")).toBe(false);
    expect(runShell(vfs, "cd /home/we/nowhere && lua main.lua").failed).toBe(true);
  });

  it("sends stdout to a file with > and >>", () => {
    const vfs = fresh();
    runShell(vfs, `lua -e "print('one')" > /tmp/o.txt`);
    runShell(vfs, `lua -e "print('two')" >> /tmp/o.txt`);
    expect(vfs.readText("/tmp/o.txt")).toBe("one\ntwo\n");
  });

  it("os.tmpname makes the file, as mkstemp does", () => {
    const vfs = fresh();
    const name = runShell(vfs, `lua -e "io.write(os.tmpname())"`).out;
    expect(name).toMatch(/^\/tmp\/lua_\w{6}$/);
    expect(vfs.exists(name)).toBe(true);
  });

  it("is stopped when it would hold the page too long", () => {
    setLuaForegroundLimit(50);
    const vfs = fresh();
    const r = runShell(vfs, `lua -e "while true do os.execute('sleep 1') end"`);
    expect(r.failed).toBe(true);
    expect(log.join("\n")).toMatch(/stopped after 0\.05 s/);
  });

  it("gives every run's state the same host functions: the table does not grow", () => {
    const vfs = fresh();
    runShell(vfs, `lua -e "print(1)"`);
    const n = luaHostFunctions();
    for (let i = 0; i < 10; i++) runShell(vfs, `lua -e "print(os.getenv('USER'))"`);
    expect(luaHostFunctions()).toBe(n);
  });

  it("runs from inside matron's own os.execute, in a second state", () => {
    const vfs = fresh();
    const host = createHost({ sources: loadNornsLua(), vfs });
    expect(
      host.run(
        "local s = io.popen('lua -e \"print(6*7)\"'):read('*a') " +
          "local f = io.open('/tmp/from-matron.txt', 'w') f:write(s .. tostring(_VERSION)) f:close()",
      ),
    ).toBeNull();
    expect(vfs.readText("/tmp/from-matron.txt")).toBe("42\nLua 5.3");
  });
});

describe("lua in the background", () => {
  it("returns at once, runs between the page's turns, and leaves the table when done", async () => {
    const vfs = fresh({
      "/home/we/bg.lua": [
        "for i = 1, 4 do",
        "  os.execute('echo ' .. (i * 25) .. ' >> /tmp/progress')",
        "  os.execute('sleep 0.02')",
        "end",
        "print('finished')",
      ].join("\n"),
    });
    const r = runShell(vfs, "lua /home/we/bg.lua &");
    expect(r).toEqual({ out: "", ok: true });
    expect(runningPrograms().map((p) => p.cmdline)).toEqual(["lua /home/we/bg.lua"]);
    // Nothing has run yet: the shell returned first, as `&` does.
    expect(vfs.exists("/tmp/progress")).toBe(false);
    await until(() => runningPrograms().length === 0);
    expect(runShell(vfs, "tail -n1 /tmp/progress").out).toBe("100\n");
    expect(log).toContain("finished");
  });

  it("waits on a file with sleep, as sampswap does, and pkill stops it", async () => {
    const vfs = fresh({
      "/home/we/wait.lua": [
        "local function exists(p) local f = io.open(p, 'r') if f then f:close() return true end return false end",
        "while not exists('/tmp/ready') do os.execute('sleep 0.01') end",
        "os.execute('echo got it > /tmp/answer')",
        "while true do os.execute('sleep 0.01') end",
      ].join("\n"),
    });
    runShell(vfs, "lua /home/we/wait.lua &");
    await new Promise((r) => setTimeout(r, 40));
    expect(vfs.exists("/tmp/answer")).toBe(false);
    vfs.write("/tmp/ready", "");
    await until(() => vfs.exists("/tmp/answer"));
    expect(runningPrograms()).toHaveLength(1);
    expect(runShell(vfs, "pkill -f wait.lua").ok).toBe(true);
    expect(runningPrograms()).toHaveLength(0);
    // And it stays stopped.
    vfs.remove("/tmp/answer");
    await new Promise((r) => setTimeout(r, 40));
    expect(vfs.exists("/tmp/answer")).toBe(false);
  });

  it("reports a background error in the log, as a child's stderr", async () => {
    const vfs = fresh({ "/home/we/err.lua": "local t = nil\nprint(t.x)\n" });
    runShell(vfs, "lua /home/we/err.lua &");
    await until(() => runningPrograms().length === 0);
    expect(log[0]).toMatch(/^lua: \/home\/we\/err\.lua:2: attempt to index a nil value \(local 't'\)$/);
  });

  it("takes sampswap's line: cd, then lua, then &", async () => {
    const vfs = fresh({
      "/home/we/dust/code/ss/lib/ss.lua": "local f = io.open('out.txt', 'w') f:write(table.concat(arg, ',')) f:close()",
    });
    const r = runShell(vfs, "cd /home/we/dust/code/ss/lib/ && lua ss.lua --server-started -output /tmp/x.wav &");
    expect(r.ok).toBe(true);
    await until(() => runningPrograms().length === 0);
    expect(vfs.readText("/home/we/dust/code/ss/lib/out.txt")).toBe("--server-started,-output,/tmp/x.wav");
  });
});

describe("tail and head of a file, which the scripts read the progress with", () => {
  it("answers tail -n1, tail -1, tail -n +2 and head", () => {
    const vfs = fresh({ "/tmp/p": "0\n25\n50\n", "/tmp/q": "a\nb" });
    expect(runShell(vfs, "tail -n1 /tmp/p").out).toBe("50\n");
    expect(runShell(vfs, "tail -1 /tmp/p").out).toBe("50\n");
    expect(runShell(vfs, "tail -n +2 /tmp/p").out).toBe("25\n50\n");
    expect(runShell(vfs, "head -n 1 /tmp/p").out).toBe("0\n");
    expect(runShell(vfs, "tail -n1 /tmp/q").out).toBe("b");
    expect(runShell(vfs, "cat /tmp/p | tail -n 2").out).toBe("25\n50\n");
    const none = runShell(vfs, "tail -n1 /tmp/none");
    expect(none).toEqual({ out: "", ok: false, failed: true });
  });
});
