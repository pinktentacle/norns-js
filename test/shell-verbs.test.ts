// E9-31 — touch, mv, cat, echo and stat.
//
// Five verbs the catalogue asks for and the shim refused, against about
// twenty scripts. Every shape tested here was read off a real call site in
// the 350 repositories, not invented:
//
//   zxcvbn.lua:897     os.execute("touch ".._path.data.."zxcvbn/meta/...")
//   twins/presets.lua  os.execute('touch -m -d @'..mtime..' "'..path..'"')
//   zxcvbn/archive.lua os.execute("mv "..path.." ".._path.data.."zxcvbn/archives")
//   nc03-ds            os.execute('mv '..state.path..'audio '.._path.audio..'nc03-ds')
//   nornsfetch.lua:180 util.os_capture("cat ~/version.txt")
//   oooooo.lua:1022    os.execute("echo "..savename.." > "..DATA_DIR.."names/"..savename)
//   tmi/utils.lua:4    io.popen("stat -c %Y "..filename)
//   twins/presets.lua  io.popen('stat -c "%n %Y" "'..PRESETS_PATH..'"/*.lua 2>/dev/null')

import { describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import { runShell } from "../src/fs/shell.js";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const read = (vfs: Vfs, p: string): string | null => {
  const d = vfs.read(p);
  return d === null ? null : new TextDecoder().decode(d);
};

describe("touch", () => {
  it("creates the marker file a script is really asking for", () => {
    const vfs = new Vfs();
    const r = runShell(vfs, "touch /home/we/dust/data/zxcvbn/meta/load_default");
    expect(r.ok).toBe(true);
    expect(vfs.exists("/home/we/dust/data/zxcvbn/meta/load_default")).toBe(true);
    expect(read(vfs, "/home/we/dust/data/zxcvbn/meta/load_default")).toBe("");
  });

  it("leaves an existing file's contents alone", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/data/x/f", text("keep me"));
    runShell(vfs, "touch /home/we/dust/data/x/f");
    expect(read(vfs, "/home/we/dust/data/x/f")).toBe("keep me");
  });

  it("sets the time from `-m -d @<epoch>`, which is what twins restores", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/data/twins/p.lua", text("preset"));
    const r = runShell(vfs, 'touch -m -d @1700000000 "/home/we/dust/data/twins/p.lua"');
    expect(r.ok).toBe(true);
    expect(vfs.mtimeOf("/home/we/dust/data/twins/p.lua")).toBe(1700000000 * 1000);
    expect(read(vfs, "/home/we/dust/data/twins/p.lua"), "and not the contents").toBe("preset");
  });

  it("refuses a -d that is not an epoch, rather than guessing a date", () => {
    const r = runShell(new Vfs(), 'touch -d "last tuesday" /tmp/x');
    expect(r.ok).toBe(false);
    expect(r.refused).toMatch(/epoch/);
  });

  it("refuses `touch<path>` with no space, exactly as a norns would", () => {
    // krill, splnkr and gematria share this copied line. On hardware the
    // command is a missing binary; recognising it here would be inventing
    // a behaviour the machine does not have.
    const vfs = new Vfs();
    const r = runShell(vfs, "touch/home/we/dust/data/krill/");
    expect(r.ok).toBe(false);
    expect(vfs.exists("/home/we/dust/data/krill")).toBe(false);
  });
});

