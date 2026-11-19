// E9-150 — the shell shim against the commands scripts actually write.
//
// Asked for after `cp -r` and three `ls` faults turned up inside a week
// (user, 2026-11-19): "reverifie les autres commandes shell". Guessing at
// idioms is what let those through, so the shapes below were not invented
// — they were extracted from the 354 scripts in the catalogue, by pulling
// every literal passed to `os.execute`, `io.popen` and `util.os_capture`
// and grouping what came out:
//
//     169 mkdir   45 rm   36 cp   18 cd   12 ls   8 touch   8 find
//       6 mv       4 cat   2 tail  ... and jack_connect/sudo/pkill, which
//                                      are refused on purpose.
//
// WHAT THIS FILE IS FOR is the difference between a refusal and a wrong
// answer. A command this shim cannot do must say so: a listing that comes
// back empty reads as "nothing there" rather than "not asked", and that is
// how `kolor` spent a week looking for samples in `bank1/home/`.

import { describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import { runShell } from "../src/fs/shell.js";

function tree(): Vfs {
  const v = new Vfs();
  v.write("/home/we/dust/code/.gitignore", "g");
  v.write("/home/we/dust/code/amen/amen.lua", "a");
  v.write("/home/we/dust/code/kolor/kolor.lua", "k");
  v.write("/home/we/dust/audio/one.wav", "w");
  v.write("/home/we/dust/audio/two.wav", "w");
  v.write("/home/we/dust/audio/sub/three.wav", "w");
  v.write("/home/we/dust/data/a-01.pset", "p");
  v.write("/home/we/dust/data/a-02.pset", "q");
  v.write("/home/we/version.txt", "1.2");
  v.write("/tmp/foo", "b\na\nb\n");
  return v;
}

describe("the shapes the catalogue writes", () => {
  it("counts what is installed", () => {
    // `ls ~/dust/code | wc -l`, verbatim from a script. It was refused
    // until E9-150 — and before the pipe was handled at all, the listing
    // branch took `-l` as the directory.
    expect(runShell(tree(), "ls /home/we/dust/code | wc -l").out).toBe("2\n");
  });

  it("sorts and dedupes through a redirect", () => {
    // `cat /tmp/foo | sort | uniq > /tmp/files`, verbatim. `sort` and
    // `uniq` were in the pipe runner the whole time; `cat` refused
    // anything with a pipe in it and never reached them.
    const v = tree();
    expect(runShell(v, "cat /tmp/foo | sort | uniq > /tmp/files").ok).toBe(true);
    expect(v.readText("/tmp/files")).toBe("a\nb\n");
  });

  it("takes the first line, written either way", () => {
    const v = tree();
    expect(runShell(v, "ls /home/we/dust/audio | head -1").out).toBe("one.wav\n");
    expect(runShell(v, "ls /home/we/dust/audio | head -n 2").out).toBe("one.wav\nsub\n");
  });

  it("shows the hidden ones for -a, and only then", () => {
    const v = tree();
    expect(runShell(v, "ls /home/we/dust/code").out).toBe("amen\nkolor\n");
    expect(runShell(v, "ls -a /home/we/dust/code").out).toBe(".gitignore\namen\nkolor\n");
    expect(runShell(v, "ls -la /home/we/dust/code").out).toContain(".gitignore");
  });

  it("finds by name below a directory", () => {
    const out = runShell(tree(), 'find /home/we/dust/audio -name "*.wav"').out;
    expect(out.trim().split("\n")).toEqual([
      "/home/we/dust/audio/one.wav",
      "/home/we/dust/audio/sub/three.wav",
      "/home/we/dust/audio/two.wav",
    ]);
  });

  it("concatenates a glob, in order", () => {
    expect(runShell(tree(), "cat /home/we/dust/data/*.pset").out).toBe("pq");
  });

  it("reads a tilde path", () => {
    expect(runShell(tree(), "cat ~/version.txt").out).toBe("1.2");
  });

  it("makes a directory, with -p or without", () => {
    const v = tree();
    expect(runShell(v, "mkdir -p /home/we/dust/audio/new/deep/").ok).toBe(true);
    expect(v.isDir("/home/we/dust/audio/new/deep")).toBe(true);
    expect(runShell(v, "mkdir /home/we/dust/tmp").ok).toBe(true);
    expect(v.isDir("/home/we/dust/tmp")).toBe(true);
  });

  it("copies with the flags scripts pass, which it ignores", () => {
    // `-u` and `-f` appear in the catalogue. Copying unconditionally is a
    // superset of both, and that is the right direction to be wrong in.
    const v = tree();
    runShell(v, "cp -u /home/we/dust/audio/*.wav /home/we/dust/audio/copies/");
    expect(v.readText("/home/we/dust/audio/copies/one.wav")).toBe("w");
    runShell(v, "cp -f /home/we/version.txt /home/we/v2.txt");
    expect(v.readText("/home/we/v2.txt")).toBe("1.2");
  });

  it("moves, removes and touches", () => {
    const v = tree();
    runShell(v, "mv /home/we/dust/audio/one.wav /home/we/dust/audio/moved.wav");
    expect(v.readText("/home/we/dust/audio/moved.wav")).toBe("w");
    expect(v.exists("/home/we/dust/audio/one.wav")).toBe(false);
    runShell(v, "touch /home/we/dust/data/flag");
    expect(v.exists("/home/we/dust/data/flag")).toBe(true);
    runShell(v, "rm -rf /home/we/dust/data");
    expect(v.walk("/home/we/dust/data")).toEqual([]);
  });

  it("redirects a listing to a file", () => {
    const v = tree();
    expect(runShell(v, "ls /home/we/dust/audio > /tmp/list").ok).toBe(true);
    expect(v.readText("/tmp/list")).toBe("one.wav\nsub\ntwo.wav\n");
  });

  // THE HALF THAT MATTERS AS MUCH. Everything above is a command this can
  // do. These are commands it cannot, and the contract is that it says so
  // — `runShell` returning ok with an empty string is the failure mode
  // that cost a week.
  it("refuses what it cannot do, by name, rather than answering emptily", () => {
    const v = tree();
    for (const cmd of [
      "du -sh /home/we/dust/audio",
      "ls /home/we/dust/audio | awk '{print $1}'",
      "cat /tmp/foo < /tmp/other",
      "sudo systemctl restart norns-sclang",
      "jack_connect crone:output_5 SuperCollider:in_1",
    ]) {
      const r = runShell(v, cmd);
      expect(r.ok, cmd).toBe(false);
      expect(r.refused, cmd).toBeTruthy();
    }
  });
});

// E9-150 — the two that silently did nothing, kept apart from the rest.
//
// `cp -r` and `rm -rf` had the same fault for the same reason: sources
// were expanded with a matcher that answers FILES, so a directory
// argument vanished and the loop ran over an empty list. Both returned
// ok. `cp` was found from a Pixel log; `rm` was found by this file.
describe("a directory is an argument, and -r is what admits it", () => {
  const withDir = (): Vfs => {
    const v = new Vfs();
    v.write("/home/we/dust/code/thing/a.lua", "a");
    v.write("/home/we/dust/code/thing/lib/b.lua", "b");
    v.write("/home/we/dust/keep.txt", "k");
    return v;
  };

  it("rm -rf empties the folder and takes it with it", () => {
    const v = withDir();
    expect(runShell(v, "rm -rf /home/we/dust/code/thing").ok).toBe(true);
    expect(v.walk("/home/we/dust/code/thing")).toEqual([]);
    expect(v.isDir("/home/we/dust/code/thing")).toBe(false);
    expect(v.readText("/home/we/dust/keep.txt"), "it took more than it was given").toBe("k");
  });

  it("rm without -r leaves a directory alone and still does the rest", () => {
    const v = withDir();
    runShell(v, "rm /home/we/dust/code/thing /home/we/dust/keep.txt");
    expect(v.readText("/home/we/dust/code/thing/a.lua"), "a directory went without -r").toBe("a");
    expect(v.exists("/home/we/dust/keep.txt")).toBe(false);
  });

  it("cp -r keeps the shape it copies", () => {
    const v = withDir();
    runShell(v, "cp -r /home/we/dust/code/thing /home/we/dust/audio/");
    expect(v.readText("/home/we/dust/audio/thing/a.lua")).toBe("a");
    expect(v.readText("/home/we/dust/audio/thing/lib/b.lua")).toBe("b");
  });
});