describe("mv", () => {
  it("renames a file", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/data/z/a.pset", text("one"));
    runShell(vfs, "mv /home/we/dust/data/z/a.pset /home/we/dust/data/z/b.pset");
    expect(read(vfs, "/home/we/dust/data/z/b.pset")).toBe("one");
    expect(vfs.exists("/home/we/dust/data/z/a.pset")).toBe(false);
  });

  it("moves into a directory that already exists, keeping the name", () => {
    // zxcvbn: `mv <path> ~/dust/data/zxcvbn/archives`
    const vfs = new Vfs();
    vfs.write("/home/we/dust/data/zxcvbn/1.pset", text("p"));
    vfs.mkdir("/home/we/dust/data/zxcvbn/archives");
    runShell(vfs, "mv /home/we/dust/data/zxcvbn/1.pset /home/we/dust/data/zxcvbn/archives");
    expect(read(vfs, "/home/we/dust/data/zxcvbn/archives/1.pset")).toBe("p");
    expect(vfs.exists("/home/we/dust/data/zxcvbn/1.pset")).toBe(false);
  });

  it("moves a whole directory, which is not a glob hit", () => {
    // nc03-ds moves its script's `audio` folder into ~/dust/audio.
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/nc03-ds/audio/a.wav", text("aa"));
    vfs.write("/home/we/dust/code/nc03-ds/audio/sub/b.wav", text("bb"));
    const r = runShell(vfs, "mv /home/we/dust/code/nc03-ds/audio /home/we/dust/audio/nc03-ds");
    expect(r.ok).toBe(true);
    expect(read(vfs, "/home/we/dust/audio/nc03-ds/a.wav")).toBe("aa");
    expect(read(vfs, "/home/we/dust/audio/nc03-ds/sub/b.wav")).toBe("bb");
    expect(vfs.exists("/home/we/dust/code/nc03-ds/audio/a.wav")).toBe(false);
  });

  it("takes several sources into a directory", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/data/s/1.pset", text("1"));
    vfs.write("/home/we/dust/data/s/2.pset", text("2"));
    vfs.mkdir("/home/we/dust/data/out");
    runShell(vfs, "mv /home/we/dust/data/s/*.pset /home/we/dust/data/out");
    expect(read(vfs, "/home/we/dust/data/out/1.pset")).toBe("1");
    expect(read(vfs, "/home/we/dust/data/out/2.pset")).toBe("2");
  });

  it("moves a sound file that has not been downloaded as a REFERENCE", () => {
    // The same care cp takes: reading a megabyte back through the shell for
    // a move nothing may ever play is the thing to avoid.
    const vfs = new Vfs();
    vfs.mountRemote("/home/we/dust/code/beets/demo/0.wav", { url: "/0.wav", size: 1270628 });
    const r = runShell(vfs, "mv /home/we/dust/code/beets/demo/0.wav /home/we/dust/audio/0.wav");
    expect(r.ok).toBe(true);
    expect(vfs.remoteAt("/home/we/dust/audio/0.wav")?.url).toBe("/0.wav");
    expect(vfs.exists("/home/we/dust/code/beets/demo/0.wav")).toBe(false);
  });

  it("carries the modification time, because a move is not a modification", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/data/t/a", text("x"));
    vfs.setMtime("/home/we/dust/data/t/a", 1690000000000);
    runShell(vfs, "mv /home/we/dust/data/t/a /home/we/dust/data/t/b");
    expect(vfs.mtimeOf("/home/we/dust/data/t/b")).toBe(1690000000000);
  });

  it("wants a source and a destination", () => {
    expect(runShell(new Vfs(), "mv /tmp/only").ok).toBe(false);
  });
});

describe("cat", () => {
  it("reads a file, which is what nornsfetch does with ~/version.txt", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/version.txt", text("norns 240424\n"));
    const r = runShell(vfs, "cat ~/version.txt");
    expect(r.ok).toBe(true);
    expect(r.out).toBe("norns 240424\n");
  });

  it("concatenates several, in the order given", () => {
    const vfs = new Vfs();
    vfs.write("/a", text("one\n"));
    vfs.write("/b", text("two\n"));
    expect(runShell(vfs, "cat /a /b").out).toBe("one\ntwo\n");
  });

  it("says nothing about a file that is not there, as cat does on stdout", () => {
    const r = runShell(new Vfs(), "cat /home/we/nope.txt");
    expect(r.ok).toBe(true);
    expect(r.out).toBe("");
  });

  it("refuses a pipeline rather than answering half of it", () => {
    // amenbreak: `cat /tmp/foo | sort | uniq > /tmp/files`. Answering the
    // `cat` and dropping the rest would write the wrong file.
    const r = runShell(new Vfs(), "cat /tmp/foo | sort | uniq > /tmp/files");
    expect(r.ok).toBe(false);
    expect(r.refused).toMatch(/pipeline/);
  });
});

describe("echo", () => {
  it("writes a one-line marker, newline included", () => {
    // oooooo and barcode read the file back, so the newline is part of it.
    const vfs = new Vfs();
    const r = runShell(vfs, "echo mysave > /home/we/dust/data/oooooo/names/mysave");
    expect(r.ok).toBe(true);
    expect(read(vfs, "/home/we/dust/data/oooooo/names/mysave")).toBe("mysave\n");
  });

  it("appends with >>, rather than starting again", () => {
    const vfs = new Vfs();
    runShell(vfs, "echo one > /home/we/l");
    runShell(vfs, "echo two >> /home/we/l");
    expect(read(vfs, "/home/we/l")).toBe("one\ntwo\n");
  });

  it("goes to stdout when nothing redirects it", () => {
    expect(runShell(new Vfs(), "echo hi").out).toBe("hi\n");
  });

  it("keeps a quoted string whole", () => {
    const vfs = new Vfs();
    runShell(vfs, 'echo "two words" > /home/we/q');
    expect(read(vfs, "/home/we/q")).toBe("two words\n");
  });
});

describe("stat", () => {
  it("answers %Y in SECONDS, which is what tmi parses", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/data/tmi/f.txt", text("x"));
    vfs.setMtime("/home/we/dust/data/tmi/f.txt", 1700000000123);
    const r = runShell(vfs, "stat -c %Y /home/we/dust/data/tmi/f.txt");
    expect(r.ok).toBe(true);
    expect(r.out).toBe("1700000000\n");
  });

  it("answers a quoted multi-part format over a glob, sorted", () => {
    // twins: `stat -c "%n %Y" "<dir>"/*.lua 2>/dev/null`, then it matches
    // `([^/]+)%.lua (%d+)$` on each line.
    const vfs = new Vfs();
    vfs.write("/home/we/dust/data/twins/presets/b.lua", text("b"));
    vfs.write("/home/we/dust/data/twins/presets/a.lua", text("a"));
    vfs.setMtime("/home/we/dust/data/twins/presets/a.lua", 1600000000000);
    vfs.setMtime("/home/we/dust/data/twins/presets/b.lua", 1610000000000);
    const r = runShell(
      vfs,
      'stat -c "%n %Y" "/home/we/dust/data/twins/presets"/*.lua 2>/dev/null',
    );
    expect(r.ok).toBe(true);
    const lines = r.out.trim().split("\n");
    expect(lines).toEqual([
      "/home/we/dust/data/twins/presets/a.lua 1600000000",
      "/home/we/dust/data/twins/presets/b.lua 1610000000",
    ]);
    // And the script's own pattern has to match what it is handed.
    expect(/([^/]+)\.lua (\d+)$/.exec(lines[0]!)?.[1]).toBe("a");
  });

  it("skips a file whose time is unknown instead of calling it 1970", () => {
    // Both callers SORT on the number. An epoch zero for every file the
    // build shipped would put them first for ever.
    const vfs = new Vfs();
    vfs.mountRemote("/home/we/dust/code/x/a.lua", { url: "/a.lua", size: 3 });
    expect(vfs.mtimeOf("/home/we/dust/code/x/a.lua")).toBeNull();
    const r = runShell(vfs, "stat -c %Y /home/we/dust/code/x/a.lua");
    expect(r.ok).toBe(true);
    expect(r.out).toBe("");
  });

  it("answers %s with the size", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/s", text("12345"));
    expect(runShell(vfs, "stat -c %s /home/we/s").out).toBe("5\n");
  });

  it("refuses a format it does not implement, rather than printing a literal", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/s", text("x"));
    expect(runShell(vfs, "stat /home/we/s").ok, "no -c at all").toBe(false);
    const owner = runShell(vfs, "stat -c %U /home/we/s");
    expect(owner.ok, "an owner a browser cannot know").toBe(false);
    expect(owner.refused).toMatch(/%n, %Y and %s/);
  });
});

// E9-37 — the dependency a script downloads for itself.
//
// Fourteen scripts do this, and the shapes below were read off their real
// call sites:
//
//   taweeet      os.execute("git clone https://github.com/skibu/nornsLib.git "
//                           .._path.code.."nornsLib")
//   paracosms    os.execute("wget -q -O /home/we/dust/code/paracosms/ignore.zip <url>")
//   norns.online os.execute("curl -L "..latest_release.." -o "..SERVER_FILE)
//   lorenzos     norns.system_cmd("cd ~/dust/audio && wget -q <url>")
//
// `ok` is FALSE for every one of them, on purpose: the files are not there
// yet, and a script told otherwise would read them and find nothing.
describe("a download the shell hands up", () => {
  const GH = "https://github.com/skibu/nornsLib.git";

  it("recognises git clone and names where it goes", () => {
    const r = runShell(new Vfs(), `git clone ${GH} /home/we/dust/code/nornsLib`);
    expect(r.ok, "not this run").toBe(false);
    expect(r.fetch).toEqual({
      kind: "repo",
      url: GH,
      dest: "/home/we/dust/code/nornsLib",
    });
    expect(r.refused).toMatch(/next run/);
  });

  it("refuses a git clone with nowhere to put it", () => {
    // On hardware it lands in the working directory. There is none here,
    // and guessing would put somebody's library where they would not find
    // it. The one script that does this passes a destination.
    const r = runShell(new Vfs(), `git clone ${GH}`);
    expect(r.ok).toBe(false);
    expect(r.fetch).toBeUndefined();
    expect(r.refused).toMatch(/no destination/);
  });

  it("refuses to clone anything that is not github", () => {
    const r = runShell(new Vfs(), "git clone https://gitlab.example/a/b /tmp/b");
    expect(r.ok).toBe(false);
    expect(r.fetch, "nothing is started").toBeUndefined();
  });

  it("reads `wget -q -O <dest> <url>`, flags in any order", () => {
    const url = "https://github.com/schollz/paracosms/releases/download/release/extra.zip";
    const r = runShell(new Vfs(), `wget -q -O /home/we/dust/code/paracosms/lib/extra.zip ${url}`);
    expect(r.fetch).toEqual({
      kind: "file",
      url,
      dest: "/home/we/dust/code/paracosms/lib/extra.zip",
    });
  });

  it("reads `curl -L <url> -o <dest>`", () => {
    const url = "https://github.com/schollz/norns.online/releases/latest/x";
    const r = runShell(new Vfs(), `curl -L ${url} -o /home/we/dust/code/norns.online/server`);
    expect(r.fetch?.kind).toBe("file");
    expect(r.fetch?.dest).toBe("/home/we/dust/code/norns.online/server");
  });

  it("follows a `cd <dir> &&` to decide where a bare wget lands", () => {
    const url = "https://github.com/schollz/lorenzos-drums/releases/download/samples/s.zip";
    const r = runShell(new Vfs(), `cd ~/dust/audio && wget -q ${url}`);
    expect(r.fetch?.dest).toBe("/home/we/dust/audio/s.zip");
  });

  it("refuses a bare wget with nowhere to put it", () => {
    const r = runShell(new Vfs(), "wget -q https://example.com/x.zip");
    expect(r.ok).toBe(false);
    expect(r.fetch).toBeUndefined();
    expect(r.refused).toMatch(/no destination/);
  });

  it("treats a `>` redirect as the destination", () => {
    const r = runShell(new Vfs(), "curl -s https://api.example/t > /home/we/t.json");
    expect(r.fetch?.dest).toBe("/home/we/t.json");
  });
});

// E9-65 — `&&` is a separator, not a filename.
//
// `mkdir -p <dir> && mv a b` reached the mkdir branch whole, and that
// branch takes every word after `mkdir` that does not begin with `-`. It
// made five directories: the one asked for, and `&&`, `mv`, `a` and `b`.
// Two of them were sitting at the root of this origin's OPFS when it was
// found, `/mv` and `/&&`, with nothing in any log to say where they came
// from.
describe("a chained command does not file its punctuation", () => {
  it("makes the directory it was asked for and nothing else", () => {
    const vfs = new Vfs();
    const r = runShell(vfs, "mkdir -p /home/we/dust/data/thing && mv a b");
    expect(r.ok, r.refused).toBe(true);
    expect(vfs.isDir("/home/we/dust/data/thing")).toBe(true);
    for (const junk of ["/&&", "/mv", "/a", "/b"]) {
      expect(vfs.isDir(junk), `${junk} is not a directory anybody asked for`).toBe(false);
    }
  });

  it("stops at the operator for rm too", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/data/keep.txt", "keep");
    vfs.write("/home/we/dust/data/go.txt", "go");
    runShell(vfs, "rm /home/we/dust/data/go.txt && rm /home/we/dust/data/keep.txt");
    expect(vfs.read("/home/we/dust/data/go.txt"), "the first part ran").toBeNull();
    expect(vfs.readText("/home/we/dust/data/keep.txt"), "the second did not").toBe("keep");
  });

  it("leaves a quoted operator alone, because it is a name", () => {
    const vfs = new Vfs();
    const r = runShell(vfs, `mkdir -p "/home/we/dust/data/a && b"`);
    expect(r.ok, r.refused).toBe(true);
    expect(vfs.isDir("/home/we/dust/data/a && b")).toBe(true);
  });
});
